import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarCheck2, CheckCircle2, ClipboardCheck, Clock3, Eye, EyeOff, FileSpreadsheet, GraduationCap, HelpCircle, LockKeyhole, Mail, Pencil, Plus, RefreshCcw, Save, Search, Send, Trash2, Upload, UsersRound, X } from "lucide-react";
import {
  bulkSetTrainingStatus,
  createActivityReportSettings,
  createAmonestacion,
  createAttendanceReportSettings,
  createBrand,
  createEncargado,
  createLote,
  createTask,
  createTienda,
  createTrainingCourse,
  createUser,
  clearOperationalRecordsCache,
  deleteActivityReportSettings,
  deleteAmonestacion,
  deleteAttendanceReportSettings,
  deleteBrand,
  deleteLote,
  deleteTask,
  deleteTienda,
  deleteTrainingCourse,
  deleteUser,
  friendlyError,
  getActivityReportPreview,
  getActivityReportSettings,
  getAttendanceForDate,
  getAttendanceReportSettings,
  getTrainingStatusByCourse,
  getUserTrainingProfile,
  importGuias,
  importGuiaItems,
  listAllActivityLogs,
  loadAverageReferences,
  listAmonestaciones,
  listAttendances,
  listBrands,
  listEncargados,
  listGuias,
  listGuiaItemsForExport,
  listLogAsistencias,
  listGeneralLoteAccumulations,
  listLotes,
  listOperationalRecords,
  listPenalizaciones,
  listPersonnelMovements,
  listTasks,
  listTiendas,
  listTrainingCourses,
  listWorkers,
  markAttendance,
  PENALTY_KEYS,
  savePenalizaciones,
  selectUsers,
  sendAttendanceReportNow,
  sendActivityReportNow,
  setUserTrainingDetails,
  setUserTrainingStatus,
  setTaskScoringRules,
  updateTask,
  updateAttendanceReportSettings,
  updateActivityReportSettings,
  updateBrand,
  updateEncargado,
  updateLote,
  updateTienda,
  updateTrainingCourse,
  updateUser,
  updateGroupLeaderAverageReference
} from "../lib/repository";
import { birthdayMaxISO, formatDateLima, formatDateTimeLima, todayLimaISO } from "../lib/dates";
import {
  emptyQuantityRanges,
  getTaskTitle,
  MAX_SCORE_QUANTITY,
  normalizeMeasurementType,
  normalizeRole,
  normalizeText,
  quantityRangesFromRules,
  getTaskFieldFlags,
  getTaskRequiredFlags,
  isGroupLeaderTimeTask,
  validateQuantityRanges
} from "../lib/scoring";
import { useAsyncData } from "../lib/hooks";
import { readSessionState, useSessionState, writeSessionState } from "../lib/sessionState";
import FootwearDashboard from "./FootwearDashboard";
import { GroupTimeDashboard, IncidentDashboard, TaskAverageField } from "./GroupLeaderDashboard";
import {
  Alert,
  Button,
  CheckboxInput,
  DataTable,
  FormActions,
  LoadingBlock,
  Metric,
  Panel,
  SelectInput,
  SwitchInput,
  TablePager,
  Tabs,
  TextArea,
  TextInput
} from "./ui";

const roleOptions = ["administrador", "operante", "lider de equipo", "otros"];
const taskTypes = ["cantidad", "fijo", "turno", "tiempo"];
const trainingStatusOptions = [
  { value: "pendiente", label: "Pendiente" },
  { value: "en_curso", label: "En curso" },
  { value: "finalizado", label: "Completado" }
];
const trainingStatusRank = { pendiente: 0, en_curso: 1, finalizado: 2 };

function trainingStatusLabel(status) {
  return trainingStatusOptions.find((option) => option.value === status)?.label || "Pendiente";
}

const ADMIN_SECTION_HELP = {
  Usuarios: {
    title: "Usuarios",
    text: "Crea, edita y desactiva trabajadores: nombre, correo, rol (administrador, operante, líder de equipo, otros), sueldo, cumpleaños y estado activo/inactivo. Abajo, \"Trabajadores con reingreso\" lista a quienes salieron y volvieron a entrar más de una vez, con el detalle de cada ingreso/salida."
  },
  Capacitaciones: {
    title: "Capacitaciones",
    text: "Crea cursos de capacitación, asígnalos a uno o varios trabajadores (con encargado y horas) y actualiza su estado: pendiente, en curso o completado."
  },
  Tareas: {
    title: "Tareas",
    text: "Catálogo de tareas operativas y de error: define su tipo (cantidad, fijo, turno, tiempo), si requiere marca, tienda, tiempo o lote, y las reglas de puntaje (puntos a favor y en contra)."
  },
  Asistencia: {
    title: "Asistencia",
    text: "Marca la asistencia diaria por trabajador. Abajo, en \"Registros de Asistencia\" está el historial de marcaciones, y en \"Historial de Cambios\" el registro de auditoría de quién creó, editó o borró cada asistencia."
  },
  Notificaciones: {
    title: "Notificaciones",
    text: "Programa el envío automático por correo de reportes de asistencia y de registros de actividades, y revisa su historial de envíos."
  },
  Tiendas: {
    title: "Tiendas y Marcas",
    text: "Catálogo de tiendas/sedes y de marcas (dos pestañas), usados al registrar tareas operativas, lotes y errores."
  },
  Lotes: {
    title: "Lotes",
    text: "Catálogo de lotes de mercadería: registra las etapas de cada lote. La pestaña Lote general muestra un acumulado que otorga puntos normales, pero no participa en reportes, documentos, cálculos ni gráficas."
  },
  Guias: {
    title: "Guías",
    text: "Importa el reporte de salidas (Excel) para cargar las guías del mes, y consulta el catálogo de guías con su fecha y cantidad de pares. Estas guías alimentan el margen de error del dashboard."
  },
  Errores: {
    title: "Errores",
    text: "Reporta incidencias/errores por trabajador o por área (tarea, tienda, número de guía, tipo de error) — la misma sección que usa el líder de equipo — y consulta el historial de errores registrados."
  },
  Amonestaciones: {
    title: "Amonestaciones",
    text: "Registra memorándums y cartas de amonestación por trabajador, y consulta el historial completo."
  },
  Documentos: {
    title: "Documentos",
    text: "Exporta a Excel los datos del sistema: usuarios, asistencias, registros de actividades, tareas, amonestaciones y capacitaciones, todo junto o por separado."
  }
};

function AdminHelpButton({ section }) {
  const [open, setOpen] = useState(false);
  const help = ADMIN_SECTION_HELP[section];
  if (!help) return null;
  return (
    <>
      <button
        type="button"
        className="admin-help-fab"
        onClick={() => setOpen(true)}
        aria-label={`Ayuda: ¿qué se hace en ${help.title}?`}
        title="¿Qué se hace en esta página?"
      >
        <HelpCircle aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="admin-help-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-help-title"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <div className="admin-help-dialog">
            <header className="admin-help-header">
              <h2 id="admin-help-title">{help.title}</h2>
              <button type="button" className="admin-help-close" onClick={() => setOpen(false)} aria-label="Cerrar ayuda">
                <X aria-hidden="true" />
              </button>
            </header>
            <p className="admin-help-text">{help.text}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function AdminDashboard({ section, user }) {
  if (section === "Dashboard") return <FootwearDashboard />;
  if (section === "Usuarios") return <><UsersPanel /><AdminHelpButton section="Usuarios" /></>;
  if (section === "Capacitaciones") return <><TrainingsPanel /><AdminHelpButton section="Capacitaciones" /></>;
  if (section === "Tareas") return <><TasksPanel /><AdminHelpButton section="Tareas" /></>;
  if (section === "Asistencia") return <><AttendancePanel /><AdminHelpButton section="Asistencia" /></>;
  if (section === "Notificaciones") return <><NotificationsPanel /><AdminHelpButton section="Notificaciones" /></>;
  if (section === "Tiendas") return <><StoresPanel /><AdminHelpButton section="Tiendas" /></>;
  if (section === "Lotes") return <><LotesPanel /><AdminHelpButton section="Lotes" /></>;
  if (section === "Guias") return <><GuiasPanel /><AdminHelpButton section="Guias" /></>;
  if (section === "Errores") return <><IncidentDashboard /><AdminHelpButton section="Errores" /></>;
  if (section === "Registros") return <div className="admin-history-only"><GroupTimeDashboard user={user} /></div>;
  if (section === "Amonestaciones") return <><WarningsPanel /><AdminHelpButton section="Amonestaciones" /></>;
  if (section === "Documentos") return <><DocumentsPanel /><AdminHelpButton section="Documentos" /></>;
  return <FootwearDashboard />;
}

function AdminOperationalRecords() {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const cached = readSessionState("admin-operational-catalogs", null);
      if (cached?.users && cached?.managers && cached?.tasks && cached?.lotes) return cached;
      const result = await listOperationalRecords({ source: "time", page: 1, pageSize: 10, includeCatalogs: true, forceRefresh: true });
      const catalogs = result.catalogs || { users: [], managers: [], tasks: [], lotes: [] };
      writeSessionState("admin-operational-catalogs", catalogs);
      return catalogs;
    },
    [],
    { users: [], managers: [], tasks: [], lotes: [] }
  );

  if (loading) return <LoadingBlock label="Cargando filtros de registros..." />;
  if (error) return <Alert type="error" action={<Button variant="secondary" onClick={reload}>Reintentar</Button>}>{friendlyError(error)}</Alert>;

  return (
    <div className="stack">
      <AdminOperationalRecordsTable source="time" title="Registros operativos de líderes de equipo" catalogs={data} />
    </div>
  );
}

function AdminOperationalRecordsTable({ source, title, catalogs }) {
  const pageSize = 25;
  const stateKey = `admin-operational:${source}`;
  const currentDate = todayLimaISO();
  const currentYear = currentDate.slice(0, 4);
  const currentMonth = currentDate.slice(5, 7);
  const [page, setPage] = useSessionState(`${stateKey}:page`, 1);
  const [workerId, setWorkerId] = useSessionState(`${stateKey}:worker`, "");
  const [managerId, setManagerId] = useSessionState(`${stateKey}:manager`, "");
  const [includeInactive, setIncludeInactive] = useSessionState(`${stateKey}:include-inactive`, false);
  const [taskId, setTaskId] = useSessionState(`${stateKey}:task`, "");
  const [lot, setLot] = useSessionState(`${stateKey}:lot`, "");
  const [year, setYear] = useSessionState(`${stateKey}:year`, currentYear);
  const [month, setMonth] = useSessionState(`${stateKey}:month`, currentMonth);
  const [day, setDay] = useSessionState(`${stateKey}:day`, "");
  const filtersMounted = useRef(false);
  const daysInMonth = month ? new Date(Number(year), Number(month), 0).getDate() : 0;
  const selectedDay = day ? String(day).padStart(2, "0") : "";
  const from = month
    ? `${year}-${month}-${selectedDay || "01"}`
    : `${year}-01-01`;
  const to = month
    ? `${year}-${month}-${selectedDay || String(daysInMonth).padStart(2, "0")}`
    : `${year}-12-31`;

  useEffect(() => {
    if (!filtersMounted.current) {
      filtersMounted.current = true;
      return;
    }
    setPage(1);
  }, [workerId, managerId, taskId, lot, year, month, day]);

  useEffect(() => {
    if (day && Number(day) > daysInMonth) setDay("");
  }, [day, daysInMonth, setDay]);

  const { data, loading, error, reload } = useAsyncData(
    () => listOperationalRecords({ source, page, pageSize, workerId, managerId, taskId, lot, from, to }),
    [source, page, workerId, managerId, taskId, lot, from, to],
    { records: [], total: 0, page: 1, pageSize }
  );

  const workerOptions = [
    { value: "", label: "Todos" },
    ...(catalogs.users || [])
      .filter((item) => normalizeRole(item.rol) === "operante" && (includeInactive || boolValue(item.activo)))
      .map((item) => ({ value: String(item.id), label: `${item.nombre || item.email}${boolValue(item.activo) ? "" : " (inactivo)"}` }))
  ];
  const managerOptions = [
    { value: "", label: "Todos" },
    ...(catalogs.managers || [])
      .filter((item) => normalizeRole(item.rol) === "lider de equipo" && (includeInactive || boolValue(item.activo)))
      .map((item) => ({ value: String(item.id), label: `${item.nombre || item.email}${boolValue(item.activo) ? "" : " (inactivo)"}` }))
  ];

  useEffect(() => {
    if (!includeInactive && workerId && !workerOptions.some((option) => option.value === String(workerId))) setWorkerId("");
    if (!includeInactive && managerId && !managerOptions.some((option) => option.value === String(managerId))) setManagerId("");
  }, [includeInactive]);
  const taskOptions = [
    { value: "", label: "Todas" },
    ...(catalogs.tasks || []).map((item) => ({ value: String(item.id), label: getTaskTitle(item) || "Tarea sin nombre" }))
  ];
  const lotOptions = [
    { value: "", label: "Todos" },
    ...(catalogs.lotes || []).map((item) => ({ value: String(item.codigo_lote || item.codigo || item.lote || ""), label: String(item.codigo_lote || item.codigo || item.lote || "") })).filter((item) => item.value)
  ];
  const yearOptions = Array.from({ length: 21 }, (_, index) => {
    const value = String(Number(currentYear) - index);
    return { value, label: value };
  });
  const monthOptions = [
    { value: "", label: "Todos los meses" },
    ...[
      "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
      "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
    ].map((label, index) => ({ value: String(index + 1).padStart(2, "0"), label }))
  ];
  const dayOptions = [
    { value: "", label: "Todos los días" },
    ...Array.from({ length: daysInMonth }, (_, index) => ({ value: String(index + 1).padStart(2, "0"), label: String(index + 1) }))
  ];
  const rows = (data.records || []).map((record) => source === "time" ? {
    Fecha: record.fecha_registro || "",
    Operante: record.trabajador_nombre || "",
    Tarea: record.tarea_nombre || "",
    "Hora inicio": formatDateTimeLima(record.hora_inicio) || "",
    "Hora fin": formatDateTimeLima(record.hora_fin) || "",
    "Tiempo (min)": record.tiempo_minutos ?? "",
    Cantidad: record.cantidad ?? "",
    Lote: record.lote || "",
    Tienda: record.tienda_nombre || "",
    Encargado: record.encargado_nombre || "",
    Detalle: record.detalle || record.observacion || ""
  } : {
    Fecha: record.fecha_registro || "",
    Hora: record.hora_registro || "",
    Operante: record.trabajador_nombre || "",
    Tarea: record.tarea_nombre || record.actividad_nombre || "",
    Cantidad: record.cantidad ?? "",
    Lote: record.lote || "",
    Guia: record.numero_guia || "",
    Tienda: record.tienda_nombre || "",
    Puntos: record.puntaje ?? "",
    "Detalle de guía": record.detalle_guia || "",
    "Detalles generales": record.detalle || record.observacion || ""
  });
  const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / pageSize));

  return (
    <Panel
      title={title}
      eyebrow={source === "time" ? "registros_tareas_jefe_equipo" : "registros_tareas"}
      actions={<Button variant="secondary" icon={RefreshCcw} onClick={() => { clearOperationalRecordsCache(source); reload(); }}>Actualizar</Button>}
    >
      <div className="toolbar">
        <SelectInput label="Operante" value={workerId} onChange={setWorkerId} options={workerOptions} />
        <SelectInput label="Encargado" value={managerId} onChange={setManagerId} options={managerOptions} />
        <CheckboxInput label="Incluir inactivos" checked={includeInactive} onChange={setIncludeInactive} />
        <SelectInput label="Tarea" value={taskId} onChange={setTaskId} options={taskOptions} />
        <SelectInput label="Lote" value={lot} onChange={setLot} options={lotOptions} />
        <SelectInput label="Año" value={year} onChange={setYear} options={yearOptions} />
        <SelectInput label="Mes" value={month} onChange={(value) => { setMonth(value); setDay(""); }} options={monthOptions} />
        <SelectInput label="Día" value={day} onChange={setDay} options={dayOptions} disabled={!month} />
      </div>
      {error ? <Alert type="error">{friendlyError(error)}</Alert> : null}
      {loading ? <LoadingBlock label="Cargando registros..." /> : (
        <>
          <DataTable rows={rows} pageSize={0} empty="No hay registros para estos filtros." />
          <TablePager page={page - 1} totalPages={totalPages} totalRows={Number(data.total || 0)} onChange={(nextPage) => setPage(nextPage + 1)} />
        </>
      )}
    </Panel>
  );
}

function boolValue(value) {
  return !["false", "0", "no"].includes(String(value ?? true).trim().toLowerCase());
}

