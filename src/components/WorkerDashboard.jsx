import { useEffect, useMemo, useRef, useState } from "react";
import { BadgeCheck, CheckCircle2, FileSpreadsheet, Minus, Plus, RefreshCcw, Save, Search, Timer, X } from "lucide-react";
import {
  createWorkerActivityLog,
  clearOperationalRecordsCache,
  friendlyError,
  getTasksForUser,
  listBrands,
  listLotes,
  listOperationalRecords,
  listAllActivityLogs,
  listAllWorkerTaskRecords,
  listTiendas,
  listTaskScoreRanges,
  listTasks,
  listWorkerActivityLogs,
  loadGroupLeaderContext,
  loadWorkerLiveProgress
} from "../lib/repository";
import { formatDateTimeLima, nowLimaTimeHHMM, todayLimaISO } from "../lib/dates";
import { downloadCsv } from "../lib/csv";
import {
  calculatePoints,
  displayShiftFromQuantity,
  FULL_SHIFT,
  getActivityCaptureMode,
  getTaskFieldFlags,
  getTaskRequiredFlags,
  getTaskTitle,
  isGroupLeaderTimeTask,
  NO_TASK_OPTION,
  normalizeMeasurementType,
  normalizeRole,
  normalizeText,
  SIMPLE_SHIFT
} from "../lib/scoring";
import { useAsyncData } from "../lib/hooks";
import { useSessionState } from "../lib/sessionState";
import {
  Alert,
  Button,
  CheckboxInput,
  DataTable,
  IconButton,
  LoadingBlock,
  Panel,
  SelectInput,
  TablePager,
  Tabs,
  TextArea,
  TextInput
} from "./ui";
import { emptyGuideShare, GuideDistribution, guideTotal } from "./GuideDistribution";

export const HANGTAG_OPTIONS = [
  { value: "", label: "Selecciona" },
  { value: "CON_HANGTAG", label: "Con hangtag" },
  { value: "SIN_HANGTAG", label: "Sin hangtag" }
];

function recordCaptureType(task) {
  const dbType = normalizeMeasurementType(task?.tipo_medicion);
  const [fallbackType] = getActivityCaptureMode(getTaskTitle(task));
  return isGroupLeaderTimeTask(task)
    ? "tiempo"
    : task?.tipo_medicion ? dbType : normalizeMeasurementType(fallbackType);
}

// Todas las banderas de la tarea se respetan tal cual. Lo unico que cambia
// segun el tipo de tarea es COMO se captura marca y guia: repartiendo la
// cantidad total cuando la tarea se mide por cantidad, o como un solo valor
// cuando se registra por turno o por cumplimiento.
function recordFieldFlags(task) {
  return getTaskFieldFlags(task);
}

function taskSplitsQuantity(task) {
  return ["cantidad", "tiempo"].includes(recordCaptureType(task));
}

function isGeneralLote(lote) {
  return Boolean(lote?.es_general) || String(lote?.codigo_lote || "").trim().toUpperCase() === "LOTE GENERAL";
}

function emptyRecord() {
  return {
    taskKey: "",
    cantidad: "",
    marcaId: "",
    numeroGuia: "",
    lote: "",
    tipoEtiquetado: "",
    tiendaId: "",
    usaGuias: false,
    guias: [emptyGuideShare()],
    cumplimiento: true,
    turno: SIMPLE_SHIFT,
    detalle: ""
  };
}

export default function WorkerDashboard({ user, embedded = false, showAllWorkers = false }) {
  const [tab, setTab] = useSessionState(`worker-tab:${user?.id || "unknown"}:${embedded ? "embedded" : "main"}`, "Registrar actividad");
  const tabs = ["Registrar actividad", "Historial", ...(showAllWorkers ? ["Registros de todos los operantes"] : [])];

  return (
    <div className={embedded ? "stack embedded-worker" : "stack"}>
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === "Registrar actividad" ? <RegisterActivity user={user} /> : null}
      {tab === "Historial" ? <WorkerHistory user={user} /> : null}
      {showAllWorkers && tab === "Registros de todos los operantes" ? <WorkerHistory user={user} allWorkers /> : null}
    </div>
  );
}

