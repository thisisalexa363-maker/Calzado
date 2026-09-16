import { requireSupabase } from "./supabaseClient";
import { applyScoringRules, isGroupLeaderTimeTask, isWorkerRole, normalizeRole, normalizeScoringRule } from "./scoring";
import { nowLimaISODateTime, nowLimaTimeHHMM } from "./dates";
import { clearSessionStatePrefix, readSessionState, writeSessionState } from "./sessionState";

let taskTableName;
let attendanceTableName;

const missingColumnRegex = /Could not find the '([^']+)' column/i;
const missingResourceRegex = /Could not find the table 'public\.([^']+)'/i;

function db() {
  return requireSupabase();
}

const API_SESSION_KEY = "formulario_api_session_v2";

function apiSessionToken() {
  try {
    return localStorage.getItem(API_SESSION_KEY) || "";
  } catch {
    return "";
  }
}

function apiEndpoints(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const configuredOrigin = import.meta.env?.VITE_API_URL;
  const localOrigins = import.meta.env?.DEV
    ? ["http://127.0.0.1:5180", "http://localhost:5180"]
    : [];
  const origins = [configuredOrigin, ...localOrigins]
    .filter(Boolean)
    .map((origin) => String(origin).replace(/\/+$/, ""));

  return Array.from(new Set([normalizedPath, ...origins.map((origin) => `${origin}${normalizedPath}`)]));
}

async function requestLocalApi(path, options = {}, config = {}) {
  let sawNotFound = false;
  let sawNonJson = false;
  let sawNetworkFailure = false;
  for (const endpoint of apiEndpoints(path)) {
    try {
      const response = await fetch(endpoint, {
        ...options,
        cache: options.cache || "no-store",
        headers: {
          "content-type": "application/json",
          ...(apiSessionToken() ? { authorization: `Bearer ${apiSessionToken()}` } : {}),
          ...(options.headers || {})
        }
      });

      const contentType = response.headers.get("content-type") || "";
      if (response.status === 404 && !contentType.includes("application/json")) {
        sawNotFound = true;
        continue;
      }
      if (!contentType.includes("application/json")) {
        sawNonJson = true;
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      if (response.status === 404 && /ruta de api no encontrada/i.test(String(payload.error || payload.message || ""))) {
        sawNotFound = true;
        continue;
      }
      if (response.ok) {
        const method = String(options.method || "GET").toUpperCase();
        if (method !== "GET" && (path.startsWith("/api/activity-logs") || path.startsWith("/api/activity-records"))) {
          clearOperationalRecordsCache("normal");
        }
        if (method !== "GET" && path.startsWith("/api/group-leader/")) {
          clearOperationalRecordsCache("time");
        }
        return payload;
      }
      if (config.nullOnAuthFailure && [400, 401, 403].includes(response.status)) return null;

      const apiError = new Error(payload.error || payload.message || `Error ${response.status} al consultar el backend local.`);
      if (payload.code) apiError.code = payload.code;
      apiError.status = response.status;
      throw apiError;
    } catch (error) {
      if (error instanceof TypeError) {
        sawNetworkFailure = true;
        continue;
      }
      throw error;
    }
  }

  if (config.requiredBackend) {
    if (sawNotFound) {
      throw new Error("El backend esta desactualizado y aun no incluye esta funcion. Reinicialo localmente o publica las nuevas Functions de Netlify.");
    }
    if (sawNonJson) {
      throw new Error("La ruta solicitada esta devolviendo la pagina web en lugar de la API. Reinicia el backend y revisa la redireccion /api de Netlify.");
    }
    if (sawNetworkFailure) {
      throw new Error("No se pudo conectar con el backend. Ejecuta npm.cmd run dev o verifica que las Functions esten publicadas.");
    }
    throw new Error("El servicio solicitado no esta disponible en este momento.");
  }

  return null;
}

export async function loadFootwearDashboard({ signal } = {}) {
  return requestLocalApi("/api/dashboard", { signal }, { requiredBackend: true });
}

export async function loadWorkerLiveProgress({ signal } = {}) {
  const result = await requestLocalApi("/api/worker/live-progress", { signal }, { requiredBackend: true });
  return {
    generatedAt: result?.generatedAt || null,
    operationsMigrationRequired: Boolean(result?.operationsMigrationRequired),
    historyMigrationRequired: Boolean(result?.historyMigrationRequired),
    activities: result?.activities || []
  };
}

function errorMessage(error) {
  return error?.message || String(error || "Error desconocido");
}

function ensureOk(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function trySelectTable(tableName) {
  const result = await db().from(tableName).select("id").limit(1);
  return !result.error;
}

export async function getTaskTableName() {
  if (taskTableName) return taskTableName;

  for (const candidate of ["tarea", "tareas"]) {
    if (await trySelectTable(candidate)) {
      taskTableName = candidate;
      return taskTableName;
    }
  }

  throw new Error("No se encontro la tabla de tareas. Crea public.tarea o public.tareas.");
}

async function getAttendanceTableName() {
  if (attendanceTableName) return attendanceTableName;

  for (const candidate of ["asistencias", "asistencia"]) {
    if (await trySelectTable(candidate)) {
      attendanceTableName = candidate;
      return attendanceTableName;
    }
  }

  throw new Error("No se encontro la tabla de asistencia. Crea public.asistencias o public.asistencia.");
}

function isMissingResource(error) {
  const message = errorMessage(error);
  return missingResourceRegex.test(message) || /relation .* does not exist/i.test(message);
}

function missingColumn(error) {
  return missingColumnRegex.exec(errorMessage(error))?.[1] || null;
}

function isMissingTableError(error, tableName) {
  const message = errorMessage(error).toLowerCase();
  return message.includes(tableName.toLowerCase()) && message.includes("schema cache");
}

async function tableColumns(tableName) {
  const result = await db().from(tableName).select("*").limit(1);
  if (result.error || !result.data?.length) return null;
  return Object.keys(result.data[0]);
}

function filterPayloadColumns(payload, columns) {
  if (!columns) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.includes(key)));
}

function isActiveValue(value) {
  return !["false", "0", "no"].includes(String(value ?? true).trim().toLowerCase());
}

