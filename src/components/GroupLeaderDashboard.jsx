import React, { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  ClipboardCheck,
  Pencil,
  FileSpreadsheet,
  Hash,
  RefreshCcw,
  Save,
  Search,
  Timer,
  Trash2,
  UserRound
} from "lucide-react";
import {
  cancelGroupLeaderActivity,
  createGroupLeaderRecord,
  createIncident,
  deleteIncident,
  deleteGroupLeaderRecord,
  friendlyError,
  listLotes,
  loadIncidentContext,
  loadGroupLeaderContext,
  updateGroupLeaderActivity,
  updateGroupLeaderAverageReference,
  updateGroupLeaderRecord,
  updateIncident
} from "../lib/repository";
import { formatDateLima, formatDateTimeLima, limaDateTimeToISO, todayLimaISO } from "../lib/dates";
import { downloadCsv } from "../lib/csv";
import {
  getGroupLeaderTaskMode,
  getTaskFieldFlags,
  getTaskRequiredFlags,
  getTaskTitle,
  isGroupLeaderTimeTask,
  normalizeMeasurementType,
  normalizeRole,
  normalizeText
} from "../lib/scoring";
import { useAsyncData } from "../lib/hooks";
import { useSessionState } from "../lib/sessionState";
import {
  Alert,
  Button,
  CheckboxInput,
  DataTable,
  DEFAULT_PAGE_SIZE,
  Field,
  LoadingBlock,
  Panel,
  SelectInput,
  TablePager,
  Tabs,
  TextArea,
  TextInput,
  usePagination
} from "./ui";
import WorkerDashboard, { HANGTAG_OPTIONS } from "./WorkerDashboard";