function RegisterActivity({ user }) {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [tasks, brands, stores, lotes] = await Promise.all([
        getTasksForUser(user), listBrands(), listTiendas(), listLotes().catch(() => [])
      ]);
      return { tasks, brands, stores: stores.filter((store) => String(store.activo ?? true) !== "false"), lotes };
    },
    [user?.id],
    { tasks: [], brands: [], stores: [], lotes: [] }
  );
  const tasks = data.tasks || [];
  const brands = data.brands || [];
  const stores = data.stores || [];
  const lotes = (data.lotes || []).filter((lote) => (
    normalizeRole(user?.rol) === "operante" || !isGeneralLote(lote)
  ));
  const draftKey = `worker-draft:${user?.id || "unknown"}`;
  const [records, setRecords] = useSessionState(`${draftKey}:records`, () => [emptyRecord()]);
  const [status, setStatus] = useState(null);
  const [successDialog, setSuccessDialog] = useState(null);
  const [saving, setSaving] = useState(false);
  const maxRecordDate = todayLimaISO();
  // El operante puede corregir actividad de hasta 3 dias atras (por ejemplo si
  // se le olvido registrar), nunca a futuro ni mas antiguo que ese limite.
  const minRecordDate = useMemo(() => {
    const limit = new Date(`${maxRecordDate}T00:00:00`);
    limit.setDate(limit.getDate() - 3);
    return limit.toISOString().slice(0, 10);
  }, [maxRecordDate]);
  const [recordDate, setRecordDate] = useSessionState(`${draftKey}:date`, maxRecordDate);
  const [recordTime, setRecordTime] = useSessionState(`${draftKey}:time`, nowLimaTimeHHMM);

  const taskMap = useMemo(() => {
    return Object.fromEntries(
      tasks
        .slice()
        .sort((a, b) => Number(a.id || 0) - Number(b.id || 0))
        .map((task) => [getTaskTitle(task) || "Tarea sin título", task])
    );
  }, [tasks]);

  const taskKeys = Object.keys(taskMap);

  function updateRecord(index, changes) {
    setRecords((current) =>
      current.map((record, recordIndex) => (recordIndex === index ? { ...record, ...changes } : record))
    );
  }

  function handleTaskChange(index, taskKey) {
    const task = taskMap[taskKey];
    setRecords((current) =>
      current.map((record, recordIndex) =>
        recordIndex === index
          ? {
              ...emptyRecord(),
              taskKey,
              usaGuias: recordFieldFlags(task).guia && getTaskRequiredFlags(task).guia && taskSplitsQuantity(task)
            }
          : record
      )
    );
  }

  function addRecord() {
    if (records.length >= taskKeys.length) return;
    setRecords([...records, emptyRecord()]);
  }

  function removeRecord() {
    if (records.length <= 1) return;
    setRecords(records.slice(0, -1));
  }

  function removeRecordAt(index) {
    setRecords((current) => {
      if (current.length === 1) return [emptyRecord()];
      return current.filter((_, recordIndex) => recordIndex !== index);
    });
    setStatus(null);
  }

  function selectedTaskFor(record) {
    return taskMap[record.taskKey] || null;
  }

  function recordPayloadShape(record) {
    const task = selectedTaskFor(record);
    const title = getTaskTitle(task);
    const [, fallbackUnit] = getActivityCaptureMode(title);
    const type = recordCaptureType(task);
    const unit = task?.unidad_medida || task?.unidad_base || task?.unidad || fallbackUnit;
    const flags = recordFieldFlags(task);
    const required = getTaskRequiredFlags(task);
    const splitsQuantity = taskSplitsQuantity(task);
    const guias = flags.guia && splitsQuantity && record.usaGuias
      ? record.guias.map((item) => ({
          numero_guia: String(item.numero_guia || "").trim(),
          cantidad: Number(item.cantidad),
          tienda_id: item.tienda_id ? Number(item.tienda_id) : null,
          detalle: String(item.detalle || "").trim() || null
        }))
      : [];
    // La marca siempre es un unico valor por registro; ya no se reparte la
    // cantidad total entre varias marcas. Si la tarea pide lote, la marca se
    // completa sola desde el lote elegido (ver LoteField), asi que tambien
    // se guarda aunque la tarea no pida marca por separado.
    const marcaId = (flags.marca || flags.lote) && record.marcaId ? Number(record.marcaId) : null;
    const numeroGuia = flags.guia && !splitsQuantity ? String(record.numeroGuia || "").trim() || null : null;
    const tiendaId = flags.tienda && record.tiendaId ? Number(record.tiendaId) : null;
    const lote = flags.lote ? String(record.lote || "").trim().toUpperCase() || null : null;
    const tipoEtiquetado = flags.hangtag ? record.tipoEtiquetado || null : null;

    let cantidad = null;
    let cantidadPuntaje = null;
    let tiempoMinutos = null;
    let cumplimiento = record.cumplimiento;
    let turno = null;

    // Con guias la cantidad total es la suma de sus filas: no se pide aparte
    // para no tener que cuadrar dos numeros a mano.
    const splitTotal = guias.length ? guideTotal(guias) : null;
    if (type === "cantidad") {
      cantidad = splitTotal ?? (record.cantidad === "" ? null : Number(record.cantidad));
      cumplimiento = true;
    }
    if (type === "tiempo") {
      cantidad = splitTotal ?? (record.cantidad === "" ? null : Number(record.cantidad));
      tiempoMinutos = null;
      cumplimiento = true;
    }
    if (type === "fijo") {
      cumplimiento = true;
    }
    if (type === "turno") {
      turno = record.turno;
      cantidadPuntaje = record.turno === FULL_SHIFT ? 2 : 1;
      cumplimiento = true;
    }

    return {
      task,
      title,
      type,
      unit,
      cantidad,
      cantidadPuntaje,
      tiempoMinutos,
      cumplimiento,
      turno,
      guias,
      flags,
      required,
      splitsQuantity,
      marcaId,
      numeroGuia,
      usesStore: flags.tienda,
      tiendaId,
      lote,
      tipoEtiquetado
    };
  }

  function validateRecords() {
    if (!records.length || records.some((record) => !record.taskKey || record.taskKey === NO_TASK_OPTION)) {
      return "Debe seleccionar una tarea en cada registro.";
    }

    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.taskKey)) return "No puedes repetir la misma tarea en el mismo envio.";
      seen.add(record.taskKey);

      const shape = recordPayloadShape(record);
      // Cuando la cantidad se distribuye por guias, cada fila trae su propia
      // tienda. La tienda general solo es obligatoria si no hay distribucion.
      if (shape.usesStore && shape.required.tienda && !record.tiendaId && !shape.guias.length) {
        return `Selecciona una tienda para ${shape.title}.`;
      }
      if (shape.usesStore && record.tiendaId && !stores.some((store) => String(store.id) === String(record.tiendaId))) {
        return `Selecciona una tienda valida para ${shape.title}.`;
      }
      if (shape.guias.length) {
        if (shape.guias.some((item) => !item.numero_guia || !Number.isFinite(item.cantidad) || item.cantidad <= 0 || !item.tienda_id)) {
          return `Completa cada número de guía, su cantidad y su tienda para ${shape.title}.`;
        }
        if (shape.guias.some((item) => !stores.some((store) => Number(store.id) === Number(item.tienda_id)))) {
          return `Selecciona una tienda válida para cada guía de ${shape.title}.`;
        }
        const normalizedGuides = shape.guias.map((item) => item.numero_guia.toLowerCase());
        if (new Set(normalizedGuides).size !== normalizedGuides.length) {
          return `No puedes repetir un número de guía en ${shape.title}.`;
        }
      }
      if (shape.flags.hangtag && shape.required.hangtag && !shape.tipoEtiquetado) {
        return `Indica si ${shape.title} va con hangtag o sin hangtag.`;
      }
      if (shape.flags.marca && shape.required.marca && !shape.marcaId) {
        return `Selecciona una marca para ${shape.title}.`;
      }
      if (shape.flags.lote && shape.required.lote && !shape.lote) {
        return `Ingresa un lote para ${shape.title}.`;
      }
      if (shape.flags.guia && shape.required.guia && !shape.guias.length && !shape.numeroGuia) {
        return `Ingresa el número de guía para ${shape.title}.`;
      }
      if (shape.type === "cantidad" && !shape.guias.length && (record.cantidad === "" || Number(record.cantidad) < 0)) {
        return `Ingresa una cantidad valida para ${shape.title}.`;
      }
      if (shape.type === "tiempo" && !shape.guias.length && (record.cantidad === "" || Number(record.cantidad) <= 0)) {
        return `Ingresa la cantidad realizada para ${shape.title}.`;
      }
    }

    return "";
  }

  async function handleSave() {
    setStatus(null);
    setSuccessDialog(null);
    const validation = validateRecords();
    if (validation) {
      setStatus({ type: "error", message: validation });
      return;
    }
    if (!recordDate || recordDate < minRecordDate || recordDate > maxRecordDate) {
      setStatus({ type: "error", message: "La fecha de registro solo puede ser hasta 3 dias antes de hoy." });
      return;
    }

    setSaving(true);
    try {
      let saved = 0;
      let totalPoints = 0;
      const failures = [];

      for (const record of records) {
        try {
          const shape = recordPayloadShape(record);
          const taskForPoints = { ...shape.task };
          if (shape.type === "cantidad") {
            taskForPoints.rangos_puntaje = await listTaskScoreRanges(shape.task.id);
          }
          const points = calculatePoints(
            taskForPoints,
            shape.cantidadPuntaje ?? shape.cantidad,
            shape.tiempoMinutos,
            shape.cumplimiento
          );
          const activityPayload = {
            trabajador_id: user.id,
            usuario_id: user.id,
            tarea_id: shape.task.id,
            actividad_nombre: shape.title,
            fecha_registro: recordDate,
            hora_registro: recordTime || null,
            cantidad: shape.cantidad,
            tipo_medicion: shape.type,
            cumplimiento: shape.cumplimiento,
            detalle: record.detalle.trim() || null,
            turno: shape.turno,
            tienda_id: shape.tiendaId,
            lote: shape.lote,
            tipo_etiquetado: shape.tipoEtiquetado,
            marca_id: shape.marcaId,
            numero_guia: shape.numeroGuia,
            puntaje: points,
            marcas: [],
            guias: shape.guias
          };
          if (shape.tiempoMinutos !== null && shape.tiempoMinutos !== undefined) {
            activityPayload.tiempo_minutos = shape.tiempoMinutos;
          }
          await createWorkerActivityLog(activityPayload);
          saved += 1;
          totalPoints += Number(points || 0);
        } catch (err) {
          failures.push({ tarea: selectedTaskFor(record)?.titulo || record.taskKey, error: friendlyError(err) });
        }
      }

      if (failures.length) {
        setStatus({
          type: "error",
          message: `${failures.length} registros fallaron. ${failures[0]?.error || "Revisa la base de datos."}`
        });
        return;
      }

      setRecords([emptyRecord()]);
      setRecordDate(maxRecordDate);
      setRecordTime(nowLimaTimeHHMM());
      setSuccessDialog({ saved, totalPoints });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <TodayLeaderTaskCard user={user} onUse={(activity) => {
      const taskEntry = Object.entries(taskMap).find(([, task]) => Number(task.id) === Number(activity.tarea_id));
      if (!taskEntry) {
        setStatus({ type: "error", message: "La tarea indicada por el jefe no esta disponible en tu formulario." });
        return;
      }
      const [, task] = taskEntry;
      const flags = recordFieldFlags(task);
      const quantity = Number(activity.cantidad || 0);
      const hangtag = String(activity.tipo_etiquetado || "").trim().toUpperCase().replace(/\s+/g, "_");
      setRecords([{
        ...emptyRecord(),
        taskKey: taskEntry[0],
        cantidad: quantity > 0 ? String(quantity) : "",
        marcaId: (flags.marca || flags.lote) && activity.marca_id ? String(activity.marca_id) : "",
        lote: flags.lote ? String(activity.lote || "") : "",
        tipoEtiquetado: flags.hangtag && ["CON_HANGTAG", "SIN_HANGTAG"].includes(hangtag) ? hangtag : "",
        tiendaId: flags.tienda && activity.tienda_id ? String(activity.tienda_id) : "",
        detalle: String(activity.detalle || activity.observacion || "")
      }]);
      setStatus({ type: "success", message: `Datos de ${activity.tarea_nombre || "la tarea"} cargados. Revisa y completa lo pendiente antes de guardar.` });
    }} />
    <Panel
      title="Registrar lo realizado"
      eyebrow="Operaciones"
      actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar tareas</Button>}
    >
      {loading ? <LoadingBlock /> : null}
      {error ? <Alert type="error">{error}</Alert> : null}
      {!loading && !tasks.length ? <Alert>No tienes tareas asignadas para registrar actividades.</Alert> : null}

      <div className="record-toolbar">
        <TextInput
          label="Fecha de registro"
          type="date"
          value={recordDate}
          onChange={setRecordDate}
          min={minRecordDate}
          max={maxRecordDate}
          hint="Puedes registrar actividad de hasta 3 dias atras."
        />
        <TextInput
          label="Hora de registro"
          type="time"
          value={recordTime}
          onChange={setRecordTime}
          hint="Por defecto es la hora actual; puedes cambiarla libremente."
        />
        <Button variant="secondary" icon={Plus} onClick={addRecord} disabled={records.length >= taskKeys.length}>
          Agregar tarea
        </Button>
        <Button className="remove-task-button" variant="ghost" icon={Minus} onClick={removeRecord} disabled={records.length <= 1}>
          Quitar tarea
        </Button>
        <span>Registros a cargar: {records.length}</span>
      </div>

      <div className="records-list">
        {records.map((record, index) => {
          const selectedKeys = records.map((item, itemIndex) => (itemIndex === index ? null : item.taskKey)).filter(Boolean);
          const availableOptions = taskKeys.filter((key) => !selectedKeys.includes(key));
          const selectedTask = selectedTaskFor(record);
          return (
            <div className="record-card" key={index}>
              <div className="record-card-header">
                <div className="record-title">Registro {index + 1}</div>
                <IconButton
                  type="button"
                  className="record-remove-btn"
                  label={`Quitar registro ${index + 1}`}
                  icon={X}
                  onClick={() => removeRecordAt(index)}
                />
              </div>
              <SelectInput
                label="Tarea realizada"
                value={record.taskKey || (index === 0 ? NO_TASK_OPTION : "")}
                onChange={(taskKey) => handleTaskChange(index, taskKey)}
                options={[
                  ...(index === 0 ? [] : [{ value: "", label: "Selecciona una tarea" }]),
                  ...(index === 0 ? [{ value: NO_TASK_OPTION, label: "Ninguno" }] : []),
                  ...availableOptions.map((key) => ({ value: key, label: key }))
                ]}
              />
              {!selectedTask || record.taskKey === NO_TASK_OPTION ? (
                <Alert>Selecciona una tarea para completar este registro.</Alert>
              ) : (
                <DynamicRecordFields
                  record={record}
                  task={selectedTask}
                  brands={brands}
                  stores={stores}
                  lotes={lotes}
                  onChange={(changes) => updateRecord(index, changes)}
                />
              )}
            </div>
          );
        })}
      </div>

      {status ? <Alert type={status.type}>{status.message}</Alert> : null}
      <div className="form-actions sticky-actions">
        <Button icon={Save} loading={saving} onClick={handleSave} disabled={!tasks.length}>Guardar registros</Button>
      </div>

      {successDialog ? (
        <div className="save-success-overlay" role="presentation">
          <section
            className="save-success-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-success-title"
            aria-describedby="save-success-description"
          >
            <div className="save-success-icon" aria-hidden="true">
              <CheckCircle2 />
            </div>
            <div className="save-success-copy">
              <p className="eyebrow">Proceso completado</p>
              <h2 id="save-success-title">¡Registros guardados correctamente!</h2>
              <p id="save-success-description">
                Se guardaron {successDialog.saved} registro{successDialog.saved === 1 ? "" : "s"} sin errores.
              </p>
              <strong>Puntos acumulados: {successDialog.totalPoints}</strong>
            </div>
            <Button
              type="button"
              className="save-success-confirm"
              autoFocus
              onClick={() => setSuccessDialog(null)}
            >
              OK, continuar
            </Button>
          </section>
        </div>
      ) : null}
    </Panel>
    </>
  );
}

