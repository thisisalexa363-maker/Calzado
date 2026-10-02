import test from "node:test";
import assert from "node:assert/strict";
import {
  averageEmployeeTenureMonths,
  buildDashboardPayroll,
  buildComparableIncidentMetrics,
  buildLeaderOperationSummary,
  buildTaggedPairsByBrand,
  dashboardDateParts,
  selectTaskDetailActivities,
  taskVolumeRows,
  timedActivityKpi,
  workerProductionRows
} from "../src/lib/dashboardMetrics.js";

test("detalle de tareas incluye apoyo registrado por el lider y filtra sin duplicar lote general", () => {
  const activities = [
    { id: "jefe-equipo-8", rawId: 8, workerId: 41, taskId: 2, date: "2026-10-02", createdAt: "2026-10-02T15:00:00Z", source: "jefe-equipo" },
    { id: "operante-7", rawId: 7, workerId: 12, taskId: 2, date: "2026-10-02", createdAt: "2026-10-02T12:00:00Z", source: "operante" }
  ];
  const general = [{ id: "operante-9", rawId: 9, workerId: 12, taskId: 3, date: "2026-10-01", source: "operante", isGeneralLote: true }];
  assert.deepEqual(selectTaskDetailActivities(activities, general).map((row) => row.id),
    ["jefe-equipo-8", "operante-7", "operante-9"]);
  assert.deepEqual(selectTaskDetailActivities(activities, general, [2]).map((row) => row.id),
    ["jefe-equipo-8", "operante-7"]);
});

test("resume ingreso y despacho solo con registros del jefe de equipo", () => {
  const tasks = [
    { id: 1, name: "Etiquetado" },
    { id: 2, name: "Picking" },
    { id: 3, name: "Embalado y Rotulado de Guía" },
    { id: 4, name: "Otra tarea" }
  ];
  const activities = [
    { source: "jefe-equipo", taskId: 2, workerId: 10, quantity: 120, minutes: 60 },
    { source: "jefe-equipo", taskId: 2, workerId: 11, quantity: 80, minutes: 30 },
    { source: "jefe-equipo", taskId: 3, workerId: 11, quantity: 20, minutes: 10 },
    { source: "operante", taskId: 2, workerId: 12, quantity: 999, minutes: 999 },
    { source: "jefe-equipo", taskId: 1, workerId: 10, quantity: 50, minutes: 15 },
    { source: "jefe-equipo", taskId: 4, workerId: 10, quantity: 500, minutes: 120 }
  ];
  assert.deepEqual(buildLeaderOperationSummary(activities, tasks, ["picking", "embalado y rotulado de guia", "envio nuevo", "visita de tienda"]), {
    pairs: 220, workerCount: 2, minutes: 100, averageMinutesPerWorker: 50, records: 3
  });
  assert.equal(buildLeaderOperationSummary(activities, tasks, "etiquetado").pairs, 50);
});

test("la fecha operativa se calcula en America/Lima", () => {
  assert.deepEqual(
    dashboardDateParts(new Date("2026-08-14T02:00:00.000Z")),
    { year: 2026, month: 8, day: 13, iso: "2026-08-13" }
  );
});

test("la planilla usa movimientos, prorratea altas y bajas, admite reingresos y solo incluye meses terminados", () => {
  const users = [
    { id: 1, rol: "operante", sueldo: 3100 },
    { id: 2, rol: "otros", sueldo: 2800 }
  ];
  const movements = [
    { id: 1, usuario_id: 1, tipo_movimiento: "Ingreso", fecha_movimiento: "2026-01-16" },
    { id: 2, usuario_id: 1, tipo_movimiento: "Salida", fecha_movimiento: "2026-02-10" },
    { id: 3, usuario_id: 1, tipo_movimiento: "Ingreso", fecha_movimiento: "2026-02-20" },
    { id: 4, usuario_id: 2, tipo_movimiento: "Ingreso", fecha_movimiento: "2026-01-01" },
    // Ingreso duplicado: no debe duplicar dias ni costo.
    { id: 5, usuario_id: 2, tipo_movimiento: "Ingreso", fecha_movimiento: "2026-01-05" }
  ];
  const payroll = buildDashboardPayroll(users, movements, [2026], {
    today: new Date("2026-08-13T18:00:00.000-05:00"),
    normalizeRole: (role) => role
  });

  assert.deepEqual(payroll.byRole[2026][0], { operante: 1600, otros: 2800 });
  assert.deepEqual(payroll.byRole[2026][1], { operante: 2103.57, otros: 2800 });
  assert.deepEqual(payroll.byRole[2026][6], { operante: 3100, otros: 2800 });
  assert.deepEqual(payroll.byRole[2026][7], {});
  assert.deepEqual(payroll.byRole[2026][8], {});
  assert.deepEqual(payroll.byWorker[2026][0], { 1: 1600, 2: 2800 });
  assert.equal(payroll.workersByMonth[2026][0], 2);
});