function createInitialForm() {
  return {
    trabajador_id: "",
    tarea_id: "",
    fecha_registro: todayLimaISO(),
    hora_inicio: "",
    marca_id: "",
    lote: "",
    tipo_etiquetado: "",
    tienda_id: "",
    detalle: ""
  };
}
var initialFilters = {
  scope: "all",
  managerId: "",
  includeInactive: false,
  workerId: "",
  taskId: "",
  categoria: "",
  search: "",
  order: "desc",
  year: todayLimaISO().slice(0, 4),
  month: todayLimaISO().slice(5, 7),
  day: ""
};
function recordSortTime(record) {
  const value = new Date(record.hora_inicio || record.fecha_registro || record.created_at || 0).getTime();
  return Number.isNaN(value) ? 0 : value;
}
// Muestra el equivalente en 12 horas junto al campo de hora, que se captura en
// formato 24h y puede confundirse (8:00 vs 20:00).
function timeTo12h(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || "")) return "";
  const [hours, minutes] = value.split(":").map(Number);
  const period = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${period}`;
}
// Se reconocen por igual las variantes con espacios y con guion bajo para no
// perder registros al agrupar, comparar o mostrar el tipo de etiquetado.
function normalizeHangtagValue(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
  return raw === "CON_HANGTAG" || raw === "SIN_HANGTAG" ? raw : null;
}
// Rendimiento propio de un registro (cantidad por hora), se muestre o no un
// promedio de referencia para compararlo. Null si no tiene un cierre valido.
function recordHourlyRate(record) {
  const minutes = Number(record.tiempo_minutos || 0);
  const quantity = Number(record.cantidad || 0);
  if (!record.hora_fin || !(minutes > 0) || !(quantity > 0)) return null;
  return (quantity / minutes) * 60;
}
// Compara el rendimiento de un registro contra el promedio de referencia de
// SU tarea, fijado manualmente arriba del historial -ya no un promedio
// automatico por tarea/hangtag. Cada tarea tiene su propio numero porque
// rinden a ritmos distintos; si ademas usa hangtag, "con hangtag" y "sin
// hangtag" tienen cada uno el suyo. Null si el registro no tiene un cierre
// valido o su tarea (y su mitad de hangtag, si aplica) no tiene un promedio
// fijado -el rendimiento propio se sigue mostrando aparte en ese caso.
function compareToReferenceAverage(record, averageReferenceByTask) {
  const rate = recordHourlyRate(record);
  if (rate === null) return null;
  const taskAverages = averageReferenceByTask?.[record.tarea_id];
  if (!taskAverages) return null;
  const hangtagKey = normalizeHangtagValue(record.tipo_etiquetado) || "";
  const average = Number(taskAverages[hangtagKey] ?? taskAverages[""] ?? 0);
  if (!(average > 0)) return null;
  const diffPct = ((rate - average) / average) * 100;
  if (Math.abs(diffPct) < 1) return { label: "En el promedio", tone: "neutral" };
  return diffPct > 0
    ? { label: `${Math.round(diffPct)}% sobre el promedio`, tone: "good" }
    : { label: `${Math.round(Math.abs(diffPct))}% bajo el promedio`, tone: "bad" };
}
export function TaskAverageField({ label, value, onSave }) {
  const initialDraft = value != null ? String(value) : "";
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  useEffect(() => {
    setDraft(value != null ? String(value) : "");
  }, [value]);
  const dirty = draft !== (value != null ? String(value) : "");
  async function handleSave() {
    setStatus(null);
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setStatus({ type: "error", message: "Ingresa un numero valido mayor o igual a cero." });
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      setStatus({ type: "success", message: "Guardado." });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="group-average-reference-item">
      <TextInput
        label={label}
        type="number"
        min="0"
        step="0.01"
        placeholder="Sin definir"
        hint="Cantidad por hora"
        value={draft}
        onChange={setDraft}
      />
      <Button type="button" variant="secondary" icon={Save} loading={saving} disabled={!dirty} onClick={handleSave}>
        Guardar
      </Button>
      {status ? <Alert type={status.type}>{status.message}</Alert> : null}
    </div>
  );
}
function GroupLeaderDashboard({ user }) {
  const [workspace, setWorkspace] = useSessionState(`leader-workspace:${user?.id || "unknown"}`, "Registro de tiempos de operarios");
  const canViewAllWorkers = ["lider de equipo", "otros"].includes(normalizeRole(user?.rol));
  const tabs = [
    "Registro de tiempos de operarios",
    "Registro operario",
    "Registrar errores",
    "Ranking"
  ];
  const [visitedWorkspaces, setVisitedWorkspaces] = useState(() => new Set([workspace]));

  useEffect(() => {
    if (!tabs.includes(workspace)) {
      setWorkspace(canViewAllWorkers && workspace === "Registros de todos los operantes" ? "Registro operario" : tabs[0]);
      return;
    }
    setVisitedWorkspaces((current) => {
      if (current.has(workspace)) return current;
      const next = new Set(current);
      next.add(workspace);
      return next;
    });
  }, [workspace, canViewAllWorkers, setWorkspace]);

  function keptWorkspace(name, content) {
    if (!visitedWorkspaces.has(name)) return null;
    return (
      <div style={{ display: workspace === name ? "block" : "none" }} aria-hidden={workspace !== name}>
        {content}
      </div>
    );
  }

  return (
    <div className="stack">
      <Tabs tabs={tabs} active={workspace} onChange={setWorkspace} />
      {keptWorkspace("Registro de tiempos de operarios", <GroupTimeDashboard user={user} />)}
      {keptWorkspace("Registro operario", (
        <div className="stack">
          <Panel title="Registro operario" eyebrow="Registro propio">
            <Alert>Los registros de este apartado quedarÃ¡n asociados a tu propio usuario, no al operante.</Alert>
          </Panel>
          <WorkerDashboard user={user} embedded showAllWorkers={canViewAllWorkers} />
        </div>
      ))}
      {keptWorkspace("Registrar errores", <IncidentDashboard user={user} />)}
      {keptWorkspace("Ranking", <RankingDashboard user={user} />)}
    </div>
  );
}
// Metrica activa del grafico de ranking: cada una sabe leer su valor de una
// entrada ya agregada y formatearlo para la barra.
const RANKING_METRICS = {
  rendimiento: { label: "Rendimiento (por hora)", getValue: (entry) => entry.rendimiento, format: (value) => `${formatRate(value)}/h` },
  cantidad: { label: "Cantidad total", getValue: (entry) => entry.cantidad, format: (value) => formatNumber(value) || "0" },
  minutos: { label: "Minutos totales", getValue: (entry) => entry.minutos, format: (value) => formatDuration(value) || "0 min" }
};

const RANKING_MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

function RankingDashboard({ user }) {
  const today = todayLimaISO();
  const [taskId, setTaskId] = useState("");
  const [topLimit, setTopLimit] = useState("5");
  const [selectedYear, setSelectedYear] = useState(today.slice(0, 4));
  const [selectedMonth, setSelectedMonth] = useState(today.slice(5, 7));
  const [selectedDay, setSelectedDay] = useState("");
  const [metric, setMetric] = useState("rendimiento");
  const [peopleScope, setPeopleScope] = useState("juntos");
  const [includeInactive, setIncludeInactive] = useState(true);
  const { data, loading, error, reload } = useAsyncData(
    loadGroupLeaderContext,
    [user?.id],
    { workers: [], tasks: [], brands: [], stores: [], leaders: [], allUsers: [], records: [] }
  );
  const tasks = (data.tasks || []).filter(isGroupLeaderTimeTask);
  const records = data.records || [];
  const recordYears = useMemo(() => [...new Set(records
    .map((record) => String(record.fecha_registro || "").slice(0, 4))
    .filter((year) => /^\d{4}$/.test(year)))]
    .sort((a, b) => Number(b) - Number(a)), [records]);
  useEffect(() => {
    if (recordYears.length && !recordYears.includes(selectedYear)) setSelectedYear(recordYears[0]);
  }, [recordYears, selectedYear]);
  const dayOptions = useMemo(() => {
    const year = Number(selectedYear);
    const month = Number(selectedMonth);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return [];
    const todayYear = Number(today.slice(0, 4));
    const todayMonth = Number(today.slice(5, 7));
    const todayDay = Number(today.slice(8, 10));
    const monthPosition = year * 12 + month;
    const todayPosition = todayYear * 12 + todayMonth;
    const lastDay = monthPosition > todayPosition
      ? 0
      : monthPosition === todayPosition
        ? todayDay
        : new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({ length: lastDay }, (_, index) => {
      const value = String(index + 1).padStart(2, "0");
      return { value, label: `Día ${index + 1}` };
    });
  }, [selectedYear, selectedMonth, today]);
  // Union de todos los que el servidor conoce: operantes, jefes y cualquier
  // otro usuario que haya quedado como trabajador de un registro (por
  // ejemplo, un líder de equipo que hizo la tarea el mismo).
  const peopleById = useMemo(() => {
    const map = new Map();
    (data.allUsers || []).forEach((item) => map.set(String(item.id), item));
    (data.workers || []).forEach((item) => {
      if (!map.has(String(item.id))) map.set(String(item.id), { ...item, activo: true });
    });
    (data.leaders || []).forEach((item) => {
      if (!map.has(String(item.id))) map.set(String(item.id), { ...item, activo: true });
    });
    return map;
  }, [data.allUsers, data.workers, data.leaders]);
  const taskFlagsById = useMemo(
    () => new Map((data.tasks || []).map((task) => [String(task.id), getTaskFieldFlags(task)])),
    [data.tasks]
  );
  // Las tarjetas de hangtag se guian por los mismos filtros que el resto de
  // esta pantalla (periodo, tarea, incluir inactivos): si el filtro de tarea
  // apunta a otra cosa, no tiene sentido mostrarlas.
  const hangtagTasks = tasks.filter((task) => {
    if (taskId && String(task.id) !== String(taskId)) return false;
    return Boolean(taskFlagsById.get(String(task.id))?.hangtag);
  });
  const { rankingByTask, hangtagAverages } = useMemo(() => {
    const taskIds = new Set(tasks.map((task) => String(task.id)));
    const grouped = new Map();
    const hangtagTotals = new Map();
    for (const record of records) {
      if (!taskIds.has(String(record.tarea_id))) continue;
      if (taskId && String(record.tarea_id) !== String(taskId)) continue;
      const recordDate = String(record.fecha_registro || "").slice(0, 10);
      if (recordDate.slice(0, 4) !== selectedYear) continue;
      if (recordDate.slice(5, 7) !== selectedMonth) continue;
      if (selectedDay && recordDate.slice(8, 10) !== selectedDay) continue;
      const person = peopleById.get(String(record.trabajador_id));
      if (!person) continue;
      if (!includeInactive && !person.activo) continue;
      const personRole = normalizeRole(person.rol);
      if (peopleScope === "operantes" && personRole !== "operante") continue;
      if (peopleScope === "jefes" && personRole !== "lider de equipo") continue;
      if (peopleScope === "juntos" && !["operante", "lider de equipo"].includes(personRole)) continue;
      const cantidad = Number(record.cantidad || 0);
      const minutos = Number(record.tiempo_minutos || 0);
      if (cantidad <= 0 || minutos <= 0) continue;
      const taskKey = String(record.tarea_id);
      if (!grouped.has(taskKey)) grouped.set(taskKey, new Map());
      const workersMap = grouped.get(taskKey);
      const workerKey = String(record.trabajador_id);
      const current = workersMap.get(workerKey) || {
        nombre: person.nombre || person.email || "Trabajador sin nombre",
        rol: personRole,
        activo: Boolean(person.activo),
        cantidad: 0,
        minutos: 0,
        registros: 0
      };
      current.cantidad += cantidad;
      current.minutos += minutos;
      current.registros += 1;
      workersMap.set(workerKey, current);

      if (taskFlagsById.get(taskKey)?.hangtag) {
        const hangtagKey = `${taskKey}::${normalizeHangtagValue(record.tipo_etiquetado) || "SIN_DATO"}`;
        const entry = hangtagTotals.get(hangtagKey) || { rateSum: 0, count: 0 };
        entry.rateSum += (cantidad / minutos) * 60;
        entry.count += 1;
        hangtagTotals.set(hangtagKey, entry);
      }
    }
    const hangtagAverages = new Map();
    hangtagTotals.forEach((entry, key) => hangtagAverages.set(key, entry.rateSum / entry.count));
    const rankingByTask = tasks.map((task) => {
      const workersMap = grouped.get(String(task.id));
      if (!workersMap) return null;
      const ranked = [...workersMap.values()].map((entry) => ({ ...entry, rendimiento: entry.cantidad / entry.minutos * 60 })).sort((a, b) => b.rendimiento - a.rendimiento);
      if (!ranked.length) return null;
      return { id: task.id, nombre: getTaskTitle(task) || "Tarea sin nombre", ranked };
    }).filter(Boolean);
    return { rankingByTask, hangtagAverages };
  }, [records, tasks, peopleById, selectedYear, selectedMonth, selectedDay, peopleScope, includeInactive, taskId, taskFlagsById]);
  const visibleRanking = taskId ? rankingByTask.filter((item) => String(item.id) === String(taskId)) : rankingByTask;
  const limit = Number(topLimit);
  return (
    <div className="stack">
      {hangtagTasks.length ? (
        <div className="hangtag-summary-card">
          <div className="hangtag-summary-header">
            <p className="eyebrow">Se ajusta a los filtros de abajo</p>
            <h2>Promedio por hangtag</h2>
            <p>Rendimiento en pares por hora, con y sin hangtag por separado. Cambia con la fecha, la tarea y "incluir inactivos" que elijas más abajo.</p>
          </div>
          <div className="hangtag-summary-grid">
            {hangtagTasks.map((task) => {
              const unit = String(task.unidad_medida || "unidades").toLowerCase();
              const label = hangtagTasks.length > 1 ? `${getTaskTitle(task)} · ` : "";
              return (
                <React.Fragment key={task.id}>
                  <HangtagStatTile
                    label={`${label}Con hangtag`}
                    value={hangtagAverages.get(`${task.id}::CON_HANGTAG`)}
                    unit={unit}
                  />
                  <HangtagStatTile
                    label={`${label}Sin hangtag`}
                    value={hangtagAverages.get(`${task.id}::SIN_HANGTAG`)}
                    unit={unit}
                  />
                </React.Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
      <Panel
        title="Ranking por tarea"
        eyebrow="Rendimiento promedio"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        <Alert>
          El rendimiento se calcula como cantidad total entre tiempo total, expresado por hora, sobre las tareas de
          líder de equipo que registran cantidad y tiempo. Incluye a jefes que hicieron la tarea ellos mismos. Por
          Por defecto se muestra el año y mes actuales, todos los días transcurridos, operantes y jefes incluyendo inactivos.
        </Alert>
        <div className="history-toolbar">
          <SelectInput
            label="Año"
            value={selectedYear}
            onChange={(year) => {
              setSelectedYear(year);
              setSelectedDay("");
            }}
            options={recordYears.map((year) => ({ value: year, label: year }))}
          />
          <SelectInput
            label="Mes"
            value={selectedMonth}
            onChange={(month) => {
              setSelectedMonth(month);
              setSelectedDay("");
            }}
            options={RANKING_MONTHS.map((label, index) => ({
              value: String(index + 1).padStart(2, "0"),
              label
            }))}
          />
          <SelectInput
            label="Día"
            value={selectedDay}
            onChange={setSelectedDay}
            options={[
              { value: "", label: "Todos los días" },
              ...dayOptions
            ]}
          />
          <SelectInput
            label="Metrica"
            value={metric}
            onChange={setMetric}
            options={Object.entries(RANKING_METRICS).map(([value, spec]) => ({ value, label: spec.label }))}
          />
          <SelectInput
            label="Tarea"
            value={taskId}
            onChange={setTaskId}
            options={[
              { value: "", label: "Todas" },
              ...tasks.map((task) => ({ value: String(task.id), label: getTaskTitle(task) || "Tarea sin nombre" }))
            ]}
          />
          <SelectInput
            label="Mostrar"
            value={topLimit}
            onChange={setTopLimit}
            options={[
              { value: "3", label: "Top 3" },
              { value: "5", label: "Top 5" },
              { value: "10", label: "Top 10" },
              { value: "0", label: "Todos" }
            ]}
          />
          <SelectInput
            label="Personal"
            value={peopleScope}
            onChange={setPeopleScope}
            options={[
              { value: "operantes", label: "Solo operantes" },
              { value: "jefes", label: "Solo jefes de equipo" },
              { value: "juntos", label: "Jefes y operantes" }
            ]}
          />
          <CheckboxInput
            label="Incluir inactivos"
            checked={includeInactive}
            onChange={setIncludeInactive}
          />
        </div>
        {!loading && !visibleRanking.length ? (
          <Alert>Aun no hay registros con cantidad y tiempo para armar el ranking en este periodo.</Alert>
        ) : null}
      </Panel>
      {visibleRanking.map((item) => {
        const ordered = [...item.ranked].sort(
          (a, b) => RANKING_METRICS[metric].getValue(b) - RANKING_METRICS[metric].getValue(a)
        );
        const limited = limit ? ordered.slice(0, limit) : ordered;
        return (
          <Panel
            key={item.id}
            title={item.nombre}
            eyebrow={peopleScope === "operantes" ? "Top operantes" : peopleScope === "jefes" ? "Top jefes de equipo" : "Top jefes y operantes"}
          >
            <RankingColumnChart entries={limited} metric={metric} />
          </Panel>
        );
      })}
    </div>
  );
}

function RankingColumnChart({ entries, metric }) {
  const [activeIndex, setActiveIndex] = useState(0);
  if (!entries.length) return null;
  const spec = RANKING_METRICS[metric] || RANKING_METRICS.rendimiento;
  const maximum = Math.max(...entries.map((entry) => spec.getValue(entry)), 1);
  const activeEntry = entries[Math.min(activeIndex, entries.length - 1)] || entries[0];
  return (
    <div className="ranking-dashboard-chart" style={{ "--ranking-count": entries.length }} role="list" aria-label={`Top operantes y jefes por ${spec.label.toLowerCase()}`}>
      <div className="ranking-dashboard-plot">
        <div className="ranking-dashboard-grid">
          {entries.map((entry, index) => {
          const value = spec.getValue(entry);
          const heightPct = Math.max(8, Math.round((value / maximum) * 100));
          const key = `${entry.nombre}-${index}`;
          const initials = String(entry.nombre || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
          return (
            <div className={`ranking-dashboard-item ranking-dashboard-position-${Math.min(index + 1, 4)}${activeIndex === index ? " is-active" : ""}`} key={key} role="listitem" tabIndex={0}
              onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)}>
              <div className="ranking-dashboard-value">{spec.format(value)}</div>
              <div className="ranking-dashboard-bar-area">
                <div className="ranking-dashboard-bar" style={{ height: `${heightPct}%` }}><i /></div>
                <span className="ranking-dashboard-medal">{index + 1}</span>
              </div>
              <div className="ranking-dashboard-person">
                <span className="ranking-dashboard-avatar">{initials}</span>
                <strong title={entry.nombre}>{entry.nombre}</strong>
                <small>{entry.rol && entry.rol !== "operante" ? entry.rol : `${entry.registros} ${entry.registros === 1 ? "registro" : "registros"}`}{!entry.activo ? " · inactivo" : ""}</small>
              </div>
            </div>
          );
          })}
        </div>
        <div className="ranking-dashboard-axis"><span>0</span><span>{spec.label}</span><span>{spec.format(maximum)}</span></div>
      </div>
      <aside className="ranking-dashboard-detail" aria-live="polite">
        <span className="ranking-dashboard-detail-position">Puesto #{activeIndex + 1}</span>
        <strong>{activeEntry.nombre}</strong>
        <small>{activeEntry.rol || "operante"}{!activeEntry.activo ? " · inactivo" : ""}</small>
        <div className="ranking-dashboard-detail-row"><span>Rendimiento</span><b>{formatRate(activeEntry.rendimiento)}/h</b></div>
        <div className="ranking-dashboard-detail-row"><span>Cantidad total</span><b>{formatNumber(activeEntry.cantidad)}</b></div>
        <div className="ranking-dashboard-detail-row"><span>Tiempo total</span><b>{formatDuration(activeEntry.minutos) || "0 min"}</b></div>
        <div className="ranking-dashboard-detail-row"><span>Registros</span><b>{activeEntry.registros}</b></div>
      </aside>
    </div>
  );
}

// Ranking visual: combina posicion, identidad y una barra relativa al lider.
// El hover/foco conserva el detalle de todas las metricas.
function RankingBarChart({ entries, metric }) {
  const [hoveredKey, setHoveredKey] = useState(null);
  if (!entries.length) return null;
  const spec = RANKING_METRICS[metric] || RANKING_METRICS.rendimiento;
  const maxValue = Math.max(...entries.map((entry) => spec.getValue(entry)), 1);
  return (
    <div className="ranking-chart" role="list" aria-label={`Ranking por ${spec.label.toLowerCase()}`}>
      {entries.map((entry, index) => {
        const value = spec.getValue(entry);
        const widthPct = Math.max(3, Math.round((value / maxValue) * 100));
        const key = `${entry.nombre}-${index}`;
        const hovered = hoveredKey === key;
        const initials = String(entry.nombre || "?")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0])
          .join("")
          .toUpperCase();
        const clearIfSelf = () => setHoveredKey((current) => (current === key ? null : current));
        return (
          <div
            key={key}
            className={`ranking-chart-row ranking-chart-position-${Math.min(index + 1, 4)}`}
            role="listitem"
            tabIndex={0}
            onMouseEnter={() => setHoveredKey(key)}
            onMouseLeave={clearIfSelf}
            onFocus={() => setHoveredKey(key)}
            onBlur={clearIfSelf}
          >
            <span className="ranking-chart-rank" aria-label={`Posición ${index + 1}`}>{index + 1}</span>
            <span className="ranking-chart-avatar" aria-hidden="true">{initials}</span>
            <span className="ranking-chart-person">
              <strong className="ranking-chart-label" title={entry.nombre}>{entry.nombre}</strong>
              <small>{entry.registros} {entry.registros === 1 ? "registro" : "registros"}</small>
            </span>
            <span className="ranking-chart-measure">
              <span className="ranking-chart-track">
                <span className="ranking-chart-bar" style={{ width: `${widthPct}%` }}>
                  <i />
                </span>
              </span>
              <small>{widthPct}% del líder</small>
            </span>
            <span className="ranking-chart-value"><small>{spec.label}</small>{spec.format(value)}</span>
            {hovered ? (
              <div className="ranking-chart-tooltip" role="tooltip">
                <strong>{entry.nombre}</strong>
                <div className={`ranking-chart-tooltip-row${metric === "rendimiento" ? " active" : ""}`}>
                  <span>Rendimiento</span><span>{formatRate(entry.rendimiento)}/h</span>
                </div>
                <div className={`ranking-chart-tooltip-row${metric === "cantidad" ? " active" : ""}`}>
                  <span>Cantidad total</span><span>{formatNumber(entry.cantidad)}</span>
                </div>
                <div className={`ranking-chart-tooltip-row${metric === "minutos" ? " active" : ""}`}>
                  <span>Tiempo total</span><span>{formatDuration(entry.minutos) || "0 min"}</span>
                </div>
                <div className="ranking-chart-tooltip-row">
                  <span>Registros</span><span>{entry.registros}</span>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
// Comparacion Con hangtag / Sin hangtag de una tarea: dos barras sobre la
// misma escala, reusando el mismo lenguaje visual que el ranking principal.
function HangtagStatTile({ label, value, unit }) {
  return (
    <div className="hangtag-stat-tile">
      <span className="hangtag-stat-label">{label}</span>
      <strong className="hangtag-stat-value">{value ? `${formatRate(value)} ${unit}/h` : "Sin datos"}</strong>
    </div>
  );
}
var initialIncidentForm = {
  usuario_id: "",
  area_id: "",
  fecha_error: todayLimaISO(),
  turno: "turno regular",
  tarea_id: "",
  tienda_id: "",
  numero_guia: "",
  numero_lote: "",
  tipo_error: "CONTENIDO",
  observacion: ""
};
var initialIncidentHistoryFilters = {
  dateFrom: "",
  dateTo: "",
  responsible: "",
  taskId: "",
  shift: "",
  errorType: "",
  storeId: "",
  search: ""
};
export function IncidentDashboard({ user }) {
  const incidentDraftKey = `incident-draft:${user?.id || "admin"}`;
  const [form, setForm] = useSessionState(`${incidentDraftKey}:form`, initialIncidentForm);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useSessionState(`${incidentDraftKey}:editing-id`, null);
  const [historyFilters, setHistoryFilters] = useSessionState(`${incidentDraftKey}:history-filters`, initialIncidentHistoryFilters);
  const { data, loading, error, reload } = useAsyncData(
    loadIncidentContext,
    [user?.id],
    { workers: [], tasks: [], stores: [], areas: [], incidents: [] }
  );
  const workers = data.workers || [];
  const tasks = data.tasks || [];
  const stores = data.stores || [];
  const areas = data.areas || [];
  const incidents = data.incidents || [];
  const storeNames = useMemo(
    () => new Map(stores.map((store) => [Number(store.id), store.nombre])),
    [stores]
  );
  function updateForm(changes) {
    setForm((current) => ({ ...current, ...changes }));
  }
  function updateHistoryFilters(changes) {
    setHistoryFilters((current) => ({ ...current, ...changes }));
  }
  function editIncident(incident) {
    const areaIncident = ["incidencia", "error"].includes(String(incident.turno || "").toLowerCase());
    setEditingId(Number(incident.id_error));
    setForm({
      usuario_id: areaIncident ? "" : String(incident.usuario_id || ""),
      area_id: areaIncident ? String(incident.area_id || "") : "",
      fecha_error: String(incident.fecha_error || "").slice(0, 10),
      turno: areaIncident ? "incidencia" : incident.turno,
      tarea_id: String(incident.tarea_error_id || ""),
      tienda_id: String(incident.tienda_id || ""),
      numero_guia: incident.numero_guia || "",
      numero_lote: incident.numero_lote || "",
      tipo_error: incident.tipo_error || "CONTENIDO",
      observacion: incident.observacion || ""
    });
    setStatus({ type: "info", message: `Editando el error #${incident.id_error}.` });
  }
  function cancelEdit() {
    setEditingId(null);
    setForm({ ...initialIncidentForm, fecha_error: todayLimaISO() });
    setStatus(null);
  }
  async function removeIncident() {
    if (!editingId || !window.confirm("¿Eliminar este registro de error? Esta acción no se puede deshacer.")) return;
    setSaving(true);
    try {
      await deleteIncident(editingId);
      cancelEdit();
      setStatus({ type: "success", message: "Error eliminado correctamente." });
      await reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }
  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);
    const isAreaIncident = ["incidencia", "error"].includes(form.turno);
    if (!isAreaIncident && !workers.some((worker) => String(worker.id) === String(form.usuario_id))) {
      setStatus({ type: "error", message: "Selecciona un trabajador." });
      return;
    }
    if (isAreaIncident && !areas.some((area) => String(area.id) === String(form.area_id))) {
      setStatus({ type: "error", message: "Selecciona un área." });
      return;
    }
    if (!tasks.some((task) => String(task.id) === String(form.tarea_id))) {
      setStatus({ type: "error", message: "Selecciona una tarea." });
      return;
    }
    if (!stores.some((store) => String(store.id) === String(form.tienda_id))) {
      setStatus({ type: "error", message: "Selecciona una tienda." });
      return;
    }
    if (!form.tipo_error.trim()) {
      setStatus({ type: "error", message: "Ingresa el tipo de error." });
      return;
    }
    if (!form.fecha_error || form.fecha_error > todayLimaISO()) {
      setStatus({ type: "error", message: "Selecciona una fecha válida que no esté en el futuro." });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        usuario_id: isAreaIncident ? null : Number(form.usuario_id),
        area_id: isAreaIncident ? Number(form.area_id) : null,
        fecha_error: form.fecha_error,
        turno: form.turno,
        tarea_error_id: Number(form.tarea_id),
        tienda_id: Number(form.tienda_id),
        numero_guia: form.numero_guia.trim(),
        numero_lote: form.numero_lote.trim(),
        tipo_error: form.tipo_error.trim(),
        observacion: form.observacion.trim() || null
      };
      if (editingId) await updateIncident(editingId, payload);
      else await createIncident(payload);
      setForm({ ...initialIncidentForm, fecha_error: todayLimaISO() });
      setStatus({ type: "success", message: editingId ? "Error actualizado correctamente." : "Error registrado correctamente." });
      setEditingId(null);
      await reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }
  const filteredIncidents = incidents.filter((incident) => {
    const date = String(incident.fecha_error || "").slice(0, 10);
    if (historyFilters.dateFrom && date < historyFilters.dateFrom) return false;
    if (historyFilters.dateTo && date > historyFilters.dateTo) return false;
    if (historyFilters.responsible) {
      const [kind, id] = historyFilters.responsible.split(":");
      if (kind === "user" && String(incident.usuario_id || "") !== id) return false;
      if (kind === "area" && String(incident.area_id || "") !== id) return false;
    }
    if (historyFilters.taskId && String(incident.tarea_error_id || "") !== historyFilters.taskId) return false;
    const shift = ["incidencia", "error"].includes(String(incident.turno || "").trim().toLowerCase())
      ? "incidencia"
      : String(incident.turno || "").trim().toLowerCase();
    if (historyFilters.shift && shift !== historyFilters.shift) return false;
    if (historyFilters.errorType && String(incident.tipo_error || "").trim().toUpperCase() !== historyFilters.errorType) return false;
    if (historyFilters.storeId && String(incident.tienda_id || "") !== historyFilters.storeId) return false;
    const search = normalizeText(historyFilters.search);
    if (search) {
      const searchable = normalizeText([
        incident.numero_guia,
        incident.numero_lote,
        incident.observacion,
        incident.usuario_nombre,
        incident.area_nombre,
        incident.tarea_nombre,
        incident.tienda_nombre
      ].filter(Boolean).join(" "));
      if (!searchable.includes(search)) return false;
    }
    return true;
  });
  const responsibleOptions = [
    { value: "", label: "Todos" },
    ...workers.map((worker) => ({ value: `user:${worker.id}`, label: worker.nombre || worker.email || `Usuario ${worker.id}` })),
    ...areas.map((area) => ({ value: `area:${area.id}`, label: `${area.nombre} (área)` }))
  ];
  const historyFiltersView = (
    <>
      <div className="toolbar incident-history-filters">
        <TextInput label="Fecha desde" type="date" value={historyFilters.dateFrom} max={historyFilters.dateTo || undefined} onChange={(dateFrom) => updateHistoryFilters({ dateFrom })} />
        <TextInput label="Fecha hasta" type="date" value={historyFilters.dateTo} min={historyFilters.dateFrom || undefined} max={todayLimaISO()} onChange={(dateTo) => updateHistoryFilters({ dateTo })} />
        <SelectInput label="Usuario o área" value={historyFilters.responsible} onChange={(responsible) => updateHistoryFilters({ responsible })} options={responsibleOptions} />
        <SelectInput label="Tarea" value={historyFilters.taskId} onChange={(taskId) => updateHistoryFilters({ taskId })} options={[{ value: "", label: "Todas" }, ...tasks.map((task) => ({ value: String(task.id), label: getTaskTitle(task) || "Tarea sin nombre" }))]} />
        <SelectInput label="Clasificación" value={historyFilters.shift} onChange={(shift) => updateHistoryFilters({ shift })} options={[{ value: "", label: "Todas" }, { value: "turno regular", label: "Turno regular" }, { value: "turno extra", label: "Turno extra" }, { value: "incidencia", label: "Incidencia" }]} />
        <SelectInput label="Tipo de error" value={historyFilters.errorType} onChange={(errorType) => updateHistoryFilters({ errorType })} options={[{ value: "", label: "Todos" }, { value: "CONTENIDO", label: "CONTENIDO" }, { value: "LIBERADO", label: "LIBERADO" }]} />
        <SelectInput label="Tienda" value={historyFilters.storeId} onChange={(storeId) => updateHistoryFilters({ storeId })} options={[{ value: "", label: "Todas" }, ...stores.map((store) => ({ value: String(store.id), label: store.nombre }))]} />
        <TextInput label="Buscar" value={historyFilters.search} onChange={(search) => updateHistoryFilters({ search })} placeholder="Guía, lote u observación" />
        <Button type="button" variant="secondary" onClick={() => setHistoryFilters(initialIncidentHistoryFilters)}>Limpiar filtros</Button>
      </div>
      <span className="muted">Mostrando {filteredIncidents.length} de {incidents.length} registros.</span>
    </>
  );
  const rows = filteredIncidents.map((incident) => ({
    id: incident.id_error,
    Acción: /* @__PURE__ */ React.createElement(Button, {
      type: "button",
      variant: "secondary",
      size: "sm",
      icon: Pencil,
      onClick: (event) => {
        event.stopPropagation();
        editIncident(incident);
      }
    }, "Editar"),
    Fecha: formatDateLima(incident.fecha_error),
    "Usuario / Área": incident.usuario_id ? incident.usuario_nombre : incident.area_nombre,
    Tarea: incident.tarea_nombre,
    "N\xFAmero de gu\xEDa": incident.numero_guia,
    "Número de lote": incident.numero_lote,
    Tienda: incident.tienda_nombre || storeNames.get(Number(incident.tienda_id)) || "Tienda no disponible",
    "Tipo de error": incident.tipo_error,
    Observaci\u00F3n: incident.observacion,
    Turno: ["incidencia", "error"].includes(String(incident.turno || "").toLowerCase()) ? "incidencia" : incident.turno,
    _incident: incident
  }));
  return /* @__PURE__ */ React.createElement("div", { className: "stack" }, /* @__PURE__ */ React.createElement(
    Panel,
    {
      title: editingId ? `Editar error #${editingId}` : "Registrar error",
      eyebrow: "Líder de equipo",
      actions: /* @__PURE__ */ React.createElement(Button, { variant: "secondary", icon: RefreshCcw, onClick: reload }, "Actualizar")
    },
    loading ? /* @__PURE__ */ React.createElement(LoadingBlock, null) : null,
    error ? /* @__PURE__ */ React.createElement(Alert, { type: "error" }, error) : null,
    !loading && !workers.length && !["incidencia", "error"].includes(form.turno) ? /* @__PURE__ */ React.createElement(Alert, null, "No hay trabajadores activos.") : null,
    !loading && !stores.length ? /* @__PURE__ */ React.createElement(Alert, null, "No hay tiendas activas registradas.") : null,
    /* @__PURE__ */ React.createElement("form", { className: "form-grid", onSubmit: handleSubmit }, /* @__PURE__ */ React.createElement(
      TextInput,
      {
        label: "Fecha del error",
        type: "date",
        value: form.fecha_error,
        max: todayLimaISO(),
        required: true,
        onChange: (fecha_error) => updateForm({ fecha_error })
      }
    ), ["incidencia", "error"].includes(form.turno) ? /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Área",
        value: form.area_id,
        onChange: (area_id) => updateForm({ area_id }),
        options: [{ value: "", label: "Selecciona un área" }, ...areas.map((area) => ({ value: String(area.id), label: area.nombre }))]
      }
    ) : /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Trabajador",
        value: form.usuario_id,
        onChange: (usuario_id) => updateForm({ usuario_id }),
        options: [
          { value: "", label: "Selecciona un trabajador" },
          ...workers.map((worker) => ({
            value: String(worker.id),
            label: worker.nombre || worker.email || "Trabajador sin nombre"
          }))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Turno",
        value: form.turno,
        onChange: (turno) => updateForm({ turno, usuario_id: turno === "incidencia" ? "" : form.usuario_id, area_id: turno === "incidencia" ? form.area_id : "" }),
        options: ["turno regular", "incidencia", "turno extra"]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Tarea",
        value: form.tarea_id,
        onChange: (tarea_id) => updateForm({ tarea_id }),
        options: [
          { value: "", label: "Selecciona una tarea" },
          ...tasks.map((task) => ({ value: String(task.id), label: getTaskTitle(task) || "Tarea sin nombre" }))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Tienda",
        value: form.tienda_id,
        onChange: (tienda_id) => updateForm({ tienda_id }),
        options: [
          { value: "", label: "Selecciona una tienda" },
          ...stores.map((store) => ({ value: String(store.id), label: store.nombre }))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      TextInput,
      {
        label: "N\xFAmero de gu\xEDa",
        value: form.numero_guia,
        onChange: (numero_guia) => updateForm({ numero_guia }),
        placeholder: "Ej. GUIA-001"
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Tipo de error",
        value: form.tipo_error,
        onChange: (tipo_error) => updateForm({ tipo_error }),
        options: ["CONTENIDO", "LIBERADO"]
      }
    ), /* @__PURE__ */ React.createElement(
      TextInput,
      {
        label: "Número de lote (opcional)",
        value: form.numero_lote,
        onChange: (numero_lote) => updateForm({ numero_lote }),
        placeholder: "Ej. LOTE-001"
      }
    ), /* @__PURE__ */ React.createElement(
      TextArea,
      {
        label: "Observaci\xF3n",
        value: form.observacion,
        onChange: (observacion) => updateForm({ observacion }),
        placeholder: "Detalle opcional"
      }
    ), /* @__PURE__ */ React.createElement("div", { className: "form-span form-actions" }, editingId ? /* @__PURE__ */ React.createElement(Button, { type: "button", variant: "danger", icon: Trash2, loading: saving, onClick: removeIncident }, "Eliminar error") : null, editingId ? /* @__PURE__ */ React.createElement(Button, { type: "button", variant: "secondary", disabled: saving, onClick: cancelEdit }, "Cancelar") : null, /* @__PURE__ */ React.createElement(Button, { type: "submit", icon: Save, loading: saving }, editingId ? "Guardar cambios" : "Guardar error")), status ? /* @__PURE__ */ React.createElement(Alert, { type: status.type }, status.message) : null)
  ), /* @__PURE__ */ React.createElement(Panel, { title: "Historial de errores", eyebrow: "Usa Editar para corregir fecha o cualquier otro dato" }, historyFiltersView, /* @__PURE__ */ React.createElement(DataTable, { rows, columns: ["Acción", "Fecha", "Usuario / Área", "Tarea", "Número de guía", "Número de lote", "Tienda", "Tipo de error", "Observación", "Turno"], onRowClick: (row) => editIncident(row._incident), empty: "No hay errores para los filtros seleccionados.", compact: true })));
}