function DynamicRecordFields({ record, task, brands, stores, lotes, onChange }) {
  const title = getTaskTitle(task);
  const [, fallbackUnit] = getActivityCaptureMode(title);
  const type = recordCaptureType(task);
  const unit = task?.unidad_medida || task?.unidad_base || task?.unidad || fallbackUnit || "unidades";
  const flags = recordFieldFlags(task);
  const usesGuideBreakdown = flags.guia;
  const usesStore = flags.tienda;

  if (type === "cantidad") {
    return (
      <div className="form-grid">
        {usesGuideBreakdown && record.usaGuias ? null : (
          <TextInput
            label={`Cantidad (${unit})`}
            type="number"
            min="0"
            value={record.cantidad}
            onChange={(cantidad) => onChange({ cantidad })}
          />
        )}
        {flags.hangtag ? <HangtagField record={record} onChange={onChange} /> : null}
        {flags.marca && !flags.lote ? <SingleBrandField record={record} brands={brands} onChange={onChange} /> : null}
        {usesGuideBreakdown ? <GuideFields record={record} stores={stores} onChange={onChange} /> : null}
        {flags.lote ? <LoteField record={record} task={task} lotes={lotes} onChange={onChange} /> : null}
        <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore && !record.usaGuias} />
        <TextArea
          label={usesGuideBreakdown && record.usaGuias ? "Detalles generales" : "Detalle"}
          value={record.detalle}
          onChange={(detalle) => onChange({ detalle })}
          placeholder="Comentarios opcionales"
        />
      </div>
    );
  }

  if (type === "tiempo") {
    return (
      <div className="form-grid">
        {usesGuideBreakdown && record.usaGuias ? null : (
          <TextInput
            label="Cantidad realizada"
            type="number"
            min="1"
            step="1"
            value={record.cantidad}
            onChange={(cantidad) => onChange({ cantidad })}
          />
        )}
        {flags.hangtag ? <HangtagField record={record} onChange={onChange} /> : null}
        {flags.marca && !flags.lote ? <SingleBrandField record={record} brands={brands} onChange={onChange} /> : null}
        {usesGuideBreakdown ? <GuideFields record={record} stores={stores} onChange={onChange} /> : null}
        {flags.lote ? <LoteField record={record} task={task} lotes={lotes} onChange={onChange} /> : null}
        <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore && !record.usaGuias} />
        <TextArea
          label={usesGuideBreakdown && record.usaGuias ? "Detalles generales" : "Detalle"}
          value={record.detalle}
          onChange={(detalle) => onChange({ detalle })}
          placeholder="Comentarios opcionales"
        />
      </div>
    );
  }

  if (type === "fijo") {
    return (
      <div className="form-grid">
        <CheckboxInput
          label="Cumplido"
          checked
          disabled
          hint="Esta tarea siempre se registra como cumplida."
        />
        {flags.hangtag ? <HangtagField record={record} onChange={onChange} /> : null}
        {flags.marca && !flags.lote ? <SingleBrandField record={record} brands={brands} onChange={onChange} /> : null}
        {flags.guia ? <SingleGuideField record={record} onChange={onChange} /> : null}
        {flags.lote ? <LoteField record={record} task={task} lotes={lotes} onChange={onChange} /> : null}
        <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore} />
        <TextArea label="Detalle" value={record.detalle} onChange={(detalle) => onChange({ detalle })} placeholder="Comentarios opcionales" />
        <Alert>Esta tarea usa el puntaje fijo definido por administracion.</Alert>
      </div>
    );
  }

  return (
    <div className="form-grid">
      <SelectInput
        label="Turno"
        value={record.turno}
        onChange={(turno) => onChange({ turno })}
        options={[SIMPLE_SHIFT, FULL_SHIFT]}
      />
      {flags.hangtag ? <HangtagField record={record} onChange={onChange} /> : null}
      {flags.marca && !flags.lote ? <SingleBrandField record={record} brands={brands} onChange={onChange} /> : null}
      {flags.guia ? <SingleGuideField record={record} onChange={onChange} /> : null}
      {flags.lote ? <LoteField record={record} task={task} lotes={lotes} onChange={onChange} /> : null}
      <OptionalContextFields record={record} stores={stores} onChange={onChange} showStore={usesStore} />
      <TextArea label="Detalle" value={record.detalle} onChange={(detalle) => onChange({ detalle })} placeholder="Comentarios opcionales" />
      <Alert>
        Puntaje configurado: simple {task.puntaje_turno_simple || task.puntos_turno_simple || 0}, completo{" "}
        {task.puntaje_turno_completo || task.puntos_turno_completo || 0}.
      </Alert>
    </div>
  );
}

