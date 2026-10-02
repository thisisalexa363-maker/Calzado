const DEFAULT_TIME_ZONE = "America/Lima";

export function dashboardIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return match ? match[0] : null;
}

export function dashboardDateParts(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    iso: `${fields.year}-${fields.month}-${fields.day}`
  };
}

export function buildDashboardPayroll(users, movements, years, {
  today = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  normalizeRole = (role) => String(role || "otros").trim().toLowerCase()
} = {}) {
  const todayParts = dashboardDateParts(today, timeZone);
  const byRole = {};
  const byWorker = {};
  const workersByMonth = {};
  const movementsByUser = new Map();

  for (const movement of movements || []) {
    const userId = Number(movement.usuario_id ?? movement.workerId);
    const date = dashboardIsoDate(movement.fecha_movimiento ?? movement.date);
    const type = String(movement.tipo_movimiento ?? movement.type ?? "").trim().toLowerCase();
    if (!userId || !date || !["ingreso", "salida"].includes(type)) continue;
    if (!movementsByUser.has(userId)) movementsByUser.set(userId, []);
    movementsByUser.get(userId).push({ id: Number(movement.id) || 0, date, type });
  }

  const periodsByUser = new Map();
  movementsByUser.forEach((items, userId) => {
    items.sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
    const periods = [];
    let openStart = null;
    for (const item of items) {
      if (item.type === "ingreso") {
        if (!openStart) openStart = item.date;
      } else if (openStart && item.date >= openStart) {
        periods.push({ start: openStart, end: item.date });
        openStart = null;
      }
    }
    if (openStart) periods.push({ start: openStart, end: null });
    periodsByUser.set(userId, periods);
  });

  for (const rawYear of years) {
    const year = Number(rawYear);
    byRole[year] = Array.from({ length: 12 }, () => ({}));
    byWorker[year] = Array.from({ length: 12 }, () => ({}));
    workersByMonth[year] = Array.from({ length: 12 }, () => 0);

    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      const monthNumber = monthIndex + 1;
      // Un mes solo entra a la estimacion cuando ya termino por completo.
      if (year > todayParts.year || (year === todayParts.year && monthNumber >= todayParts.month)) continue;

      const monthStart = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
      const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const monthEndIso = `${year}-${String(monthNumber).padStart(2, "0")}-${String(monthEnd).padStart(2, "0")}`;

      for (const user of users) {
        const salary = Number(user.sueldo || 0);
        const workerId = Number(user.id);
        if (!workerId || !Number.isFinite(salary) || salary <= 0) continue;
        const periods = periodsByUser.get(workerId) || [];
        const workedDays = new Set();
        for (const period of periods) {
          const overlapStart = period.start > monthStart ? period.start : monthStart;
          const overlapEnd = period.end && period.end < monthEndIso ? period.end : monthEndIso;
          if (overlapStart > overlapEnd) continue;
          const startDay = Number(overlapStart.slice(8, 10));
          const endDay = Number(overlapEnd.slice(8, 10));
          for (let day = startDay; day <= endDay; day += 1) workedDays.add(day);
        }
        if (!workedDays.size) continue;

        const role = normalizeRole(user.rol) || "otros";
        const proratedSalary = Math.round((salary * workedDays.size / monthEnd) * 100) / 100;
        byRole[year][monthIndex][role] = (byRole[year][monthIndex][role] || 0) + proratedSalary;
        byWorker[year][monthIndex][workerId] = proratedSalary;
        workersByMonth[year][monthIndex] += 1;
      }
    }
  }

  return { byRole, byWorker, workersByMonth };
}

export function buildComparableIncidentMetrics(incidents, operationalRecords) {
  const recordsByTask = new Map();
  for (const record of operationalRecords || []) {
    const taskId = Number(record.taskId ?? record.tarea_id);
    if (!taskId) continue;
    recordsByTask.set(taskId, (recordsByTask.get(taskId) || 0) + 1);
  }

  const allIncidentTaskIds = new Set();
  const incidentsByTask = new Map();
  for (const incident of incidents || []) {
    const taskId = Number(incident.taskId ?? incident.tarea_error_id ?? incident.tarea_id);
    if (!taskId) continue;
    allIncidentTaskIds.add(taskId);
    if (!recordsByTask.has(taskId)) continue;
    incidentsByTask.set(taskId, (incidentsByTask.get(taskId) || 0) + 1);
  }

  const comparableTaskIds = new Set([...recordsByTask.keys()].filter((taskId) => allIncidentTaskIds.has(taskId)));
  const ratesByTask = new Map();
  let comparableIncidents = 0;
  let comparableRecords = 0;
  recordsByTask.forEach((recordCount, taskId) => {
    if (!comparableTaskIds.has(taskId)) return;
    const incidentCount = incidentsByTask.get(taskId) || 0;
    comparableRecords += recordCount;
    comparableIncidents += incidentCount;
    if (incidentCount) ratesByTask.set(taskId, (incidentCount / recordCount) * 100);
  });

  return {
    comparableTaskIds,
    ratesByTask,
    comparableIncidents,
    comparableRecords,
    margin: comparableRecords ? (comparableIncidents / comparableRecords) * 100 : 0
  };
}