export function TimeRecordsHistory() {
  const [taskId, setTaskId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [lot, setLot] = useState("");
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [context, lotes] = await Promise.all([loadGroupLeaderContext(), listLotes().catch(() => [])]);
    return { ...context, lotes };
  }, [], { records: [], recordTasks: [], allUsers: [], stores: [], lotes: [] });
  const rows = (data.records || []).filter((record) => {
    const date = String(record.fecha_registro || "").slice(0, 10);
    if (taskId && String(record.tarea_id) !== taskId) return false;
    if (workerId && String(record.trabajador_id) !== workerId) return false;
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return !lot || String(record.lote || "") === lot;
  }).map((record) => ({
    Fecha: record.fecha_registro,
    Operante: record.trabajador_nombre,
    Tarea: record.tarea_nombre,
    Lote: record.lote,
    Cantidad: record.cantidad,
    "Hora inicio": record.hora_inicio ? formatDateTimeLima(record.hora_inicio) : "",
    "Hora fin": record.hora_fin ? formatDateTimeLima(record.hora_fin) : "Sin cerrar",
    "Tiempo (min)": record.tiempo_minutos,
    Tienda: record.tienda_nombre,
    Encargado: record.encargado_nombre
  }));
  return <Panel title="Registros de tiempo" eyebrow="Todos los líderes y operantes" actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
    {loading ? <LoadingBlock /> : null}
    {error ? <Alert type="error">{error}</Alert> : null}
    <div className="toolbar">
      <SelectInput label="Operante" value={workerId} onChange={setWorkerId} options={[{ value: "", label: "Todos" }, ...(data.allUsers || []).map((item) => ({ value: String(item.id), label: item.nombre || item.email }))]} />
      <SelectInput label="Tarea" value={taskId} onChange={setTaskId} options={[{ value: "", label: "Todas" }, ...(data.recordTasks || []).map((task) => ({ value: String(task.id), label: getTaskTitle(task) }))]} />
      <SelectInput label="Lote" value={lot} onChange={setLot} options={[
        { value: "", label: "Todos los lotes" },
        ...(data.lotes || []).map((item) => ({
          value: String(item.codigo_lote || item.lote || ""),
          label: item.marca_nombre ? `${item.codigo_lote} - ${item.marca_nombre}` : String(item.codigo_lote || item.lote || "")
        })).filter((option) => option.value)
      ]} />
      <TextInput label="Fecha desde" type="date" value={dateFrom} onChange={setDateFrom} />
      <TextInput label="Fecha hasta" type="date" value={dateTo} onChange={setDateTo} />
    </div>
    <DataTable rows={rows} empty="No hay registros para los filtros seleccionados." />
  </Panel>;
}
export function GroupTimeDashboard({ user }) {
  const timeDraftKey = `leader-time:${user?.id || "unknown"}`;
  const [form, setForm] = useSessionState(`${timeDraftKey}:form`, createInitialForm);
  const [filters, setFilters] = useSessionState(`${timeDraftKey}:filters`, initialFilters);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [rowSaving, setRowSaving] = useState(false);
  const { data, loading, error, reload } = useAsyncData(
    loadGroupLeaderContext,
    [user?.id],
    {
      workers: [], tasks: [], recordTasks: [], brands: [], stores: [], leaders: [], activities: [], records: [],
      historyMigrationRequired: false, averageReferenceByTask: {}, averageReferenceMigrationRequired: false
    }
  );
  const { data: lotes = [] } = useAsyncData(() => listLotes().catch(() => []), [], []);
  const workers = data.workers || [];
  const tasks = data.tasks || [];
  const recordTasks = data.recordTasks || tasks;
  const brands = data.brands || [];
  const stores = data.stores || [];
  const records = data.records || [];
  const isAdministrator = normalizeRole(user.rol) === "administrador";
  const userById = new Map((data.allUsers || []).map((item) => [String(item.id), item]));
  const includeInactive = Boolean(filters.includeInactive);
  const managerOptions = [...records.reduce((items, record) => {
    const manager = userById.get(String(record.encargado_id));
    if (record.encargado_id && (includeInactive || manager?.activo !== false)) items.set(String(record.encargado_id), `${record.encargado_nombre || record.encargado_email || `Encargado ${record.encargado_id}`}${manager?.activo === false ? " (inactivo)" : ""}`);
    return items;
  }, new Map()).entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "es"));
  const recordedWorkerIds = new Set(records.map((record) => String(record.trabajador_id)).filter(Boolean));
  const historyWorkerOptions = (data.allUsers || [])
    .filter((item) => recordedWorkerIds.has(String(item.id)) && (includeInactive || item.activo !== false))
    .map((item) => ({ value: String(item.id), label: `${item.nombre || item.email || "Trabajador sin nombre"}${item.activo === false ? " (inactivo)" : ""}` }));
  const recordYears = [...new Set([todayLimaISO().slice(0, 4), ...records.map((record) => String(record.fecha_registro || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year))])].sort((a, b) => b.localeCompare(a));
  const selectedYear = filters.year || todayLimaISO().slice(0, 4);
  const selectedMonth = filters.month || "";
  const daysInSelectedMonth = selectedMonth ? new Date(Number(selectedYear), Number(selectedMonth), 0).getDate() : 0;
  const taskCategoryById = useMemo(
    () => new Map(recordTasks.map((task) => [String(task.id), String(task.tipo_tarea || "").trim()])),
    [recordTasks]
  );
  const averageReferenceByTask = data.averageReferenceByTask || {};
  // Las tareas con hangtag (hoy, Etiquetado) muestran dos campos -con y sin
  // hangtag- porque rinden a ritmos distintos y no son comparables entre si;
  // el resto de tareas de líder de equipo muestra un solo campo.
  const selectedTask = useMemo(
    () => tasks.find((task) => String(task.id) === String(form.tarea_id)),
    [tasks, form.tarea_id]
  );
  const taskMode = resolveGroupTaskMode(selectedTask);
  const metrics = useMemo(() => {
    const today = todayLimaISO();
    const mine = records.filter((record) => String(record.encargado_id) === String(user.id));
    return {
      total: mine.length,
      today: mine.filter((record) => String(record.fecha_registro || "").slice(0, 10) === today).length,
      workers: new Set(mine.map((record) => String(record.trabajador_id))).size,
      quantity: mine.reduce((sum, record) => sum + Number(record.cantidad || 0), 0)
    };
  }, [records, user.id]);
  const filteredRecords = useMemo(() => {
    const term = normalizeText(filters.search);
    const filtered = records.filter((record) => {
      if (!isAdministrator && filters.scope === "mine" && String(record.encargado_id) !== String(user.id)) return false;
      if (isAdministrator && filters.managerId && String(record.encargado_id) !== String(filters.managerId)) return false;
      if (isAdministrator) {
        const [recordYear, recordMonth, recordDay] = String(record.fecha_registro || "").slice(0, 10).split("-");
        if (selectedYear && recordYear !== selectedYear) return false;
        if (selectedMonth && recordMonth !== selectedMonth) return false;
        if (filters.day && recordDay !== String(filters.day).padStart(2, "0")) return false;
      }
      if (filters.workerId && String(record.trabajador_id) !== String(filters.workerId)) return false;
      if (filters.taskId && String(record.tarea_id) !== String(filters.taskId)) return false;
      if (filters.categoria && taskCategoryById.get(String(record.tarea_id)) !== filters.categoria) return false;
      if (!term) return true;
      return normalizeText(
        [
          record.id,
          record.encargado_nombre,
          record.encargado_email,
          record.trabajador_nombre,
          record.trabajador_email,
          record.tarea_nombre,
          record.lote,
          record.marca_nombre,
          record.tienda_nombre,
          record.detalle
        ].join(" ")
      ).includes(term);
    });
    return filtered.sort((a, b) => {
      const diff = recordSortTime(a) - recordSortTime(b);
      return filters.order === "asc" ? diff : -diff;
    });
  }, [filters, records, taskCategoryById, user.id, isAdministrator, selectedYear, selectedMonth]);
  const combinedRows = useMemo(() => {
    const merged = filteredRecords.map((record) => ({
      kind: "record",
      key: `record-${record.id}`,
      sortTime: recordSortTime(record),
      record
    }));
    merged.sort((a, b) => filters.order === "asc" ? a.sortTime - b.sortTime : b.sortTime - a.sortTime);
    return merged;
  }, [filteredRecords, filters.order]);
  function updateForm(changes) {
    setForm((current) => ({ ...current, ...changes }));
  }
  function updateFilters(changes) {
    setFilters((current) => ({ ...current, ...changes }));
  }
  function resetForm() {
    setForm(createInitialForm());
  }
  function buildPayload(draft, revision) {
    const editing = revision !== void 0 && revision !== null;
    const worker = workers.find((item) => String(item.id) === String(draft.trabajador_id));
    const task = (editing ? recordTasks : tasks).find((item) => String(item.id) === String(draft.tarea_id));
    if (!editing && !worker) return { error: "Selecciona un operante o líder de equipo activo." };
    if (!task || !isGroupLeaderTimeTask(task)) return { error: "Selecciona una tarea por tiempo valida." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.fecha_registro || "") || draft.fecha_registro > todayLimaISO()) {
      return { error: "Selecciona una fecha de inicio valida que no este en el futuro." };
    }
    if (!isValidTime(draft.hora_inicio)) {
      return { error: "Completa una hora de inicio valida." };
    }
    const start = limaDateTimeToISO(draft.fecha_registro, draft.hora_inicio);
    if (!start) return { error: "Completa una hora de inicio valida." };
    if (new Date(start).getTime() > Date.now() + 6e4) {
      return { error: "La hora de inicio no puede estar en el futuro." };
    }
    const fields = getTaskFieldFlags(task);
    const required = getTaskRequiredFlags(task);
    if (fields.marca && required.marca && !draft.marca_id) return { error: `Selecciona una marca para ${getTaskTitle(task)}.` };
    if (fields.tienda && required.tienda && !draft.tienda_id) return { error: `Selecciona una tienda para ${getTaskTitle(task)}.` };
    if (fields.lote && required.lote && !String(draft.lote || "").trim()) return { error: `Ingresa un lote para ${getTaskTitle(task)}.` };
    if (fields.hangtag && required.hangtag && !draft.tipo_etiquetado) {
      return { error: `Indica si ${getTaskTitle(task)} va con hangtag o sin hangtag.` };
    }
    const base = {
      trabajador_id: Number(draft.trabajador_id),
      tarea_id: Number(draft.tarea_id),
      fecha_registro: draft.fecha_registro,
      hora_inicio: start,
      marca_id: fields.marca ? Number(draft.marca_id) : null,
      lote: fields.lote ? String(draft.lote || "").trim().toUpperCase() || null : null,
      tipo_etiquetado: fields.hangtag ? draft.tipo_etiquetado || null : null,
      tienda_id: fields.tienda ? Number(draft.tienda_id) : null,
      detalle: String(draft.detalle || "").trim() || null,
      ...revision === void 0 || revision === null ? {} : { revision }
    };
    // Mientras no haya cierre, el registro queda pendiente: la cantidad y la
    // hora fin se completan despues desde el historial.
    const quantityText = String(draft.cantidad ?? "").trim();
    if (!draft.hora_fin && !quantityText) {
      return { payload: { ...base, hora_fin: null, cantidad: null } };
    }
    const quantity = Number(quantityText);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { error: "La cantidad debe ser un numero entero mayor a cero." };
    }
    const finishDate = draft.fecha_fin || draft.fecha_registro;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(finishDate) || finishDate < draft.fecha_registro || finishDate > todayLimaISO()) {
      return { error: "La fecha fin debe ser igual o posterior al inicio y no puede estar en el futuro." };
    }
    if (!isValidTime(draft.hora_fin)) {
      return { error: "Completa una hora fin valida para cerrar el registro." };
    }
    const finish = limaDateTimeToISO(finishDate, draft.hora_fin);
    if (!finish || new Date(finish) <= new Date(start)) {
      return { error: "La hora fin debe ser posterior a la hora de inicio." };
    }
    if (new Date(finish).getTime() > Date.now() + 6e4) {
      return { error: "La hora fin no puede estar en el futuro." };
    }
    return { payload: { ...base, fecha_fin: finishDate, hora_fin: finish, cantidad: quantity } };
  }
  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);
    if (data.historyMigrationRequired) {
      setStatus({ type: "error", message: "Falta aplicar la migracion SQL 027 antes de guardar registros con horas." });
      return;
    }
    const { payload, error: validationError } = buildPayload(form);
    if (validationError) {
      setStatus({ type: "error", message: validationError });
      return;
    }
    setSaving(true);
    let recordCreated = false;
    try {
      await createGroupLeaderRecord(payload);
      recordCreated = true;
      setStatus({ type: "success", message: "Inicio guardado en el historial. Completa la cantidad y el cierre editando esa fila." });
      resetForm();
      await reload();
    } catch (err) {
      if (recordCreated) {
        setStatus({ type: "success", message: "Registro guardado. No se pudo actualizar el historial; presiona Actualizar para verlo." });
        return;
      }
      const message = String(err?.message || "");
      let saveMessage = friendlyError(err);
      if (err?.code === "SAVE_TIMEOUT") {
        saveMessage = "No se confirmó el registro: la conexión tardó demasiado. Actualiza el historial antes de reintentar.";
      } else if ([401, 403].includes(Number(err?.status))) {
        saveMessage = "No se registró: tu sesión venció o no tiene permiso. Vuelve a iniciar sesión.";
      } else if (Number(err?.status) === 409) {
        saveMessage = "No se registró: existe un conflicto con los datos. Actualiza el historial e inténtalo otra vez.";
      } else if (Number(err?.status) >= 500) {
        saveMessage = "No se registró: el servidor o la base de datos tuvieron un problema. Inténtalo nuevamente.";
      } else if (/conectar|network|fetch|internet/i.test(message)) {
        saveMessage = "No se registró: no hay conexión con el servidor. Revisa Internet e inténtalo otra vez.";
      }
      setStatus({ type: "error", message: saveMessage });
    } finally {
      setSaving(false);
    }
  }
  function startEditing(record) {
    if (data.historyMigrationRequired || record.revision === null || record.revision === void 0) return;
    setStatus(null);
    setEditingId(record.id);
    setEditDraft(recordToEditableDraft(record));
  }
  function cancelEditing() {
    setEditingId(null);
    setEditDraft(null);
  }
  async function removeRecord(record) {
    setStatus(null);
    setRowSaving(true);
    try {
      await deleteGroupLeaderRecord(record.id, record.revision ?? null);
      if (String(editingId) === String(record.id)) cancelEditing();
      setStatus({ type: "success", message: `Registro #${record.id} eliminado del historial.` });
      await reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
      if (/otra sesion|409|ya no existe/i.test(String(err?.message || ""))) await reload();
    } finally {
      setRowSaving(false);
    }
  }
  async function saveEditedRecord(record) {
    setStatus(null);
    const { payload, error: validationError } = buildPayload(editDraft, record.revision);
    if (validationError) {
      setStatus({ type: "error", message: validationError });
      return;
    }
    setRowSaving(true);
    try {
      await updateGroupLeaderRecord(record.id, payload);
      cancelEditing();
      setStatus({ type: "success", message: `Registro #${record.id} actualizado; el tiempo fue recalculado.` });
      await reload();
    } catch (err) {
      const message = friendlyError(err);
      setStatus({
        type: "error",
        message: Number(err?.status) === 409 || /horario|simultane|solap|intervalo/i.test(message)
          ? `Aviso de choque de horarios: ${message}`
          : message
      });
      if (/actualiz|version|otro cambio|409/i.test(String(err?.message || ""))) await reload();
    } finally {
      setRowSaving(false);
    }
  }
  return /* @__PURE__ */ React.createElement("div", { className: "group-dashboard stack" }, /* @__PURE__ */ React.createElement("section", { className: "group-hero" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("p", { className: "eyebrow" }, user.rol || "Líder de equipo"), /* @__PURE__ */ React.createElement("h2", null, "Control de tareas por tiempo"), /* @__PURE__ */ React.createElement("span", null, user.nombre || user.email)), /* @__PURE__ */ React.createElement("div", { className: "group-metrics", "aria-label": "Resumen de registros" }, /* @__PURE__ */ React.createElement(MetricTile, { icon: ClipboardCheck, label: "Mis registros", value: metrics.total }), /* @__PURE__ */ React.createElement(MetricTile, { icon: Timer, label: "Registros hoy", value: metrics.today }), /* @__PURE__ */ React.createElement(MetricTile, { icon: UserRound, label: "Personas medidas", value: metrics.workers }), /* @__PURE__ */ React.createElement(MetricTile, { icon: Hash, label: "Cantidad total", value: formatNumber(metrics.quantity) }))), status ? /* @__PURE__ */ React.createElement(Alert, { type: status.type }, status.message) : null, /* @__PURE__ */ React.createElement(
    Panel,
    {
      title: "Iniciar registro de tarea",
      eyebrow: "Alta directa al historial",
      className: "group-form-panel",
      actions: /* @__PURE__ */ React.createElement(Button, { variant: "secondary", icon: RefreshCcw, onClick: reload }, "Actualizar")
    },
    loading ? /* @__PURE__ */ React.createElement(LoadingBlock, null) : null,
    error ? /* @__PURE__ */ React.createElement(Alert, { type: "error" }, error) : null,
    data.historyMigrationRequired ? /* @__PURE__ */ React.createElement(Alert, { type: "error" }, "Falta aplicar la migracion SQL 027 en Supabase para guardar y editar hora inicio, hora fin y revision.") : null,
    /* @__PURE__ */ React.createElement(Alert, null, "Registra el inicio de la tarea. La cantidad y la fecha y hora de fin se completan despues en el historial; ahi el servidor recalcula la duracion."),
    !loading && !workers.length ? /* @__PURE__ */ React.createElement(Alert, null, "No hay operantes ni líderes de equipo activos.") : null,
    !loading && !tasks.length ? /* @__PURE__ */ React.createElement(Alert, null, "No hay tareas registradas en la base de datos.") : null,
    /* @__PURE__ */ React.createElement("form", { className: "group-form form-grid", onSubmit: handleSubmit }, /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Operante o líder de equipo",
        value: form.trabajador_id,
        onChange: (trabajador_id) => updateForm({ trabajador_id }),
        options: [
          { value: "", label: "Selecciona una persona" },
          ...workers.map((worker) => ({
            value: String(worker.id),
            label: `${worker.nombre || worker.email || "Trabajador sin nombre"} (${worker.rol || "sin rol"})`
          }))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Tarea",
        value: form.tarea_id,
        onChange: (tarea_id) => updateForm(resetTaskMetadata({ tarea_id })),
        options: [
          { value: "", label: "Selecciona tarea" },
          ...tasks.map((task) => ({
            value: String(task.id),
            label: getTaskTitle(task) || "Sin nombre"
          }))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      TextInput,
      {
        label: "Fecha de inicio",
        type: "date",
        value: form.fecha_registro,
        onChange: (fecha_registro) => updateForm({ fecha_registro }),
        max: todayLimaISO()
      }
    ), /* @__PURE__ */ React.createElement(
      Field,
      {
        label: "Hora de inicio",
        hint: "La cantidad y el cierre se completan despues en el historial."
      },
      /* @__PURE__ */ React.createElement("span", { className: "time-with-meridiem" }, /* @__PURE__ */ React.createElement(
        "input",
        {
          className: "input",
          type: "time",
          "aria-label": "Hora de inicio",
          value: form.hora_inicio,
          onChange: (event) => updateForm({ hora_inicio: event.target.value })
        }
      ), /* @__PURE__ */ React.createElement("span", { className: "time-meridiem-badge" }, timeTo12h(form.hora_inicio) || "--:-- --"))
    ), selectedTask ? /* @__PURE__ */ React.createElement(
      DynamicGroupFields,
      {
        mode: taskMode,
        task: selectedTask,
        form,
        updateForm,
        brands,
        stores,
        lotes
      }
    ) : null, /* @__PURE__ */ React.createElement(
      TextArea,
      {
        label: "Detalle",
        value: form.detalle,
        onChange: (detalle) => updateForm({ detalle }),
        placeholder: taskMode.completedOnly ? "Realizado" : "Comentario opcional"
      }
    ), /* @__PURE__ */ React.createElement("div", { className: "form-span form-note group-registrar" }, /* @__PURE__ */ React.createElement(BadgeCheck, null), /* @__PURE__ */ React.createElement("span", null, "Registrado por: ", /* @__PURE__ */ React.createElement("strong", null, user.nombre || user.email))), /* @__PURE__ */ React.createElement("div", { className: "form-span form-actions" }, /* @__PURE__ */ React.createElement(Button, { type: "submit", icon: Save, loading: saving, disabled: data.historyMigrationRequired }, "Guardar inicio en historial")))
  ), /* @__PURE__ */ React.createElement(
    Panel,
    {
      title: "Historial editable",
      eyebrow: "Listado principal de la base de datos",
      actions: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
        Button,
        {
          variant: "secondary",
          icon: FileSpreadsheet,
          disabled: !combinedRows.length,
          onClick: () => exportGroupHistoryToCsv(combinedRows)
        },
        "Exportar a Excel"
      ), /* @__PURE__ */ React.createElement(Button, { variant: "secondary", icon: RefreshCcw, onClick: reload }, "Actualizar"))
    },
    /* @__PURE__ */ React.createElement(Alert, null, normalizeRole(user.rol) === "administrador" ? "Como administrador puedes editar o eliminar cualquier registro. Al guardar, el tiempo se recalcula." : "Las filas marcadas como Sin cerrar esperan su cantidad y su fecha y hora de fin: usa Completar para cargarlas. Al guardar, el tiempo se recalcula. Los registros de otros jefes son de solo lectura."),
    /* @__PURE__ */ React.createElement("div", { className: "history-toolbar" }, !isAdministrator ? /* @__PURE__ */ React.createElement("div", { className: "scope-switch", "aria-label": "Alcance de registros" }, /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        className: filters.scope === "all" ? "active" : "",
        onClick: () => updateFilters({ scope: "all" })
      },
      "Todos"
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        className: filters.scope === "mine" ? "active" : "",
        onClick: () => updateFilters({ scope: "mine" })
      },
      "Mios"
    )) : null, isAdministrator ? /* @__PURE__ */ React.createElement(SelectInput, {
      label: "Encargado",
      value: filters.managerId || "",
      onChange: (managerId) => updateFilters({ managerId }),
      options: [{ value: "", label: "Todos los encargados" }, ...managerOptions]
    }) : null, isAdministrator ? /* @__PURE__ */ React.createElement(SelectInput, {
      label: "Año",
      value: selectedYear,
      onChange: (year) => updateFilters({ year, month: "", day: "" }),
      options: recordYears.map((year) => ({ value: year, label: year }))
    }) : null, isAdministrator ? /* @__PURE__ */ React.createElement(SelectInput, {
      label: "Mes",
      value: selectedMonth,
      onChange: (month) => updateFilters({ month, day: "" }),
      options: [
        { value: "", label: "Todos los meses" },
        ...["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"].map((label, index) => ({ value: String(index + 1).padStart(2, "0"), label }))
      ]
    }) : null, isAdministrator ? /* @__PURE__ */ React.createElement(SelectInput, {
      label: "Día",
      value: filters.day || "",
      onChange: (day) => updateFilters({ day }),
      disabled: !selectedMonth,
      options: [{ value: "", label: "Todos los días" }, ...Array.from({ length: daysInSelectedMonth }, (_, index) => ({ value: String(index + 1).padStart(2, "0"), label: String(index + 1) }))]
    }) : null, isAdministrator ? /* @__PURE__ */ React.createElement(CheckboxInput, {
      label: "Incluir inactivos",
      checked: includeInactive,
      onChange: (checked) => updateFilters({ includeInactive: checked, ...checked ? {} : { managerId: "", workerId: "" } })
    }) : null, /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Operante o líder",
        value: filters.workerId,
        onChange: (workerId) => updateFilters({ workerId }),
        options: [
          { value: "", label: "Todos" },
          ...(isAdministrator ? historyWorkerOptions : workers.map((worker) => ({
            value: String(worker.id),
            label: worker.nombre || worker.email || "Trabajador sin nombre"
          })))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Tarea",
        value: filters.taskId,
        onChange: (taskId) => updateFilters({ taskId }),
        options: [
          { value: "", label: "Todas" },
          ...recordTasks.map((task) => ({
            value: String(task.id),
            label: getTaskTitle(task) || "Tarea sin nombre"
          }))
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Categoria",
        value: filters.categoria,
        onChange: (categoria) => updateFilters({ categoria }),
        options: [
          { value: "", label: "Todas" },
          { value: "Ingreso", label: "Ingreso" },
          { value: "Despacho", label: "Despacho" }
        ]
      }
    ), /* @__PURE__ */ React.createElement(
      SelectInput,
      {
        label: "Ordenar por fecha",
        value: filters.order,
        onChange: (order) => updateFilters({ order }),
        options: [
          { value: "desc", label: "M\xE1s reciente primero" },
          { value: "asc", label: "M\xE1s antigua primero" }
        ]
      }
    ), /* @__PURE__ */ React.createElement("label", { className: "field search-field" }, /* @__PURE__ */ React.createElement("span", { className: "field-label" }, "Buscar"), /* @__PURE__ */ React.createElement("span", { className: "search-input" }, /* @__PURE__ */ React.createElement(Search, null), /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "input",
        value: filters.search,
        onChange: (event) => updateFilters({ search: event.target.value }),
        placeholder: "Nombre, tarea, lote, marca"
      }
    )))),
    /* @__PURE__ */ React.createElement(
      EditableGroupHistory,
      {
        rows: combinedRows,
        tasks: recordTasks,
        brands,
        stores,
        lotes,
        averageReferenceByTask,
        currentUserId: user.id,
        canEditAll: normalizeRole(user.rol) === "administrador",
        editingDisabled: data.historyMigrationRequired,
        editingId,
        draft: editDraft,
        saving: rowSaving,
        onEdit: startEditing,
        onDelete: removeRecord,
        onDraft: setEditDraft,
        onSave: saveEditedRecord,
        onCancel: cancelEditing,
        onReload: reload,
        onStatus: setStatus
      }
    )
  ));
}
// Orden de columnas fijo, compartido por el encabezado y las tres formas de
// fila (normal, en edicion, pendiente): Acciones va primero para no tener que
// desplazar la tabla, Encargado va al final porque es el dato menos usado al
// revisar el propio trabajo.
function EditableGroupHistory({
  rows,
  tasks,
  brands,
  stores,
  lotes,
  averageReferenceByTask,
  currentUserId,
  canEditAll = false,
  editingDisabled,
  editingId,
  draft,
  saving,
  onEdit,
  onDelete,
  onDraft,
  onSave,
  onCancel,
  onReload,
  onStatus
}) {
  const { page, totalPages, setPage, start, end } = usePagination(rows.length, DEFAULT_PAGE_SIZE);
  if (!rows.length) return <div className="empty-state">Sin registros para los filtros actuales.</div>;
  const visibleRows = rows.slice(start, end);
  return (
    <>
      <div className="editable-history-wrap" role="region" aria-label="Historial editable de tareas" tabIndex="0">
        <table className="editable-history-table">
          <thead>
            <tr>
              <th className="history-actions-heading">Acciones</th>
              <th>Fecha</th>
              <th>Persona medida</th>
              <th>Tarea</th>
              <th>Hora inicio</th>
              <th>Hora fin</th>
              <th>Cantidad</th>
              <th>Tiempo</th>
              <th>Vs. promedio</th>
              <th>Hangtag</th>
              <th>Codigo de lote</th>
              <th>Marca</th>
              <th>Tienda</th>
              <th>Detalle</th>
              <th>Modificado</th>
              <th>Encargado</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              if (row.kind === "pending") {
                return (
                  <PendingActivityRow
                    key={row.key}
                    activity={row.activity}
                    tasks={tasks}
                    brands={brands}
                    lotes={lotes}
                    currentUserId={currentUserId}
                    onReload={onReload}
                    onStatus={onStatus}
                  />
                );
              }
              const record = row.record;
              const mine = String(record.encargado_id) === String(currentUserId);
              const editable = (mine || canEditAll) && !editingDisabled && record.revision !== null && record.revision !== undefined;
              if (String(editingId) === String(record.id) && draft) {
                return (
                  <EditableHistoryRow
                    key={row.key}
                    record={record}
                    draft={draft}
                    tasks={tasks}
                    brands={brands}
                    stores={stores}
                    lotes={lotes}
                    saving={saving}
                    onDraft={onDraft}
                    onSave={() => onSave(record)}
                    onCancel={onCancel}
                  />
                );
              }
              return (
                <HistoryRow
                  key={row.key}
                  record={record}
                  editable={editable}
                  busy={saving}
                  average={compareToReferenceAverage(record, averageReferenceByTask)}
                  readonlyReason={(mine || canEditAll) && record.revision == null ? "Registro anterior" : editingDisabled && (mine || canEditAll) ? "Migracion pendiente" : "Solo lectura"}
                  onEdit={() => onEdit(record)}
                  onDelete={() => onDelete(record)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <TablePager page={page} totalPages={totalPages} totalRows={rows.length} onChange={setPage} />
    </>
  );
}
function HistoryRow({ record, editable, busy, average, readonlyReason, onEdit, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const pending = isPendingRecord(record);
  const rate = recordHourlyRate(record);
  const pendingMark = <span className="muted">Pendiente</span>;
  return (
    <tr className={pending ? "history-pending-record" : undefined}>
      <td className="history-actions-cell">
        {!editable ? (
          <span className="history-readonly-badge">{readonlyReason}</span>
        ) : confirming ? (
          <div className="history-row-actions">
            <button
              type="button"
              className="history-delete-button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              {busy ? "Eliminando..." : "Confirmar"}
            </button>
            <button type="button" className="history-cancel-button" disabled={busy} onClick={() => setConfirming(false)}>
              No
            </button>
          </div>
        ) : (
          <div className="history-row-actions">
            <button type="button" className="history-edit-button" onClick={onEdit}>
              {pending ? "Completar" : "Editar"}
            </button>
            <button
              type="button"
              className="history-delete-button"
              title={`Eliminar el registro #${record.id}`}
              onClick={() => setConfirming(true)}
            >
              Eliminar
            </button>
          </div>
        )}
      </td>
      <td>
        {formatRecordDate(record)}
        {pending ? <span className="history-pending-badge">Sin cerrar</span> : null}
      </td>
      <td>{record.trabajador_nombre || record.trabajador_email || "-"}</td>
      <td>{record.tarea_nombre || "-"}</td>
      <td className="history-time-cell">{formatTimeLima(record.hora_inicio)}</td>
      <td className="history-time-cell">{pending ? pendingMark : formatTimeLima(record.hora_fin)}</td>
      <td className="history-number-cell">{pending ? pendingMark : formatNumber(record.cantidad) || "-"}</td>
      <td>{pending ? pendingMark : formatDuration(record.tiempo_minutos) || "-"}</td>
      <td>
        <div className="history-avg-cell">
          {rate !== null ? <span className="history-rate-value">{formatRate(rate)}/h</span> : <span className="muted">-</span>}
          {average ? <span className={`history-avg-badge history-avg-${average.tone}`}>{average.label}</span> : null}
        </div>
      </td>
      <td>{hangtagLabel(record.tipo_etiquetado)}</td>
      <td>{record.lote || "-"}</td>
      <td>{record.marca_nombre || "-"}</td>
      <td>{record.tienda_nombre || "-"}</td>
      <td className="history-detail-cell" title={record.detalle || ""}>{record.detalle || "-"}</td>
      <td className="history-updated-cell">{formatUpdatedAt(record)}</td>
      <td>{record.encargado_nombre || record.encargado_email || "-"}</td>
    </tr>
  );
}
function availableLotesForTask(lotes, task, brandId) {
  const labelingTask = normalizeText(getTaskTitle(task)) === "etiquetado";
  return (lotes || []).filter((lote) => (
    (labelingTask ? lote.estado === "en_curso" : ["pendiente", "en_curso"].includes(lote.estado))
    && (!brandId || Number(lote.marca_id) === Number(brandId))
  ));
}

function EditableHistoryRow({ record, draft, tasks, brands, stores, lotes, saving, onDraft, onSave, onCancel }) {
  const selectedTask = tasks.find((task) => String(task.id) === String(draft.tarea_id));
  const fields = getTaskFieldFlags(selectedTask);
  const updateDraft = (changes) => onDraft((current) => ({ ...current, ...changes }));
  const availableLotes = availableLotesForTask(lotes, selectedTask, draft.marca_id);
  // El lote ya guardado se mantiene visible aunque ya no este disponible
  // (por ejemplo, si se marco agotado despues), para no perder el dato.
  const loteOptions = draft.lote && !availableLotes.some((lote) => lote.codigo_lote === draft.lote)
    ? [{ id: draft.lote, codigo_lote: draft.lote, marca_nombre: "no disponible" }, ...availableLotes]
    : availableLotes;
  const start = limaDateTimeToISO(draft.fecha_registro, draft.hora_inicio);
  const finish = limaDateTimeToISO(draft.fecha_fin || draft.fecha_registro, draft.hora_fin);
  return (
    <tr className="history-editing-row">
      <td className="history-actions-cell">
        <div className="history-row-actions">
          <button type="button" className="history-save-button" disabled={saving} onClick={onSave}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
          <button type="button" className="history-cancel-button" disabled={saving} onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </td>
      <td>
        <input
          className="history-cell-input history-date-input"
          type="date"
          aria-label={`Fecha del registro ${record.id}`}
          max={todayLimaISO()}
          value={draft.fecha_registro}
          onChange={(event) => updateDraft({ fecha_registro: event.target.value })}
        />
      </td>
      <td>{record.trabajador_nombre || record.trabajador_email || "-"}</td>
      <td>{record.tarea_nombre || getTaskTitle(selectedTask) || "-"}</td>
      <td>
        <input
          className="history-cell-input history-time-input"
          type="time"
          aria-label={`Hora inicio del registro ${record.id}`}
          value={draft.hora_inicio}
          onChange={(event) => updateDraft({ hora_inicio: event.target.value })}
        />
      </td>
      <td>
        <input
          className="history-cell-input history-time-input"
          type="time"
          aria-label={`Hora fin del registro ${record.id}`}
          value={draft.hora_fin}
          onChange={(event) => updateDraft({ hora_fin: event.target.value })}
        />
      </td>
      <td>
        <input
          className="history-cell-input history-quantity-input"
          type="number"
          min="1"
          step="1"
          aria-label={`Cantidad del registro ${record.id}`}
          value={draft.cantidad}
          onChange={(event) => updateDraft({ cantidad: event.target.value })}
        />
      </td>
      <td className="history-preview-cell">{start && finish ? formatDurationFromDates(start, finish) : "Pendiente"}</td>
      <td><span className="muted">Se recalcula</span></td>
      <td>
        {fields.hangtag ? (
          <select
            className="history-cell-input history-select-input"
            aria-label={`Hangtag del registro ${record.id}`}
            value={draft.tipo_etiquetado || ""}
            onChange={(event) => updateDraft({ tipo_etiquetado: event.target.value })}
          >
            {HANGTAG_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : <span className="muted">No aplica</span>}
      </td>
      <td>
        {fields.lote ? (
          <select
            className="history-cell-input history-select-input"
            aria-label={`Codigo de lote del registro ${record.id}`}
            value={draft.lote || ""}
            onChange={(event) => updateDraft({ lote: event.target.value })}
          >
            <option value="">{loteOptions.length ? "Selecciona" : "Sin lotes"}</option>
            {loteOptions.map((lote) => (
              <option key={lote.id} value={lote.codigo_lote}>{lote.codigo_lote} - {lote.marca_nombre}</option>
            ))}
          </select>
        ) : <span className="muted">No aplica</span>}
      </td>
      <td>
        {fields.marca ? (
          <select
            className="history-cell-input history-select-input"
            aria-label={`Marca del registro ${record.id}`}
            value={draft.marca_id}
            onChange={(event) => updateDraft({ marca_id: event.target.value })}
          >
            <option value="">Selecciona</option>
            {brands.map((brand) => <option key={brand.id} value={String(brand.id)}>{brand.nombre}</option>)}
          </select>
        ) : <span className="muted">No aplica</span>}
      </td>
      <td>
        {fields.tienda ? (
          <select
            className="history-cell-input history-select-input"
            aria-label={`Tienda del registro ${record.id}`}
            value={draft.tienda_id}
            onChange={(event) => updateDraft({ tienda_id: event.target.value })}
          >
            <option value="">Selecciona</option>
            {stores.map((store) => <option key={store.id} value={String(store.id)}>{store.nombre}</option>)}
          </select>
        ) : <span className="muted">No aplica</span>}
      </td>
      <td>
        <input
          className="history-cell-input history-detail-input"
          aria-label={`Detalle del registro ${record.id}`}
          value={draft.detalle}
          onChange={(event) => updateDraft({ detalle: event.target.value })}
          placeholder="Opcional"
        />
      </td>
      <td className="history-updated-cell">{formatUpdatedAt(record)}</td>
      <td>{record.encargado_nombre || record.encargado_email || "Tu registro"}</td>
    </tr>
  );
}
function PendingActivityRow({ activity, tasks, brands, lotes, currentUserId, onReload, onStatus }) {
  const mine = String(activity.encargado_id) === String(currentUserId);
  const task = tasks.find((item) => String(item.id) === String(activity.tarea_id)) || { nombre: activity.tarea_nombre };
  const fields = getTaskFieldFlags(task);
  const required = getTaskRequiredFlags(task);
  const usesBrand = fields.marca;
  const usesLote = fields.lote;
  const minFinishDate = recordDateInput(activity);
  const [draft, setDraft] = useState(() => ({
    cantidad: String(Math.max(1, Number(activity.cantidad || 0))),
    fecha_fin: todayLimaISO(),
    hora_fin: "",
    marca_id: activity.marca_id ? String(activity.marca_id) : "",
    lote: activity.lote || ""
  }));
  const [busy, setBusy] = useState(false);
  const updateDraft = (changes) => setDraft((current) => ({ ...current, ...changes }));
  const availableLotes = availableLotesForTask(lotes, task, draft.marca_id);
  const loteOptions = draft.lote && !availableLotes.some((lote) => lote.codigo_lote === draft.lote)
    ? [{ id: draft.lote, codigo_lote: draft.lote, marca_nombre: "no disponible" }, ...availableLotes]
    : availableLotes;
  const finishIso = limaDateTimeToISO(draft.fecha_fin, draft.hora_fin);
  const finishValid = Boolean(finishIso) && new Date(finishIso) > new Date(activity.hora_inicio);
  const durationPreview = finishValid ? formatDurationFromDates(activity.hora_inicio, finishIso) : "Pendiente";

  async function finish() {
    const quantity = Number(draft.cantidad);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity < Number(activity.cantidad || 0)) {
      onStatus({ type: "error", message: `Revisa la cantidad pendiente de la actividad #${activity.id}.` });
      return;
    }
    if (!finishValid || new Date(finishIso).getTime() > Date.now() + 60000) {
      onStatus({ type: "error", message: `La hora fin de la actividad #${activity.id} debe ser posterior al inicio y no puede estar en el futuro.` });
      return;
    }
    if (usesBrand && required.marca && !draft.marca_id) {
      onStatus({ type: "error", message: `Selecciona la marca para finalizar la actividad #${activity.id}.` });
      return;
    }
    if (usesLote && required.lote && !String(draft.lote || "").trim()) {
      onStatus({ type: "error", message: `Ingresa el lote para finalizar la actividad #${activity.id}.` });
      return;
    }
    setBusy(true);
    try {
      await updateGroupLeaderActivity(activity.id, {
        cantidad: quantity,
        ...(usesBrand ? { marca_id: Number(draft.marca_id) } : {}),
        ...(usesLote ? { lote: String(draft.lote || "").trim().toUpperCase() || null } : {}),
        finalizar: true,
        hora_fin: finishIso
      });
      onStatus({ type: "success", message: `Actividad #${activity.id} finalizada y enviada al historial.` });
      await onReload();
    } catch (error) {
      onStatus({ type: "error", message: friendlyError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(`¿Cancelar la actividad en curso #${activity.id} de ${activity.trabajador_nombre}? Esta accion elimina sus avances y no se puede deshacer.`)) return;
    setBusy(true);
    try {
      await cancelGroupLeaderActivity(activity.id);
      onStatus({ type: "success", message: `Actividad #${activity.id} cancelada.` });
      await onReload();
    } catch (error) {
      onStatus({ type: "error", message: friendlyError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="history-pending-row">
      <td className="history-actions-cell">
        {mine ? (
          <div className="history-row-actions">
            <button type="button" className="history-save-button" disabled={busy} onClick={finish}>{busy ? "Guardando..." : "Finalizar"}</button>
            <button type="button" className="history-cancel-button" disabled={busy} onClick={cancel}>Cancelar</button>
          </div>
        ) : <span className="history-readonly-badge">En curso · otro jefe</span>}
      </td>
      <td>
        {formatRecordDate(activity)}
        <span className="history-pending-badge">En curso</span>
      </td>
      <td>{activity.trabajador_nombre || activity.trabajador_email || "-"}</td>
      <td>{activity.tarea_nombre || "-"}</td>
      <td className="history-time-cell">{formatTimeLima(activity.hora_inicio)}</td>
      <td>
        {mine ? (
          <div className="history-pending-finish-inputs">
            <input
              className="history-cell-input history-date-input"
              type="date"
              min={minFinishDate}
              max={todayLimaISO()}
              value={draft.fecha_fin}
              disabled={busy}
              aria-label={`Fecha fin actividad ${activity.id}`}
              onChange={(event) => updateDraft({ fecha_fin: event.target.value })}
            />
            <input
              className="history-cell-input history-time-input"
              type="time"
              value={draft.hora_fin}
              disabled={busy}
              aria-label={`Hora fin actividad ${activity.id}`}
              onChange={(event) => updateDraft({ hora_fin: event.target.value })}
            />
          </div>
        ) : <span className="muted">En curso</span>}
      </td>
      <td className="history-number-cell">
        {mine ? (
          <input
            className="history-cell-input history-quantity-input"
            type="number"
            min={Math.max(1, Number(activity.cantidad || 0))}
            step="1"
            value={draft.cantidad}
            disabled={busy}
            aria-label={`Cantidad final actividad ${activity.id}`}
            onChange={(event) => updateDraft({ cantidad: event.target.value })}
          />
        ) : formatNumber(activity.cantidad)}
      </td>
      <td>{durationPreview}</td>
      <td><span className="muted">-</span></td>
      <td>{hangtagLabel(activity.tipo_etiquetado)}</td>
      <td>
        {usesLote ? (
          mine ? (
            <select
              className="history-cell-input history-select-input"
              value={draft.lote || ""}
              disabled={busy}
              aria-label={`Lote actividad ${activity.id}`}
              onChange={(event) => updateDraft({ lote: event.target.value })}
            >
              <option value="">{loteOptions.length ? "Selecciona" : "Sin lotes"}</option>
              {loteOptions.map((lote) => (
                <option key={lote.id} value={lote.codigo_lote}>{lote.codigo_lote} - {lote.marca_nombre}</option>
              ))}
            </select>
          ) : (activity.lote || "-")
        ) : <span className="muted">No aplica</span>}
      </td>
      <td>
        {usesBrand ? (
          mine ? (
            <select
              className="history-cell-input history-select-input"
              value={draft.marca_id}
              disabled={busy}
              aria-label={`Marca actividad ${activity.id}`}
              onChange={(event) => updateDraft({ marca_id: event.target.value })}
            >
              <option value="">Selecciona</option>
              {brands.map((brand) => <option key={brand.id} value={String(brand.id)}>{brand.nombre}</option>)}
            </select>
          ) : (activity.marca_nombre || "-")
        ) : <span className="muted">No aplica</span>}
      </td>
      <td>{activity.tienda_nombre || <span className="muted">No aplica</span>}</td>
      <td className="history-detail-cell" title={activity.detalle || activity.observacion || ""}>{activity.detalle || activity.observacion || "-"}</td>
      <td className="history-score-cell">Pendiente</td>
      <td className="history-updated-cell">{formatUpdatedAt(activity)}</td>
      <td>{activity.encargado_nombre || activity.encargado_email || "-"}</td>
    </tr>
  );
}
function DynamicGroupFields({ mode, task, form, updateForm, brands, stores, lotes }) {
  if (mode.completedOnly) {
    return /* @__PURE__ */ React.createElement("div", { className: "form-span" }, /* @__PURE__ */ React.createElement(Alert, null, "Esta tarea se guarda como realizado."));
  }
  const availableLotes = availableLotesForTask(lotes, task, form.marca_id);
  return /* @__PURE__ */ React.createElement(React.Fragment, null, mode.requiresBrand ? /* @__PURE__ */ React.createElement(
    SelectInput,
    {
      label: "Marca",
      value: form.marca_id,
      onChange: (marca_id) => updateForm({ marca_id }),
      options: [
        { value: "", label: "Selecciona marca" },
        ...(brands || []).map((brand) => ({ value: String(brand.id), label: brand.nombre }))
      ],
      hint: "Obligatoria para guardar esta tarea."
    }
  ) : null, mode.requiresHangtag ? /* @__PURE__ */ React.createElement(
    SelectInput,
    {
      label: "Hangtag",
      value: form.tipo_etiquetado,
      onChange: (tipo_etiquetado) => updateForm({ tipo_etiquetado }),
      options: HANGTAG_OPTIONS,
      hint: "Obligatorio para guardar esta tarea."
    }
  ) : null, mode.requiresLote ? /* @__PURE__ */ React.createElement(
    SelectInput,
    {
      label: "Codigo de lote",
      value: form.lote,
      onChange: (lote) => updateForm({ lote }),
      options: [
        { value: "", label: availableLotes.length ? "Selecciona un lote" : "No hay lotes disponibles" },
        ...availableLotes.map((lote) => ({ value: lote.codigo_lote, label: `${lote.codigo_lote} - ${lote.marca_nombre}` }))
      ],
      hint: "Opcional."
    }
  ) : null, mode.requiresStore ? /* @__PURE__ */ React.createElement(
    SelectInput,
    {
      label: "Tienda",
      value: form.tienda_id,
      onChange: (tienda_id) => updateForm({ tienda_id }),
      options: [
        { value: "", label: "Selecciona tienda" },
        ...(stores || []).map((store) => ({ value: String(store.id), label: store.nombre }))
      ],
      hint: "Obligatoria para guardar esta tarea."
    }
  ) : null);
}
function resolveGroupTaskMode(task) {
  if (!task) {
    return {
      mode: "none",
      label: "-",
      requiresQuantity: true,
      requiresGuideCode: false,
      requiresTime: false,
      requiresLote: false,
      requiresBrand: false,
      requiresStore: false,
      completedOnly: false
    };
  }
  const mode = getGroupLeaderTaskMode(getTaskTitle(task));
  const measurementType = normalizeMeasurementType(task?.tipo_medicion);
  const extraName = normalizeText(task?.nombre_dato_extra);
  const fields = getTaskFieldFlags(task);
  if (isGroupLeaderTimeTask(task)) {
    return {
      ...mode,
      mode: "tiempo",
      label: "Cantidad y tiempo",
      requiresQuantity: true,
      requiresTime: true,
      // Los campos que pide la tarea salen de sus banderas en Supabase.
      requiresGuideCode: fields.guia,
      requiresLote: fields.lote,
      requiresBrand: fields.marca,
      requiresStore: fields.tienda,
      requiresHangtag: fields.hangtag,
      completedOnly: false
    };
  }
  if (extraName.includes("lote")) {
    return {
      ...mode,
      mode: "lote",
      label: "Lote",
      requiresQuantity: true,
      requiresTime: false,
      requiresLote: true,
      completedOnly: false
    };
  }
  if (measurementType === "turno" && mode.mode === "cantidad") {
    return {
      mode: "turno",
      label: "Turno realizado",
      requiresQuantity: false,
      requiresGuideCode: false,
      requiresTime: false,
      requiresLote: false,
      completedOnly: true
    };
  }
  return mode;
}
function resetTaskMetadata({ tarea_id }) {
  return {
    tarea_id,
    marca_id: "",
    lote: "",
    tienda_id: ""
  };
}
function recordToEditableDraft(record) {
  return {
    trabajador_id: String(record.trabajador_id || ""),
    tarea_id: String(record.tarea_id || ""),
    fecha_registro: recordDateInput(record),
    fecha_fin: recordFinishDateInput(record),
    hora_inicio: timeInputValue(record.hora_inicio),
    hora_fin: timeInputValue(record.hora_fin),
    cantidad: Number(record.cantidad) > 0 ? String(record.cantidad) : "",
    tipo_etiquetado: normalizeHangtagValue(record.tipo_etiquetado) || "",
    marca_id: record.marca_id ? String(record.marca_id) : "",
    lote: record.lote || "",
    tienda_id: record.tienda_id ? String(record.tienda_id) : "",
    detalle: record.detalle || record.observacion || ""
  };
}
function recordDateInput(record) {
  const stored = String(record.fecha_registro || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
  return limaDatePart(record.hora_inicio) || limaDatePart(record.created_at) || todayLimaISO();
}
// La fecha fin no es una columna propia: vive dentro de hora_fin, que se
// guarda como instante completo.
function recordFinishDateInput(record) {
  return limaDatePart(record.hora_fin) || recordDateInput(record);
}

function formatDateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return value || "-";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatRecordDate(record) {
  return formatDateValue(recordDateInput(record));
}

function limaDatePart(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}
function timeInputValue(value) {
  if (!value) return "";
  const direct = String(value).match(/^(\d{2}):(\d{2})/);
  if (direct) return `${direct[1]}:${direct[2]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.hour}:${byType.minute}`;
}
function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}
// Un registro sigue pendiente mientras no tenga cierre: la cantidad y el
// puntaje se completan al editarlo en el historial.
function isPendingRecord(record) {
  return !record?.hora_fin;
}
// Los campos vacios de una fila "Sin cerrar" quedan en blanco en la exportacion
// en vez de mostrar "Pendiente", que solo tiene sentido en pantalla.
function groupHistoryExportRow(item, pending) {
  return {
    Fecha: formatRecordDate(item),
    Encargado: item.encargado_nombre || item.encargado_email || "",
    Operante: item.trabajador_nombre || item.trabajador_email || "",
    Tarea: item.tarea_nombre || "",
    "Hora inicio": formatTimeLima(item.hora_inicio),
    "Hora fin": pending ? "" : formatTimeLima(item.hora_fin),
    Cantidad: pending ? "" : (formatNumber(item.cantidad) || ""),
    "Tiempo (min)": pending ? "" : (item.tiempo_minutos ?? ""),
    "Codigo de lote": item.lote || "",
    Hangtag: item.tipo_etiquetado ? hangtagLabel(item.tipo_etiquetado) : "",
    Marca: item.marca_nombre || "",
    Tienda: item.tienda_nombre || "",
    Detalle: item.detalle || item.observacion || "",
    Modificado: item.updated_at ? formatUpdatedAt(item) : "",
    Estado: pending ? "Sin cerrar" : "Cerrado"
  };
}
const GROUP_HISTORY_EXPORT_COLUMNS = [
  "Fecha", "Encargado", "Operante", "Tarea", "Hora inicio", "Hora fin", "Cantidad",
  "Tiempo (min)", "Hangtag", "Codigo de lote", "Marca", "Tienda",
  "Detalle", "Modificado", "Estado"
];
// Exporta exactamente las filas que se ven en la tabla (ya filtradas por
// operante, tarea, categoria, busqueda y alcance), en el mismo orden.
function exportGroupHistoryToCsv(rows) {
  const exportRows = rows.map((row) => {
    const pending = row.kind === "pending";
    return groupHistoryExportRow(pending ? row.activity : row.record, pending);
  });
  downloadCsv(`historial-tareas-jefe-equipo-${todayLimaISO()}.csv`, GROUP_HISTORY_EXPORT_COLUMNS, exportRows);
}
function hangtagLabel(value) {
  if (!value) return "-";
  const normalized = normalizeHangtagValue(value);
  return HANGTAG_OPTIONS.find((option) => option.value === normalized)?.label || String(value);
}
function formatUpdatedAt(record) {
  const value = record?.updated_at || record?.updatedAt || null;
  if (!value) return "-";
  return formatDateTimeLima(value) || "-";
}
function MetricTile({ icon: Icon2, label, value }) {
  return /* @__PURE__ */ React.createElement("div", { className: "group-metric" }, /* @__PURE__ */ React.createElement(Icon2, null), /* @__PURE__ */ React.createElement("span", null, label), /* @__PURE__ */ React.createElement("strong", null, value));
}
function formatNumber(value) {
  if (value === null || value === void 0 || value === "") return "";
  return Number(value).toLocaleString("es-PE");
}
function formatRate(value) {
  return Number(value || 0).toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function formatDuration(value) {
  const total = Number(value || 0);
  if (!total) return "";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes} min`;
  if (!minutes) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}
function formatTimeLima(value) {
  if (!value) return "--:--";
  const direct = String(value).match(/^(\d{2}):(\d{2})/);
  if (direct) return `${direct[1]}:${direct[2]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
function formatDurationFromDates(startValue, endValue) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return "0 min";
  return formatDuration(Math.max(1, Math.round((end.getTime() - start.getTime()) / 6e4)));
}

export default GroupLeaderDashboard;