test("calidad compara solo tareas con registros operativos y excluye procesos generales del margen", () => {
  const metrics = buildComparableIncidentMetrics(
    [
      { id: 1, taskId: 3 },
      { id: 2, taskId: 3 },
      { id: 3, taskId: 50 },
      { id: 4, taskId: 50 }
    ],
    [
      { id: 10, taskId: 3 },
      { id: 11, taskId: 3 },
      { id: 12, taskId: 3 },
      { id: 13, taskId: 8 }
    ]
  );

  assert.deepEqual([...metrics.comparableTaskIds], [3]);
  assert.equal(metrics.ratesByTask.get(3), 2 / 3 * 100);
  assert.equal(metrics.ratesByTask.has(50), false);
  assert.equal(metrics.comparableIncidents, 2);
  assert.equal(metrics.comparableRecords, 3);
  assert.equal(metrics.margin, 2 / 3 * 100);
});

test("permanencia acumula reingresos y promedia solo periodos laborales cerrados", () => {
  const tenure = averageEmployeeTenureMonths([
    { id: 1, usuario_id: 1, tipo_movimiento: "Ingreso", fecha_movimiento: "2024-01-01" },
    { id: 2, usuario_id: 1, tipo_movimiento: "Salida", fecha_movimiento: "2024-07-01" },
    { id: 3, usuario_id: 1, tipo_movimiento: "Ingreso", fecha_movimiento: "2024-10-01" },
    { id: 4, usuario_id: 1, tipo_movimiento: "Salida", fecha_movimiento: "2025-04-01" },
    { id: 5, usuario_id: 2, tipo_movimiento: "Ingreso", fecha_movimiento: "2025-01-01" },
    { id: 6, usuario_id: 2, tipo_movimiento: "Ingreso", fecha_movimiento: "2025-02-01" },
    { id: 7, usuario_id: 3, tipo_movimiento: "Ingreso", fecha_movimiento: "2020-01-01" }
  ], {
    today: new Date("2025-07-01T12:00:00-05:00"),
    allowedWorkerIds: new Set([1, 2])
  });

  assert.equal(tenure.workerCount, 1);
  assert.equal(tenure.daysByWorker.get(1), 364);
  assert.equal(tenure.daysByWorker.has(2), false);
  assert.equal(tenure.totalDays, 364);
  assert.equal(tenure.months, 364 / 30.4375);
});

test("pares por marca usa solo Etiquetado y suma cantidades reales", () => {
  const tasks = new Map([
    [3, { id: 3, name: "Etiquetado" }],
    [8, { id: 8, name: "Picking" }]
  ]);
  const brands = new Map([[1, "Superga"], [2, "Adidas"]]);
  const rows = buildTaggedPairsByBrand([
    { taskId: 3, brandId: 1, quantity: 20 },
    { taskId: 3, brandId: 1, quantity: 5 },
    { taskId: 3, brandId: 2, quantity: 16 },
    { taskId: 8, brandId: 1, quantity: 999 }
  ], tasks, brands);

  assert.deepEqual(rows, [
    { name: "Superga", value: 25 },
    { name: "Adidas", value: 16 }
  ]);
});

test("KPIs por tiempo usan solo filas cronometradas y promedian la tasa de cada registro", () => {
  const result = timedActivityKpi([
    { date: "2026-08-01", quantity: 1000, minutes: 0 },
    { date: "2026-08-01", quantity: 60, minutes: 60 },
    { date: "2026-08-02", quantity: 60, minutes: 30 }
  ]);
  assert.deepEqual(result, { daily: 60, hourly: 90 });
});

test("detalle por tarea conserva el total completo aunque la grafica use top 10", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `Tarea ${index + 1}` }));
  const activities = tasks.flatMap((task, index) => Array.from({ length: index + 1 }, () => ({ taskId: task.id })));
  const rows = taskVolumeRows(tasks, activities);
  assert.equal(rows.length, 12);
  assert.equal(rows.reduce((sum, row) => sum + row.value, 0), 78);
});

test("bottom puede incluir cero puntos cuando el trabajador si tiene registros", () => {
  const rows = workerProductionRows([
    { id: 1, name: "Con cero" },
    { id: 2, name: "Sin actividad" },
    { id: 3, name: "Con puntos" }
  ], [
    { workerId: 1, points: 0 },
    { workerId: 3, points: 7 }
  ]);
  assert.deepEqual(rows.map(({ id, records, value }) => ({ id, records, value })), [
    { id: 1, records: 1, value: 0 },
    { id: 3, records: 1, value: 7 }
  ]);
});