function calculateAge(birthISO) {
  if (!birthISO || !/^\d{4}-\d{2}-\d{2}$/.test(birthISO)) return "";
  const birth = new Date(`${birthISO}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return "";
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const beforeBirthday = today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? String(age) : "";
}

const sexoOptions = ["Hombre", "Mujer", "No especificado"];
const estadoCivilOptions = ["Soltero(a)", "Casado(a)", "Conviviente", "Divorciado(a)", "Viudo(a)"];
const gradoAcademicoOptions = ["Primaria", "Secundaria", "Tecnico", "Universitario", "Postgrado"];
const tallaPoloOptions = ["S", "M", "L", "XL", "XXL"];
const personalDataFieldKeys = [
  "nombres_completos",
  "dni",
  "sexo",
  "telefono",
  "telefono_emergencia",
  "direccion",
  "distrito",
  "grado_academico",
  "ciclo_semestre",
  "puesto",
  "estado_civil",
  "hijos",
  "talla_zapatillas",
  "talla_polo",
  "alergia",
  "condicion_salud"
];

function emptyPersonalDataFields() {
  return Object.fromEntries(personalDataFieldKeys.map((key) => [key, ""]));
}

function personalDataFromUser(user) {
  return Object.fromEntries(personalDataFieldKeys.map((key) => [
    key,
    user?.[key] === null || user?.[key] === undefined ? "" : String(user[key])
  ]));
}

function PersonalDataFields({ form, setForm }) {
  const withBlank = (options) => [{ value: "", label: "Sin especificar" }, ...options];
  return (
    <>
      <TextInput label="DNI" value={form.dni} onChange={(dni) => setForm({ ...form, dni })} maxLength={20} />
      <SelectInput label="Sexo" value={form.sexo} onChange={(sexo) => setForm({ ...form, sexo })} options={sexoOptions.map((option) => ({ value: option, label: option }))} />
      <TextInput label="Telefono" value={form.telefono} onChange={(telefono) => setForm({ ...form, telefono })} maxLength={30} />
      <TextInput label="Telefono de emergencia" value={form.telefono_emergencia} onChange={(telefono_emergencia) => setForm({ ...form, telefono_emergencia })} maxLength={30} />
      <TextInput label="Distrito" value={form.distrito} onChange={(distrito) => setForm({ ...form, distrito })} maxLength={120} />
      <div className="form-span">
        <TextArea label="Direccion" value={form.direccion} onChange={(direccion) => setForm({ ...form, direccion })} rows={2} />
      </div>
      <SelectInput label="Grado academico" value={form.grado_academico} onChange={(grado_academico) => setForm({ ...form, grado_academico })} options={withBlank(gradoAcademicoOptions)} />
      <TextInput label="Ciclo / semestre" value={form.ciclo_semestre} onChange={(ciclo_semestre) => setForm({ ...form, ciclo_semestre })} placeholder="Ej. 8vo ciclo" maxLength={60} />
      <TextInput label="Puesto" value={form.puesto} onChange={(puesto) => setForm({ ...form, puesto })} placeholder="Ej. Auxiliar de almacen" maxLength={120} />
      <SelectInput label="Estado civil" value={form.estado_civil} onChange={(estado_civil) => setForm({ ...form, estado_civil })} options={withBlank(estadoCivilOptions)} />
      <TextInput label="Numero de hijos" type="number" min="0" step="1" value={form.hijos} onChange={(hijos) => setForm({ ...form, hijos })} />
      <TextInput label="Talla de zapatillas" value={form.talla_zapatillas} onChange={(talla_zapatillas) => setForm({ ...form, talla_zapatillas })} maxLength={10} />
      <SelectInput label="Talla de polo" value={form.talla_polo} onChange={(talla_polo) => setForm({ ...form, talla_polo })} options={withBlank(tallaPoloOptions)} />
      <div className="form-span">
        <TextArea label="Alergia" value={form.alergia} onChange={(alergia) => setForm({ ...form, alergia })} rows={2} placeholder="Ej. Ninguna, o detalla la alergia" />
      </div>
      <div className="form-span">
        <TextArea label="Condición de salud" value={form.condicion_salud} onChange={(condicion_salud) => setForm({ ...form, condicion_salud })} rows={2} placeholder="Ej. Ninguna, tratamiento o consideración médica" />
      </div>
    </>
  );
}

function personalDataPayload(form) {
  return Object.fromEntries(personalDataFieldKeys.map((key) => {
    if (key === "hijos") {
      return [key, form.hijos === "" ? null : Number(form.hijos)];
    }
    const trimmed = String(form[key] || "").trim();
    return [key, trimmed || null];
  }));
}

const userColumnLabels = {
  id: "ID",
  nombre: "Nombres",
  nombres_completos: "Nombres y apellidos",
  email: "Usuario o correo",
  rol: "Rol",
  activo: "Activo",
  fecha_cumpleanos: "Fecha de nacimiento",
  sueldo: "Sueldo",
  dni: "DNI",
  sexo: "Sexo",
  telefono: "Telefono",
  telefono_emergencia: "Telefono de emergencia",
  direccion: "Direccion",
  distrito: "Distrito",
  grado_academico: "Grado academico",
  ciclo_semestre: "Ciclo / semestre",
  puesto: "Puesto",
  estado_civil: "Estado civil",
  hijos: "Numero de hijos",
  talla_zapatillas: "Talla de zapatillas",
  talla_polo: "Talla de polo",
  alergia: "Alergia",
  condicion_salud: "Condición de salud",
  fecha_ingreso: "Fecha de ingreso",
  fecha_salida: "Fecha de salida",
  motivo_salida: "Motivo de salida",
  created_at: "Creado el",
  updated_at: "Actualizado el"
};

function userColumnLabel(key) {
  return userColumnLabels[key] || String(key).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatusAlert({ status }) {
  if (!status?.message) return null;
  return <Alert type={status.type}>{status.message}</Alert>;
}

function UsersPanel() {
  const { data: users = [], loading, error, reload } = useAsyncData(selectUsers, [], []);
  const [tab, setTab] = useState("Crear");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [createForm, setCreateForm] = useState({
    nombre: "",
    email: "",
    password: "",
    fecha_cumpleanos: "",
    fecha_ingreso: todayLimaISO(),
    sueldo: "0.00",
    rol: "operante",
    activo: true,
    ...emptyPersonalDataFields()
  });
  const [editId, setEditId] = useState("");
  const [editForm, setEditForm] = useState({
    nombre: "",
    email: "",
    fecha_cumpleanos: "",
    rol: "operante",
    activo: true,
    password: "",
    sueldo: "0.00",
    fecha_ingreso: "",
    fecha_salida: "",
    motivo_salida: "",
    ...emptyPersonalDataFields()
  });

  const selectedUser = users.find((user) => String(user.id) === String(editId));

  useEffect(() => {
    if (!selectedUser) return;
    setEditForm({
      nombre: selectedUser.nombre || "",
      email: selectedUser.email || "",
      fecha_cumpleanos: selectedUser.fecha_cumpleanos || "",
      rol: normalizeRole(selectedUser.rol) || "operante",
      activo: boolValue(selectedUser.activo),
      password: "",
      sueldo: Number(selectedUser.sueldo || 0).toFixed(2),
      fecha_ingreso: selectedUser.fecha_ingreso || "",
      fecha_salida: selectedUser.fecha_salida || "",
      motivo_salida: selectedUser.motivo_salida || "",
      ...personalDataFromUser(selectedUser)
    });
  }, [selectedUser?.id]);

  useEffect(() => {
    if (!confirmingDelete) return undefined;
    function closeOnEscape(event) {
      if (event.key === "Escape" && !saving) setConfirmingDelete(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [confirmingDelete, saving]);

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!createForm.nombre.trim() || !createForm.email.trim() || !createForm.password) {
      setStatus({ type: "error", message: "Nombre, usuario y contrasena son obligatorios." });
      return;
    }
    if (!createForm.fecha_ingreso) {
      setStatus({ type: "error", message: "La fecha de ingreso es obligatoria." });
      return;
    }
    if (createForm.hijos !== "" && (!Number.isInteger(Number(createForm.hijos)) || Number(createForm.hijos) < 0)) {
      setStatus({ type: "error", message: "El numero de hijos debe ser un entero mayor o igual a cero." });
      return;
    }
    setSaving(true);
    try {
      await createUser(
        {
          nombre: createForm.nombre.trim(),
          email: createForm.email.trim().toLowerCase(),
          rol: createForm.rol,
          activo: createForm.activo,
          fecha_cumpleanos: createForm.fecha_cumpleanos || null,
          fecha_ingreso: createForm.fecha_ingreso,
          sueldo: Number(createForm.sueldo),
          ...personalDataPayload(createForm)
        },
        createForm.password
      );
      setCreateForm({
        nombre: "",
        email: "",
        password: "",
        fecha_cumpleanos: "",
        fecha_ingreso: todayLimaISO(),
        sueldo: "0.00",
        rol: "operante",
        activo: true,
        ...emptyPersonalDataFields()
      });
      setStatus({ type: "success", message: "Usuario creado correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    if (!selectedUser) return;
    setStatus(null);
    if (!editForm.nombre.trim() || !editForm.email.trim()) {
      setStatus({ type: "error", message: "Nombre y usuario son obligatorios." });
      return;
    }
    if (editForm.fecha_salida && !editForm.fecha_ingreso) {
      setStatus({ type: "error", message: "Ingresa la fecha de ingreso antes de registrar la salida." });
      return;
    }
    if (editForm.fecha_ingreso && editForm.fecha_salida && editForm.fecha_salida < editForm.fecha_ingreso) {
      setStatus({ type: "error", message: "La fecha de salida no puede ser anterior a la fecha de ingreso." });
      return;
    }
    if (editForm.fecha_salida && !editForm.motivo_salida.trim()) {
      setStatus({ type: "error", message: "Ingresa el motivo de la salida." });
      return;
    }
    if (editForm.hijos !== "" && (!Number.isInteger(Number(editForm.hijos)) || Number(editForm.hijos) < 0)) {
      setStatus({ type: "error", message: "El numero de hijos debe ser un entero mayor o igual a cero." });
      return;
    }
    setSaving(true);
    try {
      await updateUser(
        selectedUser.id,
        {
          nombre: editForm.nombre.trim(),
          email: editForm.email.trim().toLowerCase(),
          rol: editForm.rol,
          activo: editForm.fecha_ingreso ? !editForm.fecha_salida : editForm.activo,
          fecha_cumpleanos: editForm.fecha_cumpleanos || null,
          sueldo: Number(editForm.sueldo),
          fecha_ingreso: editForm.fecha_ingreso || null,
          fecha_salida: editForm.fecha_salida || null,
          motivo_salida: editForm.fecha_salida ? editForm.motivo_salida.trim() : null,
          ...personalDataPayload(editForm)
        },
        editForm.password.trim() || null
      );
      setStatus({ type: "success", message: "Usuario actualizado correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedUser) return;
    setStatus(null);
    setSaving(true);
    try {
      const result = await deleteUser(selectedUser.id);
      setConfirmingDelete(false);
      setEditId("");
      setStatus({
        type: result?.archived ? "warning" : "success",
        message: result?.archived
          ? "El usuario tiene historial relacionado, por eso fue desactivado en lugar de borrar sus registros."
          : "Usuario eliminado correctamente."
      });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const inactiveCount = users.filter((user) => !boolValue(user.activo)).length;
  const visibleUsers = showInactive ? users : users.filter((user) => boolValue(user.activo));
  const availableUserColumns = Array.from(new Set(visibleUsers.flatMap((user) => Object.keys(user))))
    .filter((key) => !["id", "activo", "alias"].includes(key));
  // La fecha de creacion siempre cierra la tabla para que sea facil ubicarla
  // incluso cuando el backend devuelve los campos en un orden diferente.
  const userColumns = [
    ...availableUserColumns.filter((key) => key !== "created_at"),
    ...availableUserColumns.includes("created_at") ? ["created_at"] : []
  ];
  const rows = visibleUsers.map((user) => Object.fromEntries(
    userColumns.map((key) => {
      const label = userColumnLabel(key);
      if (key === "rol") return [label, normalizeRole(user[key])];
      if (key === "sueldo") return [label, Number(user[key] || 0).toLocaleString("es-PE", { style: "currency", currency: "PEN" })];
      if (key === "created_at") return [label, formatDateTimeLima(user[key])];
      return [label, user[key]];
    })
  ));
  const tableColumns = userColumns.map(userColumnLabel);

  return (
    <div className="stack">
      <Panel
        title="Gestion de usuarios"
        eyebrow="Administracion"
        actions={
          <Button
            variant="secondary"
            icon={showInactive ? EyeOff : Eye}
            onClick={() => {
              setShowInactive((current) => {
                const next = !current;
                if (!next && selectedUser && !boolValue(selectedUser.activo)) setEditId("");
                return next;
              });
            }}
          >
            {showInactive ? "Ocultar inactivos" : `Mostrar inactivos (${inactiveCount})`}
          </Button>
        }
      >
        {loading ? (
          <LoadingBlock />
        ) : (
          <DataTable
            rows={rows}
            columns={tableColumns}
            className="users-management-table"
            pageSize={0}
            empty={showInactive ? "No hay usuarios registrados." : "No hay usuarios activos. Presiona \"Mostrar inactivos\" para verlos."}
          />
        )}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>

      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear", "Editar", "Eliminar", "Reingresos"]} active={tab} onChange={setTab} />

        {tab === "Crear" ? (
          <form className="form-grid" onSubmit={handleCreate}>
            <TextInput label="Nombres" value={createForm.nombre} onChange={(nombre) => setCreateForm({ ...createForm, nombre })} />
            <TextInput label="Usuario o correo" value={createForm.email} onChange={(email) => setCreateForm({ ...createForm, email })} />
            <TextInput label="Nombres y Apellidos" value={createForm.nombres_completos} onChange={(nombres_completos) => setCreateForm({ ...createForm, nombres_completos })} maxLength={200} />
            <TextInput
              label="Contrasena"
              type="password"
              value={createForm.password}
              onChange={(password) => setCreateForm({ ...createForm, password })}
            />
            <TextInput
              label="Fecha de ingreso *"
              type="date"
              max={todayLimaISO()}
              required
              value={createForm.fecha_ingreso}
              onChange={(fecha_ingreso) => setCreateForm({ ...createForm, fecha_ingreso })}
              hint="Obligatoria. Viene puesta en la fecha de hoy; cambiala si el ingreso real fue otro dia."
            />
            <TextInput
              label="Fecha de nacimiento"
              type="date"
              min="1900-01-01"
              max={birthdayMaxISO()}
              value={createForm.fecha_cumpleanos}
              onChange={(fecha_cumpleanos) => setCreateForm({ ...createForm, fecha_cumpleanos })}
            />
            <TextInput label="Edad" value={calculateAge(createForm.fecha_cumpleanos)} onChange={() => {}} disabled hint="Se calcula segun la fecha de nacimiento" />
            <TextInput
              label="Sueldo"
              type="number"
              min="0"
              max="9999999999.99"
              step="0.01"
              value={createForm.sueldo}
              onChange={(sueldo) => setCreateForm({ ...createForm, sueldo })}
            />
            <SelectInput label="Rol" value={createForm.rol} onChange={(rol) => setCreateForm({ ...createForm, rol })} options={roleOptions} />
            <CheckboxInput label="Activo" checked={createForm.activo} onChange={(activo) => setCreateForm({ ...createForm, activo })} />
            <PersonalDataFields form={createForm} setForm={setCreateForm} />
            <div className="form-span">
              <Button type="submit" icon={Plus} loading={saving}>Crear usuario</Button>
            </div>
          </form>
        ) : null}

        {tab === "Editar" || tab === "Eliminar" ? (
          <div className="stack">
            <SelectInput
              label={tab === "Editar" ? "Usuario" : "Usuario a eliminar"}
              value={editId}
              onChange={setEditId}
              options={[
                { value: "", label: "Selecciona un usuario" },
                ...visibleUsers.map((user) => ({ value: String(user.id), label: user.nombres_completos || user.nombre || user.email }))
              ]}
            />
            {tab === "Editar" && selectedUser ? (
              <form className="form-grid" onSubmit={handleEdit}>
                <TextInput label="Nombres" value={editForm.nombre} onChange={(nombre) => setEditForm({ ...editForm, nombre })} />
                <TextInput label="Usuario o correo" value={editForm.email} onChange={(email) => setEditForm({ ...editForm, email })} />
                <TextInput label="Nombres y Apellidos" value={editForm.nombres_completos} onChange={(nombres_completos) => setEditForm({ ...editForm, nombres_completos })} maxLength={200} />
                <TextInput
                  label="Fecha de nacimiento"
                  type="date"
                  min="1900-01-01"
                  max={birthdayMaxISO()}
                  value={editForm.fecha_cumpleanos || ""}
                  onChange={(fecha_cumpleanos) => setEditForm({ ...editForm, fecha_cumpleanos })}
                />
                <TextInput label="Edad" value={calculateAge(editForm.fecha_cumpleanos)} onChange={() => {}} disabled hint="Se calcula segun la fecha de nacimiento" />
                <TextInput
                  label="Sueldo"
                  type="number"
                  min="0"
                  max="9999999999.99"
                  step="0.01"
                  value={editForm.sueldo}
                  onChange={(sueldo) => setEditForm({ ...editForm, sueldo })}
                />
                <SelectInput label="Rol" value={editForm.rol} onChange={(rol) => setEditForm({ ...editForm, rol })} options={roleOptions} />
                <TextInput
                  label="Nueva contrasena"
                  type="password"
                  value={editForm.password}
                  onChange={(password) => setEditForm({ ...editForm, password })}
                  placeholder="Opcional"
                />
                <TextInput
                  label="Fecha de ingreso"
                  type="date"
                  value={editForm.fecha_ingreso}
                  onChange={(fecha_ingreso) => setEditForm({ ...editForm, fecha_ingreso })}
                />
                <TextInput
                  label="Fecha de salida"
                  type="date"
                  min={editForm.fecha_ingreso || undefined}
                  value={editForm.fecha_salida}
                  onChange={(fecha_salida) => setEditForm({ ...editForm, fecha_salida })}
                />
                {editForm.fecha_salida ? (
                  <div className="form-span">
                    <TextArea
                      label="Motivo de salida"
                      value={editForm.motivo_salida}
                      onChange={(motivo_salida) => setEditForm({ ...editForm, motivo_salida })}
                      rows={3}
                      maxLength={500}
                      placeholder="Ej. Renuncia voluntaria, mejor oferta, termino de contrato..."
                    />
                  </div>
                ) : null}
                <div className="form-span">
                  <Alert>
                    La fecha de salida es opcional. Si queda vacia, el usuario permanecera activo; al registrar una salida se desactivara. Si la registras, debes indicar el motivo.
                  </Alert>
                </div>
                <PersonalDataFields form={editForm} setForm={setEditForm} />
                <div className="form-span">
                  <FormActions saving={saving} saveLabel="Guardar cambios" />
                </div>
              </form>
            ) : null}
            {tab === "Eliminar" && selectedUser ? (
              <div className="danger-zone">
                <p>Eliminaras a {selectedUser.email}. Esta accion depende de las reglas de la base de datos.</p>
                <Button variant="danger" icon={Trash2} loading={saving} onClick={() => setConfirmingDelete(true)}>Eliminar usuario</Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {tab !== "Reingresos" ? <StatusAlert status={status} /> : null}
      </Panel>
      {tab === "Reingresos" ? <RehiresSection /> : null}
      {confirmingDelete && selectedUser ? (
        <div
          className="delete-confirm-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setConfirmingDelete(false);
          }}
        >
          <section className="delete-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-user-title" aria-describedby="delete-user-description">
            <span className="delete-confirm-icon" aria-hidden="true"><AlertTriangle /></span>
            <div className="delete-confirm-copy">
              <p className="eyebrow">Confirmar eliminación</p>
              <h2 id="delete-user-title">¿Eliminar este usuario?</h2>
              <p id="delete-user-description">
                Vas a eliminar a <strong>{selectedUser.nombre || selectedUser.email}</strong> ({selectedUser.email}).
                Si tiene historial relacionado, se desactivará para conservar sus registros.
              </p>
            </div>
            <div className="delete-confirm-actions">
              <Button variant="secondary" disabled={saving} onClick={() => setConfirmingDelete(false)}>Cancelar</Button>
              <Button variant="danger" icon={Trash2} loading={saving} onClick={handleDelete}>Sí, eliminar</Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function RehiresSection() {
  const { data: movements = [], loading, error, reload } = useAsyncData(listPersonnelMovements, [], []);

  const movementsByWorker = new Map();
  for (const movement of movements) {
    const key = Number(movement.usuarioId);
    if (!movementsByWorker.has(key)) movementsByWorker.set(key, []);
    movementsByWorker.get(key).push(movement);
  }

  const rehiredWorkers = [...movementsByWorker.entries()]
    .map(([usuarioId, items]) => {
      const sorted = [...items].sort((left, right) => String(left.fecha || "").localeCompare(String(right.fecha || "")) || left.id - right.id);
      const ingresoCount = sorted.filter((item) => normalizeText(item.tipo) === "ingreso").length;
      return { usuarioId, items: sorted, ingresoCount, worker: sorted[sorted.length - 1] };
    })
    .filter((entry) => entry.ingresoCount > 1)
    .sort((left, right) => String(left.worker.workerName || "").localeCompare(String(right.worker.workerName || ""), "es"));

  return (
    <Panel
      title="Trabajadores con reingreso"
      eyebrow="Historial de ingresos y salidas"
      actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
    >
      {loading ? <LoadingBlock /> : null}
      {error ? <Alert type="error">{error}</Alert> : null}
      {!loading && !rehiredWorkers.length ? <Alert>No hay trabajadores con más de un ingreso registrado.</Alert> : null}
      {rehiredWorkers.length ? (
        <div className="details-list">
          {rehiredWorkers.map((entry) => (
            <details key={entry.usuarioId} className="detail-card">
              <summary>
                <span>
                  <strong>{entry.worker.workerName}</strong>
                  <br />
                  <small>
                    {entry.worker.workerEmail} · {normalizeRole(entry.worker.workerRole) || "sin rol"} ·{" "}
                    {entry.worker.workerActive ? "Activo" : "Inactivo"}
                  </small>
                </span>
                <span>{entry.ingresoCount} ingresos</span>
              </summary>
              <DataTable
                rows={entry.items.map((item) => ({
                  Fecha: formatDateLima(item.fecha),
                  Tipo: normalizeText(item.tipo) === "ingreso" ? "Ingreso" : "Salida",
                  Motivo: item.motivo || ""
                }))}
                columns={["Fecha", "Tipo", "Motivo"]}
                compact
              />
            </details>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function TrainingDetailFields({ userId, training, encargados, onSaved }) {
  const [nroHoras, setNroHoras] = useState(training.nro_horas || "");
  const [encargado, setEncargado] = useState(training.inversion_curso || "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    setNroHoras(training.nro_horas || "");
    setEncargado(training.inversion_curso || "");
  }, [training.nro_horas, training.inversion_curso]);

  const dirty = nroHoras !== (training.nro_horas || "") || encargado !== (training.inversion_curso || "");

  async function handleSave() {
    setStatus(null);
    if (!nroHoras.trim()) {
      setStatus({ type: "error", message: "La duracion no puede quedar vacia." });
      return;
    }
    if (!encargado.trim()) {
      setStatus({ type: "error", message: "Selecciona un encargado." });
      return;
    }
    setSaving(true);
    try {
      // Esto guarda la duracion/encargado de ESTE trabajador para este
      // curso (usuario_capacitaciones), no del catalogo global de cursos.
      await setUserTrainingDetails(userId, training.id_curso, {
        nro_horas: nroHoras.trim(),
        encargado: encargado.trim()
      });
      onSaved();
      setStatus({ type: "success", message: "Datos actualizados." });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="training-detail-fields">
      <div className="form-grid">
        <TextInput label="Duracion" value={nroHoras} onChange={setNroHoras} placeholder="Ej. 1 Hora" maxLength={60} />
        <SelectInput
          label="Encargado"
          value={encargado}
          onChange={setEncargado}
          options={[
            { value: "", label: "Selecciona un encargado" },
            ...encargados.map((item) => ({ value: item.nombre, label: item.nombre })),
            ...(encargado && !encargados.some((item) => item.nombre === encargado) ? [{ value: encargado, label: `${encargado} (inactivo)` }] : [])
          ]}
        />
      </div>
      {status ? <StatusAlert status={status} /> : null}
      <div className="form-actions">
        <Button variant="secondary" icon={Save} loading={saving} disabled={!dirty} onClick={handleSave}>Guardar</Button>
      </div>
    </div>
  );
}

function WorkerTrainingProfile({ user, onClose }) {
  const { data, setData, loading, error, reload } = useAsyncData(
    () => getUserTrainingProfile(user.id),
    [user.id],
    null
  );
  const { data: encargados = [] } = useAsyncData(listEncargados, [], []);
  const [savingCourse, setSavingCourse] = useState("");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function updateTraining(training, estado) {
    if (!estado || estado === training.estado) return;
    setStatus(null);
    setSavingCourse(training.id_curso);
    try {
      const updated = await setUserTrainingStatus(user.id, training.id_curso, estado);
      setData(updated);
      setStatus({
        type: "success",
        message: `${training.id_curso} ahora esta ${trainingStatusLabel(estado).toLowerCase()}.`
      });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSavingCourse("");
    }
  }

  const trainings = data?.trainings || [];
  const summary = data?.summary || { completed: 0, total: trainings.length, percent: 0 };

  return (
    <div
      className="worker-profile-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="worker-profile-dialog" role="dialog" aria-modal="true" aria-label={`Perfil de ${user.nombre || user.email}`}>
        <header className="worker-profile-header">
          <div className="worker-profile-identity">
            <span className="worker-profile-avatar"><GraduationCap /></span>
            <div>
              <p className="eyebrow">Perfil del trabajador</p>
              <h2>{user.nombre || user.email}</h2>
              <span>{user.email} · {normalizeRole(user.rol)} · {boolValue(user.activo) ? "Activo" : "Inactivo"}</span>
            </div>
          </div>
          <button type="button" className="profile-close" aria-label="Cerrar perfil" onClick={onClose}>
            <X />
          </button>
        </header>

        <div className="training-summary">
          <div>
            <span>Progreso de capacitaciones</span>
            <strong>{summary.completed} de {summary.total}</strong>
          </div>
          <div className="training-progress-track" aria-label={`${summary.percent}% completado`}>
            <span style={{ width: `${summary.percent}%` }} />
          </div>
          <b>{summary.percent}%</b>
        </div>

        {loading ? <LoadingBlock label="Cargando capacitaciones" /> : null}
        {error ? (
          <Alert type="error">
            {error} <button type="button" className="inline-action" onClick={reload}>Reintentar</button>
          </Alert>
        ) : null}

        {!loading && !error ? (
          <div className="training-roadmap">
            {trainings.map((training) => {
              const trainingStatus = training.estado || (training.completado ? "finalizado" : "pendiente");
              const locked = !training.disponible;
              const cannotChange = !training.puede_cambiar_estado;
              const finalized = trainingStatus === "finalizado";
              const inProgress = trainingStatus === "en_curso";
              const availableStatusOptions = trainingStatusOptions.map((option) => ({
                ...option,
                disabled: cannotChange && trainingStatusRank[option.value] < trainingStatusRank[trainingStatus]
              }));
              return (
                <article
                  key={training.id_curso}
                  className={`training-card ${finalized ? "completed" : inProgress ? "in-progress" : locked ? "locked" : "available"}`}
                >
                  <div className="training-order">
                    {finalized ? <CheckCircle2 /> : locked ? <LockKeyhole /> : inProgress ? <GraduationCap /> : <span>{training.orden}</span>}
                  </div>
                  <div className="training-content">
                    <div className="training-title-row">
                      <div>
                        <span className="training-code">{training.id_curso}</span>
                        <h3>{training.nombre_curso}</h3>
                      </div>
                      <span className={`training-state ${finalized ? "done" : inProgress ? "progress" : locked ? "blocked" : "ready"}`}>
                        {locked ? "Pendiente · bloqueada" : trainingStatusLabel(trainingStatus)}
                      </span>
                    </div>
                    <TrainingDetailFields userId={user.id} training={training} encargados={encargados} onSaved={reload} />
                    {finalized && training.completado_en ? (
                      <small>Completada el {formatDateTimeLima(training.completado_en)}</small>
                    ) : null}
                    <div className="training-action">
                      <SelectInput
                        label="Estado"
                        value={trainingStatus}
                        options={availableStatusOptions}
                        disabled={Boolean(savingCourse) || locked}
                        onChange={(estado) => updateTraining(training, estado)}
                        hint={locked
                          ? `Completa primero CAP ${Number(training.orden) - 1}`
                          : cannotChange ? "Puedes avanzar; no retroceder mientras haya una capacitacion posterior iniciada." : undefined}
                      />
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {status ? <StatusAlert status={status} /> : null}
      </section>
    </div>
  );
}

function TrainingBarChart({ completed, inProgress, pending, ariaLabel, onSelectGroup }) {
  const total = completed + inProgress + pending;
  const percentOf = (value) => (total ? Math.round((value / total) * 100) : 0);
  const rows = [
    { key: "completado", label: "Hicieron la capacitacion", value: completed, percent: percentOf(completed), tone: "done", Icon: CheckCircle2 },
    { key: "en_curso", label: "En curso", value: inProgress, percent: percentOf(inProgress), tone: "progress", Icon: Clock3 },
    { key: "pendiente", label: "No hicieron la capacitacion", value: pending, percent: percentOf(pending), tone: "pending", Icon: AlertTriangle }
  ];

  return (
    <div className="training-chart" role="group" aria-label={ariaLabel}>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          className={`training-chart-row training-chart-row--${row.tone}`}
          onClick={() => onSelectGroup(row.key)}
          aria-label={`${row.label}: ${row.value} trabajador(es), ${row.percent}%. Presiona para ver el listado.`}
        >
          <span className="training-chart-row-icon"><row.Icon aria-hidden="true" /></span>
          <span className="training-chart-row-body">
            <span className="training-chart-row-head">
              <span className="training-chart-row-label">{row.label}</span>
              <span className="training-chart-row-value">{row.value} <small>({row.percent}%)</small></span>
            </span>
            <span className="training-chart-row-track">
              <span className="training-chart-row-fill" style={{ width: `${Math.max(row.percent, row.value ? 3 : 0)}%` }} />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TrainingDetailModal({ course, groupLabel, users, onClose }) {
  const [search, setSearch] = useState("");
  const filtered = users.filter((item) => (
    !search.trim() || normalizeText(`${item.nombre || ""} ${item.email || ""}`).includes(normalizeText(search))
  ));

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="worker-profile-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="worker-profile-dialog training-detail-dialog" role="dialog" aria-modal="true" aria-label={`${groupLabel} - ${course}`}>
        <header className="worker-profile-header">
          <div className="worker-profile-identity">
            <span className="worker-profile-avatar"><GraduationCap /></span>
            <div>
              <p className="eyebrow">Registros de usuario_capacitaciones · {course}</p>
              <h2>{groupLabel}</h2>
              <span>{users.length} trabajador(es) · {users.filter((item) => item.tiene_registro).length} registro(s) creados</span>
            </div>
          </div>
          <button type="button" className="profile-close" aria-label="Cerrar" onClick={onClose}>
            <X />
          </button>
        </header>

        <label className="field attendance-search-field">
          <span className="field-label">Buscar trabajador</span>
          <span className="search-input">
            <Search aria-hidden="true" />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nombre o correo"
              autoFocus
            />
          </span>
        </label>

        <div className="training-detail-table">
          <DataTable
            rows={filtered.map((item) => ({
              id: item.id,
              Nombre: item.nombre || "Sin nombre",
              Correo: item.email || "-",
              Rol: item.rol || "-",
              Estado: trainingStatusLabel(item.estado),
              Duración: item.nro_horas || "-",
              Encargado: item.encargado || "-",
              "Fecha de finalización": item.completado_en ? formatDateTimeLima(item.completado_en) : "-"
            }))}
            columns={["Nombre", "Correo", "Rol", "Estado", "Duración", "Encargado", "Fecha de finalización"]}
            empty="No hay trabajadores en este grupo."
          />
        </div>
      </section>
    </div>
  );
}

function TrainingsPanel() {
  const { data: users = [], loading: usersLoading, error: usersError, reload: reloadUsers } = useAsyncData(selectUsers, [], []);
  const { data: courses = [], loading: coursesLoading, error: coursesError, reload: reloadCourses } = useAsyncData(listTrainingCourses, [], []);
  const {
    data: allCourses = [],
    loading: allCoursesLoading,
    error: allCoursesError,
    reload: reloadAllCourses
  } = useAsyncData(() => listTrainingCourses(true), [], []);
  const [courseId, setCourseId] = useState("");
  const [tab, setTab] = useState("Resumen");
  const [modalGroup, setModalGroup] = useState("");
  const [profileUserId, setProfileUserId] = useState("");
  const [showInactiveWorkers, setShowInactiveWorkers] = useState(false);

  function reloadCourseData() {
    reloadCourses();
    reloadAllCourses();
  }

  useEffect(() => {
    if (!courseId && courses.length) setCourseId(courses[0].id_curso);
  }, [courses, courseId]);

  const { data: statusData, loading: statusLoading, error: statusError, reload: reloadStatus } = useAsyncData(
    () => (courseId ? getTrainingStatusByCourse(courseId) : Promise.resolve(null)),
    [courseId],
    null
  );

  useEffect(() => {
    setModalGroup("");
  }, [courseId]);

  const selectedCourse = courses.find((course) => course.id_curso === courseId);
  const statusUsers = statusData?.users || [];
  const activeUsers = statusUsers.filter((item) => boolValue(item.activo) && normalizeRole(item.rol) !== "administrador");
  const completedUsers = activeUsers.filter((item) => item.estado === "finalizado");
  const inProgressUsers = activeUsers.filter((item) => item.estado === "en_curso");
  const pendingUsers = activeUsers.filter((item) => item.estado !== "finalizado" && item.estado !== "en_curso");
  const percent = activeUsers.length ? Math.round((completedUsers.length / activeUsers.length) * 100) : 0;
  const modalUsers = modalGroup === "completado" ? completedUsers : modalGroup === "en_curso" ? inProgressUsers : modalGroup === "pendiente" ? pendingUsers : [];

  const trainingUsers = users.filter((user) => normalizeRole(user.rol) !== "administrador");
  const profileUser = trainingUsers.find((user) => String(user.id) === String(profileUserId));
  const inactiveWorkerCount = trainingUsers.filter((user) => !boolValue(user.activo)).length;
  const visibleWorkers = showInactiveWorkers ? trainingUsers : trainingUsers.filter((user) => boolValue(user.activo));
  const workerRows = visibleWorkers.map((user) => ({
    id: user.id,
    Nombre: user.nombre,
    Correo: user.email,
    Rol: normalizeRole(user.rol),
    Activo: boolValue(user.activo)
  }));

  return (
    <div className="stack">
      <Panel
        title="Capacitaciones por trabajador"
        eyebrow="Perfil individual"
        actions={
          <Button
            variant="secondary"
            icon={showInactiveWorkers ? EyeOff : Eye}
            onClick={() => setShowInactiveWorkers((current) => !current)}
          >
            {showInactiveWorkers ? "Ocultar inactivos" : `Mostrar inactivos (${inactiveWorkerCount})`}
          </Button>
        }
      >
        <Alert>Presiona un trabajador para abrir su perfil y revisar sus capacitaciones.</Alert>
        {usersLoading ? (
          <LoadingBlock />
        ) : (
          <DataTable
            rows={workerRows}
            columns={["Nombre", "Correo", "Rol", "Activo"]}
            onRowClick={(row) => setProfileUserId(String(row.id))}
            empty={showInactiveWorkers ? "No hay usuarios registrados." : "No hay usuarios activos. Presiona \"Mostrar inactivos\" para verlos."}
          />
        )}
        {usersError ? <Alert type="error">{usersError}</Alert> : null}
      </Panel>

      <Panel
        title="Capacitaciones"
        eyebrow="Seguimiento por curso"
        actions={
          <Button variant="secondary" icon={RefreshCcw} onClick={() => { reloadUsers(); reloadStatus(); }}>
            Actualizar
          </Button>
        }
      >
        <Tabs tabs={["Resumen", "Asignar capacitacion", "Cursos"]} active={tab} onChange={setTab} />

        {tab === "Resumen" ? (
          <div className="stack">
            {coursesError ? <Alert type="error">{coursesError}</Alert> : null}
            <SelectInput
              label="Capacitacion"
              value={courseId}
              onChange={setCourseId}
              options={[
                { value: "", label: coursesLoading ? "Cargando..." : "Selecciona una capacitacion" },
                ...courses.map((course) => ({ value: course.id_curso, label: course.nombre_curso || "Capacitación sin nombre" }))
              ]}
            />
            {statusLoading ? <LoadingBlock /> : null}
            {statusError ? <Alert type="error">{statusError}</Alert> : null}
            {!statusLoading && !statusError && courseId ? (
              <>
                <div className="metrics-row">
                  <Metric label="Hicieron la capacitacion" value={completedUsers.length} tone="accent" />
                  <Metric label="En curso" value={inProgressUsers.length} />
                  <Metric label="No la hicieron" value={pendingUsers.length} />
                  <Metric label="% completado" value={`${percent}%`} />
                </div>
                <TrainingBarChart
                  completed={completedUsers.length}
                  inProgress={inProgressUsers.length}
                  pending={pendingUsers.length}
                  ariaLabel={`Trabajadores activos que hicieron, estan en curso o no hicieron la capacitacion ${selectedCourse?.nombre_curso || courseId}`}
                  onSelectGroup={setModalGroup}
                />
                <Alert>Haz clic en una barra para ver el listado de trabajadores en una ventana flotante.</Alert>
              </>
            ) : null}
          </div>
        ) : null}

        {tab === "Asignar capacitacion" ? (
          usersLoading ? (
            <LoadingBlock />
          ) : (
            <>
              {usersError ? <Alert type="error">{usersError}</Alert> : null}
              <BulkTrainingPanel users={trainingUsers} />
            </>
          )
        ) : null}

        {tab === "Cursos" ? (
          <CoursesEditor
            courses={allCourses}
            loading={allCoursesLoading}
            error={allCoursesError}
            onReload={reloadCourseData}
          />
        ) : null}
      </Panel>

      {modalGroup ? (
        <TrainingDetailModal
          course={selectedCourse ? `${selectedCourse.id_curso} - ${selectedCourse.nombre_curso}` : courseId}
          groupLabel={
            modalGroup === "completado"
              ? "Hicieron la capacitacion"
              : modalGroup === "en_curso"
                ? "En curso"
                : "No hicieron la capacitacion"
          }
          users={modalUsers}
          onClose={() => setModalGroup("")}
        />
      ) : null}

      {profileUser ? (
        <WorkerTrainingProfile user={profileUser} onClose={() => setProfileUserId("")} />
      ) : null}
    </div>
  );
}

function CourseCard({ course, onSaved, onDeleted }) {
  const [nombreCurso, setNombreCurso] = useState(course.nombre_curso || "");
  const [competencias, setCompetencias] = useState(course.competencias || "");
  const [activo, setActivo] = useState(boolValue(course.activo));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    setNombreCurso(course.nombre_curso || "");
    setCompetencias(course.competencias || "");
    setActivo(boolValue(course.activo));
  }, [course.nombre_curso, course.competencias, course.activo]);

  const dirty =
    nombreCurso !== (course.nombre_curso || "") ||
    competencias !== (course.competencias || "") ||
    activo !== boolValue(course.activo);

  async function handleSave() {
    setStatus(null);
    if (!nombreCurso.trim()) {
      setStatus({ type: "error", message: "El curso no puede quedar vacio." });
      return;
    }
    if (!competencias.trim()) {
      setStatus({ type: "error", message: "La competencia no puede quedar vacia." });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateTrainingCourse(course.id_curso, {
        nombre_curso: nombreCurso.trim(),
        competencias: competencias.trim(),
        activo
      });
      setStatus({ type: "success", message: "Capacitacion actualizada." });
      onSaved(updated);
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(
      `Eliminar "${course.id_curso} - ${course.nombre_curso}"? Si hay trabajadores con progreso registrado en este curso, se desactivara en su lugar.`
    )) return;
    setStatus(null);
    setDeleting(true);
    try {
      const result = await deleteTrainingCourse(course.id_curso);
      if (result?.archived) {
        setStatus({
          type: "warning",
          message: result.message || "Hay trabajadores con progreso en este curso; se desactivo en lugar de eliminarse."
        });
      }
      onDeleted();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="document-card training-course-card">
      <h3>{course.id_curso} - {course.nombre_curso}</h3>
      <div className="form-grid">
        <TextInput label="Curso" value={nombreCurso} onChange={setNombreCurso} maxLength={200} />
        <TextInput label="Competencia" value={competencias} onChange={setCompetencias} maxLength={150} />
      </div>
      <CheckboxInput label="Curso activo" checked={activo} onChange={setActivo} />
      <StatusAlert status={status} />
      <div className="form-actions">
        <Button variant="danger" icon={Trash2} loading={deleting} disabled={saving} onClick={handleDelete}>Eliminar</Button>
        <Button icon={Save} loading={saving} disabled={!dirty || deleting} onClick={handleSave}>Guardar</Button>
      </div>
    </article>
  );
}

function CourseCreateForm({ onCreated }) {
  const [nombreCurso, setNombreCurso] = useState("");
  const [competencias, setCompetencias] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!nombreCurso.trim()) {
      setStatus({ type: "error", message: "El curso no puede quedar vacio." });
      return;
    }
    if (!competencias.trim()) {
      setStatus({ type: "error", message: "La competencia no puede quedar vacia." });
      return;
    }
    setSaving(true);
    try {
      const created = await createTrainingCourse({ nombre_curso: nombreCurso.trim(), competencias: competencias.trim() });
      setNombreCurso("");
      setCompetencias("");
      setStatus({ type: "success", message: `${created.id_curso} creado correctamente.` });
      onCreated(created);
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={handleCreate}>
      <TextInput label="Curso" value={nombreCurso} onChange={setNombreCurso} placeholder="Nombre de la capacitacion" maxLength={200} />
      <TextInput label="Competencia" value={competencias} onChange={setCompetencias} placeholder="Ej. OBLIGATORIO" maxLength={150} />
      <div className="form-span">
        <StatusAlert status={status} />
        <FormActions saving={saving} saveLabel="Agregar capacitacion" />
      </div>
    </form>
  );
}

function EncargadoCard({ encargado, onSaved }) {
  const [nombre, setNombre] = useState(encargado.nombre || "");
  const [activo, setActivo] = useState(boolValue(encargado.activo));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    setNombre(encargado.nombre || "");
    setActivo(boolValue(encargado.activo));
  }, [encargado.nombre, encargado.activo]);

  const dirty = nombre !== (encargado.nombre || "") || activo !== boolValue(encargado.activo);

  async function handleSave() {
    setStatus(null);
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre no puede quedar vacio." });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateEncargado(encargado.id, { nombre: nombre.trim(), activo });
      setStatus({ type: "success", message: "Encargado actualizado." });
      onSaved(updated);
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="document-card">
      <TextInput label="Nombre" value={nombre} onChange={setNombre} maxLength={150} />
      <CheckboxInput label="Encargado activo" checked={activo} onChange={setActivo} />
      <StatusAlert status={status} />
      <div className="form-actions">
        <Button icon={Save} loading={saving} disabled={!dirty} onClick={handleSave}>Guardar</Button>
      </div>
    </article>
  );
}

function EncargadoCreateForm({ onCreated }) {
  const [nombre, setNombre] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre no puede quedar vacio." });
      return;
    }
    setSaving(true);
    try {
      const created = await createEncargado(nombre.trim());
      setNombre("");
      setStatus({ type: "success", message: `${created.nombre} agregado correctamente.` });
      onCreated(created);
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={handleCreate}>
      <TextInput label="Nombre del encargado" value={nombre} onChange={setNombre} placeholder="Ej. Gisell Tejada" maxLength={150} />
      <div className="form-span">
        <StatusAlert status={status} />
        <FormActions saving={saving} saveLabel="Agregar encargado" />
      </div>
    </form>
  );
}

function EncargadosManager() {
  const { data: encargados = [], loading, error, reload } = useAsyncData(() => listEncargados(true), [], []);
  const [overrides, setOverrides] = useState({});

  function handleSaved(updated) {
    setOverrides((current) => ({ ...current, [updated.id]: updated }));
    reload();
  }

  return (
    <div className="stack">
      <Alert>
        Administra la lista de encargados disponibles. Al asignar capacitaciones en lote es obligatorio elegir uno de
        esta lista.
      </Alert>
      {error ? <Alert type="error">{error}</Alert> : null}
      <article className="document-card">
        <h3>Nuevo encargado</h3>
        <EncargadoCreateForm onCreated={reload} />
      </article>
      {loading ? (
        <LoadingBlock />
      ) : (
        <div className="documents-grid">
          {encargados.map((item) => (
            <EncargadoCard key={item.id} encargado={overrides[item.id] || item} onSaved={handleSaved} />
          ))}
          {!encargados.length ? <Alert>Todavia no hay encargados registrados.</Alert> : null}
        </div>
      )}
    </div>
  );
}

function CoursesEditor({ courses, loading, error, onReload }) {
  const [courseOverrides, setCourseOverrides] = useState({});

  function handleSaved(updated) {
    setCourseOverrides((current) => ({ ...current, [updated.id_curso]: updated }));
    onReload();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <Alert type="error">{error}</Alert>;

  return (
    <div className="stack">
      <Alert>
        Agrega, edita o desactiva capacitaciones. La duracion y el encargado ya no son globales: se ajustan por
        trabajador desde su perfil en la tabla de arriba, o se fijan al asignar en lote.
      </Alert>
      <article className="document-card">
        <h3>Nueva capacitacion</h3>
        <CourseCreateForm onCreated={onReload} />
      </article>
      <div className="documents-grid training-courses-grid">
        {courses.map((course) => (
          <CourseCard
            key={course.id_curso}
            course={courseOverrides[course.id_curso] || course}
            onSaved={handleSaved}
            onDeleted={onReload}
          />
        ))}
      </div>

      <Panel title="Encargados" eyebrow="Catalogo para asignar capacitaciones">
        <EncargadosManager />
      </Panel>
    </div>
  );
}

// El nuevo estado que se va a aplicar determina que grupo tiene sentido
// mostrar: solo tiene sentido pasar a "completado" a quienes ya estan "en
// curso", y a "en curso" a quienes siguen "pendiente". Al elegir
// "pendiente" no se filtra por estado actual (lista general).
const BULK_SOURCE_STATUS_BY_TARGET = {
  finalizado: "en_curso",
  en_curso: "pendiente",
  pendiente: ""
};

function BulkTrainingPanel({ users }) {
  const { data: courses = [], loading: coursesLoading, error: coursesError } = useAsyncData(listTrainingCourses, [], []);
  const { data: encargados = [], loading: encargadosLoading, error: encargadosError } = useAsyncData(listEncargados, [], []);
  const [courseId, setCourseId] = useState("");
  const [estado, setEstado] = useState("finalizado");
  const [encargado, setEncargado] = useState("");
  const [nroHoras, setNroHoras] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("activos");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [successDialog, setSuccessDialog] = useState(null);

  const { data: courseStatusData, loading: courseStatusLoading, reload: reloadCourseStatus } = useAsyncData(
    () => (courseId ? getTrainingStatusByCourse(courseId) : Promise.resolve(null)),
    [courseId],
    null
  );

  useEffect(() => {
    setSelectedIds(new Set());
  }, [courseId]);
  const statusByUserId = new Map((courseStatusData?.users || []).map((item) => [Number(item.id), item.estado]));
  const sourceStatus = BULK_SOURCE_STATUS_BY_TARGET[estado] ?? "";

  const filteredUsers = users.filter((item) => {
    if (normalizeRole(item.rol) === "administrador") return false;
    if (statusFilter === "activos" && !boolValue(item.activo)) return false;
    if (statusFilter === "inactivos" && boolValue(item.activo)) return false;
    const isSelected = selectedIds.has(String(item.id));
    if (courseId && sourceStatus && !isSelected) {
      const currentStatus = statusByUserId.get(Number(item.id)) || "pendiente";
      if (currentStatus !== sourceStatus) return false;
    }
    if (!search.trim()) return true;
    return normalizeText(`${item.nombre || ""} ${item.email || ""}`).includes(normalizeText(search));
  });

  function toggleUser(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      filteredUsers.forEach((item) => next.add(String(item.id)));
      return next;
    });
  }

  async function handleApply() {
    setStatus(null);
    if (!courseId) {
      setStatus({ type: "error", message: "Selecciona una capacitacion." });
      return;
    }
    if (!encargado) {
      setStatus({ type: "error", message: "Selecciona un encargado." });
      return;
    }
    if (!selectedIds.size) {
      setStatus({ type: "error", message: "Selecciona al menos un trabajador." });
      return;
    }
    setSaving(true);
    try {
      const result = await bulkSetTrainingStatus([...selectedIds].map(Number), courseId, estado, {
        encargado,
        nroHoras: nroHoras.trim()
      });
      setStatus({
        type: "success",
        message: `${result.updated} trabajador(es) quedaron con ${courseId} en "${trainingStatusLabel(estado).toLowerCase()}" (encargado: ${encargado}).`
      });
      setSuccessDialog({ updated: result.updated, courseId, estado });
      setSelectedIds(new Set());
      reloadCourseStatus();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <Alert>
        Selecciona varios trabajadores y una capacitacion para marcarla igual en todos a la vez. Las capacitaciones
        ya no son secuenciales: se pueden completar en cualquier orden, sin depender de las anteriores.
      </Alert>
      {coursesError ? <Alert type="error">{coursesError}</Alert> : null}
      {encargadosError ? <Alert type="error">{encargadosError}</Alert> : null}
      <div className="form-grid">
        <SelectInput
          label="Capacitacion"
          value={courseId}
          onChange={setCourseId}
          options={[
            { value: "", label: coursesLoading ? "Cargando..." : "Selecciona una capacitacion" },
            ...courses.map((course) => ({ value: course.id_curso, label: course.nombre_curso || "Capacitación sin nombre" }))
          ]}
        />
        <SelectInput label="Nuevo estado" value={estado} onChange={setEstado} options={trainingStatusOptions} />
        <SelectInput
          label="Encargado (obligatorio)"
          value={encargado}
          onChange={setEncargado}
          options={[
            { value: "", label: encargadosLoading ? "Cargando..." : "Selecciona un encargado" },
            ...encargados.map((item) => ({ value: item.nombre, label: item.nombre }))
          ]}
          hint={!encargadosLoading && !encargados.length ? "No hay encargados registrados. Agrega uno en la pestana Cursos." : undefined}
        />
        <TextInput label="Duracion (opcional)" value={nroHoras} onChange={setNroHoras} placeholder="Ej. 1 Hora" maxLength={60} />
      </div>
      <div className="attendance-search-row">
        <label className="field attendance-search-field">
          <span className="field-label">Buscar trabajador</span>
          <span className="search-input">
            <Search aria-hidden="true" />
            <input
              className="input"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nombre o correo"
            />
          </span>
        </label>
        <SelectInput
          label="Mostrar"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "activos", label: "Activos" },
            { value: "inactivos", label: "Inactivos" },
            { value: "todos", label: "Todos" }
          ]}
        />
      </div>
      <div className="toolbar">
        <Button variant="secondary" type="button" onClick={selectAllVisible}>Seleccionar visibles ({filteredUsers.length})</Button>
        <Button variant="secondary" type="button" onClick={() => setSelectedIds(new Set())}>Quitar seleccion</Button>
        <span className="attendance-marked-count">{selectedIds.size} seleccionados</span>
      </div>
      {courseId ? (
        <Alert>
          Lista: {sourceStatus ? trainingStatusLabel(sourceStatus) : "Todos"} ({filteredUsers.length})
          {courseStatusLoading ? " · Cargando estado actual..." : ""}
        </Alert>
      ) : null}
      {!filteredUsers.length ? <Alert>No se encontraron trabajadores para estos filtros.</Alert> : null}
      <div className="attendance-list">
        {filteredUsers.map((item) => {
          const checked = selectedIds.has(String(item.id));
          const currentStatus = courseId ? (statusByUserId.get(Number(item.id)) || "pendiente") : null;
          return (
            <label key={item.id} className={`attendance-row${checked ? " marked" : ""}`}>
              <span>
                <strong>{item.nombre || "Sin nombre"}</strong>
                <small>
                  {item.email} · {boolValue(item.activo) ? "Activo" : "Inactivo"}
                  {currentStatus ? ` · ${trainingStatusLabel(currentStatus)}` : ""}
                </small>
              </span>
              <input type="checkbox" checked={checked} onChange={() => toggleUser(item.id)} />
            </label>
          );
        })}
      </div>
      <StatusAlert status={status} />
      <div className="form-actions">
        <Button icon={Save} loading={saving} onClick={handleApply}>Aplicar a {selectedIds.size} trabajador(es)</Button>
      </div>

      {successDialog ? (
        <div className="save-success-overlay" role="presentation">
          <section
            className="save-success-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="training-success-title"
            aria-describedby="training-success-description"
          >
            <div className="save-success-icon" aria-hidden="true">
              <CheckCircle2 />
            </div>
            <div className="save-success-copy">
              <p className="eyebrow">Proceso completado</p>
              <h2 id="training-success-title">¡Capacitación guardada correctamente!</h2>
              <p id="training-success-description">
                {successDialog.updated} trabajador{successDialog.updated === 1 ? "" : "es"} quedaron con{" "}
                {successDialog.courseId} en "{trainingStatusLabel(successDialog.estado).toLowerCase()}".
              </p>
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
    </div>
  );
}

function defaultTaskForm() {
  return {
    titulo: "",
    activo: true,
    tipo_tarea: "General",
    tipo_medicion: "cantidad",
    unidad_base: "Ninguna",
    requiere_marca: false,
    requiere_tiempo: false,
    requiere_lote: false,
    requiere_numero_guia: false,
    requiere_hangtag: false,
    requiere_tienda: false,
    obligatorio_marca: true,
    obligatorio_tiempo: true,
    obligatorio_lote: true,
    obligatorio_numero_guia: true,
    obligatorio_hangtag: true,
    obligatorio_tienda: true,
    ranges: emptyQuantityRanges(),
    puntaje_fijo: 1,
    puntaje_turno_simple: 1,
    puntaje_turno_completo: 1
  };
}

// Lee las banderas guardadas en Supabase para precargar el formulario.
function getTaskFieldFlagsForm(task) {
  const flags = getTaskFieldFlags(task);
  const required = getTaskRequiredFlags(task);
  return {
    requiere_marca: flags.marca,
    requiere_tiempo: flags.tiempo,
    requiere_lote: flags.lote,
    requiere_numero_guia: flags.guia,
    requiere_hangtag: flags.hangtag,
    requiere_tienda: flags.tienda,
    obligatorio_marca: required.marca,
    obligatorio_tiempo: required.tiempo,
    obligatorio_lote: required.lote,
    obligatorio_numero_guia: required.guia,
    obligatorio_hangtag: required.hangtag,
    obligatorio_tienda: required.tienda
  };
}

function taskPayloadFromForm(form) {
  const tipo = normalizeMeasurementType(form.tipo_medicion);
  // Las banderas se guardan tal como las marca el formulario: son la fuente de
  // verdad de que campos pide la tarea y no se deducen del nombre.
  return {
    nombre: form.titulo.trim(),
    titulo: form.titulo.trim(),
    activo: Boolean(form.activo),
    tipo_tarea: form.tipo_tarea || "General",
    tipo_medicion: tipo,
    unidad_medida: form.unidad_base.trim() || "Ninguna",
    unidad_base: form.unidad_base.trim() || null,
    requiere_marca: Boolean(form.requiere_marca),
    requiere_tiempo: Boolean(form.requiere_tiempo || tipo === "tiempo"),
    requiere_lote: Boolean(form.requiere_lote),
    requiere_numero_guia: Boolean(form.requiere_numero_guia),
    requiere_hangtag: Boolean(form.requiere_hangtag),
    requiere_tienda: Boolean(form.requiere_tienda),
    obligatorio_marca: Boolean(form.obligatorio_marca),
    obligatorio_tiempo: Boolean(form.obligatorio_tiempo),
    obligatorio_lote: Boolean(form.obligatorio_lote),
    obligatorio_numero_guia: Boolean(form.obligatorio_numero_guia),
    obligatorio_hangtag: Boolean(form.obligatorio_hangtag),
    obligatorio_tienda: Boolean(form.obligatorio_tienda)
  };
}

function scoringRulesFromForm(form) {
  const tipo = normalizeMeasurementType(form.tipo_medicion);
  if (tipo === "cantidad") {
    return form.ranges.map((range, index) => ({
      tipo_regla: "CANTIDAD",
      desde: Number(range.desde),
      hasta: range.hasta === "" || range.hasta === null ? null : Number(range.hasta),
      turno: null,
      puntos: index + 1
    }));
  }
  if (tipo === "fijo") {
    return [{ tipo_regla: "FIJO", desde: null, hasta: null, turno: null, puntos: Number(form.puntaje_fijo) }];
  }
  if (tipo === "turno") {
    return [
      { tipo_regla: "TURNO", desde: null, hasta: null, turno: "Simple", puntos: Number(form.puntaje_turno_simple) },
      { tipo_regla: "TURNO", desde: null, hasta: null, turno: "Completo", puntos: Number(form.puntaje_turno_completo) }
    ];
  }
  return [];
}

async function loadTaskBundle() {
  const tasks = await listTasks();
  const rulesByTaskId = {};
  tasks.forEach((task) => {
    rulesByTaskId[String(task.id)] = task.reglas_puntaje || [];
  });
  return { tasks, rulesByTaskId };
}

async function loadAverageReferenceBundle() {
  const [tasks, references] = await Promise.all([listTasks(), loadAverageReferences()]);
  return {
    tasks: tasks.filter((task) => isGroupLeaderTimeTask(task)),
    ...references
  };
}

function AverageReferenceSection() {
  const { data, loading, error, reload } = useAsyncData(
    loadAverageReferenceBundle,
    [],
    { tasks: [], averageReferenceByTask: {}, averageReferenceMigrationRequired: false }
  );
  const tasks = data?.tasks || [];
  const averageReferenceByTask = data?.averageReferenceByTask || {};
  const averageFields = useMemo(() => tasks.flatMap((task) => {
    const title = getTaskTitle(task) || `Tarea ${task.id}`;
    if (getTaskFieldFlags(task).hangtag) {
      return [
        { key: `${task.id}-con`, taskId: task.id, hangtagKey: "CON_HANGTAG", label: `${title} - Con hangtag` },
        { key: `${task.id}-sin`, taskId: task.id, hangtagKey: "SIN_HANGTAG", label: `${title} - Sin hangtag` }
      ];
    }
    return [{ key: String(task.id), taskId: task.id, hangtagKey: "", label: title }];
  }), [tasks]);

  async function saveAverageReference(taskId, hangtagKey, value) {
    await updateGroupLeaderAverageReference(taskId, value, hangtagKey);
    await reload();
  }

  return (
    <div className="stack">
      <Panel
        title="Promedios de referencia"
        eyebrow="Tareas y puntajes"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        <div className="group-average-reference">
          <p className="group-average-reference-hint">
            Promedio de referencia por tarea: cada registro del historial se compara contra el promedio de su tarea para marcarlo por encima o por debajo.
          </p>
          {data.averageReferenceMigrationRequired ? (
            <Alert type="error">Falta aplicar la migracion sql/031_promedio_referencia_jefe_equipo.sql en Supabase para guardar estos valores.</Alert>
          ) : null}
          <div className="group-average-reference-grid">
            {averageFields.map((field) => (
              <TaskAverageField
                key={field.key}
                label={field.label}
                value={averageReferenceByTask[field.taskId]?.[field.hangtagKey]}
                onSave={(value) => saveAverageReference(field.taskId, field.hangtagKey, value)}
              />
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function TasksPanel() {
  const [section, setSection] = useState("Puntos a favor");

  return (
    <div className="stack">
      <Tabs tabs={["Puntos a favor", "Puntos en contra", "Promedios de referencia"]} active={section} onChange={setSection} />
      {section === "Puntos a favor" ? <TaskScoringSection /> : null}
      {section === "Puntos en contra" ? <PenaltiesSection /> : null}
      {section === "Promedios de referencia" ? <AverageReferenceSection /> : null}
    </div>
  );
}

function PenaltiesSection() {
  const { data, loading, error, reload } = useAsyncData(listPenalizaciones, [], null);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm(data.map((item) => ({ ...item, puntos: String(item.puntos) })));
  }, [data]);

  const rows = form || PENALTY_KEYS.map((item) => ({ ...item, puntos: "0" }));

  function updatePoints(clave, puntos) {
    setForm((current) => (current || []).map((item) => (item.clave === clave ? { ...item, puntos } : item)));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);

    for (const item of rows) {
      const value = Number(item.puntos);
      if (item.puntos === "" || !Number.isFinite(value) || value < 0) {
        setStatus({ type: "error", message: `Ingresa un valor valido y no negativo para ${item.etiqueta}.` });
        return;
      }
    }

    setSaving(true);
    try {
      await savePenalizaciones(rows);
      setStatus({ type: "success", message: "Puntos en contra guardados correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <Panel
        title="Puntos en contra"
        eyebrow="Descuentos"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        <Alert>
          Define cuantos puntos resta cada ocurrencia. Ingresa el valor como numero positivo: se descuenta esa cantidad
          por cada carta de amonestacion, memorandum, inasistencia (solo Falta y Suspension) o tardanza.
        </Alert>

        <form className="stack" onSubmit={handleSubmit} noValidate>
          <div className="form-grid">
            {rows.map((item) => (
              <TextInput
                key={item.clave}
                label={`${item.etiqueta} (puntos a restar)`}
                type="number"
                min="0"
                step="0.5"
                value={item.puntos}
                onChange={(puntos) => updatePoints(item.clave, puntos)}
                hint={item.descripcion}
              />
            ))}
          </div>
          <StatusAlert status={status} />
          <div className="form-actions">
            <Button type="submit" icon={Save} loading={saving} disabled={loading}>Guardar puntos en contra</Button>
          </div>
        </form>
      </Panel>

      <Panel title="Resumen de descuentos" eyebrow="Configuracion actual">
        <DataTable
          rows={rows.map((item) => ({
            Concepto: item.etiqueta,
            "Puntos por ocurrencia": `-${Number(item.puntos || 0)}`,
            Detalle: item.descripcion
          }))}
          columns={["Concepto", "Puntos por ocurrencia", "Detalle"]}
          compact
        />
      </Panel>
    </div>
  );
}

function TaskScoringSection() {
  const { data, loading, error, reload } = useAsyncData(loadTaskBundle, [], { tasks: [], rulesByTaskId: {} });
  const [tab, setTab] = useState("Crear tarea");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState(defaultTaskForm());
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [editForm, setEditForm] = useState(defaultTaskForm());

  const tasks = data?.tasks || [];
  const rulesByTaskId = data?.rulesByTaskId || {};
  const selectedTask = tasks.find((task) => String(task.id) === String(selectedTaskId));

  useEffect(() => {
    if (!selectedTask) return;
    const rules = rulesByTaskId[String(selectedTask.id)] || [];
    setEditForm({
      titulo: getTaskTitle(selectedTask),
      activo: boolValue(selectedTask.activo),
      tipo_tarea: selectedTask.tipo_tarea || "General",
      tipo_medicion: normalizeMeasurementType(selectedTask.tipo_medicion),
      unidad_base: selectedTask.unidad_medida || selectedTask.unidad_base || selectedTask.unidad || "Ninguna",
      ...getTaskFieldFlagsForm(selectedTask),
      ranges: quantityRangesFromRules(rules),
      puntaje_fijo: Number(selectedTask.puntaje_fijo || selectedTask.puntaje || 1),
      puntaje_turno_simple: Number(selectedTask.puntaje_turno_simple || selectedTask.puntos_turno_simple || 1),
      puntaje_turno_completo: Number(selectedTask.puntaje_turno_completo || selectedTask.puntos_turno_completo || 1)
    });
  }, [selectedTask?.id, rulesByTaskId]);

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!createForm.titulo.trim()) {
      setStatus({ type: "error", message: "El nombre de tarea es obligatorio." });
      return;
    }
    const rangesError = normalizeMeasurementType(createForm.tipo_medicion) === "cantidad"
      ? validateQuantityRanges(createForm.ranges)
      : "";
    if (rangesError) {
      setStatus({ type: "error", message: rangesError });
      return;
    }
    setSaving(true);
    try {
      const created = await createTask(taskPayloadFromForm(createForm));
      if (created?.id) await setTaskScoringRules(created.id, scoringRulesFromForm(createForm));
      setCreateForm(defaultTaskForm());
      setStatus({ type: "success", message: "Tarea creada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    if (!selectedTask) return;
    setStatus(null);
    if (!editForm.titulo.trim()) {
      setStatus({ type: "error", message: "El nombre de tarea es obligatorio." });
      return;
    }
    const rangesError = normalizeMeasurementType(editForm.tipo_medicion) === "cantidad"
      ? validateQuantityRanges(editForm.ranges)
      : "";
    if (rangesError) {
      setStatus({ type: "error", message: rangesError });
      return;
    }
    setSaving(true);
    try {
      await updateTask(selectedTask.id, taskPayloadFromForm(editForm), selectedTask);
      await setTaskScoringRules(selectedTask.id, scoringRulesFromForm(editForm));
      setStatus({ type: "success", message: "Tarea actualizada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTask() {
    if (!selectedTask) return;
    setStatus(null);
    setSaving(true);
    try {
      const result = await deleteTask(selectedTask.id);
      setSelectedTaskId("");
      setStatus({
        type: result?.archived ? "warning" : "success",
        message: result?.archived
          ? "La tarea tiene registros relacionados, por eso fue desactivada para conservar el historial."
          : "Tarea eliminada correctamente."
      });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const summaryRows = tasks.map((task) => {
    const tipo = normalizeMeasurementType(task.tipo_medicion);
    const row = { Actividad: getTaskTitle(task), "Tipo de puntaje": tipo };
    for (let point = 1; point <= 10; point += 1) row[`${point} punto`] = "";
    if (tipo === "cantidad") {
      quantityRangesFromRules(rulesByTaskId[String(task.id)] || []).forEach((range, index) => {
        if (range.desde === "") return;
        row[`${index + 1} punto`] = `${range.desde} - ${range.hasta === "" || range.hasta === null ? "sin limite" : range.hasta}`;
      });
    }
    if (tipo === "fijo") {
      const score = Number(task.puntaje_fijo || task.puntaje || 0);
      if (score >= 1 && score <= 10) row[`${score} punto`] = "SI";
    }
    if (tipo === "turno") {
      const simple = Number(task.puntaje_turno_simple || task.puntos_turno_simple || 0);
      const complete = Number(task.puntaje_turno_completo || task.puntos_turno_completo || 0);
      if (simple >= 1 && simple <= 10) row[`${simple} punto`] = "S";
      if (complete >= 1 && complete <= 10) row[`${complete} punto`] = "C";
    }
    return row;
  });

  return (
    <div className="stack">
      <Panel title="Configuracion de puntajes" eyebrow="Tareas">
        {loading ? <LoadingBlock /> : <DataTable rows={summaryRows} compact />}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>

      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear tarea", "Editar tarea", "Eliminar tarea"]} active={tab} onChange={setTab} />

        {tab === "Crear tarea" ? (
          <TaskForm form={createForm} setForm={setCreateForm} onSubmit={handleCreate} saving={saving} submitLabel="Crear tarea" />
        ) : (
          <div className="stack">
            <SelectInput
              label={tab === "Editar tarea" ? "Selecciona una tarea" : "Tarea a eliminar"}
              value={selectedTaskId}
              onChange={setSelectedTaskId}
              options={[
                { value: "", label: "Selecciona una tarea" },
                ...tasks.map((task) => ({ value: String(task.id), label: getTaskTitle(task) || "Tarea sin título" }))
              ]}
            />
            {tab === "Editar tarea" && selectedTask ? (
              <TaskForm form={editForm} setForm={setEditForm} onSubmit={handleEdit} saving={saving} submitLabel="Guardar cambios" />
            ) : null}
            {tab === "Eliminar tarea" && selectedTask ? (
              <div className="danger-zone">
                <p>
                  Eliminaras la tarea {getTaskTitle(selectedTask)}. Si tiene actividades o incidencias relacionadas,
                  se desactivara para conservar el historial.
                </p>
                <Button variant="danger" icon={Trash2} loading={saving} onClick={handleDeleteTask}>Eliminar tarea</Button>
              </div>
            ) : null}
          </div>
        )}
        <StatusAlert status={status} />
      </Panel>
    </div>
  );
}

function TaskForm({ form, setForm, onSubmit, saving, submitLabel }) {
  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <div className="form-grid">
        <TextInput label="Nombre de tarea" value={form.titulo} onChange={(titulo) => setForm({ ...form, titulo })} />
        <SelectInput
          label="Categoria"
          value={form.tipo_tarea}
          onChange={(tipo_tarea) => setForm({ ...form, tipo_tarea })}
          options={["Ingreso", "Despacho", "General"]}
        />
        <SelectInput
          label="Tipo de puntaje"
          value={form.tipo_medicion}
          onChange={(tipo_medicion) => setForm({ ...form, tipo_medicion })}
          options={taskTypes}
        />
        <TextInput
          label="Unidad base"
          value={form.unidad_base}
          onChange={(unidad_base) => setForm({ ...form, unidad_base })}
          placeholder="Pares, cajas, bultos o Ninguna"
        />
        <CheckboxInput label="Tarea activa" checked={form.activo} onChange={(activo) => setForm({ ...form, activo })} />
        <TaskFieldControl form={form} setForm={setForm} label="Marca" requestedKey="requiere_marca" requiredKey="obligatorio_marca" />
        <TaskFieldControl form={form} setForm={setForm} label="Tiempo" requestedKey="requiere_tiempo" requiredKey="obligatorio_tiempo" hint="Solo el líder de equipo registra el tiempo de estas tareas." />
        <TaskFieldControl form={form} setForm={setForm} label="Lote" requestedKey="requiere_lote" requiredKey="obligatorio_lote" />
        <TaskFieldControl form={form} setForm={setForm} label="Número de guía" requestedKey="requiere_numero_guia" requiredKey="obligatorio_numero_guia" />
        <TaskFieldControl form={form} setForm={setForm} label="Hangtag" requestedKey="requiere_hangtag" requiredKey="obligatorio_hangtag" hint="Muestra el selector con hangtag / sin hangtag." />
        <TaskFieldControl form={form} setForm={setForm} label="Tienda" requestedKey="requiere_tienda" requiredKey="obligatorio_tienda" />
      </div>
      <ScoreFields form={form} setForm={setForm} />
      <div className="form-actions">
        <Button type="submit" icon={Save} loading={saving}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function TaskFieldControl({ form, setForm, label, requestedKey, requiredKey, hint }) {
  const requested = Boolean(form[requestedKey]);
  return (
    <div className={`task-field-control${requested ? " enabled" : ""}`}>
      <CheckboxInput
        label={`Pedir ${label.toLowerCase()}`}
        checked={requested}
        onChange={(checked) => setForm({ ...form, [requestedKey]: checked })}
        hint={hint}
      />
      <SwitchInput
        label="Ingreso de datos"
        checked={Boolean(form[requiredKey])}
        disabled={!requested}
        onChange={(checked) => setForm({ ...form, [requiredKey]: checked })}
        onLabel="Obligatorio"
        offLabel="Opcional"
      />
    </div>
  );
}

function ScoreFields({ form, setForm }) {
  const tipo = normalizeMeasurementType(form.tipo_medicion);
  if (tipo === "cantidad") {
    return (
      <div className="score-matrix">
        <div className="matrix-title">Rangos de cantidad para puntajes del 1 al 10</div>
        <Alert>Define desde y hasta para cada puntaje. En 10 puntos puedes dejar “Hasta” vacio para indicar que no tiene limite.</Alert>
        <div className="score-grid">
          {form.ranges.map((range, index) => (
            <label key={index} className="score-cell">
              <span>{index + 1} punto{index ? "s" : ""}</span>
              <div className="range-inputs">
                <input
                  aria-label={`Desde para ${index + 1} puntos`}
                  type="number"
                  min="0"
                  max={MAX_SCORE_QUANTITY}
                  step="1"
                  placeholder="Desde"
                  value={range.desde}
                  onChange={(event) => {
                    const ranges = form.ranges.map((item, itemIndex) => itemIndex === index ? { ...item, desde: event.target.value } : item);
                    setForm({ ...form, ranges });
                  }}
                />
                <input
                  aria-label={`Hasta para ${index + 1} puntos`}
                  type="number"
                  min="0"
                  max={MAX_SCORE_QUANTITY}
                  step="1"
                  placeholder={index === 9 ? "Sin limite" : "Hasta"}
                  value={range.hasta}
                  onChange={(event) => {
                    const ranges = form.ranges.map((item, itemIndex) => itemIndex === index ? { ...item, hasta: event.target.value } : item);
                    setForm({ ...form, ranges });
                  }}
                />
              </div>
            </label>
          ))}
        </div>
      </div>
    );
  }
  if (tipo === "fijo") {
    return (
      <SelectInput
        label="Puntaje fijo"
        value={String(form.puntaje_fijo)}
        onChange={(value) => setForm({ ...form, puntaje_fijo: Number(value) })}
        options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
      />
    );
  }
  if (tipo === "turno") {
    return (
      <div className="form-grid">
        <SelectInput
          label="Puntaje turno simple"
          value={String(form.puntaje_turno_simple)}
          onChange={(value) => setForm({ ...form, puntaje_turno_simple: Number(value) })}
          options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
        />
        <SelectInput
          label="Puntaje turno completo"
          value={String(form.puntaje_turno_completo)}
          onChange={(value) => setForm({ ...form, puntaje_turno_completo: Number(value) })}
          options={Array.from({ length: 10 }, (_, index) => String(index + 1))}
        />
      </div>
    );
  }
  return <Alert>Las tareas por tiempo usan la matriz historica de minutos.</Alert>;
}

const attendanceStateOptions = [
  { value: "FALTA", label: "Falta", abbreviation: "F" },
  { value: "ASISTENCIA", label: "Asistencia", abbreviation: "A" },
  { value: "TARDANZA", label: "Tardanza", abbreviation: "AT" },
  { value: "MEDIO_TURNO", label: "Medio turno", abbreviation: "MT" },
  { value: "APOYO", label: "Apoyo", abbreviation: "AP" },
  { value: "PERMISO", label: "Permiso", abbreviation: "P" },
  { value: "DESCANSO_MEDICO", label: "Descanso Médico", abbreviation: "DM" },
  { value: "SUSPENSION", label: "Suspensión", abbreviation: "S" }
];
const ATTENDANCE_PRESENT_STATES = new Set(["ASISTENCIA", "TARDANZA", "MEDIO_TURNO", "APOYO"]);

function attendanceStateLabel(value) {
  return attendanceStateOptions.find((option) => option.value === value)?.label || "Falta";
}

function AttendancePanel() {
  const [selectedDate, setSelectedDate] = useState(todayLimaISO());
  const [workerStatusFilter, setWorkerStatusFilter] = useState("activos");
  const [workerSearch, setWorkerSearch] = useState("");
  const [historyTab, setHistoryTab] = useState("Registros de Asistencia");
  const [historyUserId, setHistoryUserId] = useState("todos");
  const [historyMonth, setHistoryMonth] = useState(() => todayLimaISO().slice(0, 7));
  const [historyDay, setHistoryDay] = useState("todos");
  const [historyWorkerStatus, setHistoryWorkerStatus] = useState("activos");
  const [historyDateOrder, setHistoryDateOrder] = useState("desc");
  const [attendanceValues, setAttendanceValues] = useState({});
  const [attendanceObservations, setAttendanceObservations] = useState({});
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [successDialog, setSuccessDialog] = useState(null);
  const todayRef = useRef(todayLimaISO());
  // Trabajadores con una marca o una observacion tocadas en esta pantalla
  // que todavia no se guardaron. Mientras esten aqui, una recarga (el boton
  // Actualizar, o el reload automatico despues de guardar a otra persona) no
  // les pisa el valor local con lo que hay en la base de datos.
  const dirtyWorkersRef = useRef(new Set());

  useEffect(() => {
    dirtyWorkersRef.current = new Set();
  }, [selectedDate]);

  // Si la pestana se queda abierta y pasa la medianoche (Lima), la marcacion
  // debe verse "en 0" para el nuevo dia sin tocar el historial ya guardado.
  // Solo avanza la fecha si el admin seguia viendo "hoy"; si eligio a proposito
  // una fecha pasada para revisarla, no se la movemos.
  useEffect(() => {
    const timer = setInterval(() => {
      const today = todayLimaISO();
      if (today !== todayRef.current) {
        setSelectedDate((selected) => (selected === todayRef.current ? today : selected));
        todayRef.current = today;
      }
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [workers, allUsers, current, attendances] = await Promise.all([
        listWorkers(),
        selectUsers(),
        getAttendanceForDate(selectedDate),
        listAttendances()
      ]);
      return { workers, allUsers, current, attendances };
    },
    [selectedDate],
    { workers: [], allUsers: [], current: [], attendances: [] }
  );

  useEffect(() => {
    const currentMap = Object.fromEntries((data.current || []).map((row) => [row.usuario_id, String(row.estado || "FALTA").toUpperCase()]));
    const observationMap = Object.fromEntries((data.current || []).map((row) => [row.usuario_id, String(row.observacion || "")]));
    setAttendanceValues((previous) => {
      const nextValues = {};
      (data.workers || []).forEach((worker) => {
        nextValues[worker.id] = dirtyWorkersRef.current.has(worker.id)
          ? (previous[worker.id] ?? "")
          : (currentMap[worker.id] || "");
      });
      return nextValues;
    });
    setAttendanceObservations((previous) => {
      const nextObservations = {};
      (data.workers || []).forEach((worker) => {
        nextObservations[worker.id] = dirtyWorkersRef.current.has(worker.id)
          ? (previous[worker.id] ?? "")
          : (observationMap[worker.id] || "");
      });
      return nextObservations;
    });
  }, [data.current, data.workers]);

  const currentMarks = useMemo(
    () => Object.fromEntries((data.current || []).map((row) => [row.usuario_id, String(row.estado || "FALTA").toUpperCase()])),
    [data.current]
  );
  const currentObservations = useMemo(
    () => Object.fromEntries((data.current || []).map((row) => [row.usuario_id, String(row.observacion || "")])),
    [data.current]
  );

  const workers = data.workers || [];
  const activeWorkersCount = workers.filter((worker) => boolValue(worker.activo)).length;
  const inactiveWorkersCount = workers.length - activeWorkersCount;
  const statusFilteredWorkers = workers.filter((worker) => {
    if (workerStatusFilter === "todos") return true;
    return workerStatusFilter === "activos" ? boolValue(worker.activo) : !boolValue(worker.activo);
  });
  const normalizedWorkerSearch = normalizeText(workerSearch);
  const visibleWorkers = statusFilteredWorkers.filter((worker) => {
    if (!normalizedWorkerSearch) return true;
    return normalizeText(`${worker.nombre || ""} ${worker.email || ""}`).includes(normalizedWorkerSearch);
  });
  const workerFilterOptions = [
    { value: "activos", label: `Activos (${activeWorkersCount})` },
    { value: "inactivos", label: `Inactivos (${inactiveWorkersCount})` },
    { value: "todos", label: `Todos (${workers.length})` }
  ];
  const markedCount = statusFilteredWorkers.filter((worker) => Boolean(attendanceValues[worker.id])).length;

  function markWorker(worker, estado) {
    dirtyWorkersRef.current.add(worker.id);
    setAttendanceValues((current) => ({ ...current, [worker.id]: estado }));
  }

  function setObservation(worker, value) {
    dirtyWorkersRef.current.add(worker.id);
    setAttendanceObservations((current) => ({ ...current, [worker.id]: value }));
  }

  function handleSearchKeyDown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (visibleWorkers.length !== 1) return;
    markWorker(visibleWorkers[0], "ASISTENCIA");
    setWorkerSearch("");
  }

  async function handleSave() {
    setStatus(null);
    setSaving(true);
    try {
      let updated = 0;
      for (const worker of data.workers || []) {
        // No confundir "nadie toco esta casilla" (string vacio) con "se marco
        // Falta a proposito": antes ambos caian a "FALTA" y, si el trabajador
        // no tenia registro previo ese dia, la comparacion contra el estado
        // actual (tambien "FALTA" por defecto) salia igual y el guardado de
        // una Falta explicita se saltaba en silencio.
        const rawEstado = attendanceValues[worker.id] || "";
        const observacion = (attendanceObservations[worker.id] || "").trim();
        if (!rawEstado) continue;
        const estadoChanged = (currentMarks[worker.id] || "") !== rawEstado;
        const observacionChanged = (currentObservations[worker.id] || "") !== observacion;
        if (estadoChanged || observacionChanged) {
          await markAttendance(worker.id, selectedDate, ATTENDANCE_PRESENT_STATES.has(rawEstado), "", { estado: rawEstado, observacion });
          updated += 1;
        }
        // Ya se guardo (o ya coincidia con lo guardado): de aca en adelante
        // una recarga puede volver a sincronizar este trabajador sin riesgo.
        dirtyWorkersRef.current.delete(worker.id);
      }
      setStatus({ type: "success", message: "Asistencia guardada correctamente." });
      setSuccessDialog({ updated });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const allUsers = data.allUsers || [];
  const historyPeople = allUsers;
  const workerById = Object.fromEntries(historyPeople.map((worker) => [worker.id, worker]));
  const workerNameById = Object.fromEntries(historyPeople.map((worker) => [worker.id, worker.nombre || worker.email]));
  const workerEmailById = Object.fromEntries(historyPeople.map((worker) => [worker.id, worker.email]));
  const historyUsers = [...historyPeople].sort((left, right) =>
    String(left.nombre || left.email || "").localeCompare(String(right.nombre || right.email || ""), "es")
  );
  const historyRecords = data.attendances || [];
  const historyMonths = [...new Set(
    historyRecords.map((item) => String(item.fecha || "").slice(0, 7)).filter((value) => /^\d{4}-\d{2}$/.test(value))
  )].sort((left, right) => right.localeCompare(left));
  const historyDays = [...new Set(
    historyRecords.map((item) => String(item.fecha || "").slice(8, 10)).filter((value) => /^\d{2}$/.test(value))
  )].sort((left, right) => Number(left) - Number(right));
  // El selector "Usuario" solo debe listar personas con registros dentro del
  // mes/dia filtrado (no tiene sentido ofrecer a alguien sin datos ahi).
  const usersWithRecordsInDateRange = new Set(
    historyRecords
      .filter((item) => historyMonth === "todos" || String(item.fecha || "").startsWith(`${historyMonth}-`))
      .filter((item) => historyDay === "todos" || String(item.fecha || "").slice(8, 10) === historyDay)
      .map((item) => Number(item.usuario_id))
  );
  const historyUsersForStatus = historyUsers.filter((worker) => {
    if (!usersWithRecordsInDateRange.has(Number(worker.id))) return false;
    if (historyWorkerStatus === "todos") return true;
    return historyWorkerStatus === "activos" ? boolValue(worker.activo) : !boolValue(worker.activo);
  });
  const filteredAttendances = (data.attendances || [])
    .filter((item) => historyUserId === "todos" || String(item.usuario_id) === historyUserId)
    .filter((item) => historyMonth === "todos" || String(item.fecha || "").startsWith(`${historyMonth}-`))
    .filter((item) => historyDay === "todos" || String(item.fecha || "").slice(8, 10) === historyDay)
    .filter((item) => {
      if (historyWorkerStatus === "todos") return true;
      const worker = workerById[item.usuario_id];
      if (!worker) return false;
      return historyWorkerStatus === "activos" ? boolValue(worker.activo) : !boolValue(worker.activo);
    })
    .sort((left, right) => {
      const leftValue = `${left.fecha || ""}|${left.created_at || ""}|${String(left.id || "").padStart(12, "0")}`;
      const rightValue = `${right.fecha || ""}|${right.created_at || ""}|${String(right.id || "").padStart(12, "0")}`;
      return historyDateOrder === "asc" ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
    });
  const attendanceRows = filteredAttendances.map((item) => ({
    id: item.id,
    Fecha: item.fecha,
    Trabajador: workerNameById[item.usuario_id] || "Trabajador no disponible",
    Email: workerEmailById[item.usuario_id] || "",
    Estado: attendanceStateLabel(String(item.estado || "FALTA").toUpperCase()),
    Sigla: item.sigla || "",
    "Retiro anticipado": item.retiro_anticipado ? "Sí" : "No",
    "Tipo de retiro": item.retiro_anticipado ? (item.tipo_retiro === "apoyo" ? "Apoyo a otra area" : "Personal") : "",
    "Motivo del retiro": item.motivo_retiro || "",
    "Retirado en": item.retirado_en ? formatDateTimeLima(item.retirado_en) : "",
    "Marcado en": ATTENDANCE_PRESENT_STATES.has(String(item.estado || "").toUpperCase()) ? formatDateTimeLima(item.created_at) : "",
    Observación: item.observacion || ""
  }));

  function exportAttendance() {
    const columns = ["Fecha", "Trabajador", "Email", "Estado", "Sigla", "Observación"];
    downloadExcelTable("historial_asistencia.xls", columns, attendanceRows);
  }

  function changeHistoryWorkerStatus(value) {
    setHistoryWorkerStatus(value);
    if (historyUserId === "todos") return;
    const selectedWorker = historyUsers.find((worker) => String(worker.id) === historyUserId);
    const remainsVisible = selectedWorker && usersWithRecordsInDateRange.has(Number(selectedWorker.id)) && (
      value === "todos"
      || (value === "activos" ? boolValue(selectedWorker.activo) : !boolValue(selectedWorker.activo))
    );
    if (!remainsVisible) setHistoryUserId("todos");
  }

  // Cambiar el mes o el dia puede dejar al usuario seleccionado sin registros
  // en ese rango; en ese caso se vuelve a "Todos" para no mostrar una lista vacia.
  function changeHistoryMonth(value) {
    setHistoryMonth(value);
    setHistoryUserId("todos");
  }

  function changeHistoryDay(value) {
    setHistoryDay(value);
    setHistoryUserId("todos");
  }

  return (
    <div className="stack">
      <Panel title="Gestion de asistencia" eyebrow="Control diario">
        <div className="toolbar">
          <TextInput label="Fecha" type="date" value={selectedDate} onChange={setSelectedDate} max={todayLimaISO()} />
          <SelectInput
            label="Mostrar trabajadores"
            value={workerStatusFilter}
            onChange={setWorkerStatusFilter}
            options={workerFilterOptions}
          />
          <Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>
        </div>
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        {!loading && !workers.length ? <Alert>No hay trabajadores registrados.</Alert> : null}
        <Alert>Marca un estado por trabajador. Para cambiar una selección, desmárcala primero y elige otra casilla.</Alert>
        <div className="attendance-search-row">
          <label className="field attendance-search-field">
            <span className="field-label">Buscar trabajador</span>
            <span className="search-input">
              <Search aria-hidden="true" />
              <input
                className="input"
                type="search"
                value={workerSearch}
                onChange={(event) => setWorkerSearch(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Nombre o correo, luego Enter para marcar Puntual"
              />
            </span>
          </label>
          <span className="attendance-marked-count">{markedCount} de {statusFilteredWorkers.length} marcados</span>
        </div>
        {!loading && workers.length && !visibleWorkers.length ? (
          <Alert>No se encontraron trabajadores {workerStatusFilter === "activos" ? "activos" : workerStatusFilter === "inactivos" ? "inactivos" : ""} para "{workerSearch}".</Alert>
        ) : null}
        <div className="attendance-matrix-scroll">
          <div className="attendance-matrix" role="table" aria-label="Estados de asistencia por trabajador">
            <div className="attendance-matrix-header" role="row">
              <span role="columnheader">Trabajador</span>
              {attendanceStateOptions.map((option) => (
                <abbr key={option.value} role="columnheader" title={option.label}>{option.abbreviation}</abbr>
              ))}
              <span role="columnheader">Observación</span>
            </div>
            {visibleWorkers.map((worker) => {
              const estado = attendanceValues[worker.id] || "";
              return (
                <div key={worker.id} className={`attendance-matrix-row${estado ? " marked" : ""}`} role="row" data-estado={estado || "SIN_MARCAR"}>
                  <span className="attendance-worker" role="rowheader">
                    <strong>{worker.nombre || "Sin nombre"}</strong>
                    <small>{worker.email} · {boolValue(worker.activo) ? "Activo" : "Inactivo"}</small>
                  </span>
                  {attendanceStateOptions.map((option) => {
                    const checked = estado === option.value;
                    const disabled = Boolean(estado) && !checked;
                    return (
                      <label
                        key={option.value}
                        className={`attendance-state-check${checked ? " checked" : ""}`}
                        title={`${option.label} para ${worker.nombre || worker.email}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(event) => markWorker(worker, event.target.checked ? option.value : "")}
                          aria-label={`${option.label} para ${worker.nombre || worker.email}`}
                        />
                        <span aria-hidden="true">✓</span>
                      </label>
                    );
                  })}
                  <span className="attendance-observation" role="cell">
                    <input
                      className="input"
                      type="text"
                      value={attendanceObservations[worker.id] || ""}
                      onChange={(event) => setObservation(worker, event.target.value)}
                      placeholder="Observación (opcional)"
                      maxLength={500}
                      aria-label={`Observación para ${worker.nombre || worker.email}`}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <StatusAlert status={status} />
        <div className="form-actions">
          <Button icon={Save} loading={saving} onClick={handleSave}>Guardar asistencia</Button>
        </div>
      </Panel>

      {successDialog ? (
        <div className="save-success-overlay" role="presentation">
          <section
            className="save-success-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attendance-success-title"
            aria-describedby="attendance-success-description"
          >
            <div className="save-success-icon" aria-hidden="true">
              <CheckCircle2 />
            </div>
            <div className="save-success-copy">
              <p className="eyebrow">Proceso completado</p>
              <h2 id="attendance-success-title">¡Asistencia guardada correctamente!</h2>
              <p id="attendance-success-description">
                {successDialog.updated
                  ? `Se actualizó la marcación de ${successDialog.updated} trabajador${successDialog.updated === 1 ? "" : "es"}.`
                  : "No hubo cambios respecto a lo ya guardado."}
              </p>
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

      <Panel
        title={historyTab}
        actions={historyTab === "Registros de Asistencia" && attendanceRows.length ? <Button variant="secondary" onClick={exportAttendance}>Exportar Excel</Button> : null}
      >
        <Tabs tabs={["Registros de Asistencia", "Historial de Cambios"]} active={historyTab} onChange={setHistoryTab} />
        {historyTab === "Historial de Cambios" ? <AttendanceChangeLog /> : (
        <>
        <div className="toolbar attendance-history-filters">
          <SelectInput
            label="Usuario"
            value={historyUserId}
            onChange={setHistoryUserId}
            options={[
              { value: "todos", label: `Todos (${historyUsersForStatus.length})` },
              ...historyUsersForStatus.map((worker) => ({
                value: String(worker.id),
                label: worker.nombre || worker.email || "Trabajador sin nombre"
              }))
            ]}
          />
          <SelectInput
            label="Mes"
            value={historyMonth}
            onChange={changeHistoryMonth}
            options={[
              { value: "todos", label: "Todos" },
              ...[...new Set([todayLimaISO().slice(0, 7), ...historyMonths])]
                .sort((left, right) => right.localeCompare(left))
                .map((month) => ({
                  value: month,
                  label: new Intl.DateTimeFormat("es-PE", { month: "long", year: "numeric", timeZone: "UTC" })
                    .format(new Date(`${month}-01T12:00:00Z`))
                }))
            ]}
          />
          <SelectInput
            label="Día"
            value={historyDay}
            onChange={changeHistoryDay}
            options={[
              { value: "todos", label: "Todos" },
              ...historyDays.map((day) => ({ value: day, label: String(Number(day)) }))
            ]}
          />
          <SelectInput
            label="Estado del usuario"
            value={historyWorkerStatus}
            onChange={changeHistoryWorkerStatus}
            options={[
              { value: "todos", label: "Todos" },
              { value: "activos", label: "Activos" },
              { value: "inactivos", label: "Inactivos" }
            ]}
          />
          <SelectInput
            label="Orden por fecha"
            value={historyDateOrder}
            onChange={setHistoryDateOrder}
            options={[
              { value: "desc", label: "Más recientes primero" },
              { value: "asc", label: "Más antiguos primero" }
            ]}
          />
        </div>
        <DataTable
          rows={attendanceRows}
          columns={["Fecha", "Trabajador", "Email", "Estado", "Sigla", "Marcado en", "Observación"]}
          pageSize={25}
          empty="No hay asistencias para los filtros seleccionados."
        />
        </>
        )}
      </Panel>
    </div>
  );
}