export function buildLeaderOperationSummary(activities, tasks, operationName, { excludeMatch = false } = {}) {
  const normalize = (value) => String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const needles = (Array.isArray(operationName) ? operationName : [operationName]).map(normalize).filter(Boolean);
  const taskIds = new Set((tasks || [])
    .filter((task) => {
      const taskName = normalize(task.name || task.shortName);
      const matches = needles.some((needle) => taskName.includes(needle));
      return excludeMatch ? !matches : matches;
    })
    .map((task) => Number(task.id)));
  const rows = (activities || []).filter((row) => row.source === "jefe-equipo" && taskIds.has(Number(row.taskId)));
  const workerCount = new Set(rows.map((row) => Number(row.workerId)).filter(Number.isFinite)).size;
  const pairs = rows.reduce((sum, row) => sum + Math.max(0, Number(row.quantity || 0)), 0);
  const minutes = rows.reduce((sum, row) => sum + Math.max(0, Number(row.minutes || 0)), 0);
  return { pairs, workerCount, minutes, averageMinutesPerWorker: workerCount ? minutes / workerCount : 0, records: rows.length };
}

export function averageEmployeeTenureMonths(movements, {
  today = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
  allowedWorkerIds = null
} = {}) {
  const todayIso = dashboardDateParts(today, timeZone).iso;
  const allowedIds = allowedWorkerIds ? new Set([...allowedWorkerIds].map(Number)) : null;
  const byWorker = new Map();

  for (const movement of movements || []) {
    const workerId = Number(movement.workerId ?? movement.usuario_id);
    const date = dashboardIsoDate(movement.date ?? movement.fecha_movimiento);
    const type = String(movement.type ?? movement.tipo_movimiento ?? "").trim().toLowerCase();
    if (!workerId || (allowedIds && !allowedIds.has(workerId)) || !date || !["ingreso", "salida"].includes(type)) continue;
    if (!byWorker.has(workerId)) byWorker.set(workerId, []);
    byWorker.get(workerId).push({ id: Number(movement.id) || 0, date, type });
  }

  const utcDay = (iso) => {
    const [year, month, day] = iso.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  const tenureDaysByWorker = new Map();

  byWorker.forEach((items, workerId) => {
    items.sort((left, right) => left.date.localeCompare(right.date) || left.id - right.id);
    let openStart = null;
    let totalDays = 0;
    let hasPeriod = false;
    for (const item of items) {
      if (item.type === "ingreso") {
        if (!openStart && item.date <= todayIso) openStart = item.date;
      } else if (openStart && item.date >= openStart) {
        const periodEnd = item.date < todayIso ? item.date : todayIso;
        totalDays += Math.max(0, utcDay(periodEnd) - utcDay(openStart));
        hasPeriod = true;
        openStart = null;
      }
    }
    // El periodo abierto (trabajador activo sin fecha de salida aun) no se
    // cuenta: mezclar antiguedad "en curso" con periodos ya cerrados hacia que
    // una ola de contrataciones nuevas hundiera el promedio de golpe, aunque
    // la retencion real no hubiera cambiado. Por eso esto mide cuanto duraron
    // en promedio los que ya salieron, no la antiguedad del equipo actual.
    if (hasPeriod) tenureDaysByWorker.set(workerId, totalDays);
  });

  const workerCount = tenureDaysByWorker.size;
  const totalDays = [...tenureDaysByWorker.values()].reduce((sum, days) => sum + days, 0);
  return {
    workerCount,
    totalDays,
    months: workerCount ? totalDays / workerCount / 30.4375 : 0,
    daysByWorker: tenureDaysByWorker
  };
}

function normalizedTaskName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildTaggedPairsByBrand(activities, taskById, brandById) {
  const totals = new Map();
  for (const row of activities) {
    const task = taskById.get(Number(row.taskId));
    if (normalizedTaskName(task?.name || task?.shortName) !== "etiquetado") continue;
    const brandName = brandById.get(Number(row.brandId));
    const quantity = Math.max(0, Number(row.quantity || 0));
    if (!brandName || !quantity) continue;
    totals.set(brandName, (totals.get(brandName) || 0) + quantity);
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function timedActivityKpi(rows) {
  const timedRows = rows.filter((row) => Number(row.minutes) > 0);
  if (!timedRows.length) return { daily: 0, hourly: 0 };
  const quantity = timedRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const days = new Set(timedRows.map((row) => row.date).filter(Boolean)).size;
  const averageHourly = timedRows.reduce(
    (sum, row) => sum + (Number(row.quantity || 0) / (Number(row.minutes) / 60)),
    0
  ) / timedRows.length;
  return {
    daily: days ? Math.round(quantity / days) : 0,
    hourly: Number.isFinite(averageHourly) ? Math.round(averageHourly) : 0
  };
}

export function taskVolumeRows(tasks, activities) {
  return tasks.map((task) => ({
    id: Number(task.id),
    name: task.shortName || task.name,
    type: task.type,
    value: activities.filter((row) => Number(row.taskId) === Number(task.id)).length
  })).filter((item) => item.value > 0).sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function workerProductionRows(workers, activities, selectedWorkerIds = []) {
  return workers.map((worker) => {
    const rows = activities.filter((row) => Number(row.workerId) === Number(worker.id));
    return {
      id: Number(worker.id),
      name: worker.name,
      workerName: worker.name,
      records: rows.length,
      value: rows.reduce((sum, row) => sum + Number(row.points || 0), 0)
    };
  }).filter((item) => item.records > 0 || selectedWorkerIds.includes(item.id));
}