function OptionalContextFields({ record, stores, onChange, showStore = false }) {
  return (
    <>
      {showStore ? (
        <SelectInput
          label="Tienda"
          value={record.tiendaId}
          onChange={(tiendaId) => onChange({ tiendaId })}
          options={[
            { value: "", label: "Selecciona una tienda" },
            ...stores.map((store) => ({ value: String(store.id), label: store.nombre }))
          ]}
        />
      ) : null}
    </>
  );
}

function GuideFields({ record, stores, onChange }) {
  return (
    <>
      <CheckboxInput
        label="Registrar varias guías"
        checked={record.usaGuias}
        onChange={(usaGuias) => onChange({
          usaGuias,
          guias: record.guias?.length ? record.guias : [emptyGuideShare()]
        })}
        hint="El puntaje se calculará una sola vez con la suma total."
      />
      {record.usaGuias ? (
        <GuideDistribution items={record.guias} stores={stores} onChange={(guias) => onChange({ guias })} />
      ) : null}
    </>
  );
}

function LoteField({ record, task, lotes, onChange }) {
  // El lote ya trae su marca (codigo_lote - marca_nombre), asi que al
  // elegirlo se completa marcaId solo: la tarea no vuelve a pedir la marca
  // por separado cuando tiene lote.
  const labelingTask = normalizeText(getTaskTitle(task)) === "etiquetado";
  const availableLotes = (lotes || []).filter((lote) => (
    isGeneralLote(lote)
    || (labelingTask ? lote.estado === "en_curso" : ["pendiente", "en_curso"].includes(lote.estado))
  ));
  return (
    <SelectInput
      label="Lote"
      value={record.lote || ""}
      onChange={(codigoLote) => {
        const selected = availableLotes.find((lote) => lote.codigo_lote === codigoLote);
        onChange({ lote: codigoLote, marcaId: selected ? String(selected.marca_id) : "" });
      }}
      options={[
        { value: "", label: availableLotes.length ? "Selecciona un lote" : "No hay lotes disponibles" },
        ...availableLotes.map((lote) => ({
          value: lote.codigo_lote,
          label: isGeneralLote(lote) ? "Lote general - VARIOS" : `${lote.codigo_lote} - ${lote.marca_nombre}`
        }))
      ]}
    />
  );
}