const LOG_ASISTENCIAS_OPERACION_LABELS = {
  INSERT: "Creación",
  UPDATE: "Edición",
  DELETE: "Eliminación"
};

function AttendanceChangeLog() {
  const [operacion, setOperacion] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const { data: rows, loading, error, reload } = useAsyncData(
    () => listLogAsistencias({ operacion, desde, hasta }),
    [operacion, desde, hasta],
    []
  );

  const tableRows = (rows || []).map((row) => ({
    "Fecha y hora": row.registradoEn ? formatDateTimeLima(row.registradoEn) : "",
    "Operación": LOG_ASISTENCIAS_OPERACION_LABELS[row.operacion] || row.operacion,
    Trabajador: row.workerName || "",
    "Registrado por": row.registradoPorName || ""
  }));

  return (
    <>
      <div className="toolbar attendance-history-filters">
        <SelectInput
          label="Operación"
          value={operacion}
          onChange={setOperacion}
          options={[
            { value: "", label: "Todas" },
            { value: "INSERT", label: "Creación" },
            { value: "UPDATE", label: "Edición" },
            { value: "DELETE", label: "Eliminación" }
          ]}
        />
        <TextInput label="Desde" type="date" value={desde} onChange={setDesde} />
        <TextInput label="Hasta" type="date" value={hasta} onChange={setHasta} />
        <Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>
      </div>
      {loading ? <LoadingBlock /> : null}
      {error ? <Alert type="error">{error}</Alert> : null}
      <DataTable
        rows={tableRows}
        columns={["Fecha y hora", "Operación", "Trabajador", "Registrado por"]}
        pageSize={15}
        empty="No hay cambios registrados para los filtros seleccionados."
      />
    </>
  );
}