export function friendlyError(error) {
  const message = errorMessage(error);
  if (error?.code === "GROUP_HISTORY_MIGRATION_REQUIRED" || /sql\/027_historial_jefe_equipo_editable/i.test(message)) {
    return "Falta ejecutar la migracion sql/027_historial_jefe_equipo_editable.sql en Supabase.";
  }
  if (error?.code === "OPERATIONS_MIGRATION_REQUIRED") {
    return "Falta ejecutar la migracion sql/026_asistencia_retiro_y_actividades_en_curso.sql en Supabase.";
  }
  if (/OPERATIONS_MIGRATION_REQUIRED|sql\/026|actividades_jefe_equipo|retiro_anticipado/i.test(message) && /migraci|could not find|does not exist|schema cache/i.test(message)) {
    return "Falta ejecutar la migracion sql/026_asistencia_retiro_y_actividades_en_curso.sql en Supabase.";
  }
  if (/numeric field overflow|precision 10, scale 2/i.test(message)) {
    return "Una cantidad supera el maximo permitido por la base de datos: 99,999,999.99.";
  }
  if (/registro_errores|usuario_id/i.test(message) && /could not find|does not exist|schema cache/i.test(message)) {
    return "No se encontró la estructura actual de registro_errores en Supabase.";
  }
  if (/registros_tareas_jefe_equipo|marca_id|tienda_id/i.test(message) && /could not find|does not exist|schema cache/i.test(message)) {
    return "Falta ejecutar la migración de marca/tienda en Supabase: sql/024_registros_jefe_equipo_marca_tienda.sql.";
  }
  if (/row-level security/i.test(message)) {
    return "Supabase rechazo la operacion por politicas RLS. Revisa permisos de la clave publica.";
  }
  if (/duplicate key/i.test(message)) {
    if (/Key \(id\)|_pkey/i.test(message)) {
      return "La numeracion interna de la base de datos esta desactualizada. Reinicia el backend e intenta nuevamente.";
    }
    return "Ya existe un registro con esos datos.";
  }
  if (/violates foreign key/i.test(message)) {
    return "No se puede guardar porque falta un registro relacionado.";
  }
  return message;
}

export async function selectUsers() {
  const apiResult = await requestLocalApi("/api/users");
  if (apiResult?.users) return apiResult.users;

  const cols = "id,nombre,email,rol,activo,created_at,fecha_cumpleanos,sueldo,condicion_salud";
  const precise = await db().from("usuarios").select(cols).order("id", { ascending: true });
  if (!precise.error) return precise.data || [];
  return ensureOk(await db().from("usuarios").select("*").order("id", { ascending: true })) || [];
}

// Usado solo por el panel de Asistencia: ahi se marca a cualquier persona
// del sistema (incluye administradores, jefes de grupo y "otros"), no solo a
// quienes ejecutan tareas operativas.
export async function listWorkers() {
  return selectUsers();
}

// Historial completo de ingresos/salidas (no solo el ultimo), usado para
// detectar reingresos en el panel de Usuarios.
export async function listPersonnelMovements() {
  const apiResult = await requestLocalApi("/api/personnel-movements");
  return apiResult?.movements || [];
}

export async function listAssignableWorkers() {
  const users = await selectUsers();
  return users.filter((user) => isWorkerRole(user.rol) && isActiveValue(user.activo));
}

export async function listActiveUsers() {
  const users = await selectUsers();
  return users.filter((user) => isActiveValue(user.activo));
}

export async function listOperantesAndTeamLeads() {
  const users = await selectUsers();
  return users.filter((user) => ["operante", "lider de equipo"].includes(normalizeRole(user.rol)));
}

export async function verifyUser(email, password) {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  const apiUser = await verifyUserWithLocalApi(normalizedEmail, password);
  if (apiUser) return apiUser;

  const rpcResult = await db().rpc("verify_usuario_login", {
    p_email: normalizedEmail,
    p_password: password
  });
  if (!rpcResult.error && rpcResult.data?.length) return rpcResult.data[0];

  const byHash = await db()
    .from("usuarios")
    .select("*")
    .eq("email", normalizedEmail)
    .eq("password_hash", password)
    .limit(1);
  if (!byHash.error && byHash.data?.length) return byHash.data[0];

  const byPassword = await db()
    .from("usuarios")
    .select("*")
    .eq("email", normalizedEmail)
    .eq("password", password)
    .limit(1);
  if (!byPassword.error && byPassword.data?.length) return byPassword.data[0];

  return null;
}

async function verifyUserWithLocalApi(email, password) {
  const payload = await requestLocalApi(
    "/api/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password })
    },
    { nullOnAuthFailure: true }
  );
  if (payload?.sessionToken) {
    try {
      localStorage.setItem(API_SESSION_KEY, payload.sessionToken);
    } catch {
      // El inicio de sesion sigue funcionando aunque el navegador bloquee storage.
    }
  }
  return payload?.user || null;
}

export function clearApiSession() {
  try {
    localStorage.removeItem(API_SESSION_KEY);
  } catch {
    // Nada que limpiar si storage no esta disponible.
  }
}

export async function createUser(payload, plainPassword) {
  const apiResult = await requestLocalApi("/api/users", {
    method: "POST",
    body: JSON.stringify({ ...payload, password_hash: plainPassword })
  });
  if (apiResult?.user) return apiResult.user;

  return ensureOk(await db().from("usuarios").insert({ ...payload, password_hash: plainPassword }).select("*").single());
}