// Version de un solo valor de marca y guia, para las tareas que no tienen una
// cantidad total que repartir.
function SingleBrandField({ record, brands, onChange }) {
  return (
    <SelectInput
      label="Marca"
      value={record.marcaId}
      onChange={(marcaId) => onChange({ marcaId })}
      options={[
        { value: "", label: "Selecciona una marca" },
        ...brands.map((brand) => ({ value: String(brand.id), label: brand.nombre }))
      ]}
    />
  );
}

function SingleGuideField({ record, onChange }) {
  return (
    <TextInput
      label="Número de guía"
      value={record.numeroGuia}
      onChange={(numeroGuia) => onChange({ numeroGuia })}
      placeholder="Ej. GUIA-001"
    />
  );
}

function HangtagField({ record, onChange }) {
  return (
    <SelectInput
      label="Hangtag"
      value={record.tipoEtiquetado}
      onChange={(tipoEtiquetado) => onChange({ tipoEtiquetado })}
      options={HANGTAG_OPTIONS}
    />
  );
}

function logSortTime(log) {
  const value = new Date(log.created_at || log.fecha_registro || 0).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function liveProgressNumber(value) {
  return Number(value || 0).toLocaleString("es-PE");
}

function liveProgressTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

// Tarea que un líder de equipo dejo abierta HOY para este operante. Vive al
// tope de "Registrar actividad", en reemplazo de la antigua pestaña
// "Progreso en vivo": no es una lista de todo el historial, solo lo que esta
// en curso ahora mismo, para que sea lo primero que se ve al entrar.
function TodayLeaderTaskCard({ user, onUse }) {
  const requestRef = useRef(null);
  const consumedIdsRef = useRef(new Set());
  const [activities, setActivities] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const consumedStorageKey = `worker-leader-task-consumed:${user?.id || "unknown"}`;

  useEffect(() => {
    let cancelled = false;
    consumedIdsRef.current = new Set();
    setActivities([]);
    setLoaded(false);
    async function refresh() {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      try {
        const result = await loadWorkerLiveProgress({ signal: controller.signal });
        if (cancelled) return;
        const today = todayLimaISO();
        // Solo etiquetado: es la unica tarea donde el líder de equipo registra
        // en nombre del operante y este debe confirmar el dato el mismo dia.
        const leaderRecordsToday = (result.activities || []).filter(
          (activity) => ["historial_jefe_equipo", "jefe_equipo"].includes(activity.origen)
            && String(activity.fecha_registro || "").slice(0, 10) === today
            && normalizeText(activity.tarea_nombre || activity.actividad_nombre) === "etiquetado"
        );
        // Conserva los IDs ya usados, incluyendo la firma del formato anterior.
        // Los registros nuevos solo aportan su propia cantidad a la tarjeta.
        try {
          const storedIds = window.localStorage.getItem(consumedStorageKey) || "";
          storedIds.split("|").filter(Boolean).forEach((id) => consumedIdsRef.current.add(id));
        } catch {
          // Conserva los IDs en memoria si el navegador bloquea localStorage.
        }
        setActivities(leaderRecordsToday.filter(
          (activity) => !consumedIdsRef.current.has(String(activity.record_id ?? activity.id))
        ));
        setLoaded(true);
      } catch (err) {
        if (err?.name !== "AbortError" && !cancelled) setLoaded(true);
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [user?.id, consumedStorageKey]);

  const summary = activities.length
    ? {
        ...activities[0],
        cantidad: activities.reduce((sum, activity) => sum + Number(activity.cantidad || 0), 0),
        recordCount: activities.length
      }
    : null;

  if (!loaded || !summary) return null;

  return (
    <Panel title="Tu líder de equipo te registro esto hoy" eyebrow="Datos para completar" className="today-leader-task-panel">
      <div className="today-leader-task-grid">
        <article className="today-leader-task-card">
          <header>
            <Timer />
            <strong>{summary.tarea_nombre || summary.actividad_nombre || "Tarea sin nombre"}</strong>
          </header>
          <dl>
            <div><dt>Cantidad</dt><dd>{liveProgressNumber(summary.cantidad)}</dd></div>
            <div><dt>Lote</dt><dd>{summary.lote || "No aplica"}</dd></div>
            <div><dt>Hangtag</dt><dd>{summary.tipo_etiquetado || "No aplica"}</dd></div>
          </dl>
          <small>
            Registrada por {summary.encargado_nombre || "tu líder de equipo"} · inicio{" "}
            {liveProgressTime(summary.hora_inicio || summary.horaInicio)} · {summary.estado === "EN_CURSO" ? "En curso" : "Cerrada por el jefe"}
            {summary.recordCount > 1 ? ` · Cantidad acumulada de ${summary.recordCount} registros` : ""}
          </small>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onUse(summary);
              activities.forEach((activity) => {
                consumedIdsRef.current.add(String(activity.record_id ?? activity.id));
              });
              try {
                window.localStorage.setItem(consumedStorageKey, [...consumedIdsRef.current].sort().join("|"));
              } catch {
                // Al menos se oculta durante la sesion actual.
              }
              setActivities([]);
            }}
          >
            Usar estos datos
          </Button>
        </article>
      </div>
    </Panel>
  );
}

const WORKER_HISTORY_EXPORT_COLUMNS = [
  "Trabajador", "Fecha", "Hora", "Hora inicio", "Hora fin", "Tarea", "Cantidad", "Tiempo (min)", "Turno",
  "Cumplimiento", "Puntos", "Tienda", "Guia", "Lote", "Marcas", "Detalle de guía", "Detalles generales"
];

export function WorkerHistory({ user, allWorkers = false }) {
  return allWorkers ? <AllWorkersPaginatedHistory user={user} /> : <WorkerHistoryContent user={user} />;
}

function AllWorkersPaginatedHistory({ user }) {
  const pageSize = 25;
  const stateKey = `all-worker-records:${user?.id || "unknown"}`;
  const [page, setPage] = useSessionState(`${stateKey}:page`, 1);
  const [workerFilter, setWorkerFilter] = useSessionState(`${stateKey}:worker`, "");
  const [taskFilter, setTaskFilter] = useSessionState(`${stateKey}:task`, "");
  const [lotFilter, setLotFilter] = useSessionState(`${stateKey}:lot`, "");
  const [dateFrom, setDateFrom] = useSessionState(`${stateKey}:from`, "");
  const [dateTo, setDateTo] = useSessionState(`${stateKey}:to`, "");
  const [sortOrder, setSortOrder] = useSessionState(`${stateKey}:order`, "desc");
  const [searchInput, setSearchInput] = useSessionState(`${stateKey}:search-input`, "");
  const [search, setSearch] = useState(searchInput);
  const [catalogs, setCatalogs] = useSessionState(`${stateKey}:catalogs`, null);
  const filtersMounted = useRef(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  useEffect(() => {
    if (!filtersMounted.current) {
      filtersMounted.current = true;
      return;
    }
    setPage(1);
  }, [workerFilter, taskFilter, lotFilter, dateFrom, dateTo, sortOrder, search]);

  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const result = await listOperationalRecords({
        source: "normal",
        page,
        pageSize,
        workerId: workerFilter,
        taskId: taskFilter,
        lot: lotFilter,
        from: dateFrom,
        to: dateTo,
        order: sortOrder,
        search,
        includeCatalogs: !catalogs
      });
      if (result.catalogs) setCatalogs(result.catalogs);
      return result;
    },
    [page, workerFilter, taskFilter, lotFilter, dateFrom, dateTo, sortOrder, search, user?.id],
    { records: [], total: 0, page: 1, pageSize }
  );

  const availableCatalogs = data.catalogs || catalogs || { users: [], tasks: [], lotes: [] };
  const rows = (data.records || []).map((log) => {
    const taskName = log.tarea_nombre || log.actividad_nombre || "";
    const [tipoAct] = getActivityCaptureMode(taskName);
    return {
      Trabajador: log.trabajador_nombre || "",
      Fecha: log.fecha_registro || "",
      Hora: log.hora_registro || "",
      Tarea: taskName,
      Cantidad: log.cantidad ?? "",
      Turno: log.turno || (tipoAct === "turno" ? displayShiftFromQuantity(log.cantidad) : ""),
      Cumplimiento: log.cumplimiento,
      Puntos: log.puntaje,
      Tienda: log.tienda_nombre || "",
      Guia: log.numero_guia || "",
      Lote: log.lote || "",
      Marcas: (log.marcas || []).map((item) => `${item.marca_nombre}: ${item.cantidad}`).join(", "),
      "Detalle de guía": log.detalle_guia || "",
      "Detalles generales": log.detalle || ""
    };
  });
  const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / pageSize));

  function refresh() {
    clearOperationalRecordsCache("normal");
    reload();
  }

  function exportCurrentPage() {
    const exportRows = rows.filter((row) => String(row.Lote || "").trim().toUpperCase() !== "LOTE GENERAL");
    downloadCsv(`registros-operantes-pagina-${page}-${todayLimaISO()}.csv`, WORKER_HISTORY_EXPORT_COLUMNS, exportRows);
  }

  return (
    <Panel
      title="Registros de todos los operantes"
      eyebrow="25 registros por pagina"
      actions={(
        <>
          <Button variant="secondary" icon={FileSpreadsheet} disabled={!rows.length} onClick={exportCurrentPage}>Exportar pagina</Button>
          <Button variant="secondary" icon={RefreshCcw} onClick={refresh}>Actualizar</Button>
        </>
      )}
    >
      <div className="toolbar all-workers-history-filters">
        <SelectInput
          label="Operante"
          value={workerFilter}
          onChange={setWorkerFilter}
          options={[{ value: "", label: "Todos" }, ...(availableCatalogs.users || []).map((item) => ({ value: String(item.id), label: item.nombre || item.email }))]}
        />
        <SelectInput
          label="Tarea"
          value={taskFilter}
          onChange={setTaskFilter}
          options={[{ value: "", label: "Todas" }, ...(availableCatalogs.tasks || []).map((item) => ({ value: String(item.id), label: getTaskTitle(item) || "Tarea sin nombre" }))]}
        />
        <SelectInput
          label="Lote"
          value={lotFilter}
          onChange={setLotFilter}
          options={[{ value: "", label: "Todos los lotes" }, ...(availableCatalogs.lotes || []).map((item) => ({ value: String(item.codigo_lote || ""), label: String(item.codigo_lote || "") })).filter((item) => item.value)]}
        />
        <TextInput label="Fecha desde" type="date" value={dateFrom} onChange={setDateFrom} />
        <TextInput label="Fecha hasta" type="date" value={dateTo} onChange={setDateTo} />
        <SelectInput
          label="Ordenar por fecha"
          value={sortOrder}
          onChange={setSortOrder}
          options={[{ value: "desc", label: "Mas reciente primero" }, { value: "asc", label: "Mas antigua primero" }]}
        />
        <label className="field search-field">
          <span className="field-label">Buscar</span>
          <span className="search-input">
            <Search />
            <input className="input" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Guia, lote o detalle" />
          </span>
        </label>
      </div>
      {error ? <Alert type="error">{friendlyError(error)}</Alert> : null}
      {loading && !rows.length ? <LoadingBlock /> : null}
      {!loading && !rows.length ? <Alert>No hay registros para los filtros seleccionados.</Alert> : null}
      {rows.length ? <DataTable rows={rows} pageSize={0} className="all-workers-history-table" /> : null}
      <TablePager page={page - 1} totalPages={totalPages} totalRows={Number(data.total || 0)} onChange={(nextPage) => setPage(nextPage + 1)} />
    </Panel>
  );
}