function emptyNotificationForm() {
  return {
    nombre: "",
    activo: false,
    destinatarios: "",
    hora_envio: "18:00",
    asunto: "Reporte diario de asistencia",
    incluir_todos_activos: true,
    usuario_ids: []
  };
}

function notificationRecipients(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,;]+/);
  return Array.from(new Set(source.map((email) => String(email).trim().toLowerCase()).filter(Boolean)));
}

function notificationUserIds(config) {
  const source = Array.isArray(config?.usuario_ids) ? config.usuario_ids : [];
  return Array.from(new Set(source.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
}

function notificationIncludesAllWorkers(config) {
  return config?.incluir_todos_activos === undefined ? true : boolValue(config.incluir_todos_activos);
}

function NotificationsPanel() {
  const [tab, setTab] = useState("asistencia");
  return (
    <div className="stack notification-page">
      <div className="notification-tabs" role="tablist" aria-label="Tipos de notificacion">
        <button type="button" role="tab" aria-selected={tab === "asistencia"} className={tab === "asistencia" ? "active" : ""} onClick={() => setTab("asistencia")}>
          <Mail aria-hidden="true" /> Asistencia
        </button>
        <button type="button" role="tab" aria-selected={tab === "actividades"} className={tab === "actividades" ? "active" : ""} onClick={() => setTab("actividades")}>
          <ClipboardCheck aria-hidden="true" /> Registros de actividades
        </button>
      </div>
      {tab === "asistencia" ? <AttendanceNotificationsPanel /> : <ActivityNotificationsPanel />}
    </div>
  );
}

function emptyActivityForm() {
  return {
    nombre: "",
    activo: false,
    destinatarios: "",
    hora_manana: "12:00",
    hora_tarde: "18:00",
    asunto: "Reporte de registros de actividades",
    incluir_todos_activos: true,
    usuario_ids: []
  };
}

function ActivityNotificationsPanel() {
  const [reportDate, setReportDate] = useState(todayLimaISO());
  const [editorId, setEditorId] = useState(null);
  const [form, setForm] = useState(emptyActivityForm);
  const [workerSearch, setWorkerSearch] = useState("");
  const [excludedInactiveCount, setExcludedInactiveCount] = useState(0);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [previewConfigId, setPreviewConfigId] = useState("");
  const [previewShift, setPreviewShift] = useState("manana");
  const [preview, setPreview] = useState(null);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const editorRef = useRef(null);
  const { data, loading, error, reload } = useAsyncData(
    getActivityReportSettings,
    [],
    { configs: [], workers: [], history: [], gmail: { configured: false } }
  );

  const configs = data?.configs || [];
  const activeWorkers = (data?.workers || []).filter((worker) => boolValue(worker.activo));
  const activeWorkerIds = new Set(activeWorkers.map((worker) => Number(worker.id)));
  const gmailConfigured = Boolean(data?.gmail?.configured);
  const controlsDisabled = loading || Boolean(error);
  const selectedUserIds = new Set((form.usuario_ids || []).map(String));
  const normalizedWorkerSearch = workerSearch.trim().toLocaleLowerCase("es");
  const visibleWorkers = activeWorkers.filter((worker) => {
    if (!normalizedWorkerSearch) return true;
    return `${worker.nombre || ""} ${worker.email || ""}`.toLocaleLowerCase("es").includes(normalizedWorkerSearch);
  });
  const activeConfigs = configs.filter((config) => boolValue(config.activo));
  const configNameById = Object.fromEntries(configs.map((config) => [String(config.id), config.nombre || `Programacion ${config.id}`]));
  const reportStatusLabels = {
    procesando: "Procesando",
    enviando: "Enviando",
    enviado: "Enviado",
    error: "Error",
    omitido: "Omitido",
    revision: "Requiere revision"
  };
  const historyRows = (data?.history || []).map((item) => ({
    Programacion: item.programacion_nombre || configNameById[String(item.configuracion_id)] || `#${item.configuracion_id}`,
    Fecha: item.fecha_reporte,
    Turno: item.turno === "manana" ? "Manana" : "Tarde",
    Envio: item.tipo_envio === "automatico" ? "Automatico" : "Manual",
    Estado: reportStatusLabels[item.estado] || item.estado,
    Cumplieron: item.cumplieron_count ?? "",
    "Sin registro": item.sin_registro_count ?? "",
    Intentos: item.intentos ?? 1,
    "Fecha de envio": item.enviado_en ? formatDateTimeLima(item.enviado_en) : "",
    Detalle: item.detalle_error || ""
  }));

  useEffect(() => {
    if (!configs.length) {
      setPreviewConfigId("");
      return;
    }
    if (!configs.some((config) => String(config.id) === previewConfigId)) {
      setPreviewConfigId(String(configs[0].id));
    }
  }, [configs, previewConfigId]);

  useEffect(() => {
    if (!editorId) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorId]);

  useEffect(() => {
    if (loading || error || !previewConfigId) return;
    let cancelled = false;
    setPreviewLoading(true);
    getActivityReportPreview(previewConfigId, reportDate, previewShift)
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((err) => { if (!cancelled) setStatus({ type: "error", message: friendlyError(err) }); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [previewConfigId, reportDate, previewShift, loading, error, previewRefresh]);

  function openCreateEditor() {
    setStatus(null);
    setWorkerSearch("");
    setExcludedInactiveCount(0);
    setForm(emptyActivityForm());
    setEditorId("new");
  }

  function openEditEditor(config) {
    setStatus(null);
    setWorkerSearch("");
    const configuredUserIds = notificationUserIds(config);
    const activeSelectedUserIds = configuredUserIds.filter((id) => activeWorkerIds.has(id));
    setExcludedInactiveCount(configuredUserIds.length - activeSelectedUserIds.length);
    setForm({
      nombre: config.nombre || `Programacion ${config.id}`,
      activo: boolValue(config.activo),
      destinatarios: notificationRecipients(config.destinatarios).join("\n"),
      hora_manana: String(config.hora_manana || "12:00").slice(0, 5),
      hora_tarde: String(config.hora_tarde || "18:00").slice(0, 5),
      asunto: config.asunto || "Reporte de registros de actividades",
      incluir_todos_activos: notificationIncludesAllWorkers(config),
      usuario_ids: activeSelectedUserIds.map(String)
    });
    setEditorId(String(config.id));
  }

  function closeEditor() {
    setEditorId(null);
    setWorkerSearch("");
    setExcludedInactiveCount(0);
    setForm(emptyActivityForm());
  }

  function toggleWorker(workerId, checked) {
    const normalizedId = String(workerId);
    setForm((current) => ({
      ...current,
      usuario_ids: checked
        ? Array.from(new Set([...(current.usuario_ids || []).map(String), normalizedId]))
        : (current.usuario_ids || []).map(String).filter((id) => id !== normalizedId)
    }));
  }

  function settingsPayload() {
    const nombre = String(form.nombre || "").trim();
    const asunto = String(form.asunto || "").trim();
    const recipients = notificationRecipients(form.destinatarios);
    const userIds = (form.usuario_ids || [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && activeWorkerIds.has(id));
    if (!nombre) throw new Error("Escribe un nombre para la programacion.");
    if (nombre.length > 100) throw new Error("El nombre de la programacion admite hasta 100 caracteres.");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(form.hora_manana || "")) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(form.hora_tarde || ""))) {
      throw new Error("Selecciona horas de manana y tarde validas.");
    }
    if (form.hora_manana >= form.hora_tarde) throw new Error("La hora de la manana debe ser anterior a la hora de la tarde.");
    if (!asunto) throw new Error("Escribe el asunto del correo.");
    if (asunto.length > 160) throw new Error("El asunto admite hasta 160 caracteres.");
    const invalidEmail = recipients.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (invalidEmail) throw new Error(`El correo ${invalidEmail} no es valido.`);
    if (recipients.length > 20) throw new Error("Solo se permiten hasta 20 correos destinatarios.");
    if (form.activo && !recipients.length) throw new Error("Agrega al menos un correo destinatario para activar la programacion.");
    if (form.activo && !gmailConfigured) throw new Error("Configura Gmail antes de activar la programacion.");
    if (!form.incluir_todos_activos && !userIds.length) {
      throw new Error("Selecciona al menos un operante o incluye a todos los activos.");
    }
    return {
      nombre,
      activo: Boolean(form.activo),
      destinatarios: recipients,
      hora_manana: form.hora_manana,
      hora_tarde: form.hora_tarde,
      asunto,
      incluir_todos_activos: Boolean(form.incluir_todos_activos),
      usuario_ids: form.incluir_todos_activos ? [] : userIds
    };
  }

  async function handleSaveSettings(event) {
    event.preventDefault();
    setStatus(null);
    setSaving(true);
    try {
      const payload = settingsPayload();
      if (editorId === "new") await createActivityReportSettings(payload);
      else await updateActivityReportSettings(editorId, payload);
      const action = editorId === "new" ? "creada" : "actualizada";
      closeEditor();
      setStatus({ type: "success", message: `Programacion ${action} correctamente.` });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleSendNow(config, sendShift) {
    setStatus(null);
    setBusyAction(`send:${config.id}:${sendShift}`);
    let sendStarted = false;
    try {
      sendStarted = true;
      const result = await sendActivityReportNow(config.id, reportDate, sendShift);
      const shiftLabel = sendShift === "manana" ? "la manana" : "la tarde";
      setStatus({
        type: "success",
        message: `${config.nombre || "El reporte"} (${shiftLabel}) se envio: ${result.completedCount ?? 0} registraron actividad y ${result.missingCount ?? 0} no registraron.`
      });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setBusyAction("");
      if (sendStarted) reload();
    }
  }

  async function handleDelete(config) {
    const configName = config.nombre || `Programacion ${config.id}`;
    if (!window.confirm(`Se eliminara la programacion "${configName}". Su historial se conservara. ¿Deseas continuar?`)) return;
    setStatus(null);
    setBusyAction(`delete:${config.id}`);
    try {
      await deleteActivityReportSettings(config.id);
      if (String(editorId) === String(config.id)) closeEditor();
      setStatus({ type: "success", message: `La programacion ${configName} fue eliminada.` });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setBusyAction("");
    }
  }

  const previewRows = (preview?.rows || []).map((row) => ({
    Operante: row.nombre,
    Correo: row.email || "Sin correo",
    Estado: row.cumplio ? "Cumplio" : "Sin registro",
    Registros: row.registros
  }));

  return (
    <div className="stack">
      <Panel
        title="Notificaciones de registros de actividades"
        eyebrow="Reportes por correo"
        className="attendance-report-panel"
        actions={(
          <Button
            type="button"
            icon={Plus}
            disabled={controlsDisabled || saving || Boolean(busyAction)}
            aria-controls="activity-notification-schedule-editor"
            aria-expanded={Boolean(editorId)}
            onClick={openCreateEditor}
          >
            Nueva programacion
          </Button>
        )}
      >
        <div className="attendance-report-intro notification-hero">
          <span className="attendance-report-icon"><ClipboardCheck aria-hidden="true" /></span>
          <div className="notification-hero-copy">
            <strong>Verifica que cada operante activo registre actividad</strong>
            <p>Cada programacion envia un corte en la manana y otro en la tarde, indicando quienes registraron actividad y quienes no.</p>
          </div>
          <span className={`notification-gmail-status ${gmailConfigured ? "ready" : "pending"}`}>
            {gmailConfigured ? "Credenciales cargadas" : "Gmail pendiente"}
          </span>
        </div>

        {loading ? <LoadingBlock /> : null}
        {error ? (
          <div className="stack stack-compact" role="alert">
            <Alert type="error">{error}</Alert>
            <div className="form-actions">
              <Button type="button" variant="secondary" icon={RefreshCcw} onClick={reload}>Reintentar carga</Button>
            </div>
          </div>
        ) : null}
        {!loading && !error && !gmailConfigured ? (
          <Alert type="error">
            Falta configurar GMAIL_APP_PASSWORD como variable privada de Netlify. Puedes crear borradores, pero no activarlos ni enviarlos.
          </Alert>
        ) : null}
        {!loading && !error && gmailConfigured ? (
          <Alert type="success">Las credenciales de Gmail estan cargadas para enviar desde {data.gmail.sender}.</Alert>
        ) : null}

        <div className="notification-toolbar">
          <TextInput
            label="Fecha para envios manuales"
            type="date"
            value={reportDate}
            onChange={setReportDate}
            disabled={controlsDisabled || Boolean(busyAction)}
            hint="Los botones Enviar ahora usan esta fecha. No modifica la programacion."
          />
          <Button type="button" variant="secondary" icon={RefreshCcw} disabled={controlsDisabled || Boolean(busyAction)} onClick={reload}>
            Actualizar
          </Button>
        </div>

        {!loading && !error ? (
          <div className="metrics-row notification-metrics" aria-label="Resumen de programaciones">
            <Metric label="Programaciones" value={configs.length} />
            <Metric label="Activas" value={activeConfigs.length} tone="accent" />
            <Metric label="Operantes activos" value={activeWorkers.length} />
          </div>
        ) : null}
      </Panel>

      {editorId ? (
        <div id="activity-notification-schedule-editor" ref={editorRef}>
          <Panel
            title={editorId === "new" ? "Nueva programacion" : "Editar programacion"}
            eyebrow="Configuracion"
            className="notification-editor-panel"
          >
            <form className="stack" onSubmit={handleSaveSettings} aria-label={editorId === "new" ? "Crear programacion" : "Editar programacion"}>
              <div className="form-grid notification-editor-form">
                <TextInput
                  label="Nombre de la programacion"
                  value={form.nombre}
                  onChange={(nombre) => setForm({ ...form, nombre })}
                  disabled={saving}
                  maxLength={100}
                  required
                  autoFocus
                  placeholder="Ejemplo: Reporte para Supervision"
                />
                <TextInput
                  label="Hora de notificacion de la manana"
                  type="time"
                  value={form.hora_manana}
                  onChange={(hora_manana) => setForm({ ...form, hora_manana })}
                  disabled={saving}
                  required
                  hint="Zona horaria America/Lima."
                />
                <TextInput
                  label="Hora de notificacion de la tarde"
                  type="time"
                  value={form.hora_tarde}
                  onChange={(hora_tarde) => setForm({ ...form, hora_tarde })}
                  disabled={saving}
                  required
                  hint="Debe ser posterior a la hora de la manana."
                />
                <TextInput
                  label="Asunto del correo"
                  value={form.asunto}
                  onChange={(asunto) => setForm({ ...form, asunto })}
                  disabled={saving}
                  maxLength={160}
                  required
                />
                <CheckboxInput
                  label="Activar envios automaticos diarios"
                  checked={form.activo}
                  onChange={(activo) => {
                    if (activo && !gmailConfigured) {
                      setStatus({ type: "error", message: "Configura Gmail antes de activar una programacion." });
                      return;
                    }
                    setForm({ ...form, activo });
                  }}
                  disabled={saving}
                  hint={gmailConfigured ? "Envia dos reportes diarios, uno por cada turno." : "Gmail aun no esta configurado."}
                />
                <TextArea
                  label="Correos destinatarios"
                  value={form.destinatarios}
                  onChange={(destinatarios) => setForm({ ...form, destinatarios })}
                  disabled={saving}
                  rows={4}
                  placeholder="correo1@gmail.com\ncorreo2@empresa.com"
                  hint="Uno por linea o separados por comas. Maximo 20."
                />
                <CheckboxInput
                  label="Incluir a todos los operantes activos"
                  checked={form.incluir_todos_activos}
                  onChange={(incluir_todos_activos) => setForm({ ...form, incluir_todos_activos })}
                  disabled={saving}
                  hint="Desactivalo para elegir operantes especificos."
                />
              </div>

              {!form.incluir_todos_activos ? (
                <fieldset className="notification-worker-picker" disabled={saving}>
                  <legend>Operantes incluidos en el reporte</legend>
                  {excludedInactiveCount ? (
                    <Alert type="warning">
                      {excludedInactiveCount} operante(s) seleccionados fueron desactivados. No apareceran en el reporte y se quitaran al guardar.
                    </Alert>
                  ) : null}
                  <div className="notification-worker-picker-toolbar">
                    <label className="field notification-worker-search">
                      <span className="field-label">Buscar operante activo</span>
                      <span className="search-input">
                        <Search aria-hidden="true" />
                        <input
                          className="input"
                          type="search"
                          value={workerSearch}
                          onChange={(event) => setWorkerSearch(event.target.value)}
                          placeholder="Nombre o correo"
                        />
                      </span>
                    </label>
                    <div className="notification-selection-actions">
                      <span>{selectedUserIds.size} seleccionado(s)</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        icon={UsersRound}
                        onClick={() => setForm({ ...form, usuario_ids: activeWorkers.map((worker) => String(worker.id)) })}
                      >
                        Seleccionar todos
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, usuario_ids: [] })}>
                        Limpiar
                      </Button>
                    </div>
                  </div>
                  {!activeWorkers.length ? <Alert>No hay operantes activos disponibles.</Alert> : null}
                  {activeWorkers.length && !visibleWorkers.length ? <Alert>No hay coincidencias para esta busqueda.</Alert> : null}
                  <div className="notification-worker-list">
                    {visibleWorkers.map((worker) => (
                      <label key={worker.id} className="notification-worker-option">
                        <input
                          type="checkbox"
                          checked={selectedUserIds.has(String(worker.id))}
                          onChange={(event) => toggleWorker(worker.id, event.target.checked)}
                        />
                        <span>
                          <strong>{worker.nombre || "Sin nombre"}</strong>
                          <small>{worker.email || "Sin correo"}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <div className="form-actions notification-editor-actions">
                <Button type="button" variant="ghost" disabled={saving} onClick={closeEditor}>Cancelar</Button>
                <Button type="submit" icon={Save} loading={saving} disabled={Boolean(busyAction)}>
                  {editorId === "new" ? "Crear programacion" : "Guardar cambios"}
                </Button>
              </div>
            </form>
          </Panel>
        </div>
      ) : null}

      <Panel title="Programaciones" eyebrow="Envios automaticos">
        {loading ? <LoadingBlock label="Cargando programaciones" /> : null}
        {error ? <Alert type="error">No se pudieron cargar las programaciones.</Alert> : null}
        {!loading && !error && !configs.length ? (
          <div className="empty-state notification-empty-state">
            <ClipboardCheck aria-hidden="true" />
            <span>Todavia no hay programaciones. Crea la primera para comenzar.</span>
          </div>
        ) : null}
        {!loading && !error ? <div className="notification-schedule-grid">
          {configs.map((config) => {
            const recipients = notificationRecipients(config.destinatarios);
            const configuredUserIds = notificationUserIds(config);
            const userIds = configuredUserIds.filter((id) => activeWorkerIds.has(id));
            const excludedUsers = configuredUserIds.length - userIds.length;
            const includesAllWorkers = notificationIncludesAllWorkers(config);
            const isActive = boolValue(config.activo);
            const isSendingMorning = busyAction === `send:${config.id}:manana`;
            const isSendingAfternoon = busyAction === `send:${config.id}:tarde`;
            const isDeleting = busyAction === `delete:${config.id}`;
            const cardBusy = controlsDisabled || Boolean(busyAction) || saving;
            const canSend = !cardBusy && gmailConfigured && recipients.length && reportDate && (includesAllWorkers || userIds.length);
            return (
              <article key={config.id} className={`notification-schedule-card ${isActive ? "active" : "paused"}`}>
                <header className="notification-card-header">
                  <div className="notification-card-title">
                    <span className="notification-card-icon"><ClipboardCheck aria-hidden="true" /></span>
                    <div>
                      <small>Programacion #{config.id}</small>
                      <h3>{config.nombre || `Programacion ${config.id}`}</h3>
                    </div>
                  </div>
                  <span className={`notification-status-badge ${isActive ? "active" : "paused"}`}>
                    {isActive ? "Activa" : "Pausada"}
                  </span>
                </header>

                <div className="notification-card-time">
                  <Clock3 aria-hidden="true" />
                  <strong>{String(config.hora_manana || "12:00").slice(0, 5)}</strong>
                  <span>y</span>
                  <strong>{String(config.hora_tarde || "18:00").slice(0, 5)}</strong>
                  <span>America/Lima</span>
                </div>

                <dl className="notification-card-details">
                  <div>
                    <dt>Asunto</dt>
                    <dd>{config.asunto || "Reporte de registros de actividades"}</dd>
                  </div>
                  <div>
                    <dt>Destinatarios</dt>
                    <dd title={recipients.join(", ")}>
                      {recipients.length ? `${recipients.slice(0, 2).join(", ")}${recipients.length > 2 ? ` y ${recipients.length - 2} mas` : ""}` : "Sin destinatarios"}
                    </dd>
                  </div>
                  <div>
                    <dt>Alcance</dt>
                    <dd>
                      {includesAllWorkers
                        ? `Todos los operantes activos (${activeWorkers.length})`
                        : `${userIds.length} operante(s) activo(s)${excludedUsers ? ` · ${excludedUsers} inactivo(s) excluido(s)` : ""}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Ultimo envio manana</dt>
                    <dd>{config.ultimo_envio_manana_fecha || "Todavia no enviado"}</dd>
                  </div>
                  <div>
                    <dt>Ultimo envio tarde</dt>
                    <dd>{config.ultimo_envio_tarde_fecha || "Todavia no enviado"}</dd>
                  </div>
                </dl>

                <div className="notification-card-actions">
                  <Button
                    type="button"
                    icon={Send}
                    loading={isSendingMorning}
                    disabled={!canSend}
                    aria-label={`Enviar reporte de la manana de ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => handleSendNow(config, "manana")}
                  >
                    Enviar manana
                  </Button>
                  <Button
                    type="button"
                    icon={Send}
                    loading={isSendingAfternoon}
                    disabled={!canSend}
                    aria-label={`Enviar reporte de la tarde de ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => handleSendNow(config, "tarde")}
                  >
                    Enviar tarde
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    icon={Pencil}
                    disabled={cardBusy}
                    aria-controls="activity-notification-schedule-editor"
                    aria-expanded={String(editorId) === String(config.id)}
                    aria-label={`Editar ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => openEditEditor(config)}
                  >
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    icon={Trash2}
                    loading={isDeleting}
                    disabled={cardBusy}
                    aria-label={`Eliminar ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => handleDelete(config)}
                  >
                    Eliminar
                  </Button>
                </div>
              </article>
            );
          })}
        </div> : null}
        <StatusAlert status={status} />
      </Panel>

      <Panel title="Reporte de cumplimiento" eyebrow="Vista previa">
        <div className="notification-toolbar">
          <SelectInput
            label="Programacion"
            value={previewConfigId}
            onChange={setPreviewConfigId}
            options={configs.length
              ? configs.map((config) => ({ value: String(config.id), label: config.nombre || "Programación sin nombre" }))
              : [{ value: "", label: "Sin programaciones" }]}
          />
          <label className="field">
            <span className="field-label">Turno</span>
            <select className="input" value={previewShift} onChange={(event) => setPreviewShift(event.target.value)}>
              <option value="manana">Manana</option>
              <option value="tarde">Tarde</option>
            </select>
          </label>
          <Button type="button" variant="secondary" icon={RefreshCcw} disabled={!previewConfigId} onClick={() => setPreviewRefresh((value) => value + 1)}>
            Actualizar
          </Button>
        </div>
        <div className="metrics-row notification-metrics">
          <Metric label="Operantes en el alcance" value={preview?.rows?.length ?? 0} />
          <Metric label="Registraron actividad" value={preview?.cumplieron ?? 0} tone="accent" />
          <Metric label="Sin registro" value={preview?.sin_registro ?? 0} />
        </div>
        {!configs.length ? <Alert>Crea una programacion para ver su vista previa.</Alert> : null}
        {previewLoading ? <LoadingBlock label="Revisando registros" /> : <DataTable rows={previewRows} empty="No hay operantes en el alcance de esta programacion." compact />}
      </Panel>

      <Panel title="Historial de envios" eyebrow="Actividades">
        <DataTable rows={historyRows} empty="Todavia no se enviaron reportes de actividades." compact />
      </Panel>
    </div>
  );
}

function AttendanceNotificationsPanel() {
  const [reportDate, setReportDate] = useState(todayLimaISO());
  const [editorId, setEditorId] = useState(null);
  const [form, setForm] = useState(emptyNotificationForm);
  const [workerSearch, setWorkerSearch] = useState("");
  const [excludedInactiveCount, setExcludedInactiveCount] = useState(0);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const editorRef = useRef(null);
  const { data, loading, error, reload } = useAsyncData(
    getAttendanceReportSettings,
    [],
    {
      configs: [],
      workers: [],
      history: [],
      gmail: { sender: "calzado661@gmail.com", configured: false }
    }
  );

  const configs = data?.configs || [];
  const activeWorkers = (data?.workers || []).filter((worker) => boolValue(worker.activo));
  const activeWorkerIds = new Set(activeWorkers.map((worker) => Number(worker.id)));
  const gmailConfigured = Boolean(data?.gmail?.configured);
  const controlsDisabled = loading || Boolean(error);
  const selectedUserIds = new Set((form.usuario_ids || []).map(String));
  const normalizedWorkerSearch = workerSearch.trim().toLocaleLowerCase("es");
  const visibleWorkers = activeWorkers.filter((worker) => {
    if (!normalizedWorkerSearch) return true;
    return `${worker.nombre || ""} ${worker.email || ""}`.toLocaleLowerCase("es").includes(normalizedWorkerSearch);
  });
  const activeConfigs = configs.filter((config) => boolValue(config.activo));
  const sortedActiveConfigs = [...activeConfigs]
    .sort((left, right) => String(left.hora_envio || "23:59").localeCompare(String(right.hora_envio || "23:59")));
  const currentLimaTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());
  const todayLima = todayLimaISO();
  const unsentToday = sortedActiveConfigs.filter((config) => String(config.ultimo_envio_fecha || "") !== todayLima);
  const overdueSchedule = unsentToday.find((config) => String(config.hora_envio || "23:59").slice(0, 5) <= currentLimaTime);
  const futureSchedule = unsentToday.find((config) => String(config.hora_envio || "23:59").slice(0, 5) > currentLimaTime);
  const nextScheduleLabel = overdueSchedule
    ? "Ahora"
    : futureSchedule
      ? String(futureSchedule.hora_envio || "").slice(0, 5)
      : sortedActiveConfigs[0]
        ? `${String(sortedActiveConfigs[0].hora_envio || "").slice(0, 5)} mañana`
        : "--:--";
  const configNameById = Object.fromEntries(configs.map((config) => [String(config.id), config.nombre || `Programacion ${config.id}`]));
  const reportStatusLabels = {
    procesando: "Procesando",
    enviando: "Enviando",
    enviado: "Enviado",
    error: "Error",
    omitido: "Omitido",
    revision: "Requiere revision"
  };
  const historyRows = (data?.history || []).map((item) => ({
    Programacion: item.programacion_nombre || item.configuracion_nombre || item.configuracion?.nombre || configNameById[String(item.configuracion_id)] || `#${item.configuracion_id}`,
    Fecha: item.fecha_reporte,
    Envio: item.tipo_envio === "automatico" ? "Automatico" : "Manual",
    Estado: reportStatusLabels[item.estado] || item.estado,
    Destinatarios: notificationRecipients(item.destinatarios).join(", "),
    Asistentes: item.asistentes_count ?? "",
    Ausentes: item.ausentes_count ?? "",
    Intentos: item.intentos ?? 1,
    "Fecha de envio": item.enviado_en ? formatDateTimeLima(item.enviado_en) : "",
    Detalle: item.detalle_error || ""
  }));

  useEffect(() => {
    if (!editorId) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorId]);

  function openCreateEditor() {
    setStatus(null);
    setWorkerSearch("");
    setExcludedInactiveCount(0);
    setForm(emptyNotificationForm());
    setEditorId("new");
  }

  function openEditEditor(config) {
    setStatus(null);
    setWorkerSearch("");
    const configuredUserIds = notificationUserIds(config);
    const activeSelectedUserIds = configuredUserIds.filter((id) => activeWorkerIds.has(id));
    setExcludedInactiveCount(configuredUserIds.length - activeSelectedUserIds.length);
    setForm({
      nombre: config.nombre || `Programacion ${config.id}`,
      activo: boolValue(config.activo),
      destinatarios: notificationRecipients(config.destinatarios).join("\n"),
      hora_envio: String(config.hora_envio || "18:00").slice(0, 5),
      asunto: config.asunto || "Reporte diario de asistencia",
      incluir_todos_activos: notificationIncludesAllWorkers(config),
      usuario_ids: activeSelectedUserIds.map(String)
    });
    setEditorId(String(config.id));
  }

  function closeEditor() {
    setEditorId(null);
    setWorkerSearch("");
    setExcludedInactiveCount(0);
    setForm(emptyNotificationForm());
  }

  function toggleWorker(workerId, checked) {
    const normalizedId = String(workerId);
    setForm((current) => ({
      ...current,
      usuario_ids: checked
        ? Array.from(new Set([...(current.usuario_ids || []).map(String), normalizedId]))
        : (current.usuario_ids || []).map(String).filter((id) => id !== normalizedId)
    }));
  }

  function settingsPayload() {
    const nombre = String(form.nombre || "").trim();
    const asunto = String(form.asunto || "").trim();
    const recipients = notificationRecipients(form.destinatarios);
    const userIds = (form.usuario_ids || [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && activeWorkerIds.has(id));
    if (!nombre) throw new Error("Escribe un nombre para la programacion.");
    if (nombre.length > 100) throw new Error("El nombre de la programacion admite hasta 100 caracteres.");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(form.hora_envio || ""))) {
      throw new Error("Selecciona una hora de envio valida.");
    }
    if (!asunto) throw new Error("Escribe el asunto del correo.");
    if (asunto.length > 160) throw new Error("El asunto admite hasta 160 caracteres.");
    const invalidEmail = recipients.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (invalidEmail) throw new Error(`El correo ${invalidEmail} no es valido.`);
    if (recipients.length > 20) throw new Error("Solo se permiten hasta 20 correos destinatarios.");
    if (form.activo && !recipients.length) throw new Error("Agrega al menos un correo destinatario para activar la programacion.");
    if (form.activo && !gmailConfigured) throw new Error("Configura Gmail antes de activar la programacion.");
    if (!form.incluir_todos_activos && !userIds.length) {
      throw new Error("Selecciona al menos un trabajador o incluye a todos los activos.");
    }
    return {
      nombre,
      activo: Boolean(form.activo),
      destinatarios: recipients,
      hora_envio: form.hora_envio,
      asunto,
      incluir_todos_activos: Boolean(form.incluir_todos_activos),
      usuario_ids: form.incluir_todos_activos ? [] : userIds
    };
  }

  async function handleSaveSettings(event) {
    event.preventDefault();
    setStatus(null);
    setSaving(true);
    try {
      const payload = settingsPayload();
      if (editorId === "new") await createAttendanceReportSettings(payload);
      else await updateAttendanceReportSettings(editorId, payload);
      const action = editorId === "new" ? "creada" : "actualizada";
      closeEditor();
      setStatus({ type: "success", message: `Programacion ${action} correctamente.` });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleSendNow(config) {
    setStatus(null);
    setBusyAction(`send:${config.id}`);
    let sendStarted = false;
    try {
      sendStarted = true;
      const result = await sendAttendanceReportNow(config.id, reportDate);
      const recipientsCount = Array.isArray(result.recipients)
        ? result.recipients.length
        : notificationRecipients(config.destinatarios).length;
      setStatus({
        type: "success",
        message: `${config.nombre || "El reporte"} se envio a ${recipientsCount} correo(s): ${result.attendeesCount ?? 0} asistente(s) y ${result.absenteesCount ?? 0} ausente(s).`
      });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setBusyAction("");
      if (sendStarted) reload();
    }
  }

  async function handleDelete(config) {
    const configName = config.nombre || `Programacion ${config.id}`;
    if (!window.confirm(`Se eliminara la programacion "${configName}". Su historial se conservara. ¿Deseas continuar?`)) return;
    setStatus(null);
    setBusyAction(`delete:${config.id}`);
    try {
      await deleteAttendanceReportSettings(config.id);
      if (String(editorId) === String(config.id)) closeEditor();
      setStatus({ type: "success", message: `La programacion ${configName} fue eliminada.` });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div className="stack">
      <Panel
        title="Notificaciones de asistencia"
        eyebrow="Reportes por correo"
        className="attendance-report-panel"
        actions={(
          <Button
            type="button"
            icon={Plus}
            disabled={controlsDisabled || saving || Boolean(busyAction)}
            aria-controls="notification-schedule-editor"
            aria-expanded={Boolean(editorId)}
            onClick={openCreateEditor}
          >
            Nueva programacion
          </Button>
        )}
      >
        <div className="attendance-report-intro notification-hero">
          <span className="attendance-report-icon"><Mail aria-hidden="true" /></span>
          <div className="notification-hero-copy">
            <strong>Envia automaticamente la lista de personas que asistieron</strong>
            <p>Los reportes incluyen resumen, detalle y archivo CSV. Todos los horarios se interpretan en America/Lima.</p>
          </div>
          <span className={`notification-gmail-status ${gmailConfigured ? "ready" : "pending"}`}>
            {gmailConfigured ? "Credenciales cargadas" : "Gmail pendiente"}
          </span>
        </div>

        {loading ? <LoadingBlock /> : null}
        {error ? (
          <div className="stack stack-compact" role="alert">
            <Alert type="error">{error}</Alert>
            <div className="form-actions">
              <Button type="button" variant="secondary" icon={RefreshCcw} onClick={reload}>Reintentar carga</Button>
            </div>
          </div>
        ) : null}
        {!loading && !error && !gmailConfigured ? (
          <Alert type="error">
            Falta configurar GMAIL_APP_PASSWORD como variable privada de Netlify. Puedes crear borradores, pero no activarlos ni enviarlos.
          </Alert>
        ) : null}
        {!loading && !error && gmailConfigured ? (
          <Alert type="success">Las credenciales de Gmail estan cargadas para enviar desde {data.gmail.sender}.</Alert>
        ) : null}

        <div className="notification-toolbar">
          <TextInput
            label="Fecha para envios manuales"
            type="date"
            value={reportDate}
            onChange={setReportDate}
            disabled={controlsDisabled || Boolean(busyAction)}
            hint="Los botones Enviar ahora usan esta fecha. No modifica la programacion."
          />
          <Button type="button" variant="secondary" icon={RefreshCcw} disabled={controlsDisabled || Boolean(busyAction)} onClick={reload}>
            Actualizar
          </Button>
        </div>

        {!loading && !error ? (
          <div className="metrics-row notification-metrics" aria-label="Resumen de programaciones">
            <Metric label="Programaciones" value={configs.length} />
            <Metric label="Activas" value={activeConfigs.length} tone="accent" />
            <Metric label="Proximo horario" value={nextScheduleLabel} />
          </div>
        ) : null}
      </Panel>

      {editorId ? (
        <div id="notification-schedule-editor" ref={editorRef}>
          <Panel
          title={editorId === "new" ? "Nueva programacion" : "Editar programacion"}
          eyebrow="Configuracion"
          className="notification-editor-panel"
        >
          <form className="stack" onSubmit={handleSaveSettings} aria-label={editorId === "new" ? "Crear programacion" : "Editar programacion"}>
            <div className="form-grid notification-editor-form">
              <TextInput
                label="Nombre de la programacion"
                value={form.nombre}
                onChange={(nombre) => setForm({ ...form, nombre })}
                disabled={saving}
                maxLength={100}
                required
                autoFocus
                placeholder="Ejemplo: Reporte para Recursos Humanos"
              />
              <TextInput
                label="Hora diaria de envio"
                type="time"
                value={form.hora_envio}
                onChange={(hora_envio) => setForm({ ...form, hora_envio })}
                disabled={saving}
                required
                hint="Zona horaria America/Lima."
              />
              <TextInput
                label="Asunto del correo"
                value={form.asunto}
                onChange={(asunto) => setForm({ ...form, asunto })}
                disabled={saving}
                maxLength={160}
                required
              />
              <CheckboxInput
                label="Activar envio automatico diario"
                checked={form.activo}
                onChange={(activo) => {
                  if (activo && !gmailConfigured) {
                    setStatus({ type: "error", message: "Configura Gmail antes de activar una programacion." });
                    return;
                  }
                  setForm({ ...form, activo });
                }}
                disabled={saving}
                hint={gmailConfigured ? "Se enviara una sola vez por fecha." : "Gmail aun no esta configurado."}
              />
              <TextArea
                label="Correos destinatarios"
                value={form.destinatarios}
                onChange={(destinatarios) => setForm({ ...form, destinatarios })}
                disabled={saving}
                rows={4}
                placeholder="correo1@gmail.com\ncorreo2@empresa.com"
                hint="Uno por linea o separados por comas. Maximo 20."
              />
              <CheckboxInput
                label="Incluir a todos los trabajadores activos"
                checked={form.incluir_todos_activos}
                onChange={(incluir_todos_activos) => setForm({ ...form, incluir_todos_activos })}
                disabled={saving}
                hint="Desactivalo para elegir trabajadores especificos."
              />
            </div>

            {!form.incluir_todos_activos ? (
              <fieldset className="notification-worker-picker" disabled={saving}>
                <legend>Trabajadores incluidos en el reporte</legend>
                {excludedInactiveCount ? (
                  <Alert type="warning">
                    {excludedInactiveCount} trabajador(es) seleccionados fueron desactivados. No apareceran en el reporte y se quitaran al guardar.
                  </Alert>
                ) : null}
                <div className="notification-worker-picker-toolbar">
                  <label className="field notification-worker-search">
                    <span className="field-label">Buscar trabajador activo</span>
                    <span className="search-input">
                      <Search aria-hidden="true" />
                      <input
                        className="input"
                        type="search"
                        value={workerSearch}
                        onChange={(event) => setWorkerSearch(event.target.value)}
                        placeholder="Nombre o correo"
                      />
                    </span>
                  </label>
                  <div className="notification-selection-actions">
                    <span>{selectedUserIds.size} seleccionado(s)</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      icon={UsersRound}
                      onClick={() => setForm({ ...form, usuario_ids: activeWorkers.map((worker) => String(worker.id)) })}
                    >
                      Seleccionar todos
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setForm({ ...form, usuario_ids: [] })}>
                      Limpiar
                    </Button>
                  </div>
                </div>
                {!activeWorkers.length ? <Alert>No hay trabajadores activos disponibles.</Alert> : null}
                {activeWorkers.length && !visibleWorkers.length ? <Alert>No hay coincidencias para esta busqueda.</Alert> : null}
                <div className="notification-worker-list">
                  {visibleWorkers.map((worker) => (
                    <label key={worker.id} className="notification-worker-option">
                      <input
                        type="checkbox"
                        checked={selectedUserIds.has(String(worker.id))}
                        onChange={(event) => toggleWorker(worker.id, event.target.checked)}
                      />
                      <span>
                        <strong>{worker.nombre || "Sin nombre"}</strong>
                        <small>{worker.email || "Sin correo"}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <div className="form-actions notification-editor-actions">
              <Button type="button" variant="ghost" disabled={saving} onClick={closeEditor}>Cancelar</Button>
              <Button type="submit" icon={Save} loading={saving} disabled={Boolean(busyAction)}>
                {editorId === "new" ? "Crear programacion" : "Guardar cambios"}
              </Button>
            </div>
          </form>
          </Panel>
        </div>
      ) : null}

      <Panel title="Programaciones" eyebrow="Envios automaticos">
        {loading ? <LoadingBlock label="Cargando programaciones" /> : null}
        {error ? <Alert type="error">No se pudieron cargar las programaciones.</Alert> : null}
        {!loading && !error && !configs.length ? (
          <div className="empty-state notification-empty-state">
            <Mail aria-hidden="true" />
            <span>Todavia no hay programaciones. Crea la primera para comenzar.</span>
          </div>
        ) : null}
        {!loading && !error ? <div className="notification-schedule-grid">
          {configs.map((config) => {
            const recipients = notificationRecipients(config.destinatarios);
            const configuredUserIds = notificationUserIds(config);
            const userIds = configuredUserIds.filter((id) => activeWorkerIds.has(id));
            const excludedUsers = configuredUserIds.length - userIds.length;
            const includesAllWorkers = notificationIncludesAllWorkers(config);
            const isActive = boolValue(config.activo);
            const isSending = busyAction === `send:${config.id}`;
            const isDeleting = busyAction === `delete:${config.id}`;
            const cardBusy = controlsDisabled || Boolean(busyAction) || saving;
            return (
              <article key={config.id} className={`notification-schedule-card ${isActive ? "active" : "paused"}`}>
                <header className="notification-card-header">
                  <div className="notification-card-title">
                    <span className="notification-card-icon"><Mail aria-hidden="true" /></span>
                    <div>
                      <small>Programacion #{config.id}</small>
                      <h3>{config.nombre || `Programacion ${config.id}`}</h3>
                    </div>
                  </div>
                  <span className={`notification-status-badge ${isActive ? "active" : "paused"}`}>
                    {isActive ? "Activa" : "Pausada"}
                  </span>
                </header>

                <div className="notification-card-time">
                  <Clock3 aria-hidden="true" />
                  <strong>{String(config.hora_envio || "18:00").slice(0, 5)}</strong>
                  <span>America/Lima</span>
                </div>

                <dl className="notification-card-details">
                  <div>
                    <dt>Asunto</dt>
                    <dd>{config.asunto || "Reporte diario de asistencia"}</dd>
                  </div>
                  <div>
                    <dt>Destinatarios</dt>
                    <dd title={recipients.join(", ")}>
                      {recipients.length ? `${recipients.slice(0, 2).join(", ")}${recipients.length > 2 ? ` y ${recipients.length - 2} mas` : ""}` : "Sin destinatarios"}
                    </dd>
                  </div>
                  <div>
                    <dt>Alcance</dt>
                    <dd>
                      {includesAllWorkers
                        ? `Todos los activos (${activeWorkers.length})`
                        : `${userIds.length} trabajador(es) activo(s)${excludedUsers ? ` · ${excludedUsers} inactivo(s) excluido(s)` : ""}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Ultimo envio</dt>
                    <dd>{config.ultimo_envio_en ? formatDateTimeLima(config.ultimo_envio_en) : "Todavia no enviado"}</dd>
                  </div>
                </dl>

                <div className="notification-card-actions">
                  <Button
                    type="button"
                    icon={Send}
                    loading={isSending}
                    disabled={cardBusy || !gmailConfigured || !recipients.length || !reportDate || (!includesAllWorkers && !userIds.length)}
                    aria-label={`Enviar ahora ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => handleSendNow(config)}
                  >
                    Enviar ahora
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    icon={Pencil}
                    disabled={cardBusy}
                    aria-controls="notification-schedule-editor"
                    aria-expanded={String(editorId) === String(config.id)}
                    aria-label={`Editar ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => openEditEditor(config)}
                  >
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    icon={Trash2}
                    loading={isDeleting}
                    disabled={cardBusy}
                    aria-label={`Eliminar ${config.nombre || `programacion ${config.id}`}`}
                    onClick={() => handleDelete(config)}
                  >
                    Eliminar
                  </Button>
                </div>
              </article>
            );
          })}
        </div> : null}
        <div className="notification-live-region" aria-live="polite">
          <StatusAlert status={status} />
          {status ? (
            <button
              type="button"
              className="notification-status-close"
              aria-label="Cerrar mensaje"
              onClick={() => setStatus(null)}
            >
              <X aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </Panel>

      <Panel title="Historial de envios" eyebrow="Seguimiento">
        {loading ? <LoadingBlock label="Cargando historial" /> : null}
        {error ? <Alert type="error">No se pudo cargar el historial de envios.</Alert> : null}
        {!loading && !error ? (
          <DataTable rows={historyRows} empty="Todavia no se enviaron reportes de asistencia." compact />
        ) : null}
      </Panel>
    </div>
  );
}

function excelSheetName(value, fallback = "Datos") {
  return String(value || fallback).replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || fallback;
}

function excelTableName(value, index) {
  const normalized = String(value || `Tabla${index + 1}`).replace(/[^a-zA-Z0-9_]/g, "");
  return `Tabla_${normalized || index + 1}_${index + 1}`;
}

function excelCellValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  return String(value);
}

async function downloadExcelWorkbook(filename, datasets) {
  const excelModule = await import("exceljs");
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Sistema de Formularios";
  workbook.created = new Date();
  workbook.modified = new Date();

  datasets.forEach((dataset, datasetIndex) => {
    const sheet = workbook.addWorksheet(excelSheetName(dataset.sheetName || dataset.label, `Hoja ${datasetIndex + 1}`), {
      views: [{ state: "frozen", ySplit: 1 }],
      properties: { defaultRowHeight: 21 }
    });
    const columns = dataset.columns || [];
    const rows = dataset.rows || [];
    const tableRows = rows.map((row) => columns.map((column) => excelCellValue(row[column])));

    sheet.addTable({
      name: excelTableName(dataset.key || dataset.label, datasetIndex),
      ref: "A1",
      headerRow: true,
      totalsRow: false,
      style: { theme: "TableStyleMedium2", showRowStripes: true, showColumnStripes: false },
      columns: columns.map((column) => ({ name: column, filterButton: true })),
      rows: tableRows
    });

    const header = sheet.getRow(1);
    header.height = 30;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FF0B5F59" } },
        bottom: { style: "medium", color: { argb: "FF0B5F59" } },
        left: { style: "thin", color: { argb: "FF9CCBC5" } },
        right: { style: "thin", color: { argb: "FF9CCBC5" } }
      };
    });

    columns.forEach((column, columnIndex) => {
      const longest = rows.reduce((max, row) => Math.max(max, String(row[column] ?? "").length), String(column).length);
      const worksheetColumn = sheet.getColumn(columnIndex + 1);
      worksheetColumn.width = Math.min(42, Math.max(12, longest + 2));
      worksheetColumn.alignment = { vertical: "middle", wrapText: longest > 34 };
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) row.height = 22;
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, rows.length + 1), column: Math.max(1, columns.length) }
    };
    sheet.pageSetup = {
      orientation: columns.length > 7 ? "landscape" : "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/\.xls$/i, ".xlsx");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadExcelTable(filename, columns, rows, label = "Datos") {
  return downloadExcelWorkbook(filename, [{ key: label, label, sheetName: label, columns, rows }]);
}

function StoresPanel() {
  const [section, setSection] = useState("Tiendas");
  return (
    <div className="stack">
      <Tabs tabs={["Tiendas", "Marcas"]} active={section} onChange={setSection} />
      {section === "Tiendas" ? <StoresSection /> : <BrandsSection />}
    </div>
  );
}

function StoresSection() {
  const { data: stores = [], loading, error, reload } = useAsyncData(listTiendas, [], []);
  const [tab, setTab] = useState("Crear");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [nombre, setNombre] = useState("");
  const [activo, setActivo] = useState(true);
  const [selectedId, setSelectedId] = useState("");

  const selectedStore = stores.find((store) => String(store.id) === String(selectedId));

  useEffect(() => {
    if (!selectedStore) return;
    setNombre(selectedStore.nombre || "");
    setActivo(boolValue(selectedStore.activo));
  }, [selectedStore?.id]);

  async function submitCreate(event) {
    event.preventDefault();
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre de tienda es obligatorio." });
      return;
    }
    setSaving(true);
    try {
      await createTienda({ nombre: nombre.trim(), activo });
      setNombre("");
      setActivo(true);
      setStatus({ type: "success", message: "Tienda creada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!selectedStore) return;
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre de tienda es obligatorio." });
      return;
    }
    setSaving(true);
    try {
      await updateTienda(selectedStore.id, { nombre: nombre.trim(), activo });
      setStatus({ type: "success", message: "Tienda actualizada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitDelete() {
    if (!selectedStore) return;
    setSaving(true);
    try {
      const result = await deleteTienda(selectedStore.id);
      setSelectedId("");
      setNombre("");
      setStatus({
        type: result?.archived ? "warning" : "success",
        message: result?.archived
          ? "La tienda tiene historial relacionado y fue desactivada en lugar de eliminarse."
          : "Tienda eliminada correctamente."
      });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <Panel title="Gestion de tiendas" eyebrow="Catalogo">
        {loading ? <LoadingBlock /> : (
          <DataTable
            rows={stores.map((store) => ({ Nombre: store.nombre, Activo: boolValue(store.activo) }))}
            columns={["Nombre", "Activo"]}
          />
        )}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>
      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear", "Editar", "Eliminar"]} active={tab} onChange={setTab} />
        <form className="form-grid" onSubmit={tab === "Crear" ? submitCreate : submitEdit}>
          {tab !== "Crear" ? (
            <SelectInput
              label="Tienda"
              value={selectedId}
              onChange={setSelectedId}
              options={[
                { value: "", label: "Selecciona una tienda" },
                ...stores.map((store) => ({ value: String(store.id), label: store.nombre || "Tienda sin nombre" }))
              ]}
            />
          ) : null}
          {tab !== "Eliminar" ? (
            <>
              <TextInput label="Nombre de tienda" value={nombre} onChange={setNombre} />
              <CheckboxInput label="Activo" checked={activo} onChange={setActivo} />
              <div className="form-span">
                <Button type="submit" icon={Save} loading={saving}>{tab === "Crear" ? "Crear tienda" : "Guardar cambios"}</Button>
              </div>
            </>
          ) : selectedStore ? (
            <div className="danger-zone form-span">
              <p>Eliminaras la tienda {selectedStore.nombre}.</p>
              <Button type="button" variant="danger" icon={Trash2} loading={saving} onClick={submitDelete}>Eliminar tienda</Button>
            </div>
          ) : null}
          <div className="form-span">
            <StatusAlert status={status} />
          </div>
        </form>
      </Panel>
    </div>
  );
}

function BrandsSection() {
  const { data: brands = [], loading, error, reload } = useAsyncData(listBrands, [], []);
  const [tab, setTab] = useState("Crear");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [nombre, setNombre] = useState("");
  const [selectedId, setSelectedId] = useState("");

  const selectedBrand = brands.find((brand) => String(brand.id) === String(selectedId));

  useEffect(() => {
    if (!selectedBrand) return;
    setNombre(selectedBrand.nombre || "");
  }, [selectedBrand?.id]);

  async function submitCreate(event) {
    event.preventDefault();
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre de marca es obligatorio." });
      return;
    }
    setSaving(true);
    try {
      await createBrand({ nombre: nombre.trim() });
      setNombre("");
      setStatus({ type: "success", message: "Marca creada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!selectedBrand) return;
    if (!nombre.trim()) {
      setStatus({ type: "error", message: "El nombre de marca es obligatorio." });
      return;
    }
    setSaving(true);
    try {
      await updateBrand(selectedBrand.id, { nombre: nombre.trim() });
      setStatus({ type: "success", message: "Marca actualizada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitDelete() {
    if (!selectedBrand) return;
    setSaving(true);
    try {
      await deleteBrand(selectedBrand.id);
      setSelectedId("");
      setNombre("");
      setStatus({ type: "success", message: "Marca eliminada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <Panel title="Gestion de marcas" eyebrow="Catalogo">
        {loading ? <LoadingBlock /> : (
          <DataTable
            rows={[...brands].sort((left, right) => String(left.nombre || "").localeCompare(String(right.nombre || ""), "es"))}
            columns={["nombre"]}
            className="brands-management-table"
            pageSize={0}
          />
        )}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>
      <Panel actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        <Tabs tabs={["Crear", "Editar", "Eliminar"]} active={tab} onChange={setTab} />
        <form className="form-grid" onSubmit={tab === "Crear" ? submitCreate : submitEdit}>
          {tab !== "Crear" ? (
            <SelectInput
              label="Marca"
              value={selectedId}
              onChange={setSelectedId}
              options={[
                { value: "", label: "Selecciona una marca" },
                ...brands.map((brand) => ({ value: String(brand.id), label: brand.nombre || "Marca sin nombre" }))
              ]}
            />
          ) : null}
          {tab !== "Eliminar" ? (
            <>
              <TextInput label="Nombre de marca" value={nombre} onChange={setNombre} />
              <div className="form-span">
                <Button type="submit" icon={Save} loading={saving}>{tab === "Crear" ? "Crear marca" : "Guardar cambios"}</Button>
              </div>
            </>
          ) : selectedBrand ? (
            <div className="danger-zone form-span">
              <p>Eliminaras la marca {selectedBrand.nombre}.</p>
              <Button type="button" variant="danger" icon={Trash2} loading={saving} onClick={submitDelete}>Eliminar marca</Button>
            </div>
          ) : null}
          <div className="form-span">
            <StatusAlert status={status} />
          </div>
        </form>
      </Panel>
    </div>
  );
}

const LOTE_ESTADOS = [
  { value: "pendiente", label: "Pendiente" },
  { value: "en_curso", label: "En curso" },
  { value: "completado", label: "Completado" }
];

// Si el lote ya se completo, son los dias reales que tardo. Si sigue
// pendiente, se calcula contra hoy (no se guarda en ningun lado), asi que la
// cifra sube sola cada dia hasta que se marque como completado.
function loteClassificationDays(lote) {
  if (!lote.fecha_trabajo) return null;
  const endDate = lote.fecha_fin_clasificado || todayLimaISO();
  if (!endDate) return null;
  const days = Math.round((new Date(`${endDate}T00:00:00`) - new Date(`${lote.fecha_trabajo}T00:00:00`)) / 86400000);
  return Number.isFinite(days) ? Math.max(1, days + 1) : null;
}

function loteLabelingDays(lote) {
  if (!lote.fecha_inicio_etiquetado) return null;
  const endDate = lote.estado === "completado" && lote.fecha_completada ? lote.fecha_completada : todayLimaISO();
  const days = Math.round((new Date(`${endDate}T00:00:00`) - new Date(`${lote.fecha_inicio_etiquetado}T00:00:00`)) / 86400000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

function emptyLoteForm() {
  return {
    codigo_lote: "", cantidad_lote: "", marca_id: "", fecha_ingreso: todayLimaISO(), fecha_trabajo: "", fecha_fin_clasificado: "", fecha_inicio_etiquetado: "",
    fecha_completada: "", proveedor: "", usuario_id: "", estado: "pendiente"
  };
}

function LotesPanel() {
  const [view, setView] = useState("Inventario");
  return (
    <div className="stack">
      <Tabs tabs={["Inventario", "Lote general"]} active={view} onChange={setView} />
      {view === "Lote general" ? <GeneralLotePanel /> : <LotesInventoryPanel />}
    </div>
  );
}

function GeneralLotePanel() {
  const { data, loading, error, reload } = useAsyncData(
    listGeneralLoteAccumulations,
    [],
    { codigo_lote: "LOTE GENERAL", cantidad_total: 0, acumulados: [] }
  );
  const rows = (data.acumulados || []).map((item) => ({
    Operante: item.trabajador_nombre,
    Tarea: item.tarea_nombre,
    "Cantidad acumulada": Number(item.cantidad_acumulada || 0).toLocaleString("es-PE"),
    Registros: item.registros,
    "Ultimo registro": formatDateLima(item.ultima_fecha)
  }));
  return (
    <Panel
      title="Lote general"
      eyebrow="Acumulado aislado"
      actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
    >
      <Alert>
        En esta lista se muestra lo acumulado en el Lote general. Los registros otorgan puntos y son visibles en los
        historiales y en el Detalle de Registro de Tareas, pero no se utilizan en gráficas, cálculos, reportes ni documentos.
      </Alert>
      <div className="metrics-grid lote-general-metrics">
        <Metric label="Cantidad total acumulada" value={Number(data.cantidad_total || 0).toLocaleString("es-PE")} tone="accent" />
        <Metric label="Operantes y tareas" value={rows.length} />
      </div>
      {loading ? <LoadingBlock label="Cargando acumulados..." /> : null}
      {error ? <Alert type="error">{friendlyError(error)}</Alert> : null}
      {!loading ? (
        <DataTable
          rows={rows}
          columns={["Operante", "Tarea", "Cantidad acumulada", "Registros", "Ultimo registro"]}
          empty="Todavia no hay cantidades acumuladas en el Lote general."
        />
      ) : null}
    </Panel>
  );
}

function LotesInventoryPanel() {
  const { data: lotes = [], setData: setLotes, loading, error, reload } = useAsyncData(listLotes, [], []);
  const { data: brands = [] } = useAsyncData(listBrands, [], []);
  const { data: users = [] } = useAsyncData(selectUsers, [], []);
  const [tab, setTab] = useState("Crear");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState(emptyLoteForm);

  const teamLeaders = users.filter((user) => normalizeRole(user.rol) === "lider de equipo" && boolValue(user.activo));
  const regularLotes = lotes.filter((lote) => !lote.es_general && String(lote.codigo_lote || "").trim().toUpperCase() !== "LOTE GENERAL");
  const selectedLote = regularLotes.find((lote) => String(lote.id) === String(selectedId));

  useEffect(() => {
    if (!selectedLote) return;
    setForm({
      codigo_lote: selectedLote.codigo_lote || "",
      cantidad_lote: String(selectedLote.cantidad_lote ?? ""),
      marca_id: String(selectedLote.marca_id || ""),
      fecha_ingreso: selectedLote.fecha_ingreso || "",
      fecha_trabajo: selectedLote.fecha_trabajo || "",
      fecha_fin_clasificado: selectedLote.fecha_fin_clasificado || "",
      fecha_inicio_etiquetado: selectedLote.fecha_inicio_etiquetado || "",
      fecha_completada: selectedLote.fecha_completada || "",
      proveedor: selectedLote.proveedor || "",
      usuario_id: String(selectedLote.usuario_id || ""),
      estado: selectedLote.estado || "pendiente"
    });
  }, [selectedLote?.id]);

  function validateForm() {
    if (!form.codigo_lote.trim()) return "El codigo de lote es obligatorio.";
    if (!Number.isInteger(Number(form.cantidad_lote)) || Number(form.cantidad_lote) < 0) {
      return "La cantidad debe ser un numero entero mayor o igual a cero.";
    }
    if (!form.marca_id) return "Selecciona una marca.";
    if (!form.fecha_ingreso) return "Selecciona una fecha de ingreso.";
    if (form.fecha_trabajo && form.fecha_fin_clasificado && form.fecha_fin_clasificado < form.fecha_trabajo) {
      return "La fecha de fin de clasificado no puede ser anterior a su fecha de inicio.";
    }
    if (form.fecha_fin_clasificado && form.fecha_inicio_etiquetado && form.fecha_inicio_etiquetado < form.fecha_fin_clasificado) {
      return "La fecha de inicio de etiquetado no puede ser anterior al fin de clasificado.";
    }
    if (form.fecha_inicio_etiquetado && form.fecha_completada && form.fecha_completada < form.fecha_inicio_etiquetado) {
      return "La fecha completada de etiquetado no puede ser anterior a su fecha de inicio.";
    }
    if (!form.proveedor.trim()) return "El proveedor es obligatorio.";
    if (!form.usuario_id) return "Selecciona el líder de equipo responsable del lote.";
    if (!LOTE_ESTADOS.some((option) => option.value === form.estado)) return "Selecciona un estado valido.";
    if (form.estado === "completado" && (!form.fecha_trabajo || !form.fecha_fin_clasificado || !form.fecha_inicio_etiquetado || !form.fecha_completada)) {
      return "Completa todas las fechas antes de marcar el lote como Completado.";
    }
    return null;
  }

  function buildPayload() {
    return {
      codigo_lote: form.codigo_lote.trim(),
      cantidad_lote: Number(form.cantidad_lote),
      marca_id: Number(form.marca_id),
      fecha_ingreso: form.fecha_ingreso,
      fecha_trabajo: form.fecha_trabajo || null,
      fecha_fin_clasificado: form.fecha_fin_clasificado || null,
      fecha_inicio_etiquetado: form.fecha_inicio_etiquetado || null,
      fecha_completada: form.fecha_completada || null,
      proveedor: form.proveedor.trim(),
      usuario_id: Number(form.usuario_id),
      estado: form.estado
    };
  }

  async function submitCreate(event) {
    event.preventDefault();
    setStatus(null);
    const validationError = validateForm();
    if (validationError) {
      setStatus({ type: "error", message: validationError });
      return;
    }
    setSaving(true);
    try {
      const createdLote = await createLote(buildPayload());
      setLotes((current) => [createdLote, ...(current || []).filter((lote) => String(lote.id) !== String(createdLote.id))]);
      setForm(emptyLoteForm());
      setStatus({ type: "success", message: "Lote creado correctamente." });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!selectedLote) return;
    setStatus(null);
    const validationError = validateForm();
    if (validationError) {
      setStatus({ type: "error", message: validationError });
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload();
      const updatedLote = await updateLote(selectedLote.id, payload);
      const savedDatesMatch = ["fecha_trabajo", "fecha_fin_clasificado", "fecha_inicio_etiquetado", "fecha_completada"]
        .every((field) => (updatedLote[field] || null) === (payload[field] || null));
      if (!savedDatesMatch) {
        throw new Error("El servidor no confirmó las fechas ingresadas. Actualiza la versión publicada e inténtalo nuevamente.");
      }
      setLotes((current) => (current || []).map((lote) => (
        String(lote.id) === String(updatedLote.id) ? updatedLote : lote
      )));
      setStatus({ type: "success", message: "Lote actualizado correctamente." });
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function submitDelete() {
    if (!selectedLote) return;
    if (!window.confirm(`Eliminar el lote "${selectedLote.codigo_lote}" (${selectedLote.marca_nombre})? Esta accion no se puede deshacer.`)) return;
    setStatus(null);
    setSaving(true);
    try {
      await deleteLote(selectedLote.id);
      setSelectedId("");
      setForm(emptyLoteForm());
      setStatus({ type: "success", message: "Lote eliminado correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  const rows = regularLotes.map((lote) => {
    const classificationDays = loteClassificationDays(lote);
    const labelingDays = loteLabelingDays(lote);
    return {
      id: lote.id,
      "Codigo de lote": lote.codigo_lote,
      Cantidad: lote.cantidad_lote,
      Marca: lote.marca_nombre,
      Estado: LOTE_ESTADOS.find((option) => option.value === lote.estado)?.label || lote.estado,
      "Fecha de ingreso": formatDateLima(lote.fecha_ingreso),
      "Fecha inicio clasificado": formatDateLima(lote.fecha_trabajo),
      "Fecha fin clasificado": formatDateLima(lote.fecha_fin_clasificado),
      "Fecha inicio etiquetado": formatDateLima(lote.fecha_inicio_etiquetado),
      "Fecha fin etiquetado": formatDateLima(lote.fecha_completada),
      "Días clasificado": classificationDays === null ? null : `${classificationDays} día${classificationDays === 1 ? "" : "s"}`,
      "Días etiquetado": labelingDays === null ? null : `${labelingDays} día${labelingDays === 1 ? "" : "s"}`,
      Proveedor: lote.proveedor,
      "Líder de equipo": lote.usuario_nombre
    };
  });

  return (
    <div className="stack">
      <Panel
        title="Catalogo de lotes"
        eyebrow="Inventario"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        {loading ? (
          <LoadingBlock />
        ) : (
          <DataTable
            rows={rows}
            columns={["Codigo de lote", "Cantidad", "Marca", "Estado", "Fecha de ingreso", "Fecha inicio clasificado", "Fecha fin clasificado", "Fecha inicio etiquetado", "Fecha fin etiquetado", "Días clasificado", "Días etiquetado", "Proveedor", "Líder de equipo"]}
            onRowClick={(row) => {
              setSelectedId(String(row.id));
              setTab("Editar");
            }}
            empty="No hay lotes registrados."
          />
        )}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>

      <Panel>
        <Tabs tabs={["Crear", "Editar", "Eliminar"]} active={tab} onChange={setTab} />
        <div className="lote-form-status"><StatusAlert status={status} /></div>
        <form className="form-grid" onSubmit={tab === "Crear" ? submitCreate : submitEdit}>
          {tab !== "Crear" ? (
            <SelectInput
              label="Lote"
              value={selectedId}
              onChange={setSelectedId}
              options={[
                { value: "", label: "Selecciona un lote" },
                ...regularLotes.map((lote) => ({ value: String(lote.id), label: `${lote.codigo_lote} - ${lote.marca_nombre}` }))
              ]}
            />
          ) : null}
          {tab !== "Eliminar" ? (
            <>
              <TextInput label="Codigo de lote" value={form.codigo_lote} onChange={(codigo_lote) => setForm({ ...form, codigo_lote })} />
              <TextInput
                label="Cantidad"
                type="number"
                min="0"
                value={form.cantidad_lote}
                onChange={(cantidad_lote) => setForm({ ...form, cantidad_lote })}
              />
              <SelectInput
                label="Marca"
                value={form.marca_id}
                onChange={(marca_id) => setForm({ ...form, marca_id })}
                options={[
                  { value: "", label: "Selecciona una marca" },
                  ...brands.map((brand) => ({ value: String(brand.id), label: brand.nombre }))
                ]}
              />
              <TextInput
                label="Fecha de ingreso"
                type="date"
                value={form.fecha_ingreso}
                onChange={(fecha_ingreso) => setForm({ ...form, fecha_ingreso })}
              />
              <TextInput
                label="Fecha inicio clasificado (opcional)"
                type="date"
                value={form.fecha_trabajo}
                onChange={(fecha_trabajo) => setForm({
                  ...form,
                  fecha_trabajo,
                  fecha_fin_clasificado: fecha_trabajo ? form.fecha_fin_clasificado : "",
                  fecha_inicio_etiquetado: fecha_trabajo ? form.fecha_inicio_etiquetado : "",
                  fecha_completada: fecha_trabajo ? form.fecha_completada : "",
                  estado: fecha_trabajo ? "en_curso" : "pendiente"
                })}
              />
              <TextInput
                label="Fecha fin clasificado"
                type="date"
                value={form.fecha_fin_clasificado}
                onChange={(fecha_fin_clasificado) => setForm({
                  ...form,
                  fecha_fin_clasificado,
                  fecha_inicio_etiquetado: fecha_fin_clasificado ? form.fecha_inicio_etiquetado : "",
                  fecha_completada: fecha_fin_clasificado ? form.fecha_completada : "",
                  estado: fecha_fin_clasificado ? form.estado : "en_curso"
                })}
                disabled={!form.fecha_trabajo}
                hint={!form.fecha_trabajo ? "Primero ingresa la fecha de inicio de clasificado." : ""}
              />
              <TextInput
                label="Fecha inicio de etiquetado"
                type="date"
                value={form.fecha_inicio_etiquetado}
                onChange={(fecha_inicio_etiquetado) => setForm({
                  ...form,
                  fecha_inicio_etiquetado,
                  fecha_completada: fecha_inicio_etiquetado ? form.fecha_completada : "",
                  estado: fecha_inicio_etiquetado ? form.estado : "en_curso"
                })}
                disabled={!form.fecha_fin_clasificado}
                hint={!form.fecha_fin_clasificado ? "Primero ingresa la fecha de fin de clasificado." : ""}
              />
              <TextInput label="Proveedor" value={form.proveedor} onChange={(proveedor) => setForm({ ...form, proveedor })} />
              <SelectInput
                label="Líder de equipo"
                value={form.usuario_id}
                onChange={(usuario_id) => setForm({ ...form, usuario_id })}
                options={[
                  { value: "", label: teamLeaders.length ? "Selecciona un líder de equipo" : "No hay líderes de equipo activos" },
                  ...teamLeaders.map((leader) => ({ value: String(leader.id), label: leader.nombre || leader.email }))
                ]}
              />
              <SelectInput
                label="Estado"
                value={form.estado}
                onChange={(estado) => setForm({ ...form, estado })}
                options={LOTE_ESTADOS.map((option) => ({
                  ...option,
                  disabled: option.value !== form.estado && option.value !== "completado"
                }))}
                disabled={!form.fecha_completada}
                hint={!form.fecha_completada ? "Cambia automáticamente a En curso al iniciar clasificado. Completa todas las fechas para cerrar." : "Ya puedes marcar el lote como Completado."}
              />
              <TextInput
                label="Fecha fin de etiquetado"
                type="date"
                value={form.fecha_completada}
                onChange={(fecha_completada) => setForm({
                  ...form,
                  fecha_completada,
                  estado: fecha_completada ? form.estado : "en_curso"
                })}
                disabled={!form.fecha_inicio_etiquetado}
                hint={!form.fecha_inicio_etiquetado ? "Primero ingresa la fecha de inicio de etiquetado." : "Esta fecha habilita el estado Completado."}
              />
              <div className="form-span lote-form-actions">
                <FormActions saving={saving} saveLabel={tab === "Crear" ? "Crear lote" : "Guardar cambios"} />
              </div>
            </>
          ) : selectedLote ? (
            <div className="danger-zone form-span">
              <p>Eliminaras el lote {selectedLote.codigo_lote} ({selectedLote.marca_nombre}).</p>
              <Button type="button" variant="danger" icon={Trash2} loading={saving} onClick={submitDelete}>Eliminar lote</Button>
            </div>
          ) : null}
        </form>
      </Panel>
    </div>
  );
}

const GUIA_MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Setiembre", "Octubre", "Noviembre", "Diciembre"
];
const GUIA_DATE_HEADER = "ESTADO";
const GUIA_CODE_HEADER = "TDA ORIGEN";
const GUIA_NISSEI_HEADER = "CODIGO NISSEI";
const GUIA_DESTINATION_HEADER = "TDA DESTINO";
const GUIA_QUANTITY_HEADER = "SERIE";
const GUIA_ITEM_BATCH_SIZE = 1000;

function guiaColLetter(ref) {
  return String(ref || "").match(/[A-Za-z]+/)?.[0] || "";
}

// Varias columnas del reporte tienen el encabezado desalineado de su propio
// dato (p.ej. "CODIGO NISSEI" trae en realidad el codigo de tienda, no un
// codigo de producto), asi que no se puede confiar en ningun encabezado
// salvo "ESTADO" y "TDA ORIGEN" (los que confirmo quien pidio esta
// funcion). Para identificar cada linea de forma unica dentro de una guia
// se usa una huella (hash) del contenido completo de la fila en vez de
// adivinar cual columna es "el codigo del producto".
function guiaLineFingerprint(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function guiaExcelDateToISODate(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) return null;

  const textDate = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (textDate) {
    const [, rawDay, rawMonth, rawYear] = textDate;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
    return `${rawYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (isoDate) {
    const [, rawYear, rawMonth, rawDay] = isoDate;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
    return `${rawYear}-${rawMonth}-${rawDay}`;
  }

  const serial = Number(text);
  if (!Number.isFinite(serial)) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Decodifica entidades XML basicas. El reporte usa el texto literal
// "_x000a_" (no una entidad) para el salto de linea dentro de una celda; eso
// se limpia aparte, mas abajo.
function guiaDecodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

const GUIA_SHARED_STRING_RE = /<si[^>]*>([\s\S]*?)<\/si>/g;
const GUIA_SHARED_STRING_TEXT_RE = /<t[^>]*>([\s\S]*?)<\/t>/g;
const GUIA_ROW_RE = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
const GUIA_CELL_RE = /<c r="([^"]+)"(?:[^>]*\st="([^"]+)")?[^>]*(?:\/>|>(?:<v>([\s\S]*?)<\/v>)?<\/c>)/g;

// El reporte "Salidas AAAA mes.xlsx" lo exporta un sistema externo cuyo zip
// no abre exceljs (falla en silencio, 0 hojas). Se descomprime a mano con
// jszip. El archivo puede traer decenas de miles de filas (un año completo
// pasa de 80,000): armar un DOM con DOMParser para esa cantidad de nodos es
// lento y puede agotar la memoria del navegador a medio importar, dejando
// datos incompletos sin ningun aviso. Por eso el XML de la hoja se lee con
// expresiones regulares en vez de un arbol DOM.
async function parseGuiasWorkbook(file) {
  const JSZipModule = await import("jszip");
  const JSZip = JSZipModule.default || JSZipModule;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const sheetPath = Object.keys(zip.files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (!sheetPath) throw new Error("El archivo no tiene una hoja de calculo valida.");

  const shared = [];
  const sharedStringsEntry = zip.file("xl/sharedStrings.xml");
  if (sharedStringsEntry) {
    const sharedXml = await sharedStringsEntry.async("string");
    let siMatch;
    GUIA_SHARED_STRING_RE.lastIndex = 0;
    while ((siMatch = GUIA_SHARED_STRING_RE.exec(sharedXml))) {
      let text = "";
      let tMatch;
      GUIA_SHARED_STRING_TEXT_RE.lastIndex = 0;
      while ((tMatch = GUIA_SHARED_STRING_TEXT_RE.exec(siMatch[1]))) {
        text += tMatch[1];
      }
      shared.push(guiaDecodeXmlEntities(text));
    }
  }

  const sheetXml = await zip.file(sheetPath).async("string");
  const rows = [];
  let rowMatch;
  GUIA_ROW_RE.lastIndex = 0;
  while ((rowMatch = GUIA_ROW_RE.exec(sheetXml))) {
    const cells = [];
    let cellMatch;
    GUIA_CELL_RE.lastIndex = 0;
    while ((cellMatch = GUIA_CELL_RE.exec(rowMatch[1]))) {
      cells.push({ ref: cellMatch[1], type: cellMatch[2] || null, raw: cellMatch[3] ?? null });
    }
    rows.push(cells);
  }
  if (!rows.length) throw new Error("El archivo no tiene filas de datos.");

  function cellValue(cell) {
    if (cell.raw == null) return null;
    return cell.type === "s" ? (shared[Number(cell.raw)] ?? "") : guiaDecodeXmlEntities(cell.raw);
  }

  // Los encabezados vienen tal como los escribio el sistema que genera el
  // reporte, incluyendo el escape "_x000a_" que Excel usa para un salto de
  // linea dentro de una celda (p.ej. "TDA_x000a_DESTINO"); se limpia para
  // que las columnas exportadas despues se lean bien.
  const headerCols = [];
  const headerByCol = {};
  rows[0].forEach((cell) => {
    const col = guiaColLetter(cell.ref);
    const label = String(cellValue(cell) || "").replace(/_x000a_/gi, " ").trim();
    headerCols.push(col);
    headerByCol[col] = label.toUpperCase();
  });
  const dateCol = headerCols.find((col) => headerByCol[col] === GUIA_DATE_HEADER);
  const codeCol = headerCols.find((col) => headerByCol[col] === GUIA_CODE_HEADER);
  const nisseiCol = headerCols.find((col) => headerByCol[col] === GUIA_NISSEI_HEADER);
  const destinationCol = headerCols.find((col) => headerByCol[col] === GUIA_DESTINATION_HEADER);
  const quantityCol = headerCols.find((col) => headerByCol[col] === GUIA_QUANTITY_HEADER);
  if (!dateCol || !codeCol || !quantityCol || (!nisseiCol && !destinationCol)) {
    throw new Error(`No se encontraron las columnas "${GUIA_DATE_HEADER}", "${GUIA_CODE_HEADER}", "${GUIA_QUANTITY_HEADER}" y una columna de destino en el archivo.`);
  }

  const guidesByCode = new Map();
  const itemsByKey = new Map();
  const cantidadByCode = new Map();
  for (const row of rows.slice(1)) {
    const valuesByCol = {};
    row.forEach((cell) => {
      valuesByCol[guiaColLetter(cell.ref)] = cellValue(cell);
    });
    const codigo = String(valuesByCol[codeCol] || "").trim();
    const fecha = guiaExcelDateToISODate(valuesByCol[dateCol]);
    const nissei = String(valuesByCol[nisseiCol] || "").trim().toUpperCase();
    const destination = String(valuesByCol[destinationCol] || "").trim().toUpperCase();
    if (!codigo || !fecha || (nissei !== "CD" && destination !== "CD")) continue;
    if (!guidesByCode.has(codigo)) guidesByCode.set(codigo, fecha);

    const rawCantidad = Number(valuesByCol[quantityCol]);
    const cantidad = Number.isFinite(rawCantidad) ? rawCantidad : 0;
    const codigoItem = guiaLineFingerprint(headerCols.map((col) => valuesByCol[col] ?? "").join("|"));
    const key = `${codigo}::${codigoItem}`;
    if (itemsByKey.has(key)) continue;
    itemsByKey.set(key, { codigoGuia: codigo, codigoItem, fecha, cantidad });

    // Se suma aqui (mientras se arma cada linea unica) para que la guia se
    // cree de una con su cantidad correcta, en vez de nacer en 0 y esperar
    // a que el detalle se importe y recalcule despues.
    cantidadByCode.set(codigo, (cantidadByCode.get(codigo) || 0) + cantidad);
  }

  return {
    guides: Array.from(guidesByCode, ([codigo, fecha]) => ({ codigo, fecha, cantidad: cantidadByCode.get(codigo) || 0 })),
    items: Array.from(itemsByKey.values())
  };
}

// Filtra guias/items ya parseados a un unico año-mes (util para importar solo
// una parte de un archivo que trae varios meses juntos) y recalcula la
// cantidad de cada guia solo con las lineas que quedan, para que no arrastre
// el total del archivo completo.
function filterGuiasParseToMonth({ guides, items }, anio, mes) {
  const prefix = `${anio}-${String(mes).padStart(2, "0")}`;
  const monthItems = items.filter((item) => String(item.fecha || "").startsWith(prefix));
  const cantidadByCode = new Map();
  monthItems.forEach((item) => {
    const cantidad = Number(item.cantidad);
    if (Number.isFinite(cantidad)) {
      cantidadByCode.set(item.codigoGuia, (cantidadByCode.get(item.codigoGuia) || 0) + cantidad);
    }
  });
  const monthGuideCodes = new Set(monthItems.map((item) => item.codigoGuia));
  const monthGuides = guides
    .filter((guide) => monthGuideCodes.has(guide.codigo))
    .map((guide) => ({ ...guide, cantidad: cantidadByCode.get(guide.codigo) || 0 }));
  return { guides: monthGuides, items: monthItems };
}

// Compartido entre "Importar" (todo el archivo) e "Importar mes" (filtrado):
// sube las guias y despues el detalle en lotes, reportando progreso.
async function runGuiasImport(guides, items, filename, onProgress) {
  onProgress({ type: "info", message: `Importando ${guides.length} guia(s)...` });
  const guideResult = await importGuias(guides, filename);

  let itemsImported = 0;
  let itemsOmitted = 0;
  for (let start = 0; start < items.length; start += GUIA_ITEM_BATCH_SIZE) {
    const batch = items.slice(start, start + GUIA_ITEM_BATCH_SIZE);
    onProgress({
      type: "info",
      message: `Importando detalle: ${Math.min(start + GUIA_ITEM_BATCH_SIZE, items.length)} de ${items.length} linea(s)...`
    });
    const batchResult = await importGuiaItems(batch, filename);
    itemsImported += batchResult.imported;
    itemsOmitted += batchResult.omitted;
  }

  return {
    guideResult,
    itemsImported,
    itemsOmitted,
    message: `Guias: ${guideResult.imported} nueva(s) de ${guideResult.total} (${guideResult.omitted} ya existian). `
      + `Detalle: ${itemsImported} linea(s) nueva(s) de ${items.length} (${itemsOmitted} ya existian).`
  };
}

function GuiasPanel() {
  const { data: guias = [], loading, error, reload } = useAsyncData(listGuias, [], []);
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [monthFile, setMonthFile] = useState(null);
  const [monthFileInputKey, setMonthFileInputKey] = useState(0);
  const [monthImporting, setMonthImporting] = useState(false);
  const [monthImportStatus, setMonthImportStatus] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState(null);
  const [anioFilter, setAnioFilter] = useState("todos");
  const [mesFilter, setMesFilter] = useState("todos");
  const hasMonthSelection = anioFilter !== "todos" && mesFilter !== "todos";

  async function handleImport() {
    setImportStatus(null);
    if (!file) {
      setImportStatus({ type: "error", message: "Selecciona un archivo Excel (.xlsx)." });
      return;
    }
    setImporting(true);
    try {
      const { guides, items } = await parseGuiasWorkbook(file);
      if (!guides.length) {
        setImportStatus({
          type: "error",
          message: `No se encontraron guias validas en el archivo. Verifica que tenga las columnas "${GUIA_DATE_HEADER}", "${GUIA_CODE_HEADER}" y filas con destino CD.`
        });
        return;
      }
      const result = await runGuiasImport(guides, items, file.name, setImportStatus);
      setImportStatus({ type: "success", message: result.message });
      setFile(null);
      setFileInputKey((key) => key + 1);
      reload();
    } catch (err) {
      setImportStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setImporting(false);
    }
  }

  async function handleImportMonth() {
    setMonthImportStatus(null);
    if (!hasMonthSelection) {
      setMonthImportStatus({ type: "error", message: "Selecciona un año y un mes especificos primero." });
      return;
    }
    if (!monthFile) {
      setMonthImportStatus({ type: "error", message: "Selecciona un archivo Excel (.xlsx)." });
      return;
    }
    setMonthImporting(true);
    try {
      const parsed = await parseGuiasWorkbook(monthFile);
      const { guides, items } = filterGuiasParseToMonth(parsed, anioFilter, mesFilter);
      const mesLabel = GUIA_MESES[Number(mesFilter) - 1] || mesFilter;
      if (!guides.length) {
        setMonthImportStatus({
          type: "error",
          message: `El archivo no tiene guias de ${mesLabel} ${anioFilter}. Se encontraron ${parsed.guides.length} guia(s) en total, pero ninguna de ese mes.`
        });
        return;
      }
      const result = await runGuiasImport(guides, items, monthFile.name, setMonthImportStatus);
      setMonthImportStatus({ type: "success", message: `Solo ${mesLabel} ${anioFilter} (de ${parsed.guides.length} guia(s) en el archivo): ${result.message}` });
      setMonthFile(null);
      setMonthFileInputKey((key) => key + 1);
      reload();
    } catch (err) {
      setMonthImportStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setMonthImporting(false);
    }
  }

  async function handleExport() {
    setExportStatus(null);
    if (anioFilter === "todos" || mesFilter === "todos") {
      setExportStatus({ type: "error", message: "Selecciona un año y un mes especificos para exportar." });
      return;
    }
    setExporting(true);
    try {
      const rawItems = await listGuiaItemsForExport(anioFilter, mesFilter);
      if (!rawItems.length) {
        setExportStatus({ type: "error", message: "No hay guias importadas para ese mes." });
        return;
      }
      const items = rawItems.map((item) => ({ ...item, Estado: formatDateLima(item.Estado) }));
      const mesLabel = GUIA_MESES[Number(mesFilter) - 1] || mesFilter;
      downloadExcelTable(`guias_${mesLabel.toLowerCase()}_${anioFilter}.xls`, ["Estado", "Guia", "Cantidad"], items, "Guias");
      setExportStatus({ type: "success", message: `${items.length} guia(s) exportada(s) (agrupadas, con su cantidad sumada) de ${mesLabel} ${anioFilter}.` });
    } catch (err) {
      setExportStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setExporting(false);
    }
  }

  const withParts = guias.map((guia) => {
    const [anio, mes] = String(guia.fecha || "").split("-");
    return { ...guia, anio, mes: Number(mes) };
  });

  const years = Array.from(new Set(withParts.map((guia) => guia.anio).filter(Boolean))).sort((a, b) => b.localeCompare(a));

  const summaryMap = new Map();
  withParts.forEach((guia) => {
    if (!guia.anio || !guia.mes) return;
    const key = `${guia.anio}-${String(guia.mes).padStart(2, "0")}`;
    summaryMap.set(key, (summaryMap.get(key) || 0) + 1);
  });
  const summaryRows = Array.from(summaryMap, ([key, count]) => ({ key, Mes: `${GUIA_MESES[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`, Cantidad: count }))
    .sort((a, b) => b.key.localeCompare(a.key))
    .map(({ key: _key, ...rest }) => rest);

  const tableRows = withParts
    .filter((guia) => anioFilter === "todos" || guia.anio === anioFilter)
    .filter((guia) => mesFilter === "todos" || String(guia.mes) === mesFilter)
    .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || String(a.codigo).localeCompare(String(b.codigo)))
    .map((guia) => ({
      Codigo: guia.codigo,
      Fecha: formatDateLima(guia.fecha),
      Mes: guia.mes ? GUIA_MESES[guia.mes - 1] : "",
      Año: guia.anio || "",
      Cantidad: guia.cantidad || 0
    }));

  return (
    <div className="stack">
      <Panel title="Importar guias" eyebrow="Reporte de salidas">
        <Alert>
          Sube el Excel de salidas (por ejemplo "Salidas 2026 enero.xlsx"). Cada guia se identifica por su codigo en
          la columna "{GUIA_CODE_HEADER}" y su fecha se toma de la columna "{GUIA_DATE_HEADER}". Solo se toman en
          cuenta las filas donde "{GUIA_DESTINATION_HEADER}" o "{GUIA_NISSEI_HEADER}" sea CD; el resto se ignora. Tambien se guarda
          cada linea de producto de la guia con su cantidad. Puedes importar el mismo
          archivo mas de una vez o archivos de distintos meses: lo que ya existe no se sobrescribe ni se duplica,
          solo se agrega lo que falte.
        </Alert>
        <div className="toolbar">
          <input
            key={fileInputKey}
            className="input"
            type="file"
            accept=".xlsx"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
          <Button icon={Upload} loading={importing} onClick={handleImport}>Importar</Button>
        </div>
        <StatusAlert status={importStatus} />
      </Panel>

      <Panel title="Guias por mes" eyebrow="Resumen" actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        <DataTable rows={summaryRows} empty="Todavia no se importaron guias." />
      </Panel>

      <Panel title="Guias" eyebrow="Detalle">
        <Alert>
          Elige un año y un mes especificos: ahi se habilita importar o exportar solo ese mes. Al importar aqui, si
          el archivo trae varios meses, se ignora todo lo que no sea de {" "}
          {hasMonthSelection ? `${GUIA_MESES[Number(mesFilter) - 1] || mesFilter} ${anioFilter}` : "el mes elegido"}.
        </Alert>
        <div className="toolbar">
          <SelectInput
            label="Año"
            value={anioFilter}
            onChange={setAnioFilter}
            options={[{ value: "todos", label: "Todos" }, ...years.map((year) => ({ value: year, label: year }))]}
          />
          <SelectInput
            label="Mes"
            value={mesFilter}
            onChange={setMesFilter}
            options={[{ value: "todos", label: "Todos" }, ...GUIA_MESES.map((mes, index) => ({ value: String(index + 1), label: mes }))]}
          />
          <Button variant="secondary" icon={FileSpreadsheet} loading={exporting} disabled={!hasMonthSelection} onClick={handleExport}>Exportar Excel del mes</Button>
        </div>
        <div className="toolbar">
          <input
            key={monthFileInputKey}
            className="input"
            type="file"
            accept=".xlsx"
            disabled={!hasMonthSelection}
            onChange={(event) => setMonthFile(event.target.files?.[0] || null)}
          />
          <Button variant="secondary" icon={Upload} loading={monthImporting} disabled={!hasMonthSelection} onClick={handleImportMonth}>Importar mes</Button>
        </div>
        <DataTable rows={tableRows} columns={["Codigo", "Fecha", "Mes", "Año", "Cantidad"]} pageSize={25} empty="No hay guias para estos filtros." />
        <StatusAlert status={exportStatus} />
        <StatusAlert status={monthImportStatus} />
      </Panel>
    </div>
  );
}

const TIPOS_DOCUMENTO = ["CARTA AMONESTACION", "MEMORANDUM", "VERBAL"];

function emptyWarningForm() {
  return { usuario_id: "", descripcion: "", tipo_documento: "", fecha: todayLimaISO() };
}

// Muestra la fecha propia de la amonestacion; si es un registro viejo que no la
// tiene, cae al momento en que se creo.
function formatWarningDate(warning) {
  const value = String(warning?.fecha || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return formatDateTimeLima(warning?.created_at) || "-";
}

function WarningsPanel() {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [warnings, users] = await Promise.all([listAmonestaciones(), selectUsers()]);
      return { warnings, users };
    },
    [],
    { warnings: [], users: [] }
  );
  const [tab, setTab] = useState("Registrar");
  const [form, setForm] = useState(emptyWarningForm);
  const [selectedWarningId, setSelectedWarningId] = useState("");
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);

  const users = data.users || [];
  const operationalUsers = users.filter((user) => normalizeRole(user.rol) !== "administrador");
  const operationalUserIds = new Set(operationalUsers.map((user) => String(user.id)));
  const warnings = (data.warnings || []).filter((warning) => operationalUserIds.has(String(warning.usuario_id)));
  const activeUsers = operationalUsers.filter((user) => boolValue(user.activo));
  const userById = Object.fromEntries(users.map((user) => [String(user.id), user]));
  const selectedWarning = warnings.find((warning) => String(warning.id) === String(selectedWarningId));

  const countsByUserId = warnings.reduce((acc, warning) => {
    const key = String(warning.usuario_id);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const summaryRows = activeUsers
    .map((user) => ({
      id: user.id,
      Trabajador: user.nombre || user.email,
      Usuario: user.email,
      Rol: normalizeRole(user.rol),
      Amonestaciones: countsByUserId[String(user.id)] || 0
    }))
    .sort((a, b) => b.Amonestaciones - a.Amonestaciones || a.Trabajador.localeCompare(b.Trabajador));

  const historyRows = warnings.map((warning) => {
    const user = userById[String(warning.usuario_id)];
    const author = userById[String(warning.created_by)];
    return {
      // `id` solo identifica la fila para React; no se muestra como columna.
      id: warning.id,
      Fecha: formatWarningDate(warning),
      Trabajador: user?.nombre || user?.email || "-",
      "Tipo de documento": warning.tipo_documento || "-",
      Descripcion: warning.descripcion,
      Encargado: author?.nombre || author?.email || "-"
    };
  });

  async function handleCreate(event) {
    event.preventDefault();
    setStatus(null);
    if (!form.usuario_id) {
      setStatus({ type: "error", message: "Selecciona un usuario activo." });
      return;
    }
    if (!form.descripcion.trim()) {
      setStatus({ type: "error", message: "La descripcion es obligatoria." });
      return;
    }
    if (!form.tipo_documento) {
      setStatus({ type: "error", message: "Selecciona el tipo de documento." });
      return;
    }
    if (!form.fecha || form.fecha > todayLimaISO()) {
      setStatus({ type: "error", message: "Selecciona una fecha valida que no sea posterior a hoy." });
      return;
    }
    setSaving(true);
    try {
      await createAmonestacion({
        usuario_id: Number(form.usuario_id),
        descripcion: form.descripcion.trim(),
        tipo_documento: form.tipo_documento,
        fecha: form.fecha
      });
      setForm(emptyWarningForm());
      setStatus({ type: "success", message: "Amonestacion registrada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedWarning) return;
    setStatus(null);
    setSaving(true);
    try {
      await deleteAmonestacion(selectedWarning.id);
      setSelectedWarningId("");
      setStatus({ type: "success", message: "Amonestacion eliminada correctamente." });
      reload();
    } catch (err) {
      setStatus({ type: "error", message: friendlyError(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <Panel title="Amonestaciones por usuario" eyebrow="Resumen" actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}>
        {loading ? <LoadingBlock /> : <DataTable rows={summaryRows} columns={["Trabajador", "Usuario", "Rol", "Amonestaciones"]} empty="No hay usuarios activos para mostrar." />}
        {error ? <Alert type="error">{error}</Alert> : null}
      </Panel>

      <Panel>
        <Tabs tabs={["Registrar", "Eliminar"]} active={tab} onChange={setTab} />

        {tab === "Registrar" ? (
          <form className="form-grid" onSubmit={handleCreate}>
            <SelectInput
              label="Usuario"
              value={form.usuario_id}
              onChange={(usuario_id) => setForm({ ...form, usuario_id })}
              options={[
                { value: "", label: "Selecciona un usuario activo" },
                ...activeUsers.map((user) => ({ value: String(user.id), label: `${user.nombre || user.email} (${normalizeRole(user.rol)})` }))
              ]}
            />
            <SelectInput
              label="Tipo de documento"
              value={form.tipo_documento}
              onChange={(tipo_documento) => setForm({ ...form, tipo_documento })}
              options={[
                { value: "", label: "Selecciona el documento" },
                ...TIPOS_DOCUMENTO.map((tipo) => ({ value: tipo, label: tipo }))
              ]}
            />
            <TextInput
              label="Fecha"
              type="date"
              value={form.fecha}
              max={todayLimaISO()}
              onChange={(fecha) => setForm({ ...form, fecha })}
              hint="Puede ser hoy o una fecha anterior."
            />
            <div className="form-span">
              <TextArea
                label="Descripcion"
                value={form.descripcion}
                onChange={(descripcion) => setForm({ ...form, descripcion })}
                rows={3}
                placeholder="Detalla el motivo de la amonestacion"
              />
            </div>
            <div className="form-span">
              <Button type="submit" icon={AlertTriangle} loading={saving}>Registrar amonestacion</Button>
            </div>
          </form>
        ) : (
          <div className="stack">
            <SelectInput
              label="Amonestacion a eliminar"
              value={selectedWarningId}
              onChange={setSelectedWarningId}
              options={[
                { value: "", label: "Selecciona una amonestacion" },
                ...warnings.map((warning) => {
                  const user = userById[String(warning.usuario_id)];
                  const label = `${formatWarningDate(warning)} · ${user?.nombre || user?.email || "-"} · ${warning.tipo_documento || "-"} · ${String(warning.descripcion || "").slice(0, 40)}`;
                  return { value: String(warning.id), label };
                })
              ]}
            />
            {selectedWarning ? (
              <div className="danger-zone">
                <p>
                  Eliminaras la amonestacion de {userById[String(selectedWarning.usuario_id)]?.nombre || userById[String(selectedWarning.usuario_id)]?.email}: "{selectedWarning.descripcion}".
                </p>
                <Button variant="danger" icon={Trash2} loading={saving} onClick={handleDelete}>Eliminar amonestacion</Button>
              </div>
            ) : null}
          </div>
        )}
        <StatusAlert status={status} />
      </Panel>

      <Panel title="Historial de amonestaciones" eyebrow="Detalle">
        {loading ? <LoadingBlock /> : <DataTable rows={historyRows} columns={["Fecha", "Trabajador", "Tipo de documento", "Descripcion", "Encargado"]} empty="Todavia no se registraron amonestaciones." />}
      </Panel>
    </div>
  );
}

function DocumentsPanel() {
  const { data, loading, error, reload } = useAsyncData(
    async () => {
      const [users, attendances, logs, tasks, warnings, courses] = await Promise.all([
        selectUsers(),
        listAttendances(),
        listAllActivityLogs(),
        listTasks(),
        listAmonestaciones(),
        listTrainingCourses()
      ]);
      const trainingStatuses = await Promise.all(
        courses.map(async (course) => {
          try {
            const result = await getTrainingStatusByCourse(course.id_curso);
            return { course, users: result.users || [] };
          } catch {
            return { course, users: [] };
          }
        })
      );
      return { users, attendances, logs, tasks, warnings, trainingStatuses };
    },
    [],
    null
  );
  const [exporting, setExporting] = useState(false);

  async function exportAll(datasets) {
    setExporting(true);
    try {
      await downloadExcelWorkbook("reporte_completo_formulario.xlsx", datasets);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="stack">
      <Panel
        title="Documentos"
        eyebrow="Exportacion de datos"
        actions={<Button variant="secondary" icon={RefreshCcw} onClick={reload}>Actualizar</Button>}
      >
        {loading ? <LoadingBlock /> : null}
        {error ? <Alert type="error">{error}</Alert> : null}
        {!loading && !error ? <DocumentsExporter data={data} exporting={exporting} onExportAll={exportAll} /> : null}
      </Panel>
    </div>
  );
}

function DocumentsExporter({ data, exporting, onExportAll }) {
  const users = (data.users || []).filter((user) => normalizeRole(user.rol) !== "administrador");
  const userIds = new Set(users.map((user) => Number(user.id)));
  const workerNameById = Object.fromEntries(users.map((user) => [user.id, user.nombre || user.email]));
  const workerEmailById = Object.fromEntries(users.map((user) => [user.id, user.email]));
  const taskNameById = Object.fromEntries((data.tasks || []).map((task) => [task.id, getTaskTitle(task) || "Tarea sin nombre"]));

  const userColumns = ["Nombre", "Nombres completos", "Usuario", "Rol", "Activo", "DNI", "Telefono", "Telefono emergencia", "Direccion", "Distrito", "Fecha nacimiento", "Sueldo", "Alergia", "Condición de salud"];
  const userRows = users.map((user) => ({
    Nombre: user.nombre,
    "Nombres completos": user.nombres_completos || "",
    Usuario: user.email,
    Rol: normalizeRole(user.rol),
    Activo: boolValue(user.activo) ? "Si" : "No",
    DNI: user.dni || "",
    Telefono: user.telefono || "",
    "Telefono emergencia": user.telefono_emergencia || "",
    Direccion: user.direccion || "",
    Distrito: user.distrito || "",
    "Fecha nacimiento": user.fecha_cumpleanos || "",
    Sueldo: Number(user.sueldo || 0).toFixed(2),
    Alergia: user.alergia || "",
    "Condición de salud": user.condicion_salud || ""
  }));

  const attendanceColumns = ["Fecha", "Trabajador", "Email", "Estado", "Sigla"];
  const attendanceRows = (data.attendances || []).filter((item) => userIds.has(Number(item.usuario_id))).map((item) => ({
    Fecha: item.fecha,
    Trabajador: workerNameById[item.usuario_id] || "",
    Email: workerEmailById[item.usuario_id] || "",
    Estado: attendanceStateLabel(String(item.estado || "FALTA").toUpperCase()),
    Sigla: item.sigla || ""
  }));

  const activityColumns = ["Fecha", "Trabajador", "Email", "Tarea", "Cantidad", "Turno", "Tiempo (min)", "Puntos"];
  const activityRows = (data.logs || []).filter((log) => userIds.has(Number(log.trabajador_id || log.usuario_id))).map((log) => ({
    Fecha: formatDateTimeLima(log.created_at) || log.fecha_registro,
    Trabajador: workerNameById[log.trabajador_id] || "",
    Email: workerEmailById[log.trabajador_id] || "",
    Tarea: taskNameById[log.tarea_id] || log.actividad_nombre || "",
    Cantidad: log.cantidad ?? "",
    Turno: log.turno || "",
    "Tiempo (min)": log.tiempo_minutos ?? "",
    Puntos: Number(log.puntaje || 0)
  }));

  const warningColumns = ["Fecha", "Trabajador", "Usuario", "Tipo de documento", "Descripcion"];
  const warningRows = (data.warnings || []).filter((warning) => userIds.has(Number(warning.usuario_id))).map((warning) => ({
    Fecha: formatWarningDate(warning),
    Trabajador: workerNameById[warning.usuario_id] || "",
    Usuario: workerEmailById[warning.usuario_id] || "",
    "Tipo de documento": warning.tipo_documento || "",
    Descripcion: warning.descripcion || ""
  }));

  const trainingColumns = ["Capacitacion", "Trabajador", "Usuario", "Rol", "Estado"];
  const trainingRows = (data.trainingStatuses || []).flatMap((entry) => (
    (entry.users || []).filter((user) => normalizeRole(user.rol) !== "administrador").map((user) => ({
      Capacitacion: entry.course ? `${entry.course.id_curso} - ${entry.course.nombre_curso}` : "",
      Trabajador: user.nombre || "",
      Usuario: user.email || "",
      Rol: normalizeRole(user.rol),
      Estado: trainingStatusLabel(user.estado)
    }))
  ));

  const datasets = [
    { key: "usuarios", label: "Usuarios", sheetName: "Usuarios", Icon: UsersRound, description: `${userRows.length} trabajador(es) registrados`, filename: "usuarios.xlsx", columns: userColumns, rows: userRows },
    { key: "asistencias", label: "Asistencias", sheetName: "Asistencias", Icon: CalendarCheck2, description: `${attendanceRows.length} registro(s) de asistencia`, filename: "asistencias.xlsx", columns: attendanceColumns, rows: attendanceRows },
    { key: "actividades", label: "Actividades y puntos", sheetName: "Actividades y puntos", Icon: ClipboardCheck, description: `${activityRows.length} registro(s) de actividad`, filename: "actividades.xlsx", columns: activityColumns, rows: activityRows },
    { key: "amonestaciones", label: "Amonestaciones", sheetName: "Amonestaciones", Icon: AlertTriangle, description: `${warningRows.length} documento(s)`, filename: "amonestaciones.xlsx", columns: warningColumns, rows: warningRows },
    { key: "capacitaciones", label: "Capacitaciones", sheetName: "Capacitaciones", Icon: GraduationCap, description: `${trainingRows.length} registro(s)`, filename: "capacitaciones.xlsx", columns: trainingColumns, rows: trainingRows }
  ];
  const totalRows = datasets.reduce((sum, dataset) => sum + dataset.rows.length, 0);

  return (
    <div className="stack">
      <div className="documents-hero">
        <div className="documents-hero-icon"><FileSpreadsheet /></div>
        <div className="documents-hero-copy">
          <span className="documents-hero-eyebrow">Exportacion completa</span>
          <h3>Exporta toda la informacion en Excel</h3>
          <p>{totalRows} registros listos en un solo archivo con {datasets.length} hojas: usuarios, asistencias, actividades, amonestaciones y capacitaciones.</p>
        </div>
        <Button icon={FileSpreadsheet} loading={exporting} onClick={() => onExportAll(datasets)}>
          Exportar todo en Excel
        </Button>
      </div>
      <div className="documents-grid">
        {datasets.map((dataset) => (
          <article key={dataset.key} className="document-card">
            <div className="document-card-icon"><dataset.Icon /></div>
            <h3>{dataset.label}</h3>
            <p>{dataset.description}</p>
            <Button
              variant="secondary"
              icon={FileSpreadsheet}
              disabled={!dataset.rows.length}
              onClick={() => downloadExcelTable(dataset.filename, dataset.columns, dataset.rows, dataset.sheetName || dataset.label)}
            >
              Descargar Excel
            </Button>
          </article>
        ))}
      </div>
    </div>
  );
}