export async function updateUser(userId, changes, newPassword) {
  const { created_at: _createdAt, ...editableChanges } = changes || {};
  const payload = newPassword ? { ...editableChanges, password_hash: newPassword } : editableChanges;
  const apiResult = await requestLocalApi(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  if (apiResult?.user) return apiResult.user;

  return ensureOk(await db().from("usuarios").update(payload).eq("id", userId).select("*").single());
}

export async function deleteUser(userId) {
  const apiResult = await requestLocalApi(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
  if (apiResult && (apiResult.deleted || apiResult.archived)) return apiResult;

  ensureOk(await db().from("usuarios").delete().eq("id", userId));
  return { deleted: true, archived: false };
}

export async function getUserTrainingProfile(userId) {
  const apiResult = await requestLocalApi(`/api/users/${encodeURIComponent(userId)}/trainings`);
  if (!apiResult?.user || !Array.isArray(apiResult.trainings)) {
    throw new Error("El backend local debe estar activo para cargar las capacitaciones.");
  }
  return apiResult;
}

export async function setUserTrainingStatus(userId, courseId, status) {
  const estado = typeof status === "boolean" ? (status ? "finalizado" : "pendiente") : String(status || "");
  const apiResult = await requestLocalApi(
    `/api/users/${encodeURIComponent(userId)}/trainings/${encodeURIComponent(courseId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ estado })
    }
  );
  if (!apiResult?.user || !Array.isArray(apiResult.trainings)) {
    throw new Error("No se pudo actualizar la capacitacion.");
  }
  return apiResult;
}

export async function setUserTrainingDetails(userId, courseId, changes) {
  const apiResult = await requestLocalApi(
    `/api/users/${encodeURIComponent(userId)}/trainings/${encodeURIComponent(courseId)}`,
    {
      method: "PUT",
      body: JSON.stringify(changes)
    }
  );
  if (!apiResult?.user || !Array.isArray(apiResult.trainings)) {
    throw new Error("No se pudo actualizar la capacitacion.");
  }
  return apiResult;
}

export async function listTrainingCourses(includeInactive = false) {
  const apiResult = await requestLocalApi(
    includeInactive ? "/api/trainings/courses?all=1" : "/api/trainings/courses",
    {},
    { requiredBackend: true }
  );
  if (!Array.isArray(apiResult?.courses)) {
    throw new Error("No se pudieron cargar las capacitaciones.");
  }
  return apiResult.courses;
}

export async function createTrainingCourse(payload) {
  const apiResult = await requestLocalApi("/api/trainings/courses", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (!apiResult?.course) {
    throw new Error("No se pudo crear la capacitacion.");
  }
  return apiResult.course;
}

export async function deleteTrainingCourse(courseId) {
  const apiResult = await requestLocalApi(`/api/trainings/courses/${encodeURIComponent(courseId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (!apiResult || (!apiResult.deleted && !apiResult.archived)) {
    throw new Error("No se pudo eliminar la capacitacion.");
  }
  return apiResult;
}

export async function bulkSetTrainingStatus(userIds, courseId, status, { encargado, nroHoras } = {}) {
  const apiResult = await requestLocalApi("/api/trainings/bulk", {
    method: "PUT",
    body: JSON.stringify({
      usuario_ids: userIds,
      curso_id: courseId,
      estado: status,
      encargado,
      nro_horas: nroHoras
    })
  }, { requiredBackend: true });
  if (typeof apiResult?.updated !== "number") {
    throw new Error("No se pudo actualizar la capacitacion para el grupo seleccionado.");
  }
  return apiResult;
}

export async function getTrainingStatusByCourse(courseId) {
  const apiResult = await requestLocalApi(`/api/trainings/status/${encodeURIComponent(courseId)}`, {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.users)) {
    throw new Error("No se pudo cargar el estado de la capacitacion.");
  }
  return apiResult;
}

export async function updateTrainingCourse(courseId, changes) {
  const apiResult = await requestLocalApi(`/api/trainings/courses/${encodeURIComponent(courseId)}`, {
    method: "PUT",
    body: JSON.stringify(changes)
  }, { requiredBackend: true });
  if (!apiResult?.course) {
    throw new Error("No se pudo actualizar la capacitacion.");
  }
  return apiResult.course;
}

export async function listEncargados(includeInactive = false) {
  const apiResult = await requestLocalApi(
    includeInactive ? "/api/trainings/encargados?all=1" : "/api/trainings/encargados",
    {},
    { requiredBackend: true }
  );
  if (!Array.isArray(apiResult?.encargados)) {
    throw new Error("No se pudieron cargar los encargados.");
  }
  return apiResult.encargados;
}

export async function createEncargado(nombre) {
  const apiResult = await requestLocalApi("/api/trainings/encargados", {
    method: "POST",
    body: JSON.stringify({ nombre })
  }, { requiredBackend: true });
  if (!apiResult?.encargado) {
    throw new Error("No se pudo crear el encargado.");
  }
  return apiResult.encargado;
}

export async function updateEncargado(encargadoId, changes) {
  const apiResult = await requestLocalApi(`/api/trainings/encargados/${encodeURIComponent(encargadoId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  }, { requiredBackend: true });
  if (!apiResult?.encargado) {
    throw new Error("No se pudo actualizar el encargado.");
  }
  return apiResult.encargado;
}

export async function listTasks() {
  const apiResult = await requestLocalApi("/api/tasks");
  let tasks = apiResult?.tasks;

  if (!tasks) {
    const tableName = await getTaskTableName();
    tasks = ensureOk(await db().from(tableName).select("*").order("id", { ascending: true })) || [];
  }

  let rules = [];
  try {
    rules = await listTaskScoringRules();
  } catch (error) {
    console.warn("Las tareas se cargaron, pero no fue posible leer reglas_puntaje.", error);
  }
  const rulesByTask = new Map();
  rules.forEach((rule) => {
    const current = rulesByTask.get(String(rule.tarea_id)) || [];
    current.push(rule);
    rulesByTask.set(String(rule.tarea_id), current);
  });
  return tasks.map((task) => applyScoringRules(task, rulesByTask.get(String(task.id)) || []));
}

export async function getTasksForUser(user) {
  const role = normalizeRole(user?.rol);
  const tasks = (await listTasks()).filter((task) => isActiveValue(task.activo) && task.es_operativa === true);

  if (!["trabajador", "operante", "lider de equipo"].includes(role)) {
    return tasks;
  }

  // Las tareas por tiempo tambien se registran como actividad normal: ahi no se
  // pide ningun dato de tiempo, solo la cantidad y los campos de la tarea. El
  // tiempo se carga aparte, en el registro del líder de equipo.
  const roleTasks = tasks;

  const assignedTasks = roleTasks.filter((task) => {
    const idMatches = ["asignado_a", "trabajador_id", "usuario_id"].some(
      (column) => task[column] !== undefined && String(task[column]) === String(user?.id)
    );
    const emailMatches = ["email_trabajador", "correo_trabajador", "email"].some(
      (column) => task[column] !== undefined && String(task[column]).toLowerCase() === String(user?.email || "").toLowerCase()
    );
    return idMatches || emailMatches;
  });

  return assignedTasks.length ? assignedTasks : roleTasks;
}

export async function listBrands() {
  const apiResult = await requestLocalApi("/api/brands");
  if (apiResult?.brands) return apiResult.brands;

  const result = await db().from("marcas").select("id,nombre").order("nombre", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

export async function createBrand(payload) {
  const apiResult = await requestLocalApi("/api/brands", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.brand) return apiResult.brand;

  return ensureOk(await db().from("marcas").insert(payload).select("*").single());
}

export async function updateBrand(brandId, changes) {
  const apiResult = await requestLocalApi(`/api/brands/${encodeURIComponent(brandId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  });
  if (apiResult?.brand) return apiResult.brand;

  return ensureOk(await db().from("marcas").update(changes).eq("id", brandId).select("*").single());
}

export async function deleteBrand(brandId) {
  const apiResult = await requestLocalApi(`/api/brands/${encodeURIComponent(brandId)}`, { method: "DELETE" });
  if (apiResult?.deleted) return apiResult;

  ensureOk(await db().from("marcas").delete().eq("id", brandId));
  return { deleted: true };
}

export async function listTaskScoringRules(taskId = null) {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
  const apiResult = await requestLocalApi(`/api/task-score-ranges${query}`);
  if (apiResult?.rules || apiResult?.ranges) {
    return (apiResult.rules || apiResult.ranges || []).map(normalizeScoringRule);
  }

  let dbQuery = db().from("reglas_puntaje").select("*").order("puntos", { ascending: true });
  if (taskId) dbQuery = dbQuery.eq("tarea_id", taskId);
  const result = await dbQuery;
  if (result.error) throw result.error;
  return (result.data || []).map(normalizeScoringRule);
}

export async function listTaskScoreRanges(taskId) {
  return (await listTaskScoringRules(taskId)).filter((rule) => rule.tipo_regla === "CANTIDAD");
}

export async function deleteTaskScoringRules(taskId) {
  const apiResult = await requestLocalApi(`/api/task-score-ranges?taskId=${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
  if (apiResult) return;

  const result = await db().from("reglas_puntaje").delete().eq("tarea_id", taskId);
  if (result.error) throw result.error;
}

export async function deleteTaskScoreRanges(taskId) {
  return deleteTaskScoringRules(taskId);
}

export async function setTaskScoringRules(taskId, rules) {
  const normalized = (rules || []).map((item) => ({
    tarea_id: taskId,
    tipo_regla: String(item.tipo_regla || "CANTIDAD").toUpperCase(),
    desde: item.desde ?? item.cantidad_desde ?? null,
    hasta: item.hasta ?? item.cantidad_hasta ?? null,
    turno: item.turno || null,
    puntos: item.puntos
  }));

  const apiResult = await requestLocalApi("/api/task-score-ranges", {
    method: "PUT",
    body: JSON.stringify({ taskId, rules: normalized })
  });
  if (apiResult) return;

  await deleteTaskScoringRules(taskId);
  if (!normalized.length) return;

  ensureOk(await db().from("reglas_puntaje").insert(normalized));
}

export async function setTaskScoreRanges(taskId, ranges) {
  return setTaskScoringRules(taskId, ranges);
}

export async function createTask(payload) {
  const apiResult = await requestLocalApi("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.task) return apiResult.task;

  const tableName = await getTaskTableName();
  const columns = await tableColumns(tableName);
  const filteredPayload = filterPayloadColumns(payload, columns);
  const result = await db().from(tableName).insert(filteredPayload).select("id").single();
  if (result.error) throw result.error;
  return result.data;
}

export async function updateTask(taskId, changes, existingRow) {
  const apiResult = await requestLocalApi(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  });
  if (apiResult?.task) return apiResult.task;

  const tableName = await getTaskTableName();
  const columns = existingRow ? Object.keys(existingRow) : await tableColumns(tableName);
  ensureOk(await db().from(tableName).update(filterPayloadColumns(changes, columns)).eq("id", taskId));
}

export async function deleteTask(taskId) {
  const apiResult = await requestLocalApi(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
  if (apiResult && (apiResult.deleted || apiResult.archived)) return apiResult;

  const tableName = await getTaskTableName();
  const result = await db().from(tableName).delete().eq("id", taskId);
  if (result.error?.code === "23503") {
    ensureOk(await db().from(tableName).update({ activo: false }).eq("id", taskId));
    return { deleted: false, archived: true };
  }
  if (result.error) throw result.error;
  return { deleted: true, archived: false };
}

export async function listTiendas() {
  const apiResult = await requestLocalApi("/api/stores");
  if (apiResult?.stores) return apiResult.stores;

  const result = await db().from("tiendas").select("*").order("id", { ascending: true });
  if (result.error) return [];
  return result.data || [];
}

export async function createTienda(payload) {
  const apiResult = await requestLocalApi("/api/stores", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.store) return apiResult.store;

  const result = await db().from("tiendas").insert(payload);
  if (result.error) {
    if (isMissingTableError(result.error, "tiendas")) {
      throw new Error("La tabla public.tiendas no existe. Ejecuta la migracion SQL.");
    }
    throw result.error;
  }
}

export async function updateTienda(tiendaId, changes) {
  const apiResult = await requestLocalApi(`/api/stores/${encodeURIComponent(tiendaId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  });
  if (apiResult?.store) return apiResult.store;

  const result = await db().from("tiendas").update(changes).eq("id", tiendaId);
  if (result.error) throw result.error;
}

export async function deleteTienda(tiendaId) {
  const apiResult = await requestLocalApi(`/api/stores/${encodeURIComponent(tiendaId)}`, { method: "DELETE" });
  if (apiResult && (apiResult.deleted || apiResult.archived)) return apiResult;

  const result = await db().from("tiendas").delete().eq("id", tiendaId);
  if (result.error) throw result.error;
  return { deleted: true, archived: false };
}

export async function listLotes() {
  const apiResult = await requestLocalApi("/api/lotes", {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.lotes)) {
    throw new Error("No se pudieron cargar los lotes.");
  }
  return apiResult.lotes;
}

export async function listGeneralLoteAccumulations() {
  const apiResult = await requestLocalApi("/api/lotes/general", {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.acumulados)) {
    throw new Error("No se pudo cargar el acumulado del Lote general.");
  }
  return {
    codigo_lote: apiResult.codigo_lote || "LOTE GENERAL",
    cantidad_total: Number(apiResult.cantidad_total || 0),
    acumulados: apiResult.acumulados
  };
}

export async function createLote(payload) {
  const apiResult = await requestLocalApi("/api/lotes", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (!apiResult?.lote) {
    throw new Error("No se pudo crear el lote.");
  }
  return apiResult.lote;
}

export async function updateLote(loteId, changes) {
  const apiResult = await requestLocalApi(`/api/lotes/${encodeURIComponent(loteId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes)
  }, { requiredBackend: true });
  if (!apiResult?.lote) {
    throw new Error("No se pudo actualizar el lote.");
  }
  return apiResult.lote;
}

export async function deleteLote(loteId) {
  const apiResult = await requestLocalApi(`/api/lotes/${encodeURIComponent(loteId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (!apiResult?.deleted) {
    throw new Error("No se pudo eliminar el lote.");
  }
  return apiResult;
}

export async function listLogAsistencias({ operacion = "", desde = "", hasta = "" } = {}) {
  const params = new URLSearchParams();
  if (operacion) params.set("operacion", operacion);
  if (desde) params.set("desde", desde);
  if (hasta) params.set("hasta", hasta);
  const query = params.toString();
  const apiResult = await requestLocalApi(`/api/log-asistencias${query ? `?${query}` : ""}`, {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.rows)) {
    throw new Error("No se pudo cargar el historial de asistencias.");
  }
  return apiResult.rows;
}

export async function listGuias() {
  const apiResult = await requestLocalApi("/api/guias", {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.guias)) {
    throw new Error("No se pudieron cargar las guias.");
  }
  return apiResult.guias;
}

export async function importGuias(entries, archivo) {
  const apiResult = await requestLocalApi("/api/guias/import", {
    method: "POST",
    body: JSON.stringify({ entries, archivo })
  }, { requiredBackend: true });
  if (typeof apiResult?.imported !== "number") {
    throw new Error("No se pudieron importar las guias.");
  }
  return apiResult;
}

export async function importGuiaItems(items, archivo) {
  const apiResult = await requestLocalApi("/api/guias/import", {
    method: "POST",
    body: JSON.stringify({ items, archivo })
  }, { requiredBackend: true });
  if (typeof apiResult?.imported !== "number") {
    throw new Error("No se pudo importar el detalle de las guias.");
  }
  return apiResult;
}

export async function listGuiaItemsForExport(anio, mes) {
  const apiResult = await requestLocalApi(
    `/api/guias/items?anio=${encodeURIComponent(anio)}&mes=${encodeURIComponent(mes)}`,
    {},
    { requiredBackend: true }
  );
  if (!Array.isArray(apiResult?.items)) {
    throw new Error("No se pudo obtener el detalle de guias para exportar.");
  }
  return apiResult.items;
}

export async function listAmonestaciones() {
  const apiResult = await requestLocalApi("/api/amonestaciones");
  if (apiResult?.amonestaciones) return apiResult.amonestaciones;

  const result = await db().from("amonestaciones").select("*").order("created_at", { ascending: false });
  if (result.error) return [];
  return result.data || [];
}

export async function createAmonestacion(payload) {
  const apiResult = await requestLocalApi("/api/amonestaciones", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.amonestacion) return apiResult.amonestacion;

  const result = await db().from("amonestaciones").insert(payload).select("*").single();
  if (result.error) {
    if (isMissingTableError(result.error, "amonestaciones")) {
      throw new Error("La tabla public.amonestaciones no existe. Ejecuta la migracion SQL.");
    }
    throw result.error;
  }
  return result.data;
}

export async function deleteAmonestacion(amonestacionId) {
  const apiResult = await requestLocalApi(`/api/amonestaciones/${encodeURIComponent(amonestacionId)}`, { method: "DELETE" });
  if (apiResult?.deleted) return apiResult;

  const result = await db().from("amonestaciones").delete().eq("id", amonestacionId);
  if (result.error) throw result.error;
  return { deleted: true };
}

export const PENALTY_KEYS = [
  { clave: "carta_amonestacion", etiqueta: "Carta de amonestacion", descripcion: "Puntos que resta cada amonestacion registrada como Carta de amonestacion." },
  { clave: "memorandum", etiqueta: "Memorandum", descripcion: "Puntos que resta cada amonestacion registrada como Memorandum." },
  { clave: "inasistencia", etiqueta: "Inasistencia (Falta y suspension)", descripcion: "Puntos que resta cada dia marcado como FALTA o SUSPENSION. Permiso y descanso medico no descuentan." },
  { clave: "tardanza", etiqueta: "Tardanza", descripcion: "Puntos que resta cada dia marcado como TARDANZA." }
];

export async function listPenalizaciones() {
  const result = await db().from("penalizaciones").select("*");
  if (result.error) {
    if (isMissingTableError(result.error, "penalizaciones") || isMissingResource(result.error)) {
      throw new Error("La tabla public.penalizaciones no existe. Ejecuta sql/026_penalizaciones.sql en Supabase.");
    }
    throw result.error;
  }

  const byKey = Object.fromEntries((result.data || []).map((row) => [row.clave, row]));
  return PENALTY_KEYS.map((item) => ({
    ...item,
    puntos: Number(byKey[item.clave]?.puntos ?? 0)
  }));
}

export async function savePenalizaciones(items) {
  const payload = items.map((item) => ({
    clave: item.clave,
    etiqueta: item.etiqueta,
    descripcion: item.descripcion || null,
    puntos: Number(item.puntos || 0),
    updated_at: nowLimaISODateTime()
  }));

  const result = await db().from("penalizaciones").upsert(payload, { onConflict: "clave" }).select("*");
  if (result.error) {
    if (isMissingTableError(result.error, "penalizaciones") || isMissingResource(result.error)) {
      throw new Error("La tabla public.penalizaciones no existe. Ejecuta sql/026_penalizaciones.sql en Supabase.");
    }
    throw result.error;
  }
  return result.data || [];
}

export async function listAttendances() {
  const apiResult = await requestLocalApi("/api/attendances");
  if (apiResult?.attendances) return apiResult.attendances;

  const tableName = await getAttendanceTableName();
  const pageSize = 1000;
  const attendances = [];
  for (let from = 0; ; from += pageSize) {
    const result = await db()
      .from(tableName)
      .select("*")
      .order("fecha", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (result.error) return [];
    const page = result.data || [];
    attendances.push(...page);
    if (page.length < pageSize) break;
  }
  return attendances;
}

export async function getAttendanceForDate(fecha) {
  const apiResult = await requestLocalApi(`/api/attendances?date=${encodeURIComponent(fecha)}`);
  if (apiResult?.attendances) return apiResult.attendances;

  const tableName = await getAttendanceTableName();
  const result = await db().from(tableName).select("*").eq("fecha", fecha);
  if (result.error) return [];
  return result.data || [];
}

export const ATTENDANCE_STATES = ["FALTA", "ASISTENCIA", "TARDANZA", "MEDIO_TURNO", "APOYO", "PERMISO", "DESCANSO_MEDICO", "SUSPENSION"];

export async function markAttendance(usuarioId, fecha, presente, horaLimite, changes = {}) {
  const isPresent = Boolean(presente);
  const body = {
    usuario_id: usuarioId,
    fecha,
    presente: isPresent,
    hora_limite: horaLimite,
    ...changes
  };
  const apiResult = await requestLocalApi("/api/attendances", {
    method: "PUT",
    body: JSON.stringify(body)
  });
  if (apiResult?.attendance) return apiResult.attendance;

  if (Object.keys(changes).length) {
    throw new Error("El backend debe estar activo para editar una asistencia o registrar un retiro anticipado.");
  }

  const tableName = await getAttendanceTableName();
  const estado = changes.estado ? String(changes.estado).toUpperCase() : !isPresent
    ? "FALTA"
    : nowLimaTimeHHMM() <= String(horaLimite || "").slice(0, 5)
      ? "ASISTENCIA"
      : "TARDANZA";
  const retiroAnticipado = Boolean(changes.retiro_anticipado) && estado !== "FALTA";
  const payload = {
    usuario_id: usuarioId,
    fecha,
    estado,
    created_at: estado !== "FALTA" ? (changes.created_at || nowLimaISODateTime()) : null
  };
  if (Object.keys(changes).length) {
    payload.retiro_anticipado = retiroAnticipado;
    payload.motivo_retiro = retiroAnticipado ? String(changes.motivo_retiro || "").trim() : null;
    payload.retirado_en = retiroAnticipado ? (changes.retirado_en || nowLimaISODateTime()) : null;
    payload.updated_at = nowLimaISODateTime();
  }
  const result = await db().from(tableName).upsert(payload, { onConflict: "usuario_id,fecha" }).select("*").single();
  if (result.error) {
    throw result.error;
  }
  return result.data;
}

export async function getAttendanceReportSettings() {
  const apiResult = await requestLocalApi("/api/attendance-report/settings", {}, { requiredBackend: true });
  if (Array.isArray(apiResult?.configs)) return apiResult;
  throw new Error("El backend actual no incluye Notificaciones. Reinicia el proyecto con npm.cmd run dev; si esta publicado, despliega tambien las nuevas Functions de Netlify.");
}

export async function createAttendanceReportSettings(payload) {
  const apiResult = await requestLocalApi("/api/attendance-report/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo crear la programacion de Notificaciones.");
}

export async function updateAttendanceReportSettings(configId, payload) {
  const apiResult = await requestLocalApi(`/api/attendance-report/settings/${encodeURIComponent(configId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo actualizar la programacion de Notificaciones.");
}

export async function deleteAttendanceReportSettings(configId) {
  const apiResult = await requestLocalApi(`/api/attendance-report/settings/${encodeURIComponent(configId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (apiResult && (apiResult.deleted || apiResult.archived || apiResult.config)) return apiResult;
  throw new Error("No se pudo eliminar la programacion de Notificaciones.");
}

export async function sendAttendanceReportNow(configId, fecha) {
  const apiResult = await requestLocalApi(`/api/attendance-report/settings/${encodeURIComponent(configId)}/send`, {
    method: "POST",
    body: JSON.stringify({ fecha })
  }, { requiredBackend: true });
  if (apiResult?.report) return apiResult.report;
  throw new Error("El backend actual no incluye el envio de Notificaciones. Reinicia el backend o publica las nuevas Functions de Netlify.");
}

export async function getActivityReportSettings() {
  const apiResult = await requestLocalApi("/api/activity-report/settings", {}, { requiredBackend: true });
  if (Array.isArray(apiResult?.configs)) return apiResult;
  throw new Error("El backend actual no incluye el reporte de registros de actividades.");
}

export async function createActivityReportSettings(payload) {
  const apiResult = await requestLocalApi("/api/activity-report/settings", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo crear la programacion del reporte de actividades.");
}

export async function updateActivityReportSettings(configId, payload) {
  const apiResult = await requestLocalApi(`/api/activity-report/settings/${encodeURIComponent(configId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (apiResult?.config) return apiResult.config;
  throw new Error("No se pudo guardar la configuracion del reporte de actividades.");
}

export async function deleteActivityReportSettings(configId) {
  const apiResult = await requestLocalApi(`/api/activity-report/settings/${encodeURIComponent(configId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (apiResult && (apiResult.deleted || apiResult.archived || apiResult.config)) return apiResult;
  throw new Error("No se pudo eliminar la programacion del reporte de actividades.");
}

export async function getActivityReportPreview(configId, fecha, turno) {
  const result = await requestLocalApi(
    `/api/activity-report/settings/${encodeURIComponent(configId)}/preview?date=${encodeURIComponent(fecha)}&shift=${encodeURIComponent(turno)}`,
    {},
    { requiredBackend: true }
  );
  if (result?.report) return result.report;
  throw new Error("No se pudo generar el reporte de actividades.");
}

export async function sendActivityReportNow(configId, fecha, turno) {
  const result = await requestLocalApi(`/api/activity-report/settings/${encodeURIComponent(configId)}/send`, {
    method: "POST",
    body: JSON.stringify({ fecha, turno })
  }, { requiredBackend: true });
  if (result?.report) return result.report;
  throw new Error("No se pudo enviar el reporte de actividades.");
}

function activityLogInsertPayload(resourceName, payload) {
  if (resourceName !== "registros_tareas") {
    const mapped = { ...payload };
    if (mapped.tiempo_minutos !== null && mapped.tiempo_minutos !== undefined && !("dato_extra" in mapped)) {
      mapped.dato_extra = mapped.tiempo_minutos;
    }
    return mapped;
  }

  const mapped = {
    usuario_id: payload.usuario_id || payload.trabajador_id,
    tarea_id: payload.tarea_id,
    fecha_registro: payload.fecha_registro,
    cantidad: payload.cantidad,
    turno: payload.turno,
    tienda_id: payload.tienda_id,
    numero_guia: payload.numero_guia,
    dato_extra: payload.lote,
    observacion: payload.observacion || payload.detalle,
    puntaje: payload.puntaje
  };

  return Object.fromEntries(Object.entries(mapped).filter(([, value]) => value !== undefined && value !== null));
}

export async function createWorkerActivityLog(payload) {
  const apiResult = await requestLocalApi("/api/activity-logs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (apiResult?.log) return apiResult.log;

  if (payload.marcas?.length || payload.guias?.length) {
    throw new Error("El backend local debe estar activo para guardar distribuciones por marcas o guías.");
  }

  const cleanPayload = { ...payload };
  delete cleanPayload.created_at;

  const optionalGroups = [
    [],
    ["created_at"],
    ["actividad_id"],
    ["actividad_nombre"],
    ["turno"],
    ["created_at", "actividad_id"],
    ["created_at", "actividad_nombre"],
    ["created_at", "turno"],
    ["actividad_id", "actividad_nombre"],
    ["created_at", "actividad_id", "actividad_nombre"],
    ["created_at", "actividad_id", "actividad_nombre", "turno"]
  ];

  const attempts = [];
  const seen = new Set();
  optionalGroups.forEach((fields) => {
    const candidate = { ...cleanPayload };
    fields.forEach((field) => delete candidate[field]);
    const signature = Object.keys(candidate).sort().join("|");
    if (!seen.has(signature)) {
      seen.add(signature);
      attempts.push(candidate);
    }
  });

  let lastError = null;
  for (const resourceName of ["registros_tareas", "registro_actividades"]) {
    for (const candidate of attempts) {
      let currentCandidate = activityLogInsertPayload(resourceName, candidate);
      for (let index = 0; index <= Object.keys(currentCandidate).length; index += 1) {
        const result = await db().from(resourceName).insert(currentCandidate);
        if (!result.error) return;
        if (isMissingResource(result.error)) {
          lastError = result.error;
          break;
        }
        lastError = result.error;
        const missing = missingColumn(result.error);
        if (!missing || !(missing in currentCandidate)) break;
        currentCandidate = { ...currentCandidate };
        delete currentCandidate[missing];
      }
    }
  }

  throw lastError || new Error("No se pudo guardar el registro de actividad.");
}

function normalizeActivityLog(row) {
  const normalized = { ...row };
  if ("usuario_id" in normalized && !("trabajador_id" in normalized)) normalized.trabajador_id = normalized.usuario_id;
  if ("observacion" in normalized && !("detalle" in normalized)) normalized.detalle = normalized.observacion;
  if ("dato_extra" in normalized && normalized.dato_extra !== null && String(normalized.dato_extra).trim() !== "") {
    const rawExtra = normalized.dato_extra;
    const parsed = Number(rawExtra);
    if (Number.isNaN(parsed)) normalized.lote = normalized.lote || rawExtra;
    else if (normalized.tiempo_minutos === null || normalized.tiempo_minutos === undefined) normalized.tiempo_minutos = parsed;
  }
  if ("tarea" in normalized && !("actividad_nombre" in normalized)) normalized.actividad_nombre = normalized.tarea;
  return normalized;
}

function excludesGeneralLote(row) {
  return String(row?.lote || row?.dato_extra || "").trim().toUpperCase() !== "LOTE GENERAL";
}

async function listActivityLogsForResource(resourceName, userColumn, workerId) {
  for (const orderColumn of ["fecha_registro", "created_at", null]) {
    let query = db().from(resourceName).select("*").eq(userColumn, workerId);
    if (orderColumn) query = query.order(orderColumn, { ascending: false });
    const result = await query;
    if (!result.error) return (result.data || []).map(normalizeActivityLog);
  }
  return null;
}

export async function listWorkerActivityLogs(workerId) {
  const apiResult = await requestLocalApi(`/api/activity-logs?workerId=${encodeURIComponent(workerId)}`);
  if (apiResult?.logs) return apiResult.logs.map(normalizeActivityLog);

  const resources = ["v_registro_actividades", "registros_tareas", "registro_actividades"];
  for (const resourceName of resources) {
    const userColumns = resourceName === "registros_tareas" ? ["usuario_id", "trabajador_id"] : ["trabajador_id", "usuario_id"];
    for (const userColumn of userColumns) {
      const rows = await listActivityLogsForResource(resourceName, userColumn, workerId);
      if (rows) return rows;
    }
  }
  return [];
}

export async function listAllActivityLogs() {
  const apiResult = await requestLocalApi("/api/activity-logs");
  if (apiResult?.logs) return apiResult.logs.filter(excludesGeneralLote).map(normalizeActivityLog);

  for (const resourceName of ["v_registro_actividades", "registros_tareas", "registro_actividades"]) {
    for (const orderColumn of ["fecha_registro", "created_at", null]) {
      const pageSize = 1000;
      const rows = [];
      let failed = false;
      for (let from = 0; ; from += pageSize) {
        let query = db().from(resourceName).select("*");
        if (orderColumn) query = query.order(orderColumn, { ascending: false });
        const result = await query.range(from, from + pageSize - 1);
        if (result.error) {
          failed = true;
          break;
        }
        const page = result.data || [];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      if (!failed) return rows.filter(excludesGeneralLote).map(normalizeActivityLog);
    }
  }
  return [];
}

export async function updateActivityRecord(id, changes) {
  const { created_at: _createdAt, createdAt: _createdAtAlias, ...editableChanges } = changes || {};
  const apiResult = await requestLocalApi(`/api/activity-records/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(editableChanges)
  });
  if (apiResult?.record) return apiResult.record;
  throw new Error("El backend debe estar activo para editar un registro de tarea.");
}

export async function deleteActivityRecord(id) {
  const apiResult = await requestLocalApi(`/api/activity-records/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
  if (apiResult?.deleted) return apiResult;
  throw new Error("El backend debe estar activo para eliminar un registro de tarea.");
}

export async function listIncidentes() {
  const result = await db().from("registro_errores").select("*").order("fecha_error", { ascending: false });
  if (result.error) return [];
  return result.data || [];
}

export async function createIncidente(payload) {
  ensureOk(await db().from("registro_errores").insert(payload));
}

export async function listErrorTasks() {
  const result = await db().from("tarea_error").select("*").eq("activo", true).order("id", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

export async function loadIncidentContext() {
  const apiResult = await requestLocalApi("/api/incidents/context");
  if (!apiResult) throw new Error("El backend local debe estar activo para registrar errores.");
  return {
    workers: apiResult.workers || [],
    tasks: apiResult.tasks || [],
    stores: apiResult.stores || [],
    areas: apiResult.areas || [],
    incidents: apiResult.incidents || []
  };
}

export async function createIncident(payload) {
  const apiResult = await requestLocalApi("/api/incidents", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  if (!apiResult?.incident) throw new Error("No se pudo guardar el error.");
  return apiResult.incident;
}

export async function listAllWorkerTaskRecords() {
  const apiResult = await requestLocalApi("/api/activity-logs?source=registros_tareas", {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.logs)) throw new Error("No se pudo cargar la tabla registros_tareas.");
  return apiResult.logs.map(normalizeActivityLog);
}

export async function listOperationalRecords({
  source = "normal",
  page = 1,
  pageSize = 25,
  workerId = "",
  managerId = "",
  taskId = "",
  lot = "",
  from = "",
  to = "",
  order = "desc",
  search = "",
  includeCatalogs = false,
  forceRefresh = false
} = {}) {
  const params = new URLSearchParams({
    source,
    page: String(page),
    pageSize: String(pageSize)
  });
  if (workerId) params.set("workerId", String(workerId));
  if (managerId) params.set("managerId", String(managerId));
  if (taskId) params.set("taskId", String(taskId));
  if (lot) params.set("lot", String(lot));
  if (from) params.set("from", String(from));
  if (to) params.set("to", String(to));
  if (order === "asc") params.set("order", "asc");
  if (search) params.set("search", String(search));
  if (includeCatalogs) params.set("includeCatalogs", "true");
  const cacheKey = `operational-records:${params.toString()}`;
  if (!forceRefresh) {
    const cached = readSessionState(cacheKey, null);
    if (cached && Array.isArray(cached.records)) return cached;
  }
  const apiResult = await requestLocalApi(`/api/operational-records?${params.toString()}`, {}, { requiredBackend: true });
  if (!Array.isArray(apiResult?.records)) throw new Error("No se pudieron cargar los registros operativos.");
  const result = {
    records: apiResult.records.map(normalizeActivityLog),
    total: Number(apiResult.total || 0),
    page: Number(apiResult.page || page),
    pageSize: Number(apiResult.pageSize || pageSize),
    catalogs: apiResult.catalogs || null
  };
  writeSessionState(cacheKey, result);
  return result;
}

export function clearOperationalRecordsCache(source = "") {
  clearSessionStatePrefix(source ? `operational-records:source=${source}` : "operational-records:");
}

export async function updateIncident(incidentId, payload) {
  const apiResult = await requestLocalApi(`/api/incidents/${encodeURIComponent(incidentId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (!apiResult?.incident) throw new Error("No se pudo actualizar el error.");
  return apiResult.incident;
}

export async function deleteIncident(incidentId) {
  const apiResult = await requestLocalApi(`/api/incidents/${encodeURIComponent(incidentId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (!apiResult?.deleted) throw new Error("No se pudo eliminar el error.");
  return Number(apiResult.deleted);
}

function normalizeGroupLeaderLog(row) {
  return {
    ...row,
    codigo_guia: row.codigo_guia ?? row.numero_guia,
    detalle: row.detalle ?? row.observacion,
    encargado_nombre: row.encargado_nombre || row.encargado?.nombre,
    encargado_email: row.encargado_email || row.encargado?.email,
    trabajador_nombre: row.trabajador_nombre || row.trabajador?.nombre,
    trabajador_email: row.trabajador_email || row.trabajador?.email,
    tarea_nombre: row.tarea_nombre || row.tarea?.titulo || row.tarea?.nombre,
    hora_inicio: row.hora_inicio || row.horaInicio || null,
    hora_fin: row.hora_fin || row.horaFin || null,
    revision: Number(row.revision || 0) || null
  };
}

export async function createGroupLeaderRecord(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const apiResult = await requestLocalApi("/api/group-leader/records", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: controller.signal
    }, { requiredBackend: true });
    if (!apiResult?.record) throw new Error("No se pudo guardar el registro por tiempo.");
    return normalizeGroupLeaderLog(apiResult.record);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("La conexion tardo demasiado. Verifica Internet y actualiza el historial antes de volver a intentar.");
      timeoutError.code = "SAVE_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function updateGroupLeaderRecord(recordId, payload) {
  const { created_at: _createdAt, createdAt: _createdAtAlias, ...editablePayload } = payload || {};
  const apiResult = await requestLocalApi(`/api/group-leader/records/${encodeURIComponent(recordId)}`, {
    method: "PUT",
    body: JSON.stringify(editablePayload)
  }, { requiredBackend: true });
  if (!apiResult?.record) throw new Error("No se pudo actualizar el registro por tiempo.");
  return normalizeGroupLeaderLog(apiResult.record);
}

export async function deleteGroupLeaderRecord(recordId, revision = null) {
  const apiResult = await requestLocalApi(`/api/group-leader/records/${encodeURIComponent(recordId)}`, {
    method: "DELETE",
    body: JSON.stringify(revision === null || revision === undefined ? {} : { revision })
  }, { requiredBackend: true });
  if (!apiResult?.deleted) throw new Error("No se pudo eliminar el registro por tiempo.");
  return Number(apiResult.deleted);
}

export async function startGroupLeaderActivity(payload) {
  const result = await requestLocalApi("/api/group-leader/activities", {
    method: "POST",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (!result?.activity) throw new Error("No se pudo iniciar la actividad.");
  return result.activity;
}

export async function updateGroupLeaderActivity(activityId, payload) {
  const result = await requestLocalApi(`/api/group-leader/activities/${encodeURIComponent(activityId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, { requiredBackend: true });
  if (!result?.activity) throw new Error("No se pudo actualizar la actividad.");
  return result.activity;
}

export async function cancelGroupLeaderActivity(activityId) {
  const result = await requestLocalApi(`/api/group-leader/activities/${encodeURIComponent(activityId)}`, {
    method: "DELETE"
  }, { requiredBackend: true });
  if (!result?.deleted) throw new Error("No se pudo cancelar la actividad.");
  return result;
}

export async function loadGroupLeaderContext() {
  const apiContext = await requestLocalApi("/api/group-leader/context");
  if (apiContext) {
    return {
      workers: apiContext.workers || [],
      tasks: apiContext.tasks || [],
      recordTasks: apiContext.recordTasks || apiContext.tasks || [],
      brands: apiContext.brands || [],
      stores: apiContext.stores || [],
      leaders: apiContext.leaders || [],
      allUsers: apiContext.allUsers || [],
      activities: apiContext.activities || [],
      operationsMigrationRequired: Boolean(apiContext.operationsMigrationRequired),
      historyMigrationRequired: Boolean(apiContext.historyMigrationRequired),
      averageReferenceByTask: apiContext.averageReferenceByTask || {},
      averageReferenceMigrationRequired: Boolean(apiContext.averageReferenceMigrationRequired),
      records: (apiContext.records || []).map(normalizeGroupLeaderLog)
    };
  }

  const [workers, tasks, brands, stores, records] = await Promise.all([
    listOperantesAndTeamLeads().then((users) => users.filter((user) => isActiveValue(user.activo))),
    listTasks().then((tasks) => tasks.filter((task) => task.es_operativa === true && isGroupLeaderTimeTask(task))),
    listBrands(),
    listTiendas().then((stores) => stores.filter((store) => String(store.activo ?? true) !== "false")),
    listGroupLeaderRecords()
  ]);
  return {
    workers, tasks, brands, stores, leaders: [], allUsers: workers, activities: [],
    operationsMigrationRequired: false, historyMigrationRequired: false,
    averageReferenceByTask: {}, averageReferenceMigrationRequired: false,
    records
  };
}

export async function updateGroupLeaderAverageReference(taskId, value, hangtagKey = "") {
  const apiResult = await requestLocalApi("/api/group-leader/average-reference", {
    method: "PUT",
    body: JSON.stringify({ tarea_id: taskId, tipo_etiquetado: hangtagKey, promedio_referencia: value })
  }, { requiredBackend: true });
  if (typeof apiResult?.promedio_referencia !== "number") {
    throw new Error("No se pudo actualizar el promedio de referencia.");
  }
  return apiResult.promedio_referencia;
}

export async function loadAverageReferences() {
  const apiResult = await requestLocalApi("/api/average-references", {}, { requiredBackend: true });
  return {
    averageReferenceByTask: apiResult?.averageReferenceByTask || {},
    averageReferenceMigrationRequired: Boolean(apiResult?.averageReferenceMigrationRequired)
  };
}

export async function listGroupLeaderRecords(encargadoId = null) {
  const apiContext = await requestLocalApi("/api/group-leader/context");
  if (apiContext?.records) {
    const records = (apiContext.records || []).map(normalizeGroupLeaderLog);
    if (!encargadoId) return records;
    return records.filter((record) => String(record.encargado_id) === String(encargadoId));
  }

  let plainQuery = db().from("registros_tareas_jefe_equipo").select("*").order("created_at", { ascending: false });
  if (encargadoId) plainQuery = plainQuery.eq("encargado_id", encargadoId);
  const plainResult = await plainQuery;
  if (plainResult.error) throw plainResult.error;
  return (plainResult.data || []).map(normalizeGroupLeaderLog);
}