function WorkerHistoryContent({ user }) {
  const allWorkers = false;
  const [sortOrder, setSortOrder] = useState("desc");
  const [taskFilter, setTaskFilter] = useState("");
  const [workerFilter, setWorkerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [lotFilter, setLotFilter] = useState("");
  const [search, setSearch] = useState("");
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [logs, tasks, stores, users, lotes] = await Promise.all([
        allWorkers ? listAllWorkerTaskRecords() : listWorkerActivityLogs(user.id),
        listTasks(), listTiendas(), allWorkers ? loadGroupLeaderContext().then((context) => context.allUsers || []) : Promise.resolve([user]),
        listLotes().catch(() => [])
      ]);
      return { logs, tasks, stores, users, lotes };
    },
    [user?.id],
    { logs: [], tasks: [], stores: [], users: [], lotes: [] }
  );

  const taskNameById = Object.fromEntries((data.tasks || []).map((task) => [task.id, getTaskTitle(task) || "Tarea sin nombre"]));
  const storeNameById = Object.fromEntries((data.stores || []).map((store) => [store.id, store.nombre]));
  const allLogs = data.logs || [];
  const workerNameById = Object.fromEntries((data.users || []).map((item) => [item.id, item.nombre || item.email]));

  const loggedTaskOptions = [];
  const seenTaskIds = new Set();
  allLogs.forEach((log) => {
    const id = log.tarea_id;
    if (id === undefined || id === null || seenTaskIds.has(id)) return;
    seenTaskIds.add(id);
    loggedTaskOptions.push({ value: String(id), label: taskNameById[id] || log.actividad_nombre || "Tarea sin nombre" });
  });
  loggedTaskOptions.sort((a, b) => a.label.localeCompare(b.label));

  const filteredLogs = allLogs.filter((log) => {
    if (taskFilter && String(log.tarea_id) !== taskFilter) return false;
    const workerId = log.trabajador_id || log.usuario_id;
    if (workerFilter && String(workerId) !== workerFilter) return false;
    const date = String(log.fecha_registro || "").slice(0, 10);
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    if (lotFilter && String(log.lote || "") !== lotFilter) return false;
    if (!search.trim()) return true;
    const taskName = taskNameById[log.tarea_id] || log.actividad_nombre || "";
    const term = normalizeText(search);
    return normalizeText(
      [taskName, log.detalle, log.detalle_guia, log.observacion, log.numero_guia, log.lote, storeNameById[log.tienda_id], log.encargado_nombre].join(" ")
    ).includes(term);
  });

  const sortedLogs = [...filteredLogs].sort((a, b) => {
    const diff = logSortTime(a) - logSortTime(b);
    return sortOrder === "asc" ? diff : -diff;
  });
  const rows = sortedLogs.map((log) => {
    const taskName = taskNameById[log.tarea_id] || log.actividad_nombre || "";
    const [tipoAct] = getActivityCaptureMode(taskName);
    return {
      Trabajador: workerNameById[log.trabajador_id || log.usuario_id] || "",
      Fecha: log.fecha_registro || "",
      Hora: log.hora_registro || "",
      "Hora inicio": log.hora_inicio ? liveProgressTime(log.hora_inicio) : "",
      "Hora fin": log.hora_fin ? liveProgressTime(log.hora_fin) : "",
      Tarea: taskName,
      Cantidad: log.cantidad ?? "",
      "Tiempo (min)": log.tiempo_minutos ?? "",
      Turno: log.turno || (tipoAct === "turno" ? displayShiftFromQuantity(log.cantidad) : ""),
      Cumplimiento: log.cumplimiento,
      Puntos: log.puntaje,
      Tienda: storeNameById[log.tienda_id] || "",
      Guia: log.numero_guia || "",
      Lote: log.lote || "",
      Marcas: (log.marcas || []).map((item) => `${item.marca_nombre}: ${item.cantidad}`).join(", "),
      "Detalle de guía": log.detalle_guia || "",
      "Detalles generales": log.detalle || ""
    };
  });

  function exportToCsv() {
    const exportRows = rows.filter((row) => String(row.Lote || "").trim().toUpperCase() !== "LOTE GENERAL");
    downloadCsv(`historial-actividad-${todayLimaISO()}.csv`, WORKER_HISTORY_EXPORT_COLUMNS, exportRows);
  }

  return (
    <Panel
      title="Historial"
      eyebrow="Registros"
      actions={
        <>
          <Button variant="secondary" icon={FileSpreadsheet} disabled={!rows.length} onClick={exportToCsv}>
            Exportar a Excel
          </Button>
          <Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>
        </>
      }
    >
      <div className="toolbar">
        {allWorkers ? <SelectInput
          label="Operante"
          value={workerFilter}
          onChange={setWorkerFilter}
          options={[{ value: "", label: "Todos" }, ...(data.users || []).filter((item) => normalizeRole(item.rol) === "operante").map((item) => ({ value: String(item.id), label: item.nombre || item.email }))]}
        /> : null}
        <SelectInput
          label="Tarea"
          value={taskFilter}
          onChange={setTaskFilter}
          options={[{ value: "", label: "Todas" }, ...loggedTaskOptions]}
        />
        <SelectInput
          label="Lote"
          value={lotFilter}
          onChange={setLotFilter}
          options={[
            { value: "", label: "Todos los lotes" },
            ...(data.lotes || []).map((lote) => ({
              value: String(lote.codigo_lote || lote.lote || ""),
              label: lote.marca_nombre ? `${lote.codigo_lote} - ${lote.marca_nombre}` : String(lote.codigo_lote || lote.lote || "")
            })).filter((option) => option.value)
          ]}
        />
        <TextInput label="Fecha desde" type="date" value={dateFrom} onChange={setDateFrom} />
        <TextInput label="Fecha hasta" type="date" value={dateTo} onChange={setDateTo} />
        <SelectInput
          label="Ordenar por fecha"
          value={sortOrder}
          onChange={setSortOrder}
          options={[
            { value: "desc", label: "Más reciente primero" },
            { value: "asc", label: "Más antigua primero" }
          ]}
        />
        <label className="field search-field">
          <span className="field-label">Buscar</span>
          <span className="search-input">
            <Search />
            <input
              className="input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tarea, tienda, guía, lote, detalle"
            />
          </span>
        </label>
      </div>
      {loading ? <LoadingBlock /> : null}
      {error ? <Alert type="error">{error}</Alert> : null}
      {!loading && !allLogs.length ? <Alert>Aun no tienes registros.</Alert> : null}
      {!loading && allLogs.length > 0 && !rows.length ? <Alert>Ningun registro coincide con los filtros actuales.</Alert> : null}
      <DataTable rows={rows} />
    </Panel>
  );
}
