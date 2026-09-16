import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { applyScoringRules, calculatePoints, getTaskFieldFlags, getTaskRequiredFlags } from "./src/lib/scoring.js";
import { buildDashboardPayroll } from "./src/lib/dashboardMetrics.js";
import {
  gmailConfiguration,
  localDateTimeParts,
  normalizeRecipients,
  normalizeReportSubject,
  normalizeReportTime,
  readActiveAttendanceWorkers,
  readAttendanceReportConfig,
  readAttendanceReportConfigs,
  readAttendanceReportHistory,
  REPORT_TIME_ZONE,
  sendAttendanceReport
} from "./services/attendance_report.mjs";
import {
  readActiveActivityWorkers,
  readActivityCompliance,
  readActivityReportConfig,
  readActivityReportConfigs,
  readActivityReportHistory,
  sendActivityReport
} from "./services/activity_report.mjs";

const moduleUrl = import.meta.url;
const modulePath = moduleUrl ? fileURLToPath(moduleUrl) : "";
const __dirname = modulePath ? path.dirname(modulePath) : process.cwd();

function readEnv() {
  const envPath = path.join(__dirname, ".env");
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const env = {};

  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const name = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }

  return { ...process.env, ...env };
}

const env = readEnv();
const supabaseUrl = env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_PUBLISHABLE_KEY;
const sessionSecret = env.API_SESSION_SECRET || env.SUPABASE_SECRET_KEY;
const port = Number(env.API_PORT || 5180);
const distDir = path.join(__dirname, "dist");
const MAX_SCORE_QUANTITY = 99_999_999.99;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Faltan SUPABASE_URL y SUPABASE_SECRET_KEY en .env para el backend local.");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function sendJson(response, status, payload) {
  response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type"
    });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Solicitud demasiado grande."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function issueSessionToken(user) {
  if (!sessionSecret) return null;
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, rol: normalizeRole(user.rol), exp: Date.now() + 8 * 60 * 60 * 1000 })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSession(request) {
  if (!sessionSecret) return null;
  const authorization = String(request.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(session.exp) > Date.now() ? session : null;
  } catch {
    return null;
  }
}

function requireAdministrator(request, response) {
  if (!env.SUPABASE_SECRET_KEY) {
    sendJson(response, 503, { error: "El backend necesita SUPABASE_SECRET_KEY para administrar usuarios." });
    return false;
  }
  const session = readSession(request);
  if (!session || normalizeRole(session.rol) !== "administrador") {
    sendJson(response, 401, { error: "La sesion de administrador no es valida. Cierra sesion e ingresa nuevamente." });
    return false;
  }
  return true;
}

function requireSessionRole(request, response, allowedRoles) {
  const session = readSession(request);
  if (!session || !allowedRoles.includes(normalizeRole(session.rol))) {
    sendJson(response, 403, { error: "Tu sesión no tiene permiso para realizar esta operación." });
    return null;
  }
  return session;
}

async function handleLogin(request, response) {
  try {
    const rawBody = await readBody(request);
    const body = JSON.parse(rawBody || "{}");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) {
      sendJson(response, 400, { error: "Completa usuario y contrasena." });
      return;
    }

    const result = await supabase
      .from("usuarios")
      .select("id,nombre,email,rol,activo,created_at,fecha_cumpleanos,sueldo")
      .eq("email", email)
      .eq("password_hash", password)
      .limit(1);

    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    if (!result.data?.length) {
      sendJson(response, 401, { error: "Credenciales invalidas o usuario no existe." });
      return;
    }

    const user = result.data[0];
    if (!isActive(user.activo)) {
      sendJson(response, 423, {
        code: "ACCOUNT_BLOCKED",
        error: "Cuenta bloqueada. Tu usuario está inactivo y no puede ingresar. Contacta al administrador."
      });
      return;
    }
    sendJson(response, 200, { user, sessionToken: issueSessionToken(user) });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo iniciar sesion." });
  }
}

function normalizeRole(role) {
  const value = String(role || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (value === "trabajador") return "operante";
  if (value === "jefe de equipo") return "lider de equipo";
  if (value === "jefe de grupo") return "lider de equipo";
  return value;
}

function isTimedTaskWorkerRole(role) {
  return ["operante", "lider de equipo", "otros"].includes(normalizeRole(role));
}

function normalizeTaskName(value) {
  return normalizeRole(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function isEtiquetadoTask(task) {
  return normalizeTaskName(taskTitle(task)) === "etiquetado";
}

function isGuideBreakdownTask(task) {
  return new Set([
    "revision de guia devolucion",
    "revision de guia despacho",
    "embalado y rotulado de guia"
  ]).has(normalizeTaskName(taskTitle(task)));
}

function isActive(value) {
  return !["false", "0", "no"].includes(String(value ?? true).trim().toLowerCase());
}

// Tipos admitidos para una amonestacion.
const TIPOS_DOCUMENTO = ["CARTA AMONESTACION", "MEMORANDUM", "VERBAL"];

function normalizeTipoDocumento(value) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return TIPOS_DOCUMENTO.includes(raw) ? raw : null;
}

const HANGTAG_VALUES = new Set(["CON_HANGTAG", "SIN_HANGTAG"]);

function normalizeHangtag(value) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  return HANGTAG_VALUES.has(raw) ? raw : null;
}

function normalizeGroupHangtag(value) {
  const normalized = normalizeHangtag(value);
  return normalized === "CON_HANGTAG" ? "con hangtag" : normalized === "SIN_HANGTAG" ? "sin hangtag" : null;
}

function taskTitle(task) {
  return String(task?.nombre || task?.titulo || "");
}

const LOTE_GENERAL_CODE = "LOTE GENERAL";

function isGeneralLoteCode(value) {
  return String(value || "").trim().toUpperCase() === LOTE_GENERAL_CODE;
}

function taskUsesStore(task) {
  const title = normalizeRole(taskTitle(task));
  const storeTaskNames = [
    "pedido mayorista",
    "visita de tienda",
    "picking",
    "apoyo tienda",
    "apoyo a tienda"
  ];
  return title.startsWith("revision de guia") ||
    storeTaskNames.some((taskName) => title === taskName || title.startsWith(`${taskName} `));
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
}

function isPrimaryKeySequenceConflict(error) {
  return error?.code === "23505" && /Key \(id\)|_pkey/i.test(`${error?.details || ""} ${error?.message || ""}`);
}

function missingSchemaColumn(error) {
  return /Could not find the '([^']+)' column/i.exec(String(error?.message || ""))?.[1] || null;
}

async function nextTableId(tableName, idColumn = "id") {
  const result = await supabase.from(tableName).select(idColumn).order(idColumn, { ascending: false }).limit(1);
  if (result.error) throw result.error;
  return Number(result.data?.[0]?.[idColumn] || 0) + 1;
}

async function insertCompatibleActivityRow(payload) {
  const candidate = { ...payload };
  let needsExplicitId = false;
  let result;
  for (let attempt = 0; attempt <= Object.keys(payload).length + 1; attempt += 1) {
    const row = needsExplicitId
      ? { ...candidate, id: await nextTableId("registros_tareas") }
      : candidate;
    result = await supabase.from("registros_tareas").insert(row).select("*").single();
    if (!result.error) return result;
    if (!needsExplicitId && isPrimaryKeySequenceConflict(result.error)) {
      needsExplicitId = true;
      continue;
    }
    const missingColumn = missingSchemaColumn(result.error);
    if (!missingColumn || !(missingColumn in candidate)) return result;
    delete candidate[missingColumn];
  }
  return result;
}

let taskTableName;

async function getTaskTableName() {
  if (taskTableName) return taskTableName;
  for (const candidate of ["tarea", "tareas"]) {
    const result = await supabase.from(candidate).select("id").limit(1);
    if (!result.error) {
      taskTableName = candidate;
      return candidate;
    }
  }
  throw new Error("No se encontro la tabla public.tarea ni public.tareas.");
}

function normalizeActivityLog(row) {
  const normalized = { ...row };
  if ("usuario_id" in normalized && !("trabajador_id" in normalized)) {
    normalized.trabajador_id = normalized.usuario_id;
  }
  if ("observacion" in normalized && !("detalle" in normalized)) {
    normalized.detalle = normalized.observacion;
  }
  if ("dato_extra" in normalized && normalized.dato_extra !== null && String(normalized.dato_extra).trim() !== "") {
    const parsed = Number(normalized.dato_extra);
    if (Number.isNaN(parsed)) normalized.lote = normalized.lote || normalized.dato_extra;
    else if (normalized.tiempo_minutos === null || normalized.tiempo_minutos === undefined) normalized.tiempo_minutos = parsed;
  }
  if ("tarea" in normalized && !("actividad_nombre" in normalized)) {
    normalized.actividad_nombre = normalized.tarea;
  }
  return normalized;
}

function taskPayloadForDb(body, tableName) {
  const taskName = body.nombre ?? body.titulo;
  const unit = body.unidad_medida ?? body.unidad_base;
  // Las banderas se guardan tal como llegan del panel: definen que campos pide
  // la tarea y no se deducen de su nombre.
  const payload = tableName === "tarea"
    ? {
        nombre: taskName,
        activo: body.activo,
        unidad_medida: unit,
        tipo_tarea: body.tipo_tarea,
        requiere_marca: body.requiere_marca,
        requiere_tiempo: body.requiere_tiempo,
        requiere_lote: body.requiere_lote,
        requiere_numero_guia: body.requiere_numero_guia,
        requiere_hangtag: body.requiere_hangtag,
        requiere_tienda: body.requiere_tienda,
        obligatorio_marca: body.obligatorio_marca,
        obligatorio_tiempo: body.obligatorio_tiempo,
        obligatorio_lote: body.obligatorio_lote,
        obligatorio_numero_guia: body.obligatorio_numero_guia,
        obligatorio_hangtag: body.obligatorio_hangtag,
        obligatorio_tienda: body.obligatorio_tienda
      }
    : {
        nombre: taskName,
        tipo_medicion: body.tipo_medicion,
        activo: body.activo,
        requiere_dato_extra: body.requiere_dato_extra,
        nombre_dato_extra: body.nombre_dato_extra,
        puntaje_fijo: body.puntaje_fijo,
        puntos_turno_simple: body.puntos_turno_simple ?? body.puntaje_turno_simple,
        puntos_turno_completo: body.puntos_turno_completo ?? body.puntaje_turno_completo,
        tipo_tarea: body.tipo_tarea,
        requiere_marca: body.requiere_marca
      };

  if (payload.activo === undefined && body.estado !== undefined) {
    payload.activo = !["inactivo", "cerrado", "false", "0", "no"].includes(
      String(body.estado).trim().toLowerCase()
    );
  }

  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== "")
  );
}

async function selectUsers() {
  const [usersResult, movementsResult] = await Promise.all([
    supabase
      .from("usuarios")
      // La gestion administrativa debe reflejar todos los campos del perfil.
      // Los campos de acceso se eliminan antes de devolver la respuesta.
      .select("*")
      .order("id", { ascending: true }),
    supabase
      .from("movimientos_personal")
      .select("id,usuario_id,tipo_movimiento,fecha_movimiento,motivo,created_at")
      .order("fecha_movimiento", { ascending: true })
      .order("id", { ascending: true })
  ]);
  if (usersResult.error) throw usersResult.error;
  if (movementsResult.error) throw movementsResult.error;

  const movementByUser = new Map();
  for (const movement of movementsResult.data || []) {
    const userId = Number(movement.usuario_id);
    const summary = movementByUser.get(userId) || { ingreso: null, salida: null };
    const type = normalizeRole(movement.tipo_movimiento);
    if (type === "ingreso") summary.ingreso = movement;
    if (type === "salida") summary.salida = movement;
    movementByUser.set(userId, summary);
  }

  return (usersResult.data || []).map((user) => {
    const summary = movementByUser.get(Number(user.id)) || {};
    const ingreso = summary.ingreso?.fecha_movimiento || null;
    const salida = summary.salida?.fecha_movimiento || null;
    const salidaValida = Boolean(ingreso && salida && salida >= ingreso);
    const safeUser = Object.fromEntries(Object.entries(user).filter(([key]) => !/password|secret|token|api[_-]?key/i.test(key)));
    return {
      ...safeUser,
      fecha_ingreso: ingreso,
      fecha_salida: salidaValida ? salida : null,
      motivo_salida: salidaValida ? (summary.salida?.motivo || null) : null
    };
  });
}

function validateEmploymentDates(body) {
  const hasFields = body.fecha_ingreso !== undefined || body.fecha_salida !== undefined;
  if (!hasFields) return null;
  const ingreso = String(body.fecha_ingreso || "").trim();
  const salida = String(body.fecha_salida || "").trim();
  const motivo = String(body.motivo_salida || "").trim();
  if (salida && !ingreso) throw new Error("La fecha de ingreso es obligatoria si registras una salida.");
  if (ingreso && !/^\d{4}-\d{2}-\d{2}$/.test(ingreso)) throw new Error("La fecha de ingreso no es valida.");
  if (salida && !/^\d{4}-\d{2}-\d{2}$/.test(salida)) throw new Error("La fecha de salida no es valida.");
  if (ingreso && salida && salida < ingreso) throw new Error("La fecha de salida no puede ser anterior a la fecha de ingreso.");
  if (salida && !motivo) throw new Error("El motivo de salida es obligatorio si registras una fecha de salida.");
  if (motivo.length > 500) throw new Error("El motivo de salida no puede superar 500 caracteres.");
  return { ingreso, salida, motivo: salida ? motivo : "" };
}

async function insertPersonnelMovement(payload) {
  let result = await supabase.from("movimientos_personal").insert(payload).select("*").single();
  if (isPrimaryKeySequenceConflict(result.error)) {
    result = await supabase
      .from("movimientos_personal")
      .insert({ ...payload, id: await nextTableId("movimientos_personal") })
      .select("*")
      .single();
  }
  if (result.error) throw result.error;
  return result.data;
}

async function saveEmploymentDates(userId, dates) {
  if (!dates || !dates.ingreso) return;
  const currentResult = await supabase
    .from("movimientos_personal")
    .select("id,tipo_movimiento,fecha_movimiento")
    .eq("usuario_id", userId)
    .order("fecha_movimiento", { ascending: false })
    .order("id", { ascending: false });
  if (currentResult.error) throw currentResult.error;

  const movements = currentResult.data || [];
  const latestIngreso = movements.find((item) => normalizeRole(item.tipo_movimiento) === "ingreso");
  const latestSalida = movements.find((item) => normalizeRole(item.tipo_movimiento) === "salida");
  const wasClosed = Boolean(
    latestIngreso && latestSalida && latestSalida.fecha_movimiento >= latestIngreso.fecha_movimiento
  );

  // Reingreso: si habia un periodo cerrado (ingreso + salida) y ahora se
  // borra la salida, es que la persona volvio a entrar, no que la salida
  // haya sido un error. En vez de borrar ese registro (perdiendo el rastro
  // de cuando se fue), se deja el periodo anterior intacto como historial y
  // se agrega un ingreso nuevo para el periodo que arranca ahora. Asi el
  // grafico de rotacion sigue mostrando la salida vieja y el reingreso.
  if (wasClosed && !dates.salida) {
    const reentryDate = dates.ingreso > latestSalida.fecha_movimiento ? dates.ingreso : currentLimaDate();
    await insertPersonnelMovement({
      usuario_id: userId,
      tipo_movimiento: "Ingreso",
      fecha_movimiento: reentryDate
    });
    return;
  }

  let ingresoMovement;
  if (latestIngreso && wasClosed && dates.ingreso > latestSalida.fecha_movimiento) {
    ingresoMovement = await insertPersonnelMovement({
      usuario_id: userId,
      tipo_movimiento: "Ingreso",
      fecha_movimiento: dates.ingreso
    });
  } else if (latestIngreso) {
    const updated = await supabase
      .from("movimientos_personal")
      .update({ fecha_movimiento: dates.ingreso })
      .eq("id", latestIngreso.id)
      .select("*")
      .single();
    if (updated.error) throw updated.error;
    ingresoMovement = updated.data;
  } else {
    ingresoMovement = await insertPersonnelMovement({
      usuario_id: userId,
      tipo_movimiento: "Ingreso",
      fecha_movimiento: dates.ingreso
    });
  }

  if (dates.salida) {
    const exitBelongsToCurrentPeriod = latestSalida && latestSalida.fecha_movimiento >= ingresoMovement.fecha_movimiento;
    if (exitBelongsToCurrentPeriod) {
      const updated = await supabase
        .from("movimientos_personal")
        .update({ fecha_movimiento: dates.salida, motivo: dates.motivo || null })
        .eq("id", latestSalida.id);
      if (updated.error) throw updated.error;
    } else {
      await insertPersonnelMovement({
        usuario_id: userId,
        tipo_movimiento: "Salida",
        fecha_movimiento: dates.salida,
        motivo: dates.motivo || null
      });
    }
  }
}

const OPTIONAL_TEXT_USER_FIELDS = [
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
  "talla_zapatillas",
  "talla_polo",
  "nombres_completos",
  "alergia",
  "condicion_salud"
];

function userPayloadForDb(body, { creating = false } = {}) {
  let sueldo;
  if (body.sueldo !== undefined) {
    sueldo = Number(body.sueldo);
    if (!Number.isFinite(sueldo) || sueldo < 0 || sueldo > 9999999999.99) {
      throw new Error("El sueldo debe ser un monto valido mayor o igual a cero.");
    }
    sueldo = Math.round((sueldo + Number.EPSILON) * 100) / 100;
  }

  let hijos;
  if (body.hijos !== undefined) {
    if (body.hijos === null || body.hijos === "") {
      hijos = null;
    } else {
      hijos = Number(body.hijos);
      if (!Number.isInteger(hijos) || hijos < 0) {
        throw new Error("El numero de hijos debe ser un entero mayor o igual a cero.");
      }
    }
  }

  const payload = {
    nombre: body.nombre === undefined ? undefined : String(body.nombre).trim(),
    email: body.email === undefined ? undefined : String(body.email).trim().toLowerCase(),
    rol: body.rol === undefined ? undefined : normalizeRole(body.rol),
    activo: body.activo,
    fecha_cumpleanos:
      body.fecha_cumpleanos === undefined ? undefined : body.fecha_cumpleanos || null,
    sueldo,
    hijos,
    password_hash: body.password_hash === undefined ? undefined : String(body.password_hash)
  };

  for (const field of OPTIONAL_TEXT_USER_FIELDS) {
    if (body[field] === undefined) continue;
    const trimmed = String(body[field] ?? "").trim();
    payload[field] = trimmed || null;
  }

  if (creating && (!payload.nombre || !payload.email || !payload.password_hash)) {
    throw new Error("Nombre, usuario y contrasena son obligatorios.");
  }

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function userMutationError(response, error, fallback) {
  if (error?.code === "23505") {
    sendJson(response, 409, { error: "Ya existe una cuenta con ese usuario o correo." });
    return;
  }
  if (error?.code === "23514") {
    sendJson(response, 400, { error: "El rol seleccionado no esta permitido por la base de datos." });
    return;
  }
  sendJson(response, 500, { error: error?.message || fallback });
}

async function handleCreateUser(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const employmentDates = validateEmploymentDates(body);
    const payload = userPayloadForDb(body, { creating: true });
    let result = await supabase.from("usuarios").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("usuarios")
        .insert({ ...payload, id: await nextTableId("usuarios") })
        .select("*")
        .single();
    }
    if (result.error) {
      userMutationError(response, result.error, "No se pudo crear el usuario.");
      return;
    }
    if (employmentDates?.ingreso) await saveEmploymentDates(result.data.id, employmentDates);
    const { password_hash: _passwordHash, password: _password, ...user } = result.data;
    sendJson(response, 201, { user: { ...user, fecha_ingreso: employmentDates?.ingreso || null } });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 400;
    sendJson(response, status, { error: error.message || "No se pudo crear el usuario." });
  }
}

async function handleUpdateUser(request, response, userId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(response, 400, { error: "Usuario invalido." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    if (Object.hasOwn(body, "created_at") || Object.hasOwn(body, "createdAt")) {
      sendJson(response, 400, { error: "La fecha de creacion no se puede modificar." });
      return;
    }
    const employmentDates = validateEmploymentDates(body);
    const payload = userPayloadForDb(body);
    if (employmentDates?.ingreso) payload.activo = !employmentDates.salida;
    if (!Object.keys(payload).length) {
      sendJson(response, 400, { error: "No hay cambios para guardar." });
      return;
    }
    const result = await supabase.from("usuarios").update(payload).eq("id", userId).select("*").maybeSingle();
    if (result.error) {
      userMutationError(response, result.error, "No se pudo actualizar el usuario.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Usuario no encontrado." });
      return;
    }
    await saveEmploymentDates(userId, employmentDates);
    const { password_hash: _passwordHash, password: _password, ...user } = result.data;
    const refreshedUsers = await selectUsers();
    sendJson(response, 200, { user: refreshedUsers.find((item) => Number(item.id) === userId) || user });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "No se pudo actualizar el usuario." });
  }
}

async function handleDeleteUser(_request, response, userId) {
  try {
    if (!requireAdministrator(_request, response)) return;
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(response, 400, { error: "Usuario invalido." });
      return;
    }
    const session = readSession(_request);
    if (Number(session?.id) === userId) {
      sendJson(response, 400, { error: "No puedes eliminar tu propia cuenta de administrador." });
      return;
    }
    const result = await supabase.from("usuarios").delete().eq("id", userId).select("id").maybeSingle();
    if (result.error) {
      if (result.error.code === "23503") {
        const archived = await supabase.from("usuarios").update({ activo: false }).eq("id", userId).select("id").maybeSingle();
        if (archived.error) {
          userMutationError(response, archived.error, "No se pudo desactivar el usuario.");
          return;
        }
        sendJson(response, 200, { deleted: false, archived: true });
        return;
      }
      userMutationError(response, result.error, "No se pudo eliminar el usuario.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Usuario no encontrado." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar el usuario." });
  }
}

const trainingStates = new Set(["pendiente", "en_curso", "finalizado"]);

function normalizeTrainingState(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  return trainingStates.has(normalized) ? normalized : "";
}

function trainingStateFromProgress(progress) {
  return normalizeTrainingState(progress?.estado) || (progress?.completado ? "finalizado" : "pendiente");
}

async function selectUserTrainingProfile(userId) {
  const [userResult, coursesResult, progressResult] = await Promise.all([
    supabase
      .from("usuarios")
      .select("id,nombre,email,rol,activo,fecha_cumpleanos,created_at")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("capacitaciones")
      .select("id,id_curso,orden,nombre_curso,competencias,nro_horas,inversion_curso,activo")
      .eq("activo", true)
      .order("orden", { ascending: true }),
    supabase
      .from("usuario_capacitaciones")
      .select("capacitacion_id,curso_id,estado,completado,completado_en,completado_por,duracion,encargado")
      .eq("usuario_id", userId)
  ]);

  if (userResult.error) throw userResult.error;
  if (!userResult.data) throw new Error("Usuario no encontrado.");
  if (coursesResult.error || progressResult.error) {
    const missingState = [coursesResult.error, progressResult.error]
      .filter(Boolean)
      .some((error) => /\bestado\b/i.test(error.message || ""));
    if (missingState) throw new Error("Falta aplicar la migracion sql/016_estado_capacitaciones.sql en Supabase.");
    const missingNumericId = [coursesResult.error, progressResult.error]
      .filter(Boolean)
      .some((error) => /capacitacion_id/i.test(error.message || ""));
    if (missingNumericId) throw new Error("Falta aplicar la migracion sql/015_usuario_capacitacion_id.sql en Supabase.");
    const migrationMissing = [coursesResult.error, progressResult.error]
      .filter(Boolean)
      .some((error) => /capacitaciones|schema cache|does not exist/i.test(error.message || ""));
    if (migrationMissing) throw new Error("Falta aplicar la migracion sql/012_capacitaciones_trabajadores.sql en Supabase.");
    throw coursesResult.error || progressResult.error;
  }

  const courses = coursesResult.data || [];
  const progressByCourse = new Map((progressResult.data || []).map((item) => [item.curso_id, item]));
  // Las capacitaciones ya no son secuenciales: cualquier curso esta siempre
  // disponible y se puede cambiar de estado en cualquier orden. La duracion y
  // el encargado se fijan por trabajador (usuario_capacitaciones.duracion /
  // .encargado); si el trabajador no tiene su propio valor, se usa el del
  // catalogo de capacitaciones como base.
  const trainings = courses.map((course) => {
    const progress = progressByCourse.get(course.id_curso);
    const estado = trainingStateFromProgress(progress);
    const completed = estado === "finalizado";

    return {
      ...course,
      capacitacion_id: Number(course.id),
      estado,
      completado: completed,
      completado_en: progress?.completado_en || null,
      completado_por: progress?.completado_por || null,
      nro_horas: progress?.duracion || course.nro_horas,
      inversion_curso: progress?.encargado || course.inversion_curso,
      disponible: true,
      puede_cambiar_estado: true,
      puede_desmarcar: completed
    };
  });
  const completedCount = trainings.filter((course) => course.completado).length;
  const inProgressCount = trainings.filter((course) => course.estado === "en_curso").length;

  return {
    user: userResult.data,
    trainings,
    summary: {
      completed: completedCount,
      in_progress: inProgressCount,
      pending: trainings.length - completedCount - inProgressCount,
      total: trainings.length,
      percent: trainings.length ? Math.round((completedCount / trainings.length) * 100) : 0,
      next_course_id: trainings.find((course) => !course.completado && course.disponible)?.id_curso || null
    }
  };
}

async function handleReadUserTrainingProfile(request, response, userId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(userId) || userId <= 0) {
      sendJson(response, 400, { error: "Usuario invalido." });
      return;
    }
    sendJson(response, 200, await selectUserTrainingProfile(userId));
  } catch (error) {
    sendJson(response, /no encontrado/i.test(error.message || "") ? 404 : 500, {
      error: error.message || "No se pudo cargar el perfil de capacitaciones."
    });
  }
}

async function handleUpdateUserTraining(request, response, userId, courseId) {
  try {
    const session = requireSessionRole(request, response, ["administrador"]);
    if (!session) return;
    if (!Number.isInteger(userId) || userId <= 0 || !courseId) {
      sendJson(response, 400, { error: "Usuario o curso invalido." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    const requestedState = normalizeTrainingState(body.estado) ||
      (typeof body.completado === "boolean" ? (body.completado ? "finalizado" : "pendiente") : "");
    const hasNroHoras = body.nro_horas !== undefined;
    const hasEncargado = body.encargado !== undefined || body.inversion_curso !== undefined;
    if (hasNroHoras && !String(body.nro_horas || "").trim()) {
      sendJson(response, 400, { error: "La duracion no puede quedar vacia." });
      return;
    }
    if (hasEncargado && !String(body.encargado ?? body.inversion_curso ?? "").trim()) {
      sendJson(response, 400, { error: "El encargado no puede quedar vacio." });
      return;
    }
    if (!requestedState && !hasNroHoras && !hasEncargado) {
      sendJson(response, 400, { error: "Indica un estado, una duracion o un encargado para actualizar." });
      return;
    }

    const [userResult, courseResult] = await Promise.all([
      supabase.from("usuarios").select("id,rol").eq("id", userId).maybeSingle(),
      supabase.from("capacitaciones").select("id,id_curso,orden").eq("id_curso", courseId).eq("activo", true).maybeSingle()
    ]);
    const firstError = [userResult.error, courseResult.error].find(Boolean);
    if (firstError) throw firstError;
    if (!userResult.data) {
      sendJson(response, 404, { error: "Usuario no encontrado." });
      return;
    }
    if (normalizeRole(userResult.data.rol) === "administrador") {
      sendJson(response, 400, { error: "Los administradores no participan en capacitaciones." });
      return;
    }
    if (!courseResult.data) {
      sendJson(response, 404, { error: "Capacitacion no encontrada." });
      return;
    }

    // Las capacitaciones ya no son secuenciales: se pueden marcar en
    // cualquier orden, sin exigir que las anteriores esten finalizadas. Si
    // solo se edita la duracion/encargado, no se toca el estado ya guardado.
    const progressPayload = {
      usuario_id: userId,
      capacitacion_id: Number(courseResult.data.id),
      curso_id: courseId
    };
    if (requestedState) {
      const completed = requestedState === "finalizado";
      progressPayload.estado = requestedState;
      progressPayload.completado = completed;
      progressPayload.completado_en = completed ? new Date().toISOString() : null;
      progressPayload.completado_por = completed ? Number(session.id) : null;
    }
    // La tabla usuario_capacitaciones guarda la duracion en la columna
    // "duracion" (no "nro_horas": ese nombre solo existe en la tabla
    // capacitaciones, que es el catalogo global).
    if (hasNroHoras) progressPayload.duracion = String(body.nro_horas).trim();
    if (hasEncargado) progressPayload.encargado = String(body.encargado ?? body.inversion_curso).trim();

    const result = await supabase
      .from("usuario_capacitaciones")
      .upsert(progressPayload, { onConflict: "usuario_id,curso_id" });
    if (result.error) throw result.error;

    sendJson(response, 200, await selectUserTrainingProfile(userId));
  } catch (error) {
    const rawMessage = error.message || "No se pudo actualizar la capacitacion.";
    const message = /\bestado\b/i.test(rawMessage)
        ? "Falta aplicar la migracion sql/016_estado_capacitaciones.sql en Supabase."
        : /capacitacion_id/i.test(rawMessage)
          ? "Falta aplicar la migracion sql/015_usuario_capacitacion_id.sql en Supabase."
          : rawMessage;
    sendJson(response, /debes (?:completar|finalizar)|no puedes (?:desmarcar|retroceder)/i.test(message) ? 409 : 500, { error: message });
  }
}

async function handleReadTrainingCourses(request, response, includeInactive) {
  try {
    if (!requireAdministrator(request, response)) return;
    let query = supabase
      .from("capacitaciones")
      .select("id,id_curso,orden,nombre_curso,competencias,nro_horas,inversion_curso,activo")
      .order("orden", { ascending: true });
    if (!includeInactive) query = query.eq("activo", true);
    const result = await query;
    if (result.error) throw result.error;
    sendJson(response, 200, { courses: result.data || [] });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las capacitaciones." });
  }
}

async function handleCreateTrainingCourse(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const nombreCurso = String(body.nombre_curso ?? body.curso ?? "").trim();
    const competencias = String(body.competencias ?? body.competencia ?? "").trim();
    if (!nombreCurso) {
      sendJson(response, 400, { error: "El nombre del curso no puede quedar vacio." });
      return;
    }
    if (!competencias) {
      sendJson(response, 400, { error: "La competencia no puede quedar vacia." });
      return;
    }
    const activo = body.activo === undefined ? true : Boolean(body.activo);

    const existingResult = await supabase.from("capacitaciones").select("id_curso,orden");
    if (existingResult.error) throw existingResult.error;
    const existingRows = existingResult.data || [];
    const nextNumber = existingRows.reduce((max, row) => {
      const match = /^CAP\s+(\d+)$/i.exec(String(row.id_curso || "").trim());
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const nextOrden = existingRows.reduce((max, row) => Math.max(max, Number(row.orden) || 0), 0) + 1;

    const result = await supabase
      .from("capacitaciones")
      .insert({
        id_curso: `CAP ${nextNumber}`,
        orden: nextOrden,
        nombre_curso: nombreCurso,
        competencias,
        // La duracion y el encargado ahora se fijan por trabajador; estos
        // valores solo cubren la columna NOT NULL de la capacitacion base.
        nro_horas: "Por definir",
        inversion_curso: "Por definir",
        activo
      })
      .select("id,id_curso,orden,nombre_curso,competencias,nro_horas,inversion_curso,activo")
      .single();
    if (result.error) throw result.error;
    sendJson(response, 201, { course: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la capacitacion." });
  }
}

async function handleUpdateTrainingCourse(request, response, courseId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const normalizedCourseId = String(courseId || "").trim().toUpperCase().replace(/\s+/g, " ");
    if (!normalizedCourseId) {
      sendJson(response, 400, { error: "Capacitacion invalida." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = {};
    if (body.nro_horas !== undefined) {
      const nroHoras = String(body.nro_horas || "").trim();
      if (!nroHoras) {
        sendJson(response, 400, { error: "La duracion no puede quedar vacia." });
        return;
      }
      payload.nro_horas = nroHoras;
    }
    if (body.encargado !== undefined || body.inversion_curso !== undefined) {
      const encargado = String(body.encargado ?? body.inversion_curso ?? "").trim();
      if (!encargado) {
        sendJson(response, 400, { error: "El encargado no puede quedar vacio." });
        return;
      }
      payload.inversion_curso = encargado;
    }
    if (body.nombre_curso !== undefined || body.curso !== undefined) {
      const nombreCurso = String(body.nombre_curso ?? body.curso ?? "").trim();
      if (!nombreCurso) {
        sendJson(response, 400, { error: "El nombre del curso no puede quedar vacio." });
        return;
      }
      payload.nombre_curso = nombreCurso;
    }
    if (body.competencias !== undefined || body.competencia !== undefined) {
      const competencias = String(body.competencias ?? body.competencia ?? "").trim();
      if (!competencias) {
        sendJson(response, 400, { error: "La competencia no puede quedar vacia." });
        return;
      }
      payload.competencias = competencias;
    }
    if (body.activo !== undefined) {
      payload.activo = Boolean(body.activo);
    }
    if (!Object.keys(payload).length) {
      sendJson(response, 400, { error: "No hay cambios para guardar." });
      return;
    }

    const result = await supabase
      .from("capacitaciones")
      .update(payload)
      .eq("id_curso", normalizedCourseId)
      .select("id,id_curso,orden,nombre_curso,competencias,nro_horas,inversion_curso,activo")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "Capacitacion no encontrada." });
      return;
    }
    sendJson(response, 200, { course: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar la capacitacion." });
  }
}

async function handleDeleteTrainingCourse(request, response, courseId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const normalizedCourseId = String(courseId || "").trim().toUpperCase().replace(/\s+/g, " ");
    if (!normalizedCourseId) {
      sendJson(response, 400, { error: "Capacitacion invalida." });
      return;
    }

    const result = await supabase.from("capacitaciones").delete().eq("id_curso", normalizedCourseId).select("id").maybeSingle();
    if (result.error) {
      if (result.error.code === "23503") {
        const archived = await supabase
          .from("capacitaciones")
          .update({ activo: false })
          .eq("id_curso", normalizedCourseId)
          .select("id")
          .maybeSingle();
        if (archived.error) throw archived.error;
        if (!archived.data) {
          sendJson(response, 404, { error: "Capacitacion no encontrada." });
          return;
        }
        sendJson(response, 200, {
          deleted: false,
          archived: true,
          message: "Hay trabajadores con progreso registrado en este curso, asi que se desactivo en lugar de eliminarse."
        });
        return;
      }
      throw result.error;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Capacitacion no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la capacitacion." });
  }
}

async function handleReadEncargados(request, response, includeInactive) {
  try {
    if (!requireAdministrator(request, response)) return;
    let query = supabase.from("capacitacion_encargados").select("id,nombre,activo,created_at").order("nombre", { ascending: true });
    if (!includeInactive) query = query.eq("activo", true);
    const result = await query;
    if (result.error) throw result.error;
    sendJson(response, 200, { encargados: result.data || [] });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los encargados." });
  }
}

async function handleCreateEncargado(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const nombre = String(body.nombre || "").trim();
    if (!nombre) {
      sendJson(response, 400, { error: "El nombre del encargado no puede quedar vacio." });
      return;
    }
    const result = await supabase
      .from("capacitacion_encargados")
      .insert({ nombre, activo: true })
      .select("id,nombre,activo,created_at")
      .single();
    if (result.error) {
      if (result.error.code === "23505") {
        sendJson(response, 409, { error: "Ya existe un encargado con ese nombre." });
        return;
      }
      throw result.error;
    }
    sendJson(response, 201, { encargado: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear el encargado." });
  }
}

async function handleUpdateEncargado(request, response, encargadoId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(encargadoId) || encargadoId <= 0) {
      sendJson(response, 400, { error: "Encargado invalido." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = {};
    if (body.nombre !== undefined) {
      const nombre = String(body.nombre || "").trim();
      if (!nombre) {
        sendJson(response, 400, { error: "El nombre del encargado no puede quedar vacio." });
        return;
      }
      payload.nombre = nombre;
    }
    if (body.activo !== undefined) payload.activo = Boolean(body.activo);
    if (!Object.keys(payload).length) {
      sendJson(response, 400, { error: "No hay cambios para guardar." });
      return;
    }
    const result = await supabase
      .from("capacitacion_encargados")
      .update(payload)
      .eq("id", encargadoId)
      .select("id,nombre,activo,created_at")
      .maybeSingle();
    if (result.error) {
      if (result.error.code === "23505") {
        sendJson(response, 409, { error: "Ya existe un encargado con ese nombre." });
        return;
      }
      throw result.error;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Encargado no encontrado." });
      return;
    }
    sendJson(response, 200, { encargado: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar el encargado." });
  }
}

async function handleReadTrainingStatus(request, response, courseId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const normalizedCourseId = String(courseId || "").trim().toUpperCase().replace(/\s+/g, " ");
    if (!normalizedCourseId) {
      sendJson(response, 400, { error: "Capacitacion invalida." });
      return;
    }

    const [courseResult, usersResult, progressResult] = await Promise.all([
      supabase.from("capacitaciones").select("id,id_curso,orden,nombre_curso,nro_horas,inversion_curso").eq("id_curso", normalizedCourseId).maybeSingle(),
      supabase.from("usuarios").select("id,nombre,email,rol,activo").order("nombre", { ascending: true }),
      supabase
        .from("usuario_capacitaciones")
        .select("id,usuario_id,capacitacion_id,curso_id,estado,completado,completado_en,completado_por,created_at,updated_at,duracion,encargado")
        .eq("curso_id", normalizedCourseId)
    ]);
    const firstError = [courseResult.error, usersResult.error, progressResult.error].find(Boolean);
    if (firstError) throw firstError;
    if (!courseResult.data) {
      sendJson(response, 404, { error: "Capacitacion no encontrada." });
      return;
    }

    const progressByUser = new Map((progressResult.data || []).map((item) => [Number(item.usuario_id), item]));
    const users = (usersResult.data || [])
      .filter((user) => normalizeRole(user.rol) !== "administrador")
      .map((user) => {
      const progress = progressByUser.get(Number(user.id));
      const estado = trainingStateFromProgress(progress);
      return {
        id: Number(user.id),
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        activo: user.activo,
        registro_id: progress?.id || null,
        usuario_id: Number(user.id),
        capacitacion_id: progress?.capacitacion_id || null,
        curso_id: progress?.curso_id || normalizedCourseId,
        estado,
        completado: estado === "finalizado",
        completado_en: progress?.completado_en || null,
        completado_por: progress?.completado_por || null,
        nro_horas: progress?.duracion || courseResult.data.nro_horas || null,
        encargado: progress?.encargado || courseResult.data.inversion_curso || null,
        registro_creado_en: progress?.created_at || null,
        registro_actualizado_en: progress?.updated_at || null,
        tiene_registro: Boolean(progress)
      };
      });

    sendJson(response, 200, { course: courseResult.data, users });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo cargar el estado de la capacitacion." });
  }
}

async function handleBulkUpdateTraining(request, response) {
  try {
    const session = requireSessionRole(request, response, ["administrador"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const courseId = String(body.curso_id || "").trim().toUpperCase().replace(/\s+/g, " ");
    const requestedState = normalizeTrainingState(body.estado);
    const encargado = String(body.encargado || "").trim();
    const nroHoras = String(body.nro_horas || "").trim();
    const userIds = Array.from(new Set((Array.isArray(body.usuario_ids) ? body.usuario_ids : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)));

    if (!courseId) {
      sendJson(response, 400, { error: "Selecciona una capacitacion." });
      return;
    }
    if (!requestedState) {
      sendJson(response, 400, { error: "El estado debe ser pendiente, en_curso o finalizado." });
      return;
    }
    if (!userIds.length) {
      sendJson(response, 400, { error: "Selecciona al menos un trabajador." });
      return;
    }
    if (!encargado) {
      sendJson(response, 400, { error: "Selecciona un encargado." });
      return;
    }

    const [courseResult, encargadoResult] = await Promise.all([
      supabase.from("capacitaciones").select("id,id_curso").eq("id_curso", courseId).eq("activo", true).maybeSingle(),
      supabase.from("capacitacion_encargados").select("id").eq("nombre", encargado).eq("activo", true).maybeSingle()
    ]);
    if (courseResult.error) throw courseResult.error;
    if (encargadoResult.error) throw encargadoResult.error;
    if (!courseResult.data) {
      sendJson(response, 404, { error: "Capacitacion no encontrada." });
      return;
    }
    if (!encargadoResult.data) {
      sendJson(response, 404, { error: "El encargado seleccionado no existe o esta inactivo." });
      return;
    }

    const usersResult = await supabase.from("usuarios").select("id,rol").in("id", userIds);
    if (usersResult.error) throw usersResult.error;
    const validUserIds = new Set(
      (usersResult.data || [])
        .filter((item) => normalizeRole(item.rol) !== "administrador")
        .map((item) => Number(item.id))
    );
    const skipped = userIds.filter((id) => !validUserIds.has(id));

    const completed = requestedState === "finalizado";
    const nowIso = new Date().toISOString();
    const rows = [...validUserIds].map((usuarioId) => ({
      usuario_id: usuarioId,
      capacitacion_id: Number(courseResult.data.id),
      curso_id: courseId,
      estado: requestedState,
      completado: completed,
      completado_en: completed ? nowIso : null,
      completado_por: completed ? Number(session.id) : null,
      encargado,
      ...(nroHoras ? { duracion: nroHoras } : {})
    }));

    if (rows.length) {
      const result = await supabase.from("usuario_capacitaciones").upsert(rows, { onConflict: "usuario_id,curso_id" });
      if (result.error) throw result.error;
    }

    sendJson(response, 200, {
      updated: rows.length,
      skipped,
      curso_id: courseId,
      estado: requestedState
    });
  } catch (error) {
    const rawMessage = error.message || "No se pudo actualizar la capacitacion en lote.";
    const message = /\bestado\b/i.test(rawMessage)
      ? "Falta aplicar la migracion sql/016_estado_capacitaciones.sql en Supabase."
      : rawMessage;
    sendJson(response, 500, { error: message });
  }
}

async function selectTasks() {
  const tableName = await getTaskTableName();
  const result = await supabase.from(tableName).select("*").order("id", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

async function selectBrands() {
  const result = await supabase.from("marcas").select("id,nombre").order("nombre", { ascending: true });
  if (result.error) throw result.error;
  return result.data || [];
}

function isMissingDashboardResource(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(String(error?.code || ""))
    || /could not find (?:the table|the .* column)|does not exist/i.test(String(error?.message || ""));
}

async function selectAllDashboardRows(tableName, { optional = false, idColumn = "id" } = {}) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const result = await supabase
      .from(tableName)
      .select("*")
      .order(idColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) {
      if (optional && isMissingDashboardResource(result.error)) return [];
      throw result.error;
    }
    const page = result.data || [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function dashboardDate(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return match[0];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return match[0];
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(parsed);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function handleReadFootwearDashboard(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const taskTable = await getTaskTableName();
    const [
      users,
      tasks,
      errorTasks,
      brands,
      workerRecords,
      leaderRecords,
      attendances,
      incidents,
      incidentAreas,
      warnings,
      movements,
      trainings,
      trainingAssignments,
      scoringRules,
      penalties,
      averageReferences,
      lotes,
      guias,
      incidentStores
    ] = await Promise.all([
      selectAllDashboardRows("usuarios"),
      selectAllDashboardRows(taskTable),
      selectAllDashboardRows("tarea_error"),
      selectAllDashboardRows("marcas"),
      selectAllDashboardRows("registros_tareas", { optional: true }),
      selectAllDashboardRows("registros_tareas_jefe_equipo", { optional: true }),
      selectAllDashboardRows("asistencias", { optional: true }),
      selectAllDashboardRows("registro_errores", { optional: true, idColumn: "id_error" }),
      selectAllDashboardRows("areas_departamento", { optional: true }),
      selectAllDashboardRows("amonestaciones", { optional: true }),
      selectAllDashboardRows("movimientos_personal", { optional: true }),
      selectAllDashboardRows("capacitaciones", { optional: true }),
      selectAllDashboardRows("usuario_capacitaciones", { optional: true }),
      selectAllDashboardRows("reglas_puntaje", { optional: true }),
      selectAllDashboardRows("penalizaciones", { optional: true }),
      selectAverageReferencesByTask(),
      selectAllDashboardRows("lotes", { optional: true }),
      selectAllDashboardRows("guias", { optional: true }),
      selectAllDashboardRows("tiendas", { optional: true })
    ]);

    // Personal y asistencia abarcan todos los roles. Los graficos de
    // produccion aplican aparte su filtro de operantes y lideres de equipo.
    const dashboardUsers = users;
    const dashboardUserIds = new Set(dashboardUsers.map((user) => Number(user.id)));
    const dashboardWorkerRecords = workerRecords.filter((row) => (
      dashboardUserIds.has(Number(row.usuario_id || row.trabajador_id))
    ));
    const visibleWorkerRecords = dashboardWorkerRecords.filter((row) => !isGeneralLoteCode(row.dato_extra || row.lote));
    const generalLoteWorkerRecords = dashboardWorkerRecords.filter((row) => isGeneralLoteCode(row.dato_extra || row.lote));
    const visibleLeaderRecords = leaderRecords.filter((row) => (
      dashboardUserIds.has(Number(row.usuario_id || row.trabajador_id))
      && !isGeneralLoteCode(row.lote || row.dato_extra)
    ));
    const visibleAttendances = attendances.filter((row) => dashboardUserIds.has(Number(row.usuario_id)));
    const visibleIncidents = incidents.filter((row) => !row.usuario_id || dashboardUserIds.has(Number(row.usuario_id)));
    const visibleWarnings = warnings.filter((row) => dashboardUserIds.has(Number(row.usuario_id)));
    const visibleMovements = movements.filter((row) => dashboardUserIds.has(Number(row.usuario_id)));
    const visibleTrainingAssignments = trainingAssignments.filter((row) => dashboardUserIds.has(Number(row.usuario_id)));

    const years = new Set([Number(currentLimaDate().slice(0, 4))]);
    const collectYear = (value) => {
      const date = dashboardDate(value);
      if (date) years.add(Number(date.slice(0, 4)));
    };
    visibleWorkerRecords.forEach((row) => collectYear(row.fecha_registro || row.created_at));
    visibleLeaderRecords.forEach((row) => collectYear(row.fecha_registro || row.created_at));
    visibleAttendances.forEach((row) => collectYear(row.fecha || row.created_at));
    visibleIncidents.forEach((row) => collectYear(row.fecha_error || row.created_at));
    visibleWarnings.forEach((row) => collectYear(row.fecha || row.created_at));
    visibleMovements.forEach((row) => collectYear(row.fecha_movimiento || row.created_at));
    visibleTrainingAssignments.forEach((row) => collectYear(row.completado_en || row.created_at));
    guias.forEach((row) => collectYear(row.fecha || row.created_at));
    const dashboardYears = [...years].filter(Number.isFinite).sort((a, b) => a - b);

    const rulesByTaskId = new Map();
    scoringRules.forEach((rule) => {
      const taskId = Number(rule.tarea_id);
      if (!rulesByTaskId.has(taskId)) rulesByTaskId.set(taskId, []);
      rulesByTaskId.get(taskId).push(rule);
    });
    const scoredTaskById = new Map(tasks.map((task) => [
      Number(task.id),
      applyScoringRules(task, rulesByTaskId.get(Number(task.id)) || [])
    ]));
    const errorTaskById = new Map(errorTasks.map((task) => [Number(task.id), task]));

    const safeWorkers = dashboardUsers.map((user) => ({
      id: Number(user.id),
      name: String(user.nombre || `Usuario ${user.id}`),
      alias: String(user.alias || user.nombre || `Usuario ${user.id}`),
      role: normalizeRole(user.rol) || "otros",
      active: isActive(user.activo),
      joinedAt: dashboardDate(user.fecha_ingreso || user.created_at),
      leftAt: dashboardDate(user.fecha_salida),
      birthday: dashboardDate(user.fecha_cumpleanos)
    }));

    // El indicador de cumpleanos del dashboard incluye a todos los usuarios.
    const birthdayPeople = users.map((user) => ({
      id: Number(user.id),
      name: String(user.nombre || `Usuario ${user.id}`),
      active: isActive(user.activo),
      birthday: dashboardDate(user.fecha_cumpleanos)
    }));

    const normalizeActivity = (row, source) => {
      const task = scoredTaskById.get(Number(row.tarea_id));
      const storedPoints = row.puntaje === null || row.puntaje === undefined ? null : Number(row.puntaje);
      const numericExtra = row.dato_extra === null || row.dato_extra === undefined || row.dato_extra === ""
        ? 0
        : Number(row.dato_extra);
      const minutes = Number(row.tiempo_minutos ?? (Number.isFinite(numericExtra) ? numericExtra : 0) ?? 0);
      const fallbackPoints = task
        ? calculatePoints(task, Number(row.cantidad || 0), minutes, source === "jefe-equipo" || Boolean(row.cumplimiento))
        : 0;
      return {
        id: `${source}-${row.id}`,
        rawId: Number(row.id),
        source,
        workerId: Number(row.usuario_id || row.trabajador_id),
        taskId: Number(row.tarea_id),
        date: dashboardDate(row.fecha_registro || row.created_at),
        createdAt: row.created_at || null,
        shift: String(row.turno || "").trim() || null,
        quantity: Number(row.cantidad || 0),
        minutes,
        brandId: Number(row.marca_id) || null,
        guideNumber: String(row.numero_guia || "").trim() || null,
        lote: String(row.lote || (!Number.isFinite(numericExtra) ? row.dato_extra : "") || "").trim() || null,
        labelingType: normalizeHangtag(row.tipo_etiquetado),
        observation: String(row.observacion || "").trim() || null,
        points: Number.isFinite(storedPoints) ? storedPoints : Number(fallbackPoints || 0),
        pointsStored: storedPoints !== null && Number.isFinite(storedPoints)
      };
    };

    const incidentUserById = new Map(dashboardUsers.map((item) => [Number(item.id), item]));
    const incidentAreaById = new Map(incidentAreas.map((item) => [Number(item.id), item]));
    const incidentStoreById = new Map(incidentStores.map((item) => [Number(item.id), item]));
    const loteBrandNameById = new Map(brands.map((brand) => [Number(brand.id), String(brand.nombre || `Marca ${brand.id}`)]));
    const payrollYear = Number(currentLimaDate().slice(0, 4));
    const payroll = buildDashboardPayroll(dashboardUsers, visibleMovements, [payrollYear], { normalizeRole });

    response.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      years: dashboardYears,
      workers: safeWorkers,
      birthdayPeople,
      tasks: tasks.map((task) => ({
        id: Number(task.id),
        name: taskTitle(task) || `Tarea ${task.id}`,
        type: String(task.tipo_tarea || "General"),
        unit: String(task.unidad_medida || task.unidad_base || "").trim(),
        active: isActive(task.activo),
        operational: task.es_operativa === true,
        requiresBrand: [true, 1, "1", "true", "si", "sí"].includes(task.requiere_marca),
        requiresTime: [true, 1, "1", "true", "si", "sí"].includes(task.requiere_tiempo) || isGroupLeaderTimeTask(task)
      })),
      errorTasks: errorTasks.map((task) => ({
        id: Number(task.id),
        name: taskTitle(task) || `Tarea de error ${task.id}`,
        active: isActive(task.activo)
      })),
      brands: brands.map((brand) => ({ id: Number(brand.id), name: String(brand.nombre || `Marca ${brand.id}`) })),
      lotes: lotes.filter((lote) => !lote.es_general && !isGeneralLoteCode(lote.codigo_lote)).map((lote) => ({
        id: Number(lote.id),
        code: String(lote.codigo_lote || "").trim().toUpperCase(),
        quantity: Number(lote.cantidad_lote || 0),
        status: String(lote.estado || "pendiente").trim().toLowerCase(),
        classificationStartDate: dashboardDate(lote.fecha_trabajo),
        classificationEndDate: dashboardDate(lote.fecha_fin_clasificado),
        labelingStartDate: dashboardDate(lote.fecha_inicio_etiquetado),
        completedLabelingDate: dashboardDate(lote.fecha_completada),
        brandName: loteBrandNameById.get(Number(lote.marca_id)) || null,
        teamLeaderName: incidentUserById.get(Number(lote.usuario_id))?.nombre || null
      })).filter((lote) => lote.code),
      guias: guias.map((row) => ({
        id: Number(row.id),
        code: String(row.codigo || "").trim(),
        date: dashboardDate(row.fecha || row.created_at),
        quantity: Number(row.cantidad || 0)
      })).filter((row) => row.code && row.date),
      penalties: penalties.map((item) => ({ key: String(item.clave || ""), points: Number(item.puntos || 0) })),
      averageReferenceByTask: averageReferences.byTask,
      averageReferenceMigrationRequired: averageReferences.migrationRequired,
      activities: [
        ...visibleWorkerRecords.map((row) => normalizeActivity(row, "operante")),
        ...visibleLeaderRecords.map((row) => normalizeActivity(row, "jefe-equipo"))
      ].filter((row) => row.workerId && row.taskId && row.date),
      // Coleccion separada: solo la consume la tabla "Detalle de Registro de
      // Tareas". No participa en ningun KPI, grafica, ranking ni calculo.
      generalLoteActivities: generalLoteWorkerRecords
        .map((row) => ({ ...normalizeActivity(row, "operante"), isGeneralLote: true }))
        .filter((row) => row.workerId && row.taskId && row.date),
      attendances: visibleAttendances.map((row) => ({
        id: Number(row.id), workerId: Number(row.usuario_id), date: dashboardDate(row.fecha || row.created_at),
        state: String(row.estado || "FALTA").toUpperCase(), earlyExit: Boolean(row.retiro_anticipado),
        observation: String(row.observacion || "").trim() || null
      })).filter((row) => row.workerId && row.date),
      incidents: visibleIncidents.map((row) => ({
        id: Number(row.id_error), workerId: Number(row.usuario_id) || null, areaId: Number(row.area_id) || null, taskId: Number(row.tarea_error_id),
        offenderName: String(row.usuario_id
          ? incidentUserById.get(Number(row.usuario_id))?.nombre || `Usuario ${row.usuario_id}`
          : incidentAreaById.get(Number(row.area_id))?.nombre || "Área sin identificar"),
        offenderType: row.usuario_id ? "Usuario" : "Área",
        taskName: String(taskTitle(errorTaskById.get(Number(row.tarea_error_id))) || ""), errorType: String(row.tipo_error || "Sin tipo"),
        shift: String(row.turno || "Sin turno").trim().toLowerCase(),
        storeId: Number(row.tienda_id) || null,
        storeName: row.tienda_id ? String(incidentStoreById.get(Number(row.tienda_id))?.nombre || `Tienda ${row.tienda_id}`) : null,
        // Conserva todas las columnas de registro_errores para el detalle del
        // grafico, incluso si en el futuro se agregan campos al esquema.
        details: row,
        date: dashboardDate(row.fecha_error || row.created_at)
      })).filter((row) => row.date),
      warnings: visibleWarnings.map((row) => ({
        id: Number(row.id),
        workerId: Number(row.usuario_id),
        date: dashboardDate(row.fecha || row.created_at),
        documentType: String(row.tipo_documento || "").trim().toUpperCase()
      })).filter((row) => row.workerId && row.date),
      movements: visibleMovements.map((row) => ({
        id: Number(row.id), workerId: Number(row.usuario_id), type: String(row.tipo_movimiento || ""),
        reason: String(row.motivo || "Sin especificar"), date: dashboardDate(row.fecha_movimiento || row.created_at)
      })).filter((row) => row.date),
      trainings: trainings.map((row) => ({
        id: Number(row.id), code: String(row.id_curso || row.id),
        course: String(row.nombre_curso || row.curso || `Capacitacion ${row.id}`),
        competence: String(row.competencias || row.competencia || "General"),
        hours: row.numero_horas !== null && row.numero_horas !== undefined && Number.isFinite(Number(row.numero_horas))
          ? Number(row.numero_horas)
          : null
      })),
      trainingAssignments: visibleTrainingAssignments.map((row) => ({
        id: Number(row.id), workerId: Number(row.usuario_id),
        trainingId: Number(row.capacitacion_id || row.curso_id),
        state: String(row.estado || (row.completado ? "finalizado" : "pendiente")).toLowerCase(),
        date: dashboardDate(row.completado_en || row.created_at)
      })),
      payrollByRole: payroll.byRole,
      payrollByWorker: payroll.byWorker,
      payrollWorkersByMonth: payroll.workersByMonth,
      dataQuality: {
        activitiesWithoutStoredScore: [...visibleWorkerRecords, ...visibleLeaderRecords]
          .filter((row) => row.puntaje === null || row.puntaje === undefined).length
      }
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo cargar la informacion del dashboard." });
  }
}

// Una tarea es del registro por tiempo del líder de equipo segun su bandera en
// la tabla `tarea`, no por su nombre.
function isGroupLeaderTimeTask(task) {
  return getTaskFieldFlags(task).tiempo;
}

function normalizedBrandItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item) => {
    const marca_id = Number(item.marca_id);
    const cantidad = Number(item.cantidad);
    if (!marca_id || !Number.isFinite(cantidad) || cantidad <= 0) {
      throw new Error("Cada marca debe tener una cantidad mayor a cero.");
    }
    if (seen.has(marca_id)) throw new Error("No puedes repetir una marca en el mismo registro.");
    seen.add(marca_id);
    return { marca_id, cantidad };
  });
}

function normalizedGuideItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map((item) => {
    const numero_guia = String(item.numero_guia || "").trim();
    const cantidad = Number(item.cantidad);
    const tienda_id = Number(item.tienda_id);
    const detalle = String(item.detalle || "").trim() || null;
    if (!numero_guia || !Number.isFinite(cantidad) || cantidad <= 0 || !Number.isInteger(tienda_id) || tienda_id <= 0) {
      throw new Error("Cada guía debe tener un número y una cantidad mayor a cero.");
    }
    const normalizedNumber = normalizeRole(numero_guia);
    if (seen.has(normalizedNumber)) throw new Error("No puedes repetir un número de guía en el mismo registro.");
    seen.add(normalizedNumber);
    return { numero_guia, cantidad, tienda_id, detalle };
  });
}

async function attachBrandBreakdown(rows) {
  if (!rows.length) return rows;
  const brands = await selectBrands();
  const brandName = new Map(brands.map((brand) => [Number(brand.id), brand.nombre]));
  return rows.map((row) => ({
    ...row,
    marcas: row.marca_id
      ? [{
          marca_id: Number(row.marca_id),
          cantidad: nullableNumber(row.cantidad),
          marca_nombre: brandName.get(Number(row.marca_id)) || `Marca ${row.marca_id}`
        }]
      : []
  }));
}

async function selectTaskScoreRanges(taskId = null) {
  let query = supabase.from("reglas_puntaje").select("*").order("puntos", { ascending: true });
  if (taskId) query = query.eq("tarea_id", taskId);
  const result = await query;
  if (result.error) throw result.error;
  return result.data || [];
}

// Las actividades por tiempo que registra un líder de equipo a nombre de un
// operante viven en una tabla aparte. Se muestran en el historial del
// operante puntuadas con las mismas reglas de "Configuracion de puntajes"
// que usa cualquier otra tarea (segun cantidad); el tiempo registrado por el
// líder de equipo es solo informativo y no participa en el calculo.
async function selectGroupLeaderActivityLogsForWorker(workerId) {
  const result = await selectGroupLeaderRecordRows((query) =>
    query.eq("trabajador_id", workerId).order("created_at", { ascending: false })
  );
  if (result.error || !result.data?.length) return [];
  const rows = result.data;

  const tableName = await getTaskTableName();
  const taskIds = Array.from(new Set(rows.map((row) => Number(row.tarea_id)).filter(Boolean)));
  const encargadoIds = Array.from(new Set(rows.map((row) => Number(row.encargado_id)).filter(Boolean)));
  const brandIds = Array.from(new Set(rows.map((row) => Number(row.marca_id)).filter(Boolean)));
  const recordIds = Array.from(new Set(rows.map((row) => Number(row.id)).filter(Boolean)));
  const [tasksResult, rulesResult, leadersResult, brandsResult, liveActivitiesResult] = await Promise.all([
    taskIds.length ? supabase.from(tableName).select("*").in("id", taskIds) : Promise.resolve({ data: [] }),
    taskIds.length ? supabase.from("reglas_puntaje").select("*").in("tarea_id", taskIds) : Promise.resolve({ data: [] }),
    encargadoIds.length ? supabase.from("usuarios").select("id,nombre,email").in("id", encargadoIds) : Promise.resolve({ data: [] }),
    brandIds.length ? supabase.from("marcas").select("id,nombre").in("id", brandIds) : Promise.resolve({ data: [] }),
    recordIds.length
      ? supabase.from("actividades_jefe_equipo").select("id,registro_tarea_id,hora_inicio,hora_fin").in("registro_tarea_id", recordIds)
      : Promise.resolve({ data: [] })
  ]);
  const rulesByTaskId = new Map();
  (rulesResult.data || []).forEach((rule) => {
    const key = Number(rule.tarea_id);
    if (!rulesByTaskId.has(key)) rulesByTaskId.set(key, []);
    rulesByTaskId.get(key).push(rule);
  });
  const scoredTaskById = new Map(
    (tasksResult.data || []).map((task) => [Number(task.id), applyScoringRules(task, rulesByTaskId.get(Number(task.id)) || [])])
  );
  const leaderById = new Map((leadersResult.data || []).map((leader) => [Number(leader.id), leader]));
  const brandById = new Map((brandsResult.data || []).map((brand) => [Number(brand.id), brand]));
  if (liveActivitiesResult.error && !operationsSchemaMissing(liveActivitiesResult.error)) throw liveActivitiesResult.error;
  const liveActivityByRecordId = new Map((liveActivitiesResult.data || []).map((activity) => [Number(activity.registro_tarea_id), activity]));

  return rows.map((row) => {
    const leader = leaderById.get(Number(row.encargado_id));
    const task = scoredTaskById.get(Number(row.tarea_id));
    const brand = row.marca_id ? brandById.get(Number(row.marca_id)) : null;
    const liveActivity = liveActivityByRecordId.get(Number(row.id));
    // Se puntua con las reglas configuradas en el admin (por cantidad, fijo o
    // turno). El tiempo registrado es solo para seguimiento, no para puntaje.
    const storedPoints = row.puntaje === null || row.puntaje === undefined ? null : Number(row.puntaje);
    const puntosObtenidos = storedPoints ?? (task ? calculatePoints(task, row.cantidad, null, true) : null);
    return {
      id: `jefe-equipo-${row.id}`,
      trabajador_id: row.trabajador_id,
      usuario_id: row.trabajador_id,
      tarea_id: row.tarea_id,
      actividad_nombre: task ? taskTitle(task) : "",
      fecha_registro: row.fecha_registro,
      cantidad: row.cantidad,
      tiempo_minutos: row.tiempo_minutos,
      numero_guia: row.numero_guia,
      lote: row.lote,
      tienda_id: row.tienda_id,
      detalle: row.observacion,
      cumplimiento: true,
      puntaje: puntosObtenidos,
      marcas: brand ? [{ marca_id: brand.id, marca_nombre: brand.nombre, cantidad: nullableNumber(row.cantidad) }] : [],
      created_at: row.created_at,
      hora_inicio: row.hora_inicio || liveActivity?.hora_inicio || null,
      hora_fin: row.hora_fin || liveActivity?.hora_fin || null,
      origen: "jefe_equipo",
      encargado_id: row.encargado_id,
      encargado_nombre: leader?.nombre || leader?.email || `Usuario ${row.encargado_id}`
    };
  });
}

async function selectActivityLogs(workerId = null) {
  const resources = [
    // La tabla contiene los campos mas recientes (por ejemplo detalle_guia).
    // La vista antigua queda como respaldo para instalaciones heredadas.
    { table: "registros_tareas", userColumn: "usuario_id", orderColumn: "fecha_registro" },
    { table: "v_registro_actividades", userColumn: "usuario_id", orderColumn: "fecha_registro" }
  ];

  let lastError = null;
  for (const resource of resources) {
    const pageSize = 1000;
    const allRows = [];
    let resourceError = null;
    for (let from = 0; ; from += pageSize) {
      let query = supabase.from(resource.table).select("*");
      if (workerId) query = query.eq(resource.userColumn, workerId);
      query = query.order(resource.orderColumn, { ascending: false }).range(from, from + pageSize - 1);
      const result = await query;
      if (result.error) {
        resourceError = result.error;
        break;
      }
      const page = result.data || [];
      allRows.push(...page);
      if (page.length < pageSize) break;
    }

    if (!resourceError) {
      return attachBrandBreakdown(allRows.map(normalizeActivityLog));
    }
    lastError = resourceError;
  }

  throw lastError || new Error("No se pudieron leer los registros de actividades.");
}

async function handleReadUsers(_request, response) {
  try {
    if (!requireAdministrator(_request, response)) return;
    sendJson(response, 200, { users: await selectUsers() });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los usuarios." });
  }
}

// Historial completo de ingresos/salidas por trabajador, usado para detectar
// reingresos (mas de un "Ingreso") en el panel de Usuarios. selectUsers() solo
// trae el ultimo ingreso/salida de cada uno, no sirve para esto.
async function handleReadPersonnelMovements(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const [movementsResult, usersResult] = await Promise.all([
      supabase
        .from("movimientos_personal")
        .select("id,usuario_id,tipo_movimiento,fecha_movimiento,motivo")
        .order("usuario_id", { ascending: true })
        .order("fecha_movimiento", { ascending: true })
        .order("id", { ascending: true }),
      supabase.from("usuarios").select("id,nombre,email,rol,activo")
    ]);
    if (movementsResult.error) throw movementsResult.error;
    if (usersResult.error) throw usersResult.error;
    const userById = new Map((usersResult.data || []).map((user) => [Number(user.id), user]));
    const movements = (movementsResult.data || []).map((row) => {
      const user = userById.get(Number(row.usuario_id));
      return {
        id: Number(row.id),
        usuarioId: Number(row.usuario_id),
        workerName: user?.nombre || user?.email || `Usuario ${row.usuario_id}`,
        workerEmail: user?.email || null,
        workerRole: user?.rol || null,
        workerActive: user ? isActive(user.activo) : null,
        tipo: String(row.tipo_movimiento || "").trim(),
        fecha: row.fecha_movimiento,
        motivo: row.motivo || null
      };
    });
    sendJson(response, 200, { movements });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los movimientos de personal." });
  }
}

async function handleReadBrands(_request, response) {
  try {
    sendJson(response, 200, { brands: await selectBrands() });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las marcas." });
  }
}

async function handleCreateBrand(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = { nombre: String(body.nombre || "").trim() };
    if (!payload.nombre) {
      sendJson(response, 400, { error: "El nombre de la marca es obligatorio." });
      return;
    }
    let result = await supabase.from("marcas").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase.from("marcas").insert({ ...payload, id: await nextTableId("marcas") }).select("*").single();
    }
    if (result.error) {
      userMutationError(response, result.error, "No se pudo crear la marca.");
      return;
    }
    sendJson(response, 201, { brand: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la marca." });
  }
}

async function handleUpdateBrand(request, response, brandId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(brandId) || brandId <= 0) {
      sendJson(response, 400, { error: "Marca invalida." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    const nombre = body.nombre === undefined ? undefined : String(body.nombre).trim();
    if (nombre === undefined) {
      sendJson(response, 400, { error: "No hay cambios para guardar." });
      return;
    }
    if (!nombre) {
      sendJson(response, 400, { error: "El nombre de la marca es obligatorio." });
      return;
    }
    const result = await supabase.from("marcas").update({ nombre }).eq("id", brandId).select("*").maybeSingle();
    if (result.error) {
      userMutationError(response, result.error, "No se pudo actualizar la marca.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Marca no encontrada." });
      return;
    }
    sendJson(response, 200, { brand: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar la marca." });
  }
}

async function handleDeleteBrand(request, response, brandId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(brandId) || brandId <= 0) {
      sendJson(response, 400, { error: "Marca invalida." });
      return;
    }
    const result = await supabase.from("marcas").delete().eq("id", brandId).select("id").maybeSingle();
    if (result.error?.code === "23503") {
      sendJson(response, 409, { error: "No se puede eliminar la marca porque tiene lotes o registros relacionados." });
      return;
    }
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "Marca no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la marca." });
  }
}

async function handleReadTasks(_request, response) {
  try {
    sendJson(response, 200, { tasks: await selectTasks() });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las tareas." });
  }
}

async function handleCreateTask(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const tableName = await getTaskTableName();
    const payload = taskPayloadForDb(body, tableName);
    if (!String(payload.nombre || "").trim()) {
      sendJson(response, 400, { error: "El nombre de la tarea es obligatorio." });
      return;
    }

    let result = await supabase.from(tableName).insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from(tableName)
        .insert({ ...payload, id: await nextTableId(tableName) })
        .select("*")
        .single();
    }
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    sendJson(response, 201, { task: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la tarea." });
  }
}

async function handleUpdateTask(request, response, taskId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const tableName = await getTaskTableName();
    const payload = taskPayloadForDb(body, tableName);
    const result = await supabase.from(tableName).update(payload).eq("id", taskId).select("*").single();
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    sendJson(response, 200, { task: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar la tarea." });
  }
}

async function archiveTask(response, tableName, taskId) {
  const archived = await supabase
    .from(tableName)
    .update({ activo: false })
    .eq("id", taskId)
    .select("id")
    .maybeSingle();
  if (archived.error) throw archived.error;
  if (!archived.data) {
    sendJson(response, 404, { error: "Tarea no encontrada." });
    return false;
  }
  sendJson(response, 200, { deleted: false, archived: true });
  return true;
}

async function handleDeleteTask(request, response, taskId) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(taskId) || taskId <= 0) {
      sendJson(response, 400, { error: "Tarea invalida." });
      return;
    }

    const tableName = await getTaskTableName();
    const existing = await supabase.from(tableName).select("id").eq("id", taskId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) {
      sendJson(response, 404, { error: "Tarea no encontrada." });
      return;
    }

    const historyResults = await Promise.all([
      supabase.from("registros_tareas").select("id", { count: "exact", head: true }).eq("tarea_id", taskId),
      supabase.from("registros_tareas_jefe_equipo").select("id", { count: "exact", head: true }).eq("tarea_id", taskId)
    ]);
    const historyError = historyResults.find((result) => result.error)?.error;
    if (historyError) throw historyError;
    if (historyResults.some((result) => Number(result.count || 0) > 0)) {
      await archiveTask(response, tableName, taskId);
      return;
    }

    const previousRules = await selectTaskScoreRanges(taskId);
    const deleteRules = await supabase.from("reglas_puntaje").delete().eq("tarea_id", taskId);
    if (deleteRules.error) throw deleteRules.error;

    const result = await supabase.from(tableName).delete().eq("id", taskId).select("id").maybeSingle();
    if (result.error) {
      if (previousRules.length) await supabase.from("reglas_puntaje").insert(previousRules);
      if (result.error.code === "23503") {
        await archiveTask(response, tableName, taskId);
        return;
      }
      throw result.error;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Tarea no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la tarea." });
  }
}

async function handleReadTaskScoreRanges(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const taskId = url.searchParams.get("taskId");
    const rules = await selectTaskScoreRanges(taskId);
    sendJson(response, 200, { rules, ranges: rules });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los rangos." });
  }
}

async function handleReplaceTaskScoreRanges(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const taskId = Number(body.taskId || body.tarea_id);
    const rules = Array.isArray(body.rules) ? body.rules : Array.isArray(body.ranges) ? body.ranges : [];
    if (!taskId) {
      sendJson(response, 400, { error: "La tarea es obligatoria." });
      return;
    }

    const normalized = rules.map((item) => ({
      tarea_id: taskId,
      tipo_regla: String(item.tipo_regla || "CANTIDAD").trim().toUpperCase(),
      desde: nullableNumber(item.desde ?? item.cantidad_desde),
      hasta: nullableNumber(item.hasta ?? item.cantidad_hasta),
      turno: item.turno ? String(item.turno).trim() : null,
      puntos: nullableNumber(item.puntos)
    }));
    const invalid = normalized.find((rule) => (
      !["CANTIDAD", "FIJO", "TURNO"].includes(rule.tipo_regla) ||
      !Number.isInteger(rule.puntos) || rule.puntos < 1 || rule.puntos > 10 ||
      (rule.tipo_regla === "CANTIDAD" && (
        rule.desde === null || rule.desde < 0 || rule.desde > MAX_SCORE_QUANTITY
      )) ||
      (rule.hasta !== null && (
        rule.desde === null || rule.hasta < rule.desde || rule.hasta > MAX_SCORE_QUANTITY
      ))
    ));
    if (invalid) {
      sendJson(response, 400, {
        error: "Hay una regla invalida. Los rangos deben estar entre 0 y 99,999,999.99 y el puntaje entre 1 y 10."
      });
      return;
    }

    const quantityRules = normalized
      .filter((rule) => rule.tipo_regla === "CANTIDAD")
      .sort((a, b) => a.puntos - b.puntos);
    if (quantityRules.length && (quantityRules.length !== 10 || quantityRules.at(-1)?.puntos !== 10 || quantityRules.at(-1)?.hasta !== null)) {
      sendJson(response, 400, { error: "Las tareas por cantidad necesitan 10 rangos y el rango de 10 puntos debe quedar sin límite final." });
      return;
    }

    const previousRules = await selectTaskScoreRanges(taskId);
    const deleteResult = await supabase.from("reglas_puntaje").delete().eq("tarea_id", taskId);
    if (deleteResult.error) {
      sendJson(response, 500, { error: deleteResult.error.message });
      return;
    }

    if (normalized.length) {
      let insertResult = await supabase.from("reglas_puntaje").insert(normalized);
      if (isPrimaryKeySequenceConflict(insertResult.error)) {
        const firstId = await nextTableId("reglas_puntaje");
        insertResult = await supabase.from("reglas_puntaje").insert(
          normalized.map((rule, index) => ({ ...rule, id: firstId + index }))
        );
      }
      if (insertResult.error) {
        const rollback = previousRules.map(({ id: _id, ...rule }) => rule);
        if (rollback.length) await supabase.from("reglas_puntaje").insert(rollback);
        sendJson(response, 500, { error: insertResult.error.message });
        return;
      }
    }

    const savedRules = await selectTaskScoreRanges(taskId);
    sendJson(response, 200, { rules: savedRules, ranges: savedRules });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron guardar los rangos." });
  }
}

async function handleDeleteTaskScoreRanges(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const taskId = Number(url.searchParams.get("taskId"));
    if (!taskId) {
      sendJson(response, 400, { error: "La tarea es obligatoria." });
      return;
    }
    const result = await supabase.from("reglas_puntaje").delete().eq("tarea_id", taskId);
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron eliminar los rangos." });
  }
}

async function handleReadStores(request, response) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "operante", "lider de equipo", "otros"])) return;
    const result = await supabase.from("tiendas").select("*").order("id", { ascending: true });
    if (result.error) throw result.error;
    sendJson(response, 200, { stores: result.data || [] });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las tiendas." });
  }
}

async function handleCreateStore(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = { nombre: String(body.nombre || "").trim(), activo: body.activo !== false };
    if (!payload.nombre) {
      sendJson(response, 400, { error: "El nombre de la tienda es obligatorio." });
      return;
    }
    let result = await supabase.from("tiendas").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase.from("tiendas").insert({ ...payload, id: await nextTableId("tiendas") }).select("*").single();
    }
    if (result.error) {
      userMutationError(response, result.error, "No se pudo crear la tienda.");
      return;
    }
    sendJson(response, 201, { store: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la tienda." });
  }
}

async function handleUpdateStore(request, response, storeId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = {};
    if (body.nombre !== undefined) payload.nombre = String(body.nombre).trim();
    if (body.activo !== undefined) payload.activo = Boolean(body.activo);
    if (payload.nombre === "") {
      sendJson(response, 400, { error: "El nombre de la tienda es obligatorio." });
      return;
    }
    const result = await supabase.from("tiendas").update(payload).eq("id", storeId).select("*").maybeSingle();
    if (result.error) {
      userMutationError(response, result.error, "No se pudo actualizar la tienda.");
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Tienda no encontrada." });
      return;
    }
    sendJson(response, 200, { store: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar la tienda." });
  }
}

async function handleDeleteStore(request, response, storeId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const result = await supabase.from("tiendas").delete().eq("id", storeId).select("id").maybeSingle();
    if (result.error?.code === "23503") {
      const archived = await supabase.from("tiendas").update({ activo: false }).eq("id", storeId).select("id").maybeSingle();
      if (archived.error) throw archived.error;
      sendJson(response, 200, { deleted: false, archived: true });
      return;
    }
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "Tienda no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true, archived: false });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la tienda." });
  }
}

const LOTE_SELECT_COLUMNS = "id,codigo_lote,cantidad_lote,marca_id,fecha_ingreso,fecha_trabajo,fecha_fin_clasificado,fecha_inicio_etiquetado,proveedor,usuario_id,estado,fecha_completada,es_general";
const LOTE_ESTADOS = ["pendiente", "en_curso", "completado"];

async function enrichLotes(rows) {
  const marcaIds = Array.from(new Set(rows.map((row) => Number(row.marca_id)).filter(Boolean)));
  const usuarioIds = Array.from(new Set(rows.map((row) => Number(row.usuario_id)).filter(Boolean)));
  const [brandsResult, usersResult] = await Promise.all([
    marcaIds.length ? supabase.from("marcas").select("id,nombre").in("id", marcaIds) : Promise.resolve({ data: [] }),
    usuarioIds.length ? supabase.from("usuarios").select("id,nombre,email").in("id", usuarioIds) : Promise.resolve({ data: [] })
  ]);
  if (brandsResult.error) throw brandsResult.error;
  if (usersResult.error) throw usersResult.error;
  const brandById = new Map((brandsResult.data || []).map((brand) => [Number(brand.id), brand.nombre]));
  const userById = new Map((usersResult.data || []).map((user) => [Number(user.id), user.nombre || user.email]));
  return rows.map((row) => ({
    ...row,
    marca_nombre: brandById.get(Number(row.marca_id)) || `Marca ${row.marca_id}`,
    usuario_nombre: row.usuario_id ? userById.get(Number(row.usuario_id)) || `Usuario ${row.usuario_id}` : null
  }));
}

async function handleReadGeneralLoteAccumulations(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const allRecords = await selectAllDashboardRows("registros_tareas", { optional: true });
    const records = allRecords.filter((row) => isGeneralLoteCode(row.dato_extra || row.lote));
    const userIds = [...new Set(records.map((row) => Number(row.usuario_id || row.trabajador_id)).filter(Boolean))];
    const taskIds = [...new Set(records.map((row) => Number(row.tarea_id)).filter(Boolean))];
    const taskTable = await getTaskTableName();
    const [usersResult, tasksResult] = await Promise.all([
      userIds.length ? supabase.from("usuarios").select("id,nombre,email").in("id", userIds) : Promise.resolve({ data: [] }),
      taskIds.length ? supabase.from(taskTable).select("*").in("id", taskIds) : Promise.resolve({ data: [] })
    ]);
    if (usersResult.error) throw usersResult.error;
    if (tasksResult.error) throw tasksResult.error;
    const users = new Map((usersResult.data || []).map((item) => [Number(item.id), item.nombre || item.email]));
    const tasks = new Map((tasksResult.data || []).map((item) => [Number(item.id), taskTitle(item)]));
    const grouped = new Map();
    records.forEach((record) => {
      const workerId = Number(record.usuario_id || record.trabajador_id);
      const taskId = Number(record.tarea_id);
      if (!workerId || !taskId) return;
      const key = `${workerId}:${taskId}`;
      const date = String(record.fecha_registro || record.created_at || "");
      const current = grouped.get(key) || {
        trabajador_id: workerId,
        trabajador_nombre: users.get(workerId) || `Usuario ${workerId}`,
        tarea_id: taskId,
        tarea_nombre: tasks.get(taskId) || `Tarea ${taskId}`,
        cantidad_acumulada: 0,
        registros: 0,
        ultima_fecha: ""
      };
      current.cantidad_acumulada += Number(record.cantidad || 0);
      current.registros += 1;
      if (date > current.ultima_fecha) current.ultima_fecha = date;
      grouped.set(key, current);
    });
    const acumulados = [...grouped.values()].sort((a, b) => (
      b.cantidad_acumulada - a.cantidad_acumulada || a.trabajador_nombre.localeCompare(b.trabajador_nombre)
    ));
    response.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    sendJson(response, 200, {
      codigo_lote: LOTE_GENERAL_CODE,
      cantidad_total: acumulados.reduce((total, item) => total + item.cantidad_acumulada, 0),
      acumulados
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo cargar el acumulado del Lote general." });
  }
}

async function handleReadLotes(request, response) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "operante", "lider de equipo", "otros"])) return;
    response.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    const result = await supabase.from("lotes").select(LOTE_SELECT_COLUMNS).order("id", { ascending: false });
    if (result.error) throw result.error;
    sendJson(response, 200, { lotes: await enrichLotes(result.data || []) });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los lotes." });
  }
}

function invalidLote(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateLotePayload(body) {
  const codigoLote = String(body.codigo_lote || "").trim().toUpperCase();
  const proveedor = String(body.proveedor || "").trim();
  const cantidadLote = Number(body.cantidad_lote);
  const marcaId = Number(body.marca_id);
  const fechaIngreso = String(body.fecha_ingreso || "").trim();
  const fechaTrabajo = String(body.fecha_trabajo || "").trim();
  const fechaFinClasificado = String(body.fecha_fin_clasificado || "").trim();
  const fechaInicioEtiquetado = String(body.fecha_inicio_etiquetado || "").trim();
  const fechaCompletada = String(body.fecha_completada || "").trim();
  const usuarioId = Number(body.usuario_id);
  const estado = String(body.estado || "pendiente").trim().toLowerCase();
  if (!codigoLote) throw invalidLote("El codigo de lote es obligatorio.");
  if (isGeneralLoteCode(codigoLote)) throw invalidLote("El codigo LOTE GENERAL esta reservado por el sistema.");
  if (!Number.isInteger(cantidadLote) || cantidadLote < 0) {
    throw invalidLote("La cantidad del lote debe ser un numero entero mayor o igual a cero.");
  }
  if (!Number.isInteger(marcaId) || marcaId <= 0) throw invalidLote("Selecciona una marca.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaIngreso)) throw invalidLote("Selecciona una fecha de ingreso valida.");
  if (fechaTrabajo && !/^\d{4}-\d{2}-\d{2}$/.test(fechaTrabajo)) throw invalidLote("Selecciona una fecha de inicio de clasificado valida.");
  if (fechaFinClasificado && !/^\d{4}-\d{2}-\d{2}$/.test(fechaFinClasificado)) throw invalidLote("Selecciona una fecha de fin de clasificado valida.");
  if (fechaInicioEtiquetado && !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicioEtiquetado)) throw invalidLote("Selecciona una fecha de inicio de etiquetado valida.");
  if (fechaCompletada && !/^\d{4}-\d{2}-\d{2}$/.test(fechaCompletada)) throw invalidLote("Selecciona una fecha completada de etiquetado valida.");
  if (fechaFinClasificado && !fechaTrabajo) throw invalidLote("Primero ingresa la fecha de inicio de clasificado.");
  if (fechaInicioEtiquetado && !fechaFinClasificado) throw invalidLote("Primero ingresa la fecha de fin de clasificado.");
  if (fechaCompletada && !fechaInicioEtiquetado) throw invalidLote("Primero ingresa la fecha de inicio de etiquetado.");
  if (fechaTrabajo && fechaFinClasificado && fechaFinClasificado < fechaTrabajo) {
    throw invalidLote("La fecha de fin de clasificado no puede ser anterior a su fecha de inicio.");
  }
  if (fechaFinClasificado && fechaInicioEtiquetado && fechaInicioEtiquetado < fechaFinClasificado) {
    throw invalidLote("La fecha de inicio de etiquetado no puede ser anterior al fin de clasificado.");
  }
  if (fechaInicioEtiquetado && fechaCompletada && fechaCompletada < fechaInicioEtiquetado) {
    throw invalidLote("La fecha completada de etiquetado no puede ser anterior a su fecha de inicio.");
  }
  if (!proveedor) throw invalidLote("El proveedor es obligatorio.");
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) throw invalidLote("Selecciona el líder de equipo responsable del lote.");
  if (!LOTE_ESTADOS.includes(estado)) throw invalidLote("El estado del lote no es valido.");
  if (estado === "completado" && (!fechaTrabajo || !fechaFinClasificado || !fechaInicioEtiquetado || !fechaCompletada)) {
    throw invalidLote("Completa todas las fechas del proceso antes de marcar el lote como Completado.");
  }
  const resolvedEstado = !fechaTrabajo ? "pendiente" : estado === "completado" ? "completado" : "en_curso";
  return {
    codigo_lote: codigoLote,
    cantidad_lote: cantidadLote,
    marca_id: marcaId,
    fecha_ingreso: fechaIngreso,
    fecha_trabajo: fechaTrabajo || null,
    fecha_fin_clasificado: fechaFinClasificado || null,
    fecha_inicio_etiquetado: fechaInicioEtiquetado || null,
    fecha_completada: fechaCompletada || null,
    proveedor,
    usuario_id: usuarioId,
    estado: resolvedEstado
  };
}

async function validateLoteResponsible(usuarioId) {
  const result = await supabase.from("usuarios").select("id,rol,activo").eq("id", usuarioId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data || normalizeRole(result.data.rol) !== "lider de equipo" || !isActive(result.data.activo)) {
    throw invalidLote("Selecciona un líder de equipo activo y valido.");
  }
}

async function handleCreateLote(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = validateLotePayload(body);
    const brandResult = await supabase.from("marcas").select("id").eq("id", payload.marca_id).maybeSingle();
    if (brandResult.error) throw brandResult.error;
    if (!brandResult.data) {
      sendJson(response, 400, { error: "Selecciona una marca valida." });
      return;
    }
    await validateLoteResponsible(payload.usuario_id);
    let result = await supabase.from("lotes").insert(payload).select(LOTE_SELECT_COLUMNS).single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("lotes")
        .insert({ ...payload, id: await nextTableId("lotes") })
        .select(LOTE_SELECT_COLUMNS)
        .single();
    }
    if (result.error) {
      sendJson(response, result.error.code === "23514" ? 400 : 500, {
        error: result.error.code === "23514" ? "La cantidad del lote no puede ser negativa." : result.error.message || "No se pudo crear el lote."
      });
      return;
    }
    const [lote] = await enrichLotes([result.data]);
    sendJson(response, 201, { lote });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "No se pudo crear el lote." });
  }
}

async function handleUpdateLote(request, response, loteId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const currentResult = await supabase.from("lotes").select("id,es_general").eq("id", loteId).maybeSingle();
    if (currentResult.error) throw currentResult.error;
    if (currentResult.data?.es_general) {
      sendJson(response, 403, { error: "El Lote general es administrado por el sistema y no se puede editar." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    const payload = validateLotePayload(body);
    const brandResult = await supabase.from("marcas").select("id").eq("id", payload.marca_id).maybeSingle();
    if (brandResult.error) throw brandResult.error;
    if (!brandResult.data) {
      sendJson(response, 400, { error: "Selecciona una marca valida." });
      return;
    }
    await validateLoteResponsible(payload.usuario_id);
    const result = await supabase.from("lotes").update(payload).eq("id", loteId).select(LOTE_SELECT_COLUMNS).maybeSingle();
    if (result.error) {
      sendJson(response, result.error.code === "23514" ? 400 : 500, {
        error: result.error.code === "23514" ? "La cantidad del lote no puede ser negativa." : result.error.message || "No se pudo actualizar el lote."
      });
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Lote no encontrado." });
      return;
    }
    const [lote] = await enrichLotes([result.data]);
    sendJson(response, 200, { lote });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "No se pudo actualizar el lote." });
  }
}

async function handleDeleteLote(request, response, loteId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const currentResult = await supabase.from("lotes").select("id,es_general").eq("id", loteId).maybeSingle();
    if (currentResult.error) throw currentResult.error;
    if (currentResult.data?.es_general) {
      sendJson(response, 403, { error: "El Lote general no se puede eliminar." });
      return;
    }
    const result = await supabase.from("lotes").delete().eq("id", loteId).select("id").maybeSingle();
    if (result.error?.code === "23503") {
      sendJson(response, 409, { error: "No se puede eliminar: hay registros relacionados con este lote." });
      return;
    }
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "Lote no encontrado." });
      return;
    }
    sendJson(response, 200, { deleted: true });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar el lote." });
  }
}

async function handleReadGuias(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    // PostgREST solo devuelve 1000 filas por consulta si no se pagina: con
    // varios meses importados "guias" ya supera eso, y un select plano corta
    // en silencio los registros mas antiguos (asi desaparecia enero al
    // importar meses despues). selectAllDashboardRows pagina con .range()
    // hasta traer todo.
    const rows = await selectAllDashboardRows("guias");
    const guias = rows
      .map((row) => ({ id: row.id, codigo: row.codigo, fecha: row.fecha, archivo_origen: row.archivo_origen, cantidad: row.cantidad }))
      .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    sendJson(response, 200, { guias });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las guias." });
  }
}

// El Excel origen llama "SERIE" a esta columna, pero el dato que trae es una
// cantidad. Se guarda sumada en "guias.cantidad" (en vez de recalcularla en
// cada lectura) y se recalcula solo para los codigos de guia que acaban de
// recibir lineas nuevas.
async function recomputeGuiasCantidad(codigosGuia) {
  if (!codigosGuia.length) return;

  // PostgREST tope de 1000 filas por consulta si no se pagina: con guias de
  // ~20 lineas cada una, un lote de codigos puede superarlo. Se pagina con
  // .range() para no cortar lineas y sumar mal la cantidad.
  const pageSize = 1000;
  const items = [];
  for (let from = 0; ; from += pageSize) {
    const itemsResult = await supabase
      .from("guias_items")
      .select("codigo_guia,cantidad")
      .in("codigo_guia", codigosGuia)
      .range(from, from + pageSize - 1);
    if (itemsResult.error) throw itemsResult.error;
    const page = itemsResult.data || [];
    items.push(...page);
    if (page.length < pageSize) break;
  }

  const sums = new Map();
  for (const item of items) {
    const cantidad = Number(item.cantidad);
    sums.set(item.codigo_guia, (sums.get(item.codigo_guia) || 0) + (Number.isFinite(cantidad) ? cantidad : 0));
  }

  // Antes se hacia un UPDATE por codigo en paralelo (Promise.all) sin
  // revisar si alguno fallaba: con archivos grandes (miles de codigos,
  // cientos de lotes) algunas de esas llamadas fallaban en silencio y la
  // guia se quedaba con cantidad en 0 sin que nadie se enterara. Ahora es
  // un solo upsert con todos los codigos del lote, y si falla se propaga el
  // error en vez de tragarselo.
  const guiasResult = await supabase.from("guias").select("codigo,fecha").in("codigo", codigosGuia);
  if (guiasResult.error) throw guiasResult.error;
  const updates = (guiasResult.data || []).map((guia) => ({
    codigo: guia.codigo,
    fecha: guia.fecha,
    cantidad: sums.get(guia.codigo) || 0
  }));
  if (!updates.length) return;
  const updateResult = await supabase.from("guias").upsert(updates, { onConflict: "codigo" });
  if (updateResult.error) throw updateResult.error;
}

async function handleImportGuias(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const archivo = body.archivo ? String(body.archivo).trim().slice(0, 200) || null : null;
    const rawEntries = Array.isArray(body.entries) ? body.entries : null;
    const rawItems = Array.isArray(body.items) ? body.items : null;

    if (rawEntries) {
      const seen = new Set();
      const rows = [];
      for (const entry of rawEntries) {
        const codigo = String(entry?.codigo || "").trim();
        const fecha = String(entry?.fecha || "").trim();
        if (!codigo || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || seen.has(codigo)) continue;
        seen.add(codigo);
        const cantidad = Number(entry?.cantidad);
        rows.push({ codigo, fecha, archivo_origen: archivo, cantidad: Number.isFinite(cantidad) ? cantidad : 0 });
      }
      if (!rows.length) {
        sendJson(response, 400, { error: "No se encontraron guias validas para importar. Revisa que el archivo tenga las columnas ESTADO y TDA ORIGEN." });
        return;
      }
      const result = await supabase
        .from("guias")
        .upsert(rows, { onConflict: "codigo", ignoreDuplicates: true })
        .select("id");
      if (result.error) throw result.error;
      const imported = (result.data || []).length;
      sendJson(response, 200, { imported, omitted: rows.length - imported, total: rows.length });
      return;
    }

    if (rawItems) {
      const seen = new Set();
      const rows = [];
      for (const item of rawItems) {
        const codigoGuia = String(item?.codigoGuia || "").trim();
        const codigoItem = String(item?.codigoItem || "").trim();
        const fecha = String(item?.fecha || "").trim();
        const key = `${codigoGuia}::${codigoItem}`;
        if (!codigoGuia || !codigoItem || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || seen.has(key)) continue;
        seen.add(key);
        const cantidad = Number(item?.cantidad);
        rows.push({ codigo_guia: codigoGuia, codigo_item: codigoItem, fecha, cantidad: Number.isFinite(cantidad) ? cantidad : 0, archivo_origen: archivo });
      }
      if (!rows.length) {
        sendJson(response, 400, { error: "No se encontraron lineas de detalle validas para importar." });
        return;
      }
      const result = await supabase
        .from("guias_items")
        .upsert(rows, { onConflict: "codigo_guia,codigo_item", ignoreDuplicates: true })
        .select("id");
      if (result.error) throw result.error;
      const imported = (result.data || []).length;

      await recomputeGuiasCantidad(Array.from(new Set(rows.map((row) => row.codigo_guia))));

      sendJson(response, 200, { imported, omitted: rows.length - imported, total: rows.length });
      return;
    }

    sendJson(response, 400, { error: "Envia 'entries' (guias) o 'items' (detalle) para importar." });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "No se pudieron importar las guias." });
  }
}

async function handleReadGuiaItems(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const anio = Number(url.searchParams.get("anio"));
    const mes = Number(url.searchParams.get("mes"));
    if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      sendJson(response, 400, { error: "Indica un año y mes validos para exportar." });
      return;
    }
    const desde = `${anio}-${String(mes).padStart(2, "0")}-01`;
    const hastaMes = mes === 12 ? 1 : mes + 1;
    const hastaAnio = mes === 12 ? anio + 1 : anio;
    const hasta = `${hastaAnio}-${String(hastaMes).padStart(2, "0")}-01`;

    // Paginado con .range() por el mismo motivo que handleReadGuias: un mes
    // con muchas guias podria superar el tope de 1000 filas por consulta.
    const pageSize = 1000;
    const guiasDelMes = [];
    for (let from = 0; ; from += pageSize) {
      const result = await supabase
        .from("guias")
        .select("codigo,fecha,cantidad")
        .gte("fecha", desde)
        .lt("fecha", hasta)
        .order("fecha", { ascending: true })
        .order("codigo", { ascending: true })
        .range(from, from + pageSize - 1);
      if (result.error) throw result.error;
      const page = result.data || [];
      guiasDelMes.push(...page);
      if (page.length < pageSize) break;
    }

    const items = guiasDelMes.map((guia) => ({
      Estado: guia.fecha,
      Guia: guia.codigo,
      Cantidad: Number(guia.cantidad || 0)
    }));
    sendJson(response, 200, { items });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo exportar el detalle de guias." });
  }
}

const LOG_ASISTENCIAS_OPERACIONES = ["INSERT", "UPDATE", "DELETE"];

async function handleReadLogAsistencias(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const operacion = String(url.searchParams.get("operacion") || "").trim().toUpperCase();
    const desde = String(url.searchParams.get("desde") || "").trim();
    const hasta = String(url.searchParams.get("hasta") || "").trim();

    // Igual que listAttendances(): trae todo el historial filtrado y la
    // paginacion la resuelve la tabla en el cliente (DataTable pageSize=15).
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      let query = supabase.from("log_asistencias").select("*");
      if (LOG_ASISTENCIAS_OPERACIONES.includes(operacion)) query = query.eq("operacion", operacion);
      if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) query = query.gte("registrado_en", `${desde}T00:00:00`);
      if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) query = query.lte("registrado_en", `${hasta}T23:59:59`);
      const result = await query.order("registrado_en", { ascending: false }).range(from, from + pageSize - 1);
      if (result.error) throw result.error;
      const page = result.data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
    }

    const usuarioIds = new Set();
    rows.forEach((row) => {
      const uid = Number(row.datos_nuevos?.usuario_id ?? row.datos_anteriores?.usuario_id);
      if (Number.isInteger(uid) && uid > 0) usuarioIds.add(uid);
      const registradorId = Number(row.registrado_por_id);
      if (Number.isInteger(registradorId) && registradorId > 0) usuarioIds.add(registradorId);
    });
    let usersById = new Map();
    if (usuarioIds.size) {
      const usersResult = await supabase.from("usuarios").select("id,nombre,email").in("id", [...usuarioIds]);
      if (usersResult.error) throw usersResult.error;
      usersById = new Map((usersResult.data || []).map((user) => [Number(user.id), user.nombre || user.email]));
    }

    sendJson(response, 200, {
      rows: rows.map((row) => {
        const uid = Number(row.datos_nuevos?.usuario_id ?? row.datos_anteriores?.usuario_id) || null;
        const registradorId = Number(row.registrado_por_id) || null;
        return {
          id: Number(row.id),
          asistenciaId: Number(row.asistencia_id) || null,
          operacion: String(row.operacion || ""),
          workerName: uid ? usersById.get(uid) || `Usuario ${uid}` : null,
          registradoPorName: registradorId ? usersById.get(registradorId) || `Usuario ${registradorId}` : null,
          registradoEn: row.registrado_en || null
        };
      })
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo cargar el historial de asistencias." });
  }
}

async function handleReadAmonestaciones(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const [warningsResult, usersResult] = await Promise.all([
      supabase.from("amonestaciones").select("*").order("created_at", { ascending: false }),
      supabase.from("usuarios").select("id,rol")
    ]);
    if (warningsResult.error || usersResult.error) throw warningsResult.error || usersResult.error;
    const allowedUserIds = new Set(
      (usersResult.data || [])
        .filter((user) => normalizeRole(user.rol) !== "administrador")
        .map((user) => Number(user.id))
    );
    sendJson(response, 200, {
      amonestaciones: (warningsResult.data || []).filter((warning) => allowedUserIds.has(Number(warning.usuario_id)))
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las amonestaciones." });
  }
}

async function handleCreateAmonestacion(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const usuarioId = Number(body.usuario_id);
    const descripcion = String(body.descripcion || "").trim();
    const tipoDocumento = normalizeTipoDocumento(body.tipo_documento);
    const fecha = String(body.fecha || "").trim();

    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      sendJson(response, 400, { error: "Selecciona un usuario valido." });
      return;
    }
    if (!descripcion) {
      sendJson(response, 400, { error: "La descripcion de la amonestacion es obligatoria." });
      return;
    }
    if (!tipoDocumento) {
      sendJson(response, 400, { error: "Selecciona el tipo de documento: carta de amonestacion, memorandum o verbal." });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      sendJson(response, 400, { error: "Selecciona una fecha valida." });
      return;
    }
    if (fecha > currentLimaDate()) {
      sendJson(response, 400, { error: "La fecha no puede ser posterior a hoy." });
      return;
    }

    const userResult = await supabase.from("usuarios").select("id,activo,rol").eq("id", usuarioId).maybeSingle();
    if (userResult.error) throw userResult.error;
    if (!userResult.data || !isActive(userResult.data.activo)) {
      sendJson(response, 400, { error: "Selecciona un usuario activo." });
      return;
    }
    if (normalizeRole(userResult.data.rol) === "administrador") {
      sendJson(response, 400, { error: "El administrador no participa en las listas operativas." });
      return;
    }

    const payload = {
      usuario_id: usuarioId,
      descripcion,
      tipo_documento: tipoDocumento,
      fecha,
      created_by: session?.id ? Number(session.id) : null
    };
    let result = await supabase.from("amonestaciones").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("amonestaciones")
        .insert({ ...payload, id: await nextTableId("amonestaciones") })
        .select("*")
        .single();
    }
    if (result.error) {
      userMutationError(response, result.error, "No se pudo crear la amonestacion.");
      return;
    }
    sendJson(response, 201, { amonestacion: result.data });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo crear la amonestacion." });
  }
}

async function handleDeleteAmonestacion(request, response, amonestacionId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const result = await supabase.from("amonestaciones").delete().eq("id", amonestacionId).select("id").maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "Amonestacion no encontrada." });
      return;
    }
    sendJson(response, 200, { deleted: true });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar la amonestacion." });
  }
}

async function selectAttendanceCatalog() {
  const result = await supabase.from("dato_asistencia").select("estado,nombre,sigla");
  if (result.error) throw result.error;
  return new Map((result.data || []).map((item) => [item.estado, item]));
}

async function handleReadAttendances(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const date = url.searchParams.get("date");
    const [rows, catalog] = await Promise.all([
      date
        ? supabase.from("asistencias").select("*").eq("fecha", date).then((result) => {
          if (result.error) throw result.error;
          return result.data || [];
        })
        : selectAllDashboardRows("asistencias"),
      selectAttendanceCatalog()
    ]);
    rows.sort((left, right) => {
      const byDate = String(right.fecha || "").localeCompare(String(left.fecha || ""));
      if (byDate) return byDate;
      const byCreatedAt = String(right.created_at || "").localeCompare(String(left.created_at || ""));
      return byCreatedAt || Number(right.id || 0) - Number(left.id || 0);
    });
    // La sigla se saca del catalogo dato_asistencia en vez de repetirla en
    // cada fila o en el codigo del cliente.
    const attendances = rows.map((row) => ({
      ...row,
      sigla: catalog.get(row.estado)?.sigla || "",
      estado_nombre: catalog.get(row.estado)?.nombre || row.estado
    }));
    sendJson(response, 200, { attendances });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo cargar la asistencia." });
  }
}

const ATTENDANCE_STATES = new Set(["FALTA", "ASISTENCIA", "TARDANZA", "MEDIO_TURNO", "APOYO", "PERMISO", "DESCANSO_MEDICO", "SUSPENSION"]);
const ATTENDANCE_PRESENT_STATES = new Set(["ASISTENCIA", "TARDANZA", "MEDIO_TURNO", "APOYO"]);
const ATTENDANCE_RETIRO_TYPES = new Set(["personal", "apoyo"]);
const ATTENDANCE_TIME_ZONE = "America/Lima";

function currentAttendanceMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ATTENDANCE_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function attendanceCutoffMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function currentLimaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function operationsSchemaMissing(error) {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST203", "PGRST204", "PGRST205"].includes(error?.code);
}

function handleOperationsError(response, error, fallback) {
  if (operationsSchemaMissing(error)) {
    sendJson(response, 503, {
      code: "OPERATIONS_MIGRATION_REQUIRED",
      error: "Falta ejecutar sql/026_asistencia_retiro_y_actividades_en_curso.sql en Supabase."
    });
    return;
  }
  const statusByCode = {
    "23514": 409,
    "23P01": 409,
    "42501": 403,
    P0002: 404,
    "22P02": 400,
    "23503": 400
  };
  if (statusByCode[error?.code]) {
    sendJson(response, statusByCode[error.code], { error: error?.message || fallback });
    return;
  }
  sendJson(response, 500, { error: error?.message || fallback });
}

async function handleMarkAttendance(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const userId = Number(body.usuario_id);
    const date = String(body.fecha || "").trim();
    if (!Number.isInteger(userId) || userId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(response, 400, { error: "Usuario y fecha de asistencia son obligatorios." });
      return;
    }
    let estado = String(body.estado || "").trim().toUpperCase();
    if (!estado && body.presente !== undefined) {
      if (body.presente === false) {
        estado = "FALTA";
      } else {
        const cutoffMinutes = attendanceCutoffMinutes(body.hora_limite);
        if (cutoffMinutes === null) {
          sendJson(response, 400, { error: "Selecciona una hora limite valida para marcar la asistencia." });
          return;
        }
        estado = currentAttendanceMinutes() <= cutoffMinutes ? "ASISTENCIA" : "TARDANZA";
      }
    }
    if (!ATTENDANCE_STATES.has(estado)) {
      sendJson(response, 400, { error: "El estado de asistencia seleccionado no es valido." });
      return;
    }
    const present = ATTENDANCE_PRESENT_STATES.has(estado);
    const hasWithdrawalFields = "retiro_anticipado" in body || "motivo_retiro" in body || "retirado_en" in body;
    const requestedEarlyExit = Boolean(body.retiro_anticipado);
    const earlyExitReason = String(body.motivo_retiro || "").trim();
    // "personal" por defecto para no romper clientes viejos que no mandan
    // tipo_retiro; "apoyo" es cuando lo llaman a apoyar a otra area/tienda
    // durante su turno normal.
    const requestedRetiroType = ATTENDANCE_RETIRO_TYPES.has(String(body.tipo_retiro || "").trim().toLowerCase())
      ? String(body.tipo_retiro).trim().toLowerCase()
      : "personal";
    if (hasWithdrawalFields && date !== currentLimaDate()) {
      sendJson(response, 409, { error: "El retiro anticipado solo puede editarse para la asistencia del dia de hoy." });
      return;
    }
    if (earlyExitReason.length > 500) {
      sendJson(response, 400, { error: "El motivo del retiro no puede superar 500 caracteres." });
      return;
    }
    const hasObservacion = "observacion" in body;
    const observacion = String(body.observacion || "").trim();
    if (observacion.length > 500) {
      sendJson(response, 400, { error: "La observación no puede superar 500 caracteres." });
      return;
    }
    if (requestedEarlyExit && !present) {
      sendJson(response, 400, { error: "Solo un trabajador presente (Puntual o Tardanza) puede figurar con retiro anticipado." });
      return;
    }
    if (requestedEarlyExit && !earlyExitReason) {
      sendJson(response, 400, { error: "Ingresa el motivo del retiro anticipado." });
      return;
    }
    const existingResult = await supabase
      .from("asistencias")
      .select(hasWithdrawalFields ? "id,created_at,retiro_anticipado,motivo_retiro,retirado_en,tipo_retiro" : "id,created_at")
      .eq("usuario_id", userId)
      .eq("fecha", date)
      .maybeSingle();
    if (existingResult.error) throw existingResult.error;
    if (hasWithdrawalFields && !existingResult.data) {
      sendJson(response, 409, { error: "Primero guarda la asistencia de hoy antes de editar su salida." });
      return;
    }
    const payload = {
      usuario_id: userId,
      fecha: date,
      estado,
      created_at: present ? (existingResult.data?.created_at || new Date().toISOString()) : null,
      registrado_por_id: session.id,
      ...(hasObservacion ? { observacion: observacion || null } : {}),
      ...(existingResult.data?.id ? { updated_at: new Date().toISOString() } : {})
    };
    if (hasWithdrawalFields) {
      payload.retiro_anticipado = requestedEarlyExit && present;
      payload.motivo_retiro = requestedEarlyExit && present ? earlyExitReason : null;
      payload.tipo_retiro = requestedEarlyExit && present ? requestedRetiroType : null;
      payload.retirado_en = requestedEarlyExit && present
        ? (existingResult.data?.retiro_anticipado ? existingResult.data.retirado_en : new Date().toISOString())
        : null;
      payload.updated_at = new Date().toISOString();
    } else if (!present && existingResult.data?.id) {
      // Si se desmarca desde la lista principal, elimina cualquier retiro previo
      // para no dejar FALTA + retiro_anticipado, combinacion invalida en SQL.
      payload.retiro_anticipado = false;
      payload.motivo_retiro = null;
      payload.tipo_retiro = null;
      payload.retirado_en = null;
      payload.updated_at = new Date().toISOString();
    }
    let result = await supabase
      .from("asistencias")
      .upsert(payload, { onConflict: "usuario_id,fecha" })
      .select("*")
      .single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("asistencias")
        .upsert({ ...payload, id: await nextTableId("asistencias") }, { onConflict: "usuario_id,fecha" })
        .select("*")
        .single();
    }
    if (result.error) throw result.error;
    sendJson(response, 200, { attendance: result.data });
  } catch (error) {
    handleOperationsError(response, error, "No se pudo guardar la asistencia.");
  }
}

function attendanceReportSchemaMissing(error) {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code);
}

function handleAttendanceReportError(response, error, fallback, defaultStatus = 500) {
  if (attendanceReportSchemaMissing(error)) {
    sendJson(response, 503, {
      code: "ATTENDANCE_REPORT_MIGRATION_REQUIRED",
      error: "Falta aplicar una migracion de reportes en Supabase (sql/017, sql/018, sql/019 o sql/022)."
    });
    return;
  }
  if (["ATTENDANCE_REPORT_CONFIG_NOT_FOUND", "ACTIVITY_REPORT_CONFIG_NOT_FOUND", "P0002"].includes(error?.code)) {
    sendJson(response, 404, { error: "La programacion del reporte no existe o fue eliminada." });
    return;
  }
  if (error?.code === "GMAIL_CONFIGURATION_REQUIRED" || String(error?.message || "").includes("GMAIL_APP_PASSWORD")) {
    sendJson(response, 503, {
      code: "GMAIL_CONFIGURATION_REQUIRED",
      error: "Falta configurar la contrasena de aplicacion de Gmail en Netlify."
    });
    return;
  }
  if (["EAUTH", "ECONNECTION", "ETIMEDOUT", "ESOCKET"].includes(error?.code)) {
    sendJson(response, 502, {
      code: "GMAIL_SEND_FAILED",
      error: "Gmail rechazo o no completo el envio. Revisa la cuenta y su contrasena de aplicacion."
    });
    return;
  }
  sendJson(response, defaultStatus, { error: error?.message || fallback });
}

function formatAttendanceReportConfig(config) {
  return {
    ...config,
    hora_envio: String(config?.hora_envio || "18:00").slice(0, 5),
    usuario_ids: Array.isArray(config?.usuario_ids) ? config.usuario_ids.map(Number) : []
  };
}

async function attendanceReportSchedulePayload(body) {
  const recipients = normalizeRecipients(body.destinatarios);
  const active = body.activo === true;
  const name = String(body.nombre || "").trim();
  if (!name) throw new Error("El nombre de la programacion es obligatorio.");
  if (name.length > 100) throw new Error("El nombre de la programacion no puede superar 100 caracteres.");
  if (active && !recipients.length) {
    throw new Error("Agrega al menos un correo destinatario para activar el reporte.");
  }
  if (active && !gmailConfiguration(env).configured) {
    const error = new Error("Configura primero la contrasena de aplicacion de Gmail en Netlify para activar el reporte.");
    error.code = "GMAIL_CONFIGURATION_REQUIRED";
    throw error;
  }

  const includeAllActive = body.incluir_todos_activos !== false;
  const rawUserIds = Array.isArray(body.usuario_ids) ? body.usuario_ids : [];
  const invalidUserId = rawUserIds.find((value) => !Number.isInteger(Number(value)) || Number(value) <= 0);
  if (invalidUserId !== undefined) throw new Error("La seleccion de trabajadores no es valida.");
  const userIds = Array.from(new Set(rawUserIds.map(Number)));

  if (!includeAllActive) {
    if (!userIds.length) throw new Error("Selecciona al menos un trabajador activo para el reporte.");
    const activeWorkers = await readActiveAttendanceWorkers(supabase);
    const activeWorkerIds = new Set(activeWorkers.map((worker) => Number(worker.id)));
    if (userIds.some((userId) => !activeWorkerIds.has(userId))) {
      throw new Error("Solo puedes seleccionar trabajadores que tengan su cuenta activa.");
    }
  }

  return {
    nombre: name,
    activo: active,
    destinatarios: recipients,
    hora_envio: normalizeReportTime(body.hora_envio),
    zona_horaria: REPORT_TIME_ZONE,
    asunto: normalizeReportSubject(body.asunto),
    incluir_todos_activos: includeAllActive,
    usuario_ids: includeAllActive ? [] : userIds
  };
}

async function attendanceReportScheduleExists(configId) {
  const result = await supabase
    .from("configuracion_reporte_asistencia")
    .select("id")
    .eq("id", configId)
    .is("eliminado_en", null)
    .maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data);
}

async function saveAttendanceReportSchedule({ configId = null, body, updatedBy }) {
  if (configId && !(await attendanceReportScheduleExists(configId))) {
    const error = new Error("La programacion no existe.");
    error.code = "ATTENDANCE_REPORT_CONFIG_NOT_FOUND";
    throw error;
  }
  const payload = await attendanceReportSchedulePayload(body);
  const result = await supabase.rpc("guardar_programacion_reporte_asistencia", {
    p_configuracion_id: configId || null,
    p_nombre: payload.nombre,
    p_activo: payload.activo,
    p_destinatarios: payload.destinatarios,
    p_hora_envio: payload.hora_envio,
    p_zona_horaria: payload.zona_horaria,
    p_asunto: payload.asunto,
    p_incluir_todos_activos: payload.incluir_todos_activos,
    p_usuario_ids: payload.usuario_ids,
    p_actualizado_por: updatedBy || null
  });
  if (result.error) throw result.error;
  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!saved?.id) throw new Error("Supabase no devolvio la programacion guardada.");
  return formatAttendanceReportConfig(await readAttendanceReportConfig(supabase, saved.id));
}

async function handleReadAttendanceReportSettings(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const [configs, workers, history] = await Promise.all([
      readAttendanceReportConfigs(supabase),
      readActiveAttendanceWorkers(supabase),
      readAttendanceReportHistory(supabase, 50)
    ]);
    const gmail = gmailConfiguration(env);
    sendJson(response, 200, {
      configs: configs.map(formatAttendanceReportConfig),
      config: configs[0] ? formatAttendanceReportConfig(configs[0]) : null,
      workers,
      history,
      gmail: { sender: gmail.sender, configured: gmail.configured }
    });
  } catch (error) {
    handleAttendanceReportError(response, error, "No se pudo cargar la configuracion del reporte.");
  }
}

async function handleCreateAttendanceReportSettings(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const config = await saveAttendanceReportSchedule({
      body,
      updatedBy: Number(session?.id) || null
    });
    sendJson(response, 201, { config });
  } catch (error) {
    const validationError = error instanceof SyntaxError ||
      /correo|hora|asunto|destinatario|nombre|programacion|trabajador|usuario/i.test(String(error?.message || ""));
    handleAttendanceReportError(
      response,
      error,
      "No se pudo crear la programacion del reporte.",
      validationError ? 400 : 500
    );
  }
}

async function handleUpdateAttendanceReportSettings(request, response, configId = 1) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const config = await saveAttendanceReportSchedule({
      configId,
      body,
      updatedBy: Number(session?.id) || null
    });
    sendJson(response, 200, { config });
  } catch (error) {
    const validationError = error instanceof SyntaxError ||
      /correo|hora|asunto|destinatario|nombre|programacion|trabajador|usuario/i.test(String(error?.message || ""));
    handleAttendanceReportError(
      response,
      error,
      "No se pudo actualizar la programacion del reporte.",
      validationError ? 400 : 500
    );
  }
}

async function handleDeleteAttendanceReportSettings(request, response, configId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const result = await supabase
      .from("configuracion_reporte_asistencia")
      .update({
        activo: false,
        eliminado_en: new Date().toISOString(),
        eliminado_por: Number(session?.id) || null
      })
      .eq("id", configId)
      .is("eliminado_en", null)
      .select("id")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "La programacion no existe o ya fue eliminada." });
      return;
    }
    sendJson(response, 200, { deleted: true, id: configId });
  } catch (error) {
    handleAttendanceReportError(response, error, "No se pudo eliminar la programacion del reporte.");
  }
}

async function handleSendAttendanceReport(request, response, configId = 1) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const config = await readAttendanceReportConfig(supabase, configId);
    const reportDate = String(
      body.fecha || localDateTimeParts(new Date(), config.zona_horaria || REPORT_TIME_ZONE).date
    ).trim();
    const result = await sendAttendanceReport({
      db: supabase,
      envValues: env,
      config,
      reportDate,
      type: "manual",
      initiatedBy: Number(session?.id) || null
    });
    sendJson(response, 200, { report: result });
  } catch (error) {
    const validationError = error instanceof SyntaxError ||
      /fecha|correo|destinatario|tipo de envio/i.test(String(error?.message || ""));
    handleAttendanceReportError(
      response,
      error,
      "No se pudo enviar el reporte de asistencia.",
      validationError ? 400 : 500
    );
  }
}

function formatActivityReportConfig(config) {
  return {
    ...config,
    hora_manana: String(config?.hora_manana || "12:00").slice(0, 5),
    hora_tarde: String(config?.hora_tarde || "18:00").slice(0, 5),
    usuario_ids: Array.isArray(config?.usuario_ids) ? config.usuario_ids.map(Number) : []
  };
}

async function activityReportSchedulePayload(body) {
  const recipients = normalizeRecipients(body.destinatarios);
  const active = body.activo === true;
  const name = String(body.nombre || "").trim();
  if (!name) throw new Error("El nombre de la programacion es obligatorio.");
  if (name.length > 100) throw new Error("El nombre de la programacion no puede superar 100 caracteres.");
  const morning = normalizeReportTime(body.hora_manana);
  const afternoon = normalizeReportTime(body.hora_tarde);
  if (morning >= afternoon) throw new Error("La hora de la manana debe ser anterior a la hora de la tarde.");
  if (active && !recipients.length) {
    throw new Error("Agrega al menos un correo destinatario para activar el reporte.");
  }
  if (active && !gmailConfiguration(env).configured) {
    const error = new Error("Configura primero la contrasena de aplicacion de Gmail en Netlify para activar el reporte.");
    error.code = "GMAIL_CONFIGURATION_REQUIRED";
    throw error;
  }

  const includeAllActive = body.incluir_todos_activos !== false;
  const rawUserIds = Array.isArray(body.usuario_ids) ? body.usuario_ids : [];
  const invalidUserId = rawUserIds.find((value) => !Number.isInteger(Number(value)) || Number(value) <= 0);
  if (invalidUserId !== undefined) throw new Error("La seleccion de operantes no es valida.");
  const userIds = Array.from(new Set(rawUserIds.map(Number)));

  if (!includeAllActive) {
    if (!userIds.length) throw new Error("Selecciona al menos un operante activo para el reporte.");
    const activeWorkers = await readActiveActivityWorkers(supabase);
    const activeWorkerIds = new Set(activeWorkers.map((worker) => Number(worker.id)));
    if (userIds.some((userId) => !activeWorkerIds.has(userId))) {
      throw new Error("Solo puedes seleccionar operantes que tengan su cuenta activa.");
    }
  }

  return {
    nombre: name,
    activo: active,
    destinatarios: recipients,
    hora_manana: morning,
    hora_tarde: afternoon,
    zona_horaria: REPORT_TIME_ZONE,
    asunto: normalizeReportSubject(body.asunto || "Reporte de registros de actividades"),
    incluir_todos_activos: includeAllActive,
    usuario_ids: includeAllActive ? [] : userIds
  };
}

async function activityReportScheduleExists(configId) {
  const result = await supabase
    .from("configuracion_reporte_actividad")
    .select("id")
    .eq("id", configId)
    .is("eliminado_en", null)
    .maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data);
}

async function saveActivityReportSchedule({ configId = null, body, updatedBy }) {
  if (configId && !(await activityReportScheduleExists(configId))) {
    const error = new Error("La programacion no existe.");
    error.code = "ACTIVITY_REPORT_CONFIG_NOT_FOUND";
    throw error;
  }
  const payload = await activityReportSchedulePayload(body);
  const result = await supabase.rpc("guardar_programacion_reporte_actividad", {
    p_configuracion_id: configId || null,
    p_nombre: payload.nombre,
    p_activo: payload.activo,
    p_destinatarios: payload.destinatarios,
    p_hora_manana: payload.hora_manana,
    p_hora_tarde: payload.hora_tarde,
    p_zona_horaria: payload.zona_horaria,
    p_asunto: payload.asunto,
    p_incluir_todos_activos: payload.incluir_todos_activos,
    p_usuario_ids: payload.usuario_ids,
    p_actualizado_por: updatedBy || null
  });
  if (result.error) throw result.error;
  const saved = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!saved?.id) throw new Error("Supabase no devolvio la programacion guardada.");
  return formatActivityReportConfig(await readActivityReportConfig(supabase, saved.id));
}

async function handleReadActivityReportSettings(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const [configs, workers, history] = await Promise.all([
      readActivityReportConfigs(supabase),
      readActiveActivityWorkers(supabase),
      readActivityReportHistory(supabase, 50)
    ]);
    const gmail = gmailConfiguration(env);
    sendJson(response, 200, {
      configs: configs.map(formatActivityReportConfig),
      config: configs[0] ? formatActivityReportConfig(configs[0]) : null,
      workers,
      history,
      gmail: { sender: gmail.sender, configured: gmail.configured }
    });
  } catch (error) {
    handleAttendanceReportError(response, error, "No se pudo cargar el reporte de actividades.");
  }
}

async function handleCreateActivityReportSettings(request, response) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const config = await saveActivityReportSchedule({
      body,
      updatedBy: Number(session?.id) || null
    });
    sendJson(response, 201, { config });
  } catch (error) {
    const validationError = error instanceof SyntaxError ||
      /correo|hora|asunto|destinatario|nombre|programacion|operante|usuario|manana|tarde/i.test(String(error?.message || ""));
    handleAttendanceReportError(
      response,
      error,
      "No se pudo crear la programacion del reporte de actividades.",
      validationError ? 400 : 500
    );
  }
}

async function handleUpdateActivityReportSettings(request, response, configId = 1) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const config = await saveActivityReportSchedule({
      configId,
      body,
      updatedBy: Number(session?.id) || null
    });
    sendJson(response, 200, { config });
  } catch (error) {
    const validationError = error instanceof SyntaxError ||
      /correo|hora|asunto|destinatario|nombre|programacion|operante|usuario|manana|tarde/i.test(String(error?.message || ""));
    handleAttendanceReportError(
      response,
      error,
      "No se pudo actualizar la programacion del reporte de actividades.",
      validationError ? 400 : 500
    );
  }
}

async function handleDeleteActivityReportSettings(request, response, configId) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const result = await supabase
      .from("configuracion_reporte_actividad")
      .update({
        activo: false,
        eliminado_en: new Date().toISOString(),
        eliminado_por: Number(session?.id) || null
      })
      .eq("id", configId)
      .is("eliminado_en", null)
      .select("id")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) {
      sendJson(response, 404, { error: "La programacion no existe o ya fue eliminada." });
      return;
    }
    sendJson(response, 200, { deleted: true, id: configId });
  } catch (error) {
    handleAttendanceReportError(response, error, "No se pudo eliminar la programacion del reporte de actividades.");
  }
}

async function handlePreviewActivityReport(request, response, configId = 1) {
  try {
    if (!requireAdministrator(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const config = await readActivityReportConfig(supabase, configId);
    const reportDate = String(url.searchParams.get("date") || localDateTimeParts(new Date(), REPORT_TIME_ZONE).date);
    const shift = String(url.searchParams.get("shift") || "manana");
    const rows = await readActivityCompliance(supabase, reportDate, shift, config);
    sendJson(response, 200, {
      report: {
        fecha: reportDate,
        turno: shift,
        rows,
        cumplieron: rows.filter((row) => row.cumplio).length,
        sin_registro: rows.filter((row) => !row.cumplio).length
      }
    });
  } catch (error) {
    const validationError = /fecha|turno/i.test(String(error?.message || ""));
    handleAttendanceReportError(response, error, "No se pudo generar el reporte de actividades.", validationError ? 400 : 500);
  }
}

async function handleSendActivityReport(request, response, configId = 1) {
  try {
    if (!requireAdministrator(request, response)) return;
    const session = readSession(request);
    const body = JSON.parse((await readBody(request)) || "{}");
    const config = await readActivityReportConfig(supabase, configId);
    const reportDate = String(body.fecha || localDateTimeParts(new Date(), REPORT_TIME_ZONE).date);
    const result = await sendActivityReport({
      db: supabase,
      envValues: env,
      config,
      reportDate,
      shift: String(body.turno || "manana"),
      type: "manual",
      initiatedBy: Number(session?.id) || null
    });
    sendJson(response, 200, { report: result });
  } catch (error) {
    const validationError = error instanceof SyntaxError || /fecha|turno|correo|destinatario/i.test(String(error?.message || ""));
    handleAttendanceReportError(response, error, "No se pudo enviar el reporte de actividades.", validationError ? 400 : 500);
  }
}

async function handleReadActivityLogs(request, response) {
  try {
    const session = requireSessionRole(request, response, ["administrador", "operante", "lider de equipo", "otros"]);
    if (!session) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const workerId = url.searchParams.get("workerId");
    const source = url.searchParams.get("source");
    if (normalizeRole(session.rol) !== "administrador" && workerId && Number(workerId) !== Number(session.id)) {
      sendJson(response, 403, { error: "No puedes consultar los registros de otro usuario." });
      return;
    }
    if (source === "registros_tareas") {
      if (!["administrador", "lider de equipo", "otros"].includes(normalizeRole(session.rol))) {
        sendJson(response, 403, { error: "Tu rol no puede consultar la tabla completa." });
        return;
      }
      const rows = await selectAllDashboardRows("registros_tareas", { orderColumn: "fecha_registro" });
      sendJson(response, 200, { logs: await attachBrandBreakdown(rows.map(normalizeActivityLog)) });
      return;
    }
    sendJson(response, 200, { logs: await selectActivityLogs(workerId) });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los registros." });
  }
}

async function handleReadOperationalRecords(request, response) {
  try {
    const session = requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"]);
    if (!session) return;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const source = url.searchParams.get("source") === "time" ? "time" : "normal";
    if (source === "time" && normalizeRole(session.rol) !== "administrador") {
      sendJson(response, 403, { error: "Tu rol no puede consultar todos los registros por tiempo." });
      return;
    }
    const table = source === "time" ? "registros_tareas_jefe_equipo" : "registros_tareas";
    const workerColumn = source === "time" ? "trabajador_id" : "usuario_id";
    const lotColumn = source === "time" ? "lote" : "dato_extra";
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(url.searchParams.get("pageSize") || "25", 10)));
    const workerId = Number(url.searchParams.get("workerId"));
    const managerId = Number(url.searchParams.get("managerId"));
    const taskId = Number(url.searchParams.get("taskId"));
    const lot = String(url.searchParams.get("lot") || "").trim();
    const fromDate = String(url.searchParams.get("from") || "").trim();
    const toDate = String(url.searchParams.get("to") || "").trim();
    const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
    const search = String(url.searchParams.get("search") || "").replace(/[,()%]/g, " ").trim();
    const includeCatalogs = url.searchParams.get("includeCatalogs") === "true";
    let query = supabase.from(table).select("*", { count: "exact" });
    if (workerId > 0) query = query.eq(workerColumn, workerId);
    if (source === "time" && managerId > 0) query = query.eq("encargado_id", managerId);
    if (taskId > 0) query = query.eq("tarea_id", taskId);
    if (lot) query = query.eq(lotColumn, lot);
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) query = query.gte("fecha_registro", fromDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) query = query.lte("fecha_registro", toDate);
    if (search && source === "normal") {
      query = query.or(`observacion.ilike.%${search}%,detalle_guia.ilike.%${search}%,numero_guia.ilike.%${search}%,dato_extra.ilike.%${search}%`);
    }
    const start = (page - 1) * pageSize;
    const ascending = order === "asc";
    const result = await query.order("fecha_registro", { ascending }).order("id", { ascending }).range(start, start + pageSize - 1);
    if (result.error) throw result.error;
    const normalizedRecords = (result.data || []).map(normalizeActivityLog);
    const records = source === "normal" ? await attachBrandBreakdown(normalizedRecords) : normalizedRecords;
    const userIds = [...new Set(records.flatMap((row) => [Number(row[workerColumn]), Number(row.encargado_id)]).filter(Boolean))];
    const taskIds = [...new Set(records.map((row) => Number(row.tarea_id)).filter(Boolean))];
    const storeIds = [...new Set(records.map((row) => Number(row.tienda_id)).filter(Boolean))];
    const taskTable = await getTaskTableName();
    const [usersResult, tasksResult, storesResult] = await Promise.all([
      userIds.length ? supabase.from("usuarios").select("id,nombre,email").in("id", userIds) : Promise.resolve({ data: [] }),
      taskIds.length ? supabase.from(taskTable).select("*").in("id", taskIds) : Promise.resolve({ data: [] }),
      storeIds.length ? supabase.from("tiendas").select("id,nombre").in("id", storeIds) : Promise.resolve({ data: [] })
    ]);
    if (usersResult.error) throw usersResult.error;
    if (tasksResult.error) throw tasksResult.error;
    if (storesResult.error) throw storesResult.error;
    const users = new Map((usersResult.data || []).map((item) => [Number(item.id), item.nombre || item.email]));
    const tasks = new Map((tasksResult.data || []).map((item) => [Number(item.id), taskTitle(item)]));
    const stores = new Map((storesResult.data || []).map((item) => [Number(item.id), item.nombre]));
    let catalogs;
    if (includeCatalogs) {
      const [allUsersResult, allTasks, lotesResult, catalogRecordRows] = await Promise.all([
        supabase.from("usuarios").select("id,nombre,email,rol,activo").order("nombre", { ascending: true }),
        selectTasks(),
        supabase.from("lotes").select("codigo_lote,es_general").order("codigo_lote", { ascending: true }),
        selectAllDashboardRows(table)
      ]);
      if (allUsersResult.error) throw allUsersResult.error;
      if (lotesResult.error) throw lotesResult.error;
      const recordedWorkerIds = new Set(catalogRecordRows.map((row) => Number(row[workerColumn])).filter(Boolean));
      const recordedManagerIds = new Set(catalogRecordRows.map((row) => Number(row.encargado_id)).filter(Boolean));
      catalogs = {
        users: (allUsersResult.data || []).filter((item) => recordedWorkerIds.has(Number(item.id))),
        managers: (allUsersResult.data || []).filter((item) => recordedManagerIds.has(Number(item.id))),
        tasks: allTasks,
        lotes: lotesResult.data || []
      };
    }
    sendJson(response, 200, {
      records: records.map((row) => ({
        ...row,
        trabajador_nombre: users.get(Number(row[workerColumn])) || "",
        encargado_nombre: users.get(Number(row.encargado_id)) || "",
        tarea_nombre: tasks.get(Number(row.tarea_id)) || "",
        tienda_nombre: stores.get(Number(row.tienda_id)) || "",
        lote: source === "time" ? row.lote : row.dato_extra
      })),
      total: Number(result.count || 0), page, pageSize,
      ...(catalogs ? { catalogs } : {})
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los registros operativos." });
  }
}

async function handleCreateActivityLog(request, response) {
  try {
    const session = requireSessionRole(request, response, ["operante", "lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const submittedTime = body.tiempo_minutos ?? body.dato_extra;
    if (
      normalizeRole(session.rol) === "operante" &&
      submittedTime !== null &&
      submittedTime !== undefined &&
      submittedTime !== ""
    ) {
      sendJson(response, 403, { error: "El operante no puede registrar tiempo, horas ni minutos." });
      return;
    }
    if (normalizeRole(session.rol) === "operante" && body.fecha_registro) {
      const requestedDate = String(body.fecha_registro).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        sendJson(response, 400, { error: "La fecha de registro no es valida." });
        return;
      }
      const today = currentLimaDate();
      const oldestAllowed = new Date(`${today}T00:00:00`);
      oldestAllowed.setDate(oldestAllowed.getDate() - 3);
      const oldestAllowedIso = oldestAllowed.toISOString().slice(0, 10);
      if (requestedDate > today || requestedDate < oldestAllowedIso) {
        sendJson(response, 400, { error: "La fecha de registro solo puede ser hasta 3 dias antes de hoy." });
        return;
      }
    }
    let horaRegistro = null;
    if (body.hora_registro !== undefined && body.hora_registro !== null && body.hora_registro !== "") {
      const requestedHora = String(body.hora_registro).trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedHora)) {
        sendJson(response, 400, { error: "La hora de registro no es valida." });
        return;
      }
      horaRegistro = requestedHora;
    }
    const tableName = await getTaskTableName();
    const taskResult = await supabase.from(tableName).select("*").eq("id", Number(body.tarea_id)).eq("es_operativa", true).maybeSingle();
    if (taskResult.error || !taskResult.data) {
      sendJson(response, 400, { error: "Selecciona una tarea operativa activa." });
      return;
    }
    const scoringRulesResult = await supabase
      .from("reglas_puntaje")
      .select("tipo_regla")
      .eq("tarea_id", Number(body.tarea_id));
    if (scoringRulesResult.error) {
      sendJson(response, 500, { error: scoringRulesResult.error.message });
      return;
    }
    const scoringTypes = new Set((scoringRulesResult.data || []).map((rule) => normalizeRole(rule.tipo_regla)));
    const requestedType = normalizeRole(body.tipo_medicion);
    const storesQuantity = !scoringTypes.has("fijo") && !scoringTypes.has("turno") &&
      !["fijo", "turno", "cumplimiento"].includes(requestedType);
    const taskFields = getTaskFieldFlags(taskResult.data);
    const requiredFields = getTaskRequiredFlags(taskResult.data);
    const isTimeTask = taskFields.tiempo;
    const allowsStore = taskFields.tienda;
    const requiresStore = allowsStore && requiredFields.tienda;
    const allowsBrands = taskFields.marca;
    const allowsGuideNumber = taskFields.guia;
    const allowsLote = taskFields.lote;
    if (isTimeTask && body.tiempo_minutos !== null && body.tiempo_minutos !== undefined && body.tiempo_minutos !== "") {
      sendJson(response, 403, { error: "El operante no puede registrar el tiempo. Debe hacerlo el líder de equipo." });
      return;
    }
    const brandItems = normalizedBrandItems(body.marcas);
    const guideItems = normalizedGuideItems(body.guias);
    const singleGuideNumber = String(body.numero_guia || "").trim();
    // Las tareas sin cantidad que repartir mandan una sola marca en lugar de la
    // distribucion por marcas.
    let singleBrandId = nullableNumber(body.marca_id);
    const lote = String(body.lote || "").trim().toUpperCase();
    const tipoEtiquetado = normalizeHangtag(body.tipo_etiquetado);
    if (isGeneralLoteCode(lote) && normalizeRole(session.rol) !== "operante") {
      sendJson(response, 403, { error: "Solo los operantes pueden acumular cantidades en el Lote general." });
      return;
    }
    if (isGeneralLoteCode(lote)) {
      const generalLoteResult = await supabase
        .from("lotes")
        .select("marca_id,es_general")
        .eq("es_general", true)
        .maybeSingle();
      if (generalLoteResult.error) throw generalLoteResult.error;
      if (!generalLoteResult.data) {
        sendJson(response, 503, { error: "Falta aplicar la migracion del Lote general en Supabase." });
        return;
      }
      singleBrandId = Number(generalLoteResult.data.marca_id) || null;
    }
    // Si la tarea pide lote, la marca llega derivada del lote elegido (ver
    // LoteField en el frontend) aunque la tarea no tenga "requiere_marca"
    // marcado por separado.
    if (singleBrandId && !allowsBrands && !allowsLote) {
      sendJson(response, 400, { error: `Las marcas no estan disponibles para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (brandItems.length && !allowsBrands) {
      sendJson(response, 400, { error: `Las marcas no estan disponibles para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (lote && !allowsLote) {
      sendJson(response, 400, { error: `El lote no esta disponible para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if ((guideItems.length || singleGuideNumber) && !allowsGuideNumber) {
      sendJson(response, 400, { error: "El número de guía no está disponible para esta tarea." });
      return;
    }
    if (taskFields.hangtag && requiredFields.hangtag && !tipoEtiquetado) {
      sendJson(response, 400, { error: `Indica si ${taskTitle(taskResult.data)} va con hangtag o sin hangtag.` });
      return;
    }
    if (!taskFields.hangtag && tipoEtiquetado) {
      sendJson(response, 400, { error: `El hangtag no esta disponible para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (taskFields.marca && requiredFields.marca && !singleBrandId && !brandItems.length) {
      sendJson(response, 400, { error: `Selecciona una marca para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (taskFields.lote && requiredFields.lote && !lote) {
      sendJson(response, 400, { error: `Ingresa un lote para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (taskFields.guia && requiredFields.guia && !singleGuideNumber && !guideItems.length) {
      sendJson(response, 400, { error: `Ingresa el numero de guia para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (brandItems.length && guideItems.length) {
      sendJson(response, 400, { error: "No puedes distribuir el mismo registro por marcas y por guías a la vez." });
      return;
    }
    const brandTotal = brandItems.reduce((total, item) => total + item.cantidad, 0);
    const guideTotal = guideItems.reduce((total, item) => total + item.cantidad, 0);
    const requestedQuantity = storesQuantity ? nullableNumber(body.cantidad) : null;
    if (isTimeTask && (!requestedQuantity || requestedQuantity <= 0)) {
      sendJson(response, 400, { error: "Las tareas de tiempo también requieren una cantidad mayor a cero." });
      return;
    }
    if (brandItems.length && (!requestedQuantity || requestedQuantity <= 0 || requestedQuantity !== brandTotal)) {
      sendJson(response, 400, { error: `Las cantidades por marca deben sumar exactamente la cantidad total (${requestedQuantity || 0}).` });
      return;
    }
    if (guideItems.length && (!requestedQuantity || requestedQuantity <= 0 || requestedQuantity !== guideTotal)) {
      sendJson(response, 400, { error: `Las cantidades por guía deben sumar exactamente la cantidad total (${requestedQuantity || 0}).` });
      return;
    }
    const payload = {
      usuario_id: Number(session.id),
      tarea_id: Number(body.tarea_id),
      fecha_registro: body.fecha_registro ? String(body.fecha_registro) : new Date().toISOString().slice(0, 10),
      hora_registro: horaRegistro,
      cantidad: requestedQuantity,
      turno: body.turno ? String(body.turno).trim() : null,
      cumplimiento: body.cumplimiento === undefined ? null : Boolean(body.cumplimiento),
      tienda_id: allowsStore ? nullableNumber(body.tienda_id) : null,
      numero_guia: singleGuideNumber || null,
      marca_id: singleBrandId,
      tipo_etiquetado: tipoEtiquetado,
      dato_extra: lote || null,
      observacion: body.observacion || body.detalle ? String(body.observacion || body.detalle).trim() : null,
      puntaje: nullableNumber(body.puntaje) ?? 0
    };
    const requestedTime = nullableNumber(body.tiempo_minutos ?? body.dato_extra);
    if (!isTimeTask && requestedTime !== null) payload.tiempo_minutos = requestedTime;

    if (!payload.usuario_id || !payload.tarea_id) {
      sendJson(response, 400, { error: "Usuario y tarea son obligatorios." });
      return;
    }
    // Una tarea puede usar una tienda general o una tienda distinta por guia.
    // En el segundo caso normalizedGuideItems ya exige tienda_id en cada fila
    // y, al insertar, el resto de los campos del registro se conserva.
    if (requiresStore && !payload.tienda_id && !guideItems.length) {
      sendJson(response, 400, { error: `La tienda es obligatoria para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (payload.tienda_id) {
      const storeResult = await supabase
        .from("tiendas")
        .select("id,activo")
        .eq("id", payload.tienda_id)
        .maybeSingle();
      if (storeResult.error || !storeResult.data || !isActive(storeResult.data.activo)) {
        sendJson(response, 400, { error: "Selecciona una tienda activa y valida." });
        return;
      }
    }
    if (payload.marca_id) {
      const brandResult = await supabase
        .from("marcas")
        .select("id")
        .eq("id", payload.marca_id)
        .maybeSingle();
      if (brandResult.error || !brandResult.data) {
        sendJson(response, 400, { error: "Selecciona una marca valida." });
        return;
      }
    }

    if (guideItems.length) {
      const guideStoreIds = [...new Set(guideItems.map((item) => item.tienda_id))];
      const guideStoresResult = await supabase.from("tiendas").select("id,activo").in("id", guideStoreIds);
      if (guideStoresResult.error) {
        sendJson(response, 500, { error: guideStoresResult.error.message });
        return;
      }
      const validStoreIds = new Set(
        (guideStoresResult.data || []).filter((store) => isActive(store.activo)).map((store) => Number(store.id))
      );
      if (guideStoreIds.some((id) => !validStoreIds.has(Number(id)))) {
        sendJson(response, 400, { error: "Selecciona una tienda activa y valida para cada guia." });
        return;
      }
    }

    const insertedRows = [];
    const rowsToInsert = brandItems.length
      ? brandItems.map((item, index) => ({
          ...payload,
          cantidad: item.cantidad,
          marca_id: item.marca_id,
          puntaje: index === 0 ? payload.puntaje : 0
        }))
      : guideItems.length
        ? guideItems.map((item, index) => ({
            ...payload,
            cantidad: item.cantidad,
            numero_guia: item.numero_guia,
            tienda_id: item.tienda_id,
            detalle_guia: item.detalle,
            puntaje: index === 0 ? payload.puntaje : 0
          }))
      : [payload];

    for (const row of rowsToInsert) {
      const result = await insertCompatibleActivityRow(row);
      if (result.error) {
        if (insertedRows.length) {
          await supabase.from("registros_tareas").delete().in("id", insertedRows.map((item) => item.id));
        }
        sendJson(response, 500, { error: result.error.message });
        return;
      }
      insertedRows.push(result.data);
    }

    const brands = brandItems.length ? await selectBrands() : [];
    const brandName = new Map(brands.map((brand) => [Number(brand.id), brand.nombre]));
    const log = {
      ...normalizeActivityLog(insertedRows[0]),
      cantidad: requestedQuantity,
      puntaje: payload.puntaje,
      guias: guideItems,
      marcas: brandItems.map((item) => ({
        ...item,
        marca_nombre: brandName.get(Number(item.marca_id)) || `Marca ${item.marca_id}`
      }))
    };
    sendJson(response, 201, { log });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar el registro." });
  }
}

// Edicion/eliminacion puntual desde el detalle de registro de tareas del
// dashboard admin. Solo toca los campos visibles en esa tabla; no recalcula
// el puntaje guardado para no alterar rankings ya cerrados.
async function handleUpdateActivityRecord(request, response, id) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(response, 400, { error: "Registro invalido." });
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}");
    if (Object.hasOwn(body, "created_at") || Object.hasOwn(body, "createdAt")) {
      sendJson(response, 400, { error: "La fecha de creacion no se puede modificar." });
      return;
    }
    const payload = {};
    if (body.fecha_registro !== undefined) {
      const fecha = String(body.fecha_registro || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        sendJson(response, 400, { error: "La fecha no es valida." });
        return;
      }
      payload.fecha_registro = fecha;
    }
    if (body.turno !== undefined) payload.turno = String(body.turno || "").trim() || null;
    if (body.cantidad !== undefined) {
      const cantidad = nullableNumber(body.cantidad);
      if (cantidad === null || cantidad < 0) {
        sendJson(response, 400, { error: "La cantidad debe ser un numero mayor o igual a cero." });
        return;
      }
      payload.cantidad = cantidad;
    }
    if (body.numero_guia !== undefined) payload.numero_guia = String(body.numero_guia || "").trim() || null;
    if (body.lote !== undefined) payload.dato_extra = String(body.lote || "").trim().toUpperCase() || null;
    if (body.marca_id !== undefined) payload.marca_id = nullableNumber(body.marca_id);
    if (body.observacion !== undefined) payload.observacion = String(body.observacion || "").trim() || null;
    if (!Object.keys(payload).length) {
      sendJson(response, 400, { error: "No hay cambios para guardar." });
      return;
    }
    const result = await supabase.from("registros_tareas").update(payload).eq("id", id).select("*").maybeSingle();
    if (result.error) {
      sendJson(response, 500, { error: result.error.message || "No se pudo actualizar el registro." });
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Registro no encontrado." });
      return;
    }
    sendJson(response, 200, { record: result.data });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "No se pudo actualizar el registro." });
  }
}

async function handleDeleteActivityRecord(request, response, id) {
  try {
    if (!requireAdministrator(request, response)) return;
    if (!Number.isInteger(id) || id <= 0) {
      sendJson(response, 400, { error: "Registro invalido." });
      return;
    }
    const result = await supabase.from("registros_tareas").delete().eq("id", id).select("id").maybeSingle();
    if (result.error) {
      sendJson(response, 500, { error: result.error.message || "No se pudo eliminar el registro." });
      return;
    }
    if (!result.data) {
      sendJson(response, 404, { error: "Registro no encontrado." });
      return;
    }
    sendJson(response, 200, { deleted: true });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo eliminar el registro." });
  }
}

const GROUP_RECORD_COLUMNS_CURRENT =
  "id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,lote,marca_id,tienda_id,tipo_etiquetado,observacion,hora_inicio,hora_fin,created_at,updated_at,revision";
const GROUP_RECORD_COLUMNS_WITH_EXTRAS =
  "id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,lote,marca_id,tienda_id,observacion,created_at";
const GROUP_RECORD_COLUMNS_BASE =
  "id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,lote,observacion,created_at";

// marca_id/tienda_id solo existen despues de aplicar sql/024. Hasta entonces,
// esta consulta cae de vuelta a las columnas base para no romper el resto del
// panel de líder de equipo (lista de tareas, historial, etc.).
async function selectGroupLeaderRecordRows(applyFilters) {
  let query = supabase.from("registros_tareas_jefe_equipo").select(GROUP_RECORD_COLUMNS_CURRENT);
  query = applyFilters(query);
  let result = await query;
  if (["42703", "PGRST204"].includes(result.error?.code)) {
    let fallbackQuery = supabase.from("registros_tareas_jefe_equipo").select(GROUP_RECORD_COLUMNS_WITH_EXTRAS);
    fallbackQuery = applyFilters(fallbackQuery);
    result = await fallbackQuery;
    if (["42703", "PGRST204"].includes(result.error?.code)) {
      let baseQuery = supabase.from("registros_tareas_jefe_equipo").select(GROUP_RECORD_COLUMNS_BASE);
      baseQuery = applyFilters(baseQuery);
      result = await baseQuery;
      if (["42703", "PGRST204"].includes(result.error?.code)) {
        let legacyQuery = supabase
          .from("registros_tareas_jefe_equipo")
          .select("id,encargado_id,trabajador_id,tarea_id,fecha_registro,cantidad,tiempo_minutos,lote,observacion,created_at");
        legacyQuery = applyFilters(legacyQuery);
        result = await legacyQuery;
      }
    }
    if (!result.error) {
      result.historyMigrationRequired = true;
      result.data = (result.data || []).map((row) => ({
        ...row,
        marca_id: row.marca_id ?? null,
        tienda_id: row.tienda_id ?? null,
        hora_inicio: null,
        hora_fin: null,
        updated_at: row.created_at || null,
        revision: null
      }));
    }
  }
  return result;
}

function enrichGroupRecords(records, users, tasks, brands = [], stores = []) {
  const userById = new Map(users.map((user) => [Number(user.id), user]));
  const taskById = new Map(tasks.map((task) => [Number(task.id), task]));
  const brandById = new Map(brands.map((brand) => [Number(brand.id), brand]));
  const storeById = new Map(stores.map((store) => [Number(store.id), store]));

  return records.map((record) => {
    const encargado = userById.get(Number(record.encargado_id));
    const trabajador = userById.get(Number(record.trabajador_id));
    const task = taskById.get(Number(record.tarea_id));
    const brand = record.marca_id ? brandById.get(Number(record.marca_id)) : null;
    const store = record.tienda_id ? storeById.get(Number(record.tienda_id)) : null;

    return {
      ...record,
      encargado_nombre: encargado?.nombre || encargado?.email || "",
      encargado_email: encargado?.email || "",
      trabajador_nombre: trabajador?.nombre || trabajador?.email || "",
      trabajador_email: trabajador?.email || "",
      tarea_nombre: record.tarea_nombre || taskTitle(task) || `Tarea ${record.tarea_id}`,
      marca_nombre: brand?.nombre || "",
      tienda_nombre: store?.nombre || ""
    };
  });
}

// Promedio de referencia manual por tarea (sql/031): reemplaza el calculo
// automatico anterior por tarea/hangtag. Cada tarea de líder de equipo tiene
// su propio numero porque rinden a ritmos distintos; una tarea sin promedio
// fijado simplemente no se compara (queda sin dato en el historial). Las
// tareas que usan hangtag (hoy, Etiquetado) guardan un promedio separado
// para "con hangtag" y "sin hangtag" bajo esas mismas claves; el resto usa
// la clave "" (un solo promedio para toda la tarea).
async function selectAverageReferencesByTask() {
  const result = await supabase
    .from("promedios_referencia_jefe_equipo")
    .select("tarea_id,tipo_etiquetado,promedio_referencia");
  if (result.error) {
    if (isMissingDashboardResource(result.error)) return { byTask: {}, migrationRequired: true };
    throw result.error;
  }
  const byTask = {};
  (result.data || []).forEach((row) => {
    const taskId = Number(row.tarea_id);
    const key = normalizeHangtag(row.tipo_etiquetado) || "";
    byTask[taskId] = byTask[taskId] || {};
    byTask[taskId][key] = Number(row.promedio_referencia);
  });
  return { byTask, migrationRequired: false };
}

async function loadGroupLeaderData() {
  const tableName = await getTaskTableName();
  const [usersResult, tasksResult, recordsResult, brandsResult, storesResult, averageReferenceResult] = await Promise.all([
    supabase.from("usuarios").select("id,nombre,email,rol,activo").order("id", { ascending: true }),
    supabase.from(tableName).select("*").eq("es_operativa", true).order("id", { ascending: true }),
    selectGroupLeaderRecordRows((query) => query.order("created_at", { ascending: false })),
    supabase.from("marcas").select("*").order("nombre", { ascending: true }),
    supabase.from("tiendas").select("id,nombre,activo"),
    selectAverageReferencesByTask()
  ]);

  if (usersResult.error) throw usersResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (recordsResult.error) throw recordsResult.error;
  if (brandsResult.error) throw brandsResult.error;
  if (storesResult.error) throw storesResult.error;

  const users = usersResult.data || [];
  const recordTasks = (tasksResult.data || []).filter((task) => isGroupLeaderTimeTask(task));
  const tasks = recordTasks.filter((task) => isActive(task.activo));
  const workers = users.filter((user) => isTimedTaskWorkerRole(user.rol) && isActive(user.activo));
  const leaders = users.filter((user) => ["lider de equipo"].includes(normalizeRole(user.rol)) && isActive(user.activo));
  const records = enrichGroupRecords(
    (recordsResult.data || []).map((record) => ({
      ...record,
      detalle: record.observacion
    })),
    users,
    tasksResult.data || [],
    brandsResult.data || [],
    storesResult.data || []
  );
  const stores = (storesResult.data || []).filter((store) => isActive(store.activo));
  let activities = [];
  let legacyActivitiesUnavailable = false;
  try {
    activities = await selectLiveGroupLeaderActivities();
  } catch (error) {
    if (!operationsSchemaMissing(error)) throw error;
    legacyActivitiesUnavailable = true;
  }

  const liveActivityByRecordId = new Map(
    activities
      .filter((activity) => activity.registro_tarea_id)
      .map((activity) => [Number(activity.registro_tarea_id), activity])
  );
  const recordsWithTimes = records.map((record) => {
    const activity = liveActivityByRecordId.get(Number(record.id));
    return {
      ...record,
      hora_inicio: record.hora_inicio || activity?.hora_inicio || null,
      hora_fin: record.hora_fin || activity?.hora_fin || null,
      actividad_seguimiento_id: activity?.id || null
    };
  });

  return {
    workers,
    tasks,
    recordTasks,
    leaders,
    // Sin filtrar por rol ni por activo: un registro puede tener como
    // trabajador a alguien inactivo o a un líder de equipo que hizo la tarea el
    // mismo. `workers`/`leaders` siguen restringidos para los selectores de
    // alta; esto es para poder mostrar y agrupar cualquier registro existente
    // (por ejemplo en el Ranking).
    allUsers: users.filter((item) => normalizeRole(item.rol) !== "administrador").map((item) => ({
      id: item.id,
      nombre: item.nombre,
      email: item.email,
      rol: item.rol,
      activo: isActive(item.activo)
    })),
    records: recordsWithTimes,
    activities,
    operationsMigrationRequired: false,
    legacyActivitiesUnavailable,
    historyMigrationRequired: Boolean(recordsResult.historyMigrationRequired),
    averageReferenceByTask: averageReferenceResult.byTask,
    averageReferenceMigrationRequired: averageReferenceResult.migrationRequired,
    brands: (brandsResult.data || []).filter((brand) => isActive(brand.activo)),
    stores
  };
}

async function handleUpdateAverageReference(request, response) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "administrador", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const taskId = Number(body.tarea_id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      sendJson(response, 400, { error: "Tarea invalida." });
      return;
    }
    // "" = un solo promedio para toda la tarea; si viene con hangtag valido
    // se guarda esa mitad por separado (con y sin hangtag no son comparables).
    const hangtagKey = normalizeGroupHangtag(body.tipo_etiquetado) || "";
    const value = Number(body.promedio_referencia);
    if (!Number.isFinite(value) || value < 0) {
      sendJson(response, 400, { error: "El promedio de referencia debe ser un numero mayor o igual a cero." });
      return;
    }
    const tableName = await getTaskTableName();
    const taskResult = await supabase.from(tableName).select("id").eq("id", taskId).maybeSingle();
    if (taskResult.error) throw taskResult.error;
    if (!taskResult.data) {
      sendJson(response, 404, { error: "Tarea no encontrada." });
      return;
    }
    const rounded = Math.round(value * 100) / 100;
    const result = await supabase
      .from("promedios_referencia_jefe_equipo")
      .upsert({
        tarea_id: taskId,
        tipo_etiquetado: hangtagKey,
        promedio_referencia: rounded,
        updated_at: new Date().toISOString(),
        updated_by: Number(session.id)
      }, { onConflict: "tarea_id,tipo_etiquetado" })
      .select("tarea_id,tipo_etiquetado,promedio_referencia")
      .maybeSingle();
    if (result.error) {
      if (isMissingDashboardResource(result.error)) {
        sendJson(response, 503, { error: "Falta aplicar la migracion sql/031_promedio_referencia_jefe_equipo.sql en Supabase." });
        return;
      }
      throw result.error;
    }
    sendJson(response, 200, {
      tarea_id: taskId,
      tipo_etiquetado: hangtagKey,
      promedio_referencia: Number(result.data?.promedio_referencia ?? rounded)
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo actualizar el promedio de referencia." });
  }
}

async function handleReadAverageReferences(request, response) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "administrador"]);
    if (!session) return;
    const result = await selectAverageReferencesByTask();
    sendJson(response, 200, {
      averageReferenceByTask: result.byTask,
      averageReferenceMigrationRequired: result.migrationRequired
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los promedios de referencia." });
  }
}

async function handleGroupLeaderContext(request, response) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"])) return;
    const data = await loadGroupLeaderData();
    sendJson(response, 200, data);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar los datos." });
  }
}

async function handleWorkerLiveProgress(request, response) {
  try {
    const session = requireSessionRole(request, response, ["operante"]);
    if (!session) return;

    const context = await loadGroupLeaderData();
    const directRecords = context.records
      .filter((record) => Number(record.trabajador_id) === Number(session.id))
      .map((record) => ({
        ...record,
        id: `registro-${record.id}`,
        record_id: Number(record.id),
        registro_tarea_id: Number(record.id),
        origen: "historial_jefe_equipo",
        // Un registro sin hora_fin sigue "Sin cerrar" en el historial: aqui
        // se traduce como EN_CURSO para que el operante lo vea como tarea
        // abierta, no como si ya estuviera terminada.
        estado: !record.hora_fin ? "EN_CURSO" : Number(record.revision || 1) > 1 ? "ACTUALIZADA" : "FINALIZADA",
        horaInicio: record.hora_inicio || null,
        horaFin: record.hora_fin || null,
        tiempoMinutos: nullableNumber(record.tiempo_minutos),
        updatedAt: record.updated_at || record.created_at || null,
        history: [{
          tipo: record.revision > 1 ? "ACTUALIZACION" : "REGISTRO",
          cantidad: nullableNumber(record.cantidad),
          puntaje: nullableNumber(record.puntaje),
          created_at: record.updated_at || record.created_at || null
        }]
      }));
    const directRecordIds = new Set(directRecords.map((record) => Number(record.record_id)));
    const legacyActivities = (context.activities || [])
      .filter((activity) => Number(activity.trabajador_id) === Number(session.id))
      .filter((activity) => !activity.registro_tarea_id || !directRecordIds.has(Number(activity.registro_tarea_id)))
      .map((activity) => ({
        ...activity,
        origen: "actividad_legacy",
        horaInicio: activity.hora_inicio || null,
        horaFin: activity.hora_fin || null,
        tiempoMinutos: activity.hora_fin
          ? Math.max(1, Math.round((new Date(activity.hora_fin) - new Date(activity.hora_inicio)) / 60000))
          : null,
        updatedAt: activity.updated_at || activity.created_at || null
      }));
    const workerActivities = [...directRecords, ...legacyActivities]
      .sort((a, b) => new Date(b.updated_at || b.updatedAt || b.hora_inicio || 0) - new Date(a.updated_at || a.updatedAt || a.hora_inicio || 0))
      .slice(0, 50);

    response.setHeader("cache-control", "no-store, no-cache, must-revalidate");
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      operationsMigrationRequired: Boolean(context.operationsMigrationRequired),
      historyMigrationRequired: Boolean(context.historyMigrationRequired),
      activities: workerActivities
    });
  } catch (error) {
    if (operationsSchemaMissing(error)) {
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        operationsMigrationRequired: true,
        historyMigrationRequired: true,
        activities: []
      });
      return;
    }
    sendJson(response, 500, { error: error.message || "No se pudo cargar el progreso en vivo." });
  }
}

async function handleCreateGroupLeaderRecordLegacy(request, response) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "otros"]);
    if (!session) return;
    const rawBody = await readBody(request);
    const body = JSON.parse(rawBody || "{}");
    const taskId = Number(body.tarea_id);
    const workerId = Number(body.trabajador_id);
    if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(workerId) || workerId <= 0) {
      sendJson(response, 400, { error: "Operante y tarea son obligatorios." });
      return;
    }

    const tableName = await getTaskTableName();
    const taskResult = await supabase
      .from(tableName)
      .select("*")
      .eq("id", taskId)
      .maybeSingle();
    if (taskResult.error || !taskResult.data || !isGroupLeaderTimeTask(taskResult.data)) {
      sendJson(response, 400, { error: "Selecciona una tarea por tiempo válida." });
      return;
    }
    if (!isActive(taskResult.data.activo)) {
      sendJson(response, 400, { error: "La tarea seleccionada no está activa." });
      return;
    }
    const workerResult = await supabase
      .from("usuarios")
      .select("id,rol,activo")
      .eq("id", workerId)
      .maybeSingle();
    if (
      workerResult.error ||
      !workerResult.data ||
      !isTimedTaskWorkerRole(workerResult.data.rol) ||
      !isActive(workerResult.data.activo)
    ) {
      sendJson(response, 400, { error: "Selecciona un operante o lider de equipo activo." });
      return;
    }

    const requestedQuantity = Number(body.cantidad);
    const requestedMinutes = Number(body.tiempo_minutos);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity <= 0) {
      sendJson(response, 400, { error: "La cantidad debe ser un número entero mayor a cero." });
      return;
    }
    if (!Number.isInteger(requestedMinutes) || requestedMinutes <= 0) {
      sendJson(response, 400, { error: "El tiempo debe ser una cantidad entera de minutos mayor a cero." });
      return;
    }
    const lote = String(body.lote || "").trim().toUpperCase();
    if (lote && !isEtiquetadoTask(taskResult.data)) {
      sendJson(response, 400, { error: "El lote solo esta disponible para la tarea Etiquetado." });
      return;
    }

    // Los datos adicionales salen de las banderas de la tarea, igual que en el
    // registro del operante.
    const legacyFields = getTaskFieldFlags(taskResult.data);
    const legacyRequired = getTaskRequiredFlags(taskResult.data);
    const allowsBrand = legacyFields.marca;
    const allowsStore = legacyFields.tienda;
    const requiresBrand = allowsBrand && legacyRequired.marca;
    const requiresStore = allowsStore && legacyRequired.tienda;
    const requestedBrandId = nullableNumber(body.marca_id);
    const requestedStoreId = nullableNumber(body.tienda_id);

    if (requiresBrand && !requestedBrandId) {
      sendJson(response, 400, { error: `Selecciona una marca para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (!allowsBrand && requestedBrandId) {
      sendJson(response, 400, { error: "La marca solo esta disponible para la tarea Etiquetado." });
      return;
    }
    if (requiresStore && !requestedStoreId) {
      sendJson(response, 400, { error: `Selecciona una tienda para ${taskTitle(taskResult.data)}.` });
      return;
    }
    if (!allowsStore && requestedStoreId) {
      sendJson(response, 400, { error: "La tienda no esta disponible para esta tarea." });
      return;
    }
    if (requestedBrandId) {
      const brandResult = await supabase.from("marcas").select("id").eq("id", requestedBrandId).maybeSingle();
      if (brandResult.error || !brandResult.data) {
        sendJson(response, 400, { error: "Selecciona una marca valida." });
        return;
      }
    }
    if (requestedStoreId) {
      const storeResult = await supabase.from("tiendas").select("id,activo").eq("id", requestedStoreId).maybeSingle();
      if (storeResult.error || !storeResult.data || !isActive(storeResult.data.activo)) {
        sendJson(response, 400, { error: "Selecciona una tienda activa y valida." });
        return;
      }
    }

    const payload = {
      encargado_id: Number(session.id),
      trabajador_id: workerId,
      tarea_id: taskId,
      fecha_registro: body.fecha_registro ? String(body.fecha_registro) : new Date().toISOString().slice(0, 10),
      cantidad: requestedQuantity,
      tiempo_minutos: requestedMinutes,
      lote: lote || null,
      marca_id: requestedBrandId,
      tienda_id: requestedStoreId,
      observacion: body.detalle ? String(body.detalle).trim() : null
    };

    if (!payload.encargado_id || !payload.trabajador_id || !payload.tarea_id) {
      sendJson(response, 400, { error: "Encargado, trabajador y tarea son obligatorios." });
      return;
    }

    let result = await supabase
      .from("registros_tareas_jefe_equipo")
      .insert(payload)
      .select(GROUP_RECORD_COLUMNS_WITH_EXTRAS)
      .single();

    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("registros_tareas_jefe_equipo")
        .insert({ ...payload, id: await nextTableId("registros_tareas_jefe_equipo") })
        .select(GROUP_RECORD_COLUMNS_WITH_EXTRAS)
        .single();
    }

    // marca_id/tienda_id solo existen despues de aplicar sql/024. Si la tarea no
    // los necesita (ambos quedaron null), reintenta sin esas columnas para no
    // bloquear el registro completo por una migracion pendiente.
    if (["42703", "PGRST204"].includes(result.error?.code) && !payload.marca_id && !payload.tienda_id) {
      const { marca_id, tienda_id, ...basePayload } = payload;
      result = await supabase
        .from("registros_tareas_jefe_equipo")
        .insert(basePayload)
        .select(GROUP_RECORD_COLUMNS_BASE)
        .single();
      if (isPrimaryKeySequenceConflict(result.error)) {
        result = await supabase
          .from("registros_tareas_jefe_equipo")
          .insert({ ...basePayload, id: await nextTableId("registros_tareas_jefe_equipo") })
          .select(GROUP_RECORD_COLUMNS_BASE)
          .single();
      }
      if (!result.error) result.data = { ...result.data, marca_id: null, tienda_id: null };
    }

    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }

    const data = await loadGroupLeaderData();
    const record = data.records.find((item) => Number(item.id) === Number(result.data.id)) || result.data;
    sendJson(response, 201, { record });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar el registro." });
  }
}

function historyRecordMigrationMissing(error) {
  return ["42703", "42883", "PGRST202", "PGRST203", "PGRST204"].includes(error?.code) ||
    /hora_inicio|hora_fin|revision|updated_at/i.test(String(error?.message || ""));
}

function pendingRecordMigrationMissing(error) {
  return String(error?.code) === "23514" &&
    /registros_tareas_jefe_equipo_horas_validas/i.test(
      `${error?.message || ""} ${error?.details || ""}`
    );
}

function sendHistoryRecordError(response, error, fallback) {
  if (pendingRecordMigrationMissing(error)) {
    sendJson(response, 503, {
      code: "GROUP_PENDING_MIGRATION_REQUIRED",
      error: "Falta ejecutar sql/028_registro_jefe_equipo_pendiente.sql en Supabase para guardar registros sin cierre."
    });
    return;
  }
  if (historyRecordMigrationMissing(error)) {
    sendJson(response, 503, {
      code: "GROUP_HISTORY_MIGRATION_REQUIRED",
      error: "Falta ejecutar sql/027_historial_jefe_equipo_editable.sql en Supabase."
    });
    return;
  }
  if (error?.code === "23P01") {
    sendJson(response, 409, { error: "El operante ya tiene otra tarea dentro de ese horario. Corrige el intervalo y vuelve a guardar." });
    return;
  }
  if (error?.statusCode) {
    sendJson(response, error.statusCode, { error: error.message || fallback });
    return;
  }
  handleOperationsError(response, error, fallback);
}

function invalidGroupRecord(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function limaDateForInstant(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Registro recien empezado: solo se conoce el inicio. La cantidad, el cierre y
// el puntaje se completan despues desde el historial.
export function groupLeaderRecordStartTiming(horaInicio, { now = Date.now() } = {}) {
  const start = new Date(horaInicio || "");
  if (Number.isNaN(start.getTime())) {
    throw invalidGroupRecord("Selecciona una fecha y una hora de inicio validas.");
  }
  if (start.getTime() > Number(now) + 60000) {
    throw invalidGroupRecord("La hora de inicio no puede estar en el futuro.");
  }
  return {
    hora_inicio: start.toISOString(),
    hora_fin: null,
    fecha_registro: limaDateForInstant(start),
    tiempo_minutos: 0
  };
}

export function groupLeaderRecordTiming(horaInicio, horaFin, { now = Date.now() } = {}) {
  const start = new Date(horaInicio || "");
  const finish = new Date(horaFin || "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) {
    throw invalidGroupRecord("Selecciona una hora de inicio y una hora fin validas.");
  }
  if (finish <= start) {
    throw invalidGroupRecord("La hora fin debe ser posterior a la hora de inicio.");
  }
  if (finish.getTime() > Number(now) + 60000) {
    throw invalidGroupRecord("La hora fin no puede estar en el futuro.");
  }
  const elapsed = finish.getTime() - start.getTime();
  if (elapsed > 24 * 60 * 60 * 1000) {
    throw invalidGroupRecord("Una actividad no puede superar 24 horas. Revisa las fechas y horas.");
  }
  return {
    hora_inicio: start.toISOString(),
    hora_fin: finish.toISOString(),
    fecha_registro: limaDateForInstant(start),
    tiempo_minutos: Math.max(1, Math.round(elapsed / 60000))
  };
}

async function validateGroupRecordMetadata(body, task, current = null) {
  const fields = getTaskFieldFlags(task);
  const required = getTaskRequiredFlags(task);
  const marcaId = nullableNumber(body.marca_id);
  const tiendaId = nullableNumber(body.tienda_id);
  const lote = String(body.lote || "").trim().toUpperCase() || null;
  const tipoEtiquetado = normalizeGroupHangtag(body.tipo_etiquetado);
  const observacion = String(body.detalle ?? body.observacion ?? "").trim() || null;

  if (fields.marca && required.marca && !marcaId) throw invalidGroupRecord(`Selecciona una marca para ${taskTitle(task)}.`);
  if (!fields.marca && marcaId) throw invalidGroupRecord(`La marca no esta disponible para ${taskTitle(task)}.`);
  if (!fields.lote && lote) throw invalidGroupRecord(`El lote no esta disponible para ${taskTitle(task)}.`);
  if (fields.lote && required.lote && !lote) throw invalidGroupRecord(`Ingresa un lote para ${taskTitle(task)}.`);
  if (fields.hangtag && required.hangtag && !tipoEtiquetado) throw invalidGroupRecord(`Indica si ${taskTitle(task)} va con hangtag o sin hangtag.`);
  if (!fields.hangtag && tipoEtiquetado) throw invalidGroupRecord(`El hangtag no esta disponible para ${taskTitle(task)}.`);
  if (fields.tienda && required.tienda && !tiendaId) throw invalidGroupRecord(`Selecciona una tienda para ${taskTitle(task)}.`);
  if (!fields.tienda && tiendaId) throw invalidGroupRecord(`La tienda no esta disponible para ${taskTitle(task)}.`);
  if (lote && lote.length > 100) throw invalidGroupRecord("El codigo de lote no puede superar 100 caracteres.");
  if (observacion && observacion.length > 1000) throw invalidGroupRecord("El detalle no puede superar 1,000 caracteres.");

  if (marcaId && Number(marcaId) !== Number(current?.marca_id || 0)) {
    if (!Number.isInteger(marcaId) || marcaId <= 0) throw invalidGroupRecord("Selecciona una marca valida.");
    const brandResult = await supabase.from("marcas").select("id").eq("id", marcaId).maybeSingle();
    if (brandResult.error) throw brandResult.error;
    if (!brandResult.data) throw invalidGroupRecord("Selecciona una marca valida.");
  }
  if (tiendaId && Number(tiendaId) !== Number(current?.tienda_id || 0)) {
    if (!Number.isInteger(tiendaId) || tiendaId <= 0) throw invalidGroupRecord("Selecciona una tienda valida.");
    const storeResult = await supabase.from("tiendas").select("id,activo").eq("id", tiendaId).maybeSingle();
    if (storeResult.error) throw storeResult.error;
    if (!storeResult.data || !isActive(storeResult.data.activo)) throw invalidGroupRecord("Selecciona una tienda activa y valida.");
  }

  return {
    marca_id: marcaId,
    tienda_id: tiendaId,
    lote,
    tipo_etiquetado: tipoEtiquetado,
    observacion
  };
}

async function ensureGroupRecordDoesNotOverlap(workerId, timing, excludeRecordId = null) {
  let query = supabase
    .from("registros_tareas_jefe_equipo")
    .select("id,hora_inicio,hora_fin")
    .eq("trabajador_id", workerId)
    .lt("hora_inicio", timing.hora_fin)
    .gt("hora_fin", timing.hora_inicio)
    .limit(1);
  if (excludeRecordId) query = query.neq("id", excludeRecordId);
  const result = await query;
  if (result.error) throw result.error;
  if (result.data?.length) {
    throw invalidGroupRecord(
      `El operante ya tiene el registro #${result.data[0].id} dentro de ese horario. Corrige el intervalo para evitar tareas simultaneas.`,
      409
    );
  }
}

async function validateGroupRecordBase(body, { current = null, validateWorker = true } = {}) {
  const taskId = Number(current?.tarea_id ?? body.tarea_id);
  const workerId = Number(current?.trabajador_id ?? body.trabajador_id);
  if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(workerId) || workerId <= 0) {
    throw invalidGroupRecord("Trabajador y tarea son obligatorios.");
  }
  if (current && body.tarea_id !== undefined && Number(body.tarea_id) !== taskId) {
    throw invalidGroupRecord("La tarea de un registro historico no se puede reemplazar.");
  }
  if (current && body.trabajador_id !== undefined && Number(body.trabajador_id) !== workerId) {
    throw invalidGroupRecord("El operante de un registro historico no se puede reemplazar.");
  }
  const task = await taskWithScoringRules(taskId);
  if (!task || !isGroupLeaderTimeTask(task)) throw invalidGroupRecord("Selecciona una tarea por tiempo valida.");
  if (!current && !isActive(task.activo)) throw invalidGroupRecord("La tarea seleccionada no esta activa.");
  if (validateWorker) {
    const workerResult = await supabase.from("usuarios").select("id,rol,activo").eq("id", workerId).maybeSingle();
    if (workerResult.error) throw workerResult.error;
    if (!workerResult.data || !isTimedTaskWorkerRole(workerResult.data.rol) || !isActive(workerResult.data.activo)) {
      throw invalidGroupRecord("Selecciona un operante o lider de equipo activo.");
    }
  }
  const metadata = await validateGroupRecordMetadata(body, task, current);
  // Sin hora de fin el registro queda pendiente: se guarda el inicio y se
  // cierra mas adelante desde el historial, con la cantidad real.
  if (!body.hora_fin) {
    return {
      task,
      workerId,
      taskId,
      payload: {
        trabajador_id: workerId,
        tarea_id: taskId,
        cantidad: 0,
        ...groupLeaderRecordStartTiming(body.hora_inicio),
        ...metadata
      }
    };
  }
  const quantity = Number(body.cantidad);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_SCORE_QUANTITY) {
    throw invalidGroupRecord(`La cantidad debe ser un numero entero entre 1 y ${MAX_SCORE_QUANTITY.toLocaleString("es-PE")}.`);
  }
  const timing = groupLeaderRecordTiming(body.hora_inicio, body.hora_fin);
  await ensureGroupRecordDoesNotOverlap(workerId, timing, current?.id || null);
  return {
    task,
    workerId,
    taskId,
    payload: {
      trabajador_id: workerId,
      tarea_id: taskId,
      cantidad: quantity,
      ...timing,
      ...metadata
    }
  };
}

async function handleCreateGroupLeaderRecord(request, response) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const { payload } = await validateGroupRecordBase(body);
    let result = await supabase
      .from("registros_tareas_jefe_equipo")
      .insert({ ...payload, encargado_id: Number(session.id) })
      .select(GROUP_RECORD_COLUMNS_CURRENT)
      .single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("registros_tareas_jefe_equipo")
        .insert({ ...payload, encargado_id: Number(session.id), id: await nextTableId("registros_tareas_jefe_equipo") })
        .select(GROUP_RECORD_COLUMNS_CURRENT)
        .single();
    }
    if (result.error) throw result.error;
    const data = await loadGroupLeaderData();
    const record = data.records.find((item) => Number(item.id) === Number(result.data.id)) || result.data;
    sendJson(response, 201, { record });
  } catch (error) {
    sendHistoryRecordError(response, error, "No se pudo guardar el registro por tiempo.");
  }
}

async function handleUpdateGroupLeaderRecord(request, response, recordId) {
  try {
    const session = requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    if (Object.hasOwn(body, "created_at") || Object.hasOwn(body, "createdAt")) {
      throw invalidGroupRecord("La fecha de creacion no se puede modificar.", 400);
    }
    const currentResult = await supabase
      .from("registros_tareas_jefe_equipo")
      .select(GROUP_RECORD_COLUMNS_CURRENT)
      .eq("id", recordId)
      .maybeSingle();
    if (currentResult.error) throw currentResult.error;
    const current = currentResult.data;
    if (!current) throw invalidGroupRecord("Registro no encontrado.", 404);
    const administrator = normalizeRole(session.rol) === "administrador";
    if (!administrator && Number(current.encargado_id) !== Number(session.id)) {
      throw invalidGroupRecord("Solo el jefe que creo el registro puede editarlo.", 403);
    }
    const expectedRevision = Number(body.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw invalidGroupRecord("Actualiza el historial antes de editar esta fila: falta su revision.", 409);
    }
    if (expectedRevision !== Number(current.revision)) {
      throw invalidGroupRecord("La fila fue modificada por otra sesion. Actualiza el historial antes de guardar.", 409);
    }
    const merged = {
      ...current,
      ...body,
      tarea_id: current.tarea_id,
      trabajador_id: current.trabajador_id,
      detalle: body.detalle ?? body.observacion ?? current.observacion
    };
    const { payload } = await validateGroupRecordBase(merged, { current, validateWorker: false });
    const updatePayload = {
      cantidad: payload.cantidad,
      tiempo_minutos: payload.tiempo_minutos,
      fecha_registro: payload.fecha_registro,
      hora_inicio: payload.hora_inicio,
      hora_fin: payload.hora_fin,
      lote: payload.lote,
      marca_id: payload.marca_id,
      tienda_id: payload.tienda_id,
      tipo_etiquetado: payload.tipo_etiquetado,
      observacion: payload.observacion
    };
    const updateResult = await supabase
      .from("registros_tareas_jefe_equipo")
      .update(updatePayload)
      .eq("id", recordId)
      .eq("encargado_id", administrator ? Number(current.encargado_id) : Number(session.id))
      .eq("revision", expectedRevision)
      .select(GROUP_RECORD_COLUMNS_CURRENT)
      .maybeSingle();
    if (updateResult.error) throw updateResult.error;
    if (!updateResult.data) {
      throw invalidGroupRecord("La fila fue modificada por otra sesion. Actualiza el historial antes de guardar.", 409);
    }
    const data = await loadGroupLeaderData();
    const record = data.records.find((item) => Number(item.id) === Number(recordId)) || updateResult.data;
    sendJson(response, 200, { record });
  } catch (error) {
    sendHistoryRecordError(response, error, "No se pudo actualizar el registro por tiempo.");
  }
}

async function handleDeleteGroupLeaderRecord(request, response, recordId) {
  try {
    const session = requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const currentResult = await supabase
      .from("registros_tareas_jefe_equipo")
      .select("id,encargado_id,revision")
      .eq("id", recordId)
      .maybeSingle();
    if (currentResult.error) throw currentResult.error;
    const current = currentResult.data;
    if (!current) throw invalidGroupRecord("Registro no encontrado.", 404);
    const administrator = normalizeRole(session.rol) === "administrador";
    if (!administrator && Number(current.encargado_id) !== Number(session.id)) {
      throw invalidGroupRecord("Solo el jefe que creo el registro puede eliminarlo.", 403);
    }
    // Si el cliente manda la revision que tenia a la vista, se comprueba para
    // no borrar una fila que otra sesion acaba de cambiar.
    if (body.revision !== undefined && body.revision !== null &&
      Number(body.revision) !== Number(current.revision)) {
      throw invalidGroupRecord("La fila fue modificada por otra sesion. Actualiza el historial antes de eliminarla.", 409);
    }
    // La tarjeta en curso enlazada, si existe, queda desligada por la regla
    // `on delete set null` de la tabla de actividades.
    const deleteResult = await supabase
      .from("registros_tareas_jefe_equipo")
      .delete()
      .eq("id", recordId)
      .eq("encargado_id", administrator ? Number(current.encargado_id) : Number(session.id))
      .select("id")
      .maybeSingle();
    if (deleteResult.error) throw deleteResult.error;
    if (!deleteResult.data) throw invalidGroupRecord("El registro ya no existe.", 404);
    sendJson(response, 200, { deleted: Number(recordId) });
  } catch (error) {
    sendHistoryRecordError(response, error, "No se pudo eliminar el registro por tiempo.");
  }
}

function normalizeLiveActivity(activity, usersById, tasksById, brandsById, storesById, history = []) {
  const worker = usersById.get(Number(activity.trabajador_id));
  const leader = usersById.get(Number(activity.encargado_id));
  const task = tasksById.get(Number(activity.tarea_id));
  return {
    ...activity,
    trabajador_nombre: worker?.nombre || worker?.email || `Usuario ${activity.trabajador_id}`,
    trabajador_email: worker?.email || "",
    encargado_nombre: leader?.nombre || leader?.email || `Usuario ${activity.encargado_id}`,
    tarea_nombre: taskTitle(task) || `Tarea ${activity.tarea_id}`,
    marca_nombre: brandsById.get(Number(activity.marca_id))?.nombre || "",
    tienda_nombre: storesById.get(Number(activity.tienda_id))?.nombre || "",
    history
  };
}

async function selectLiveGroupLeaderActivities() {
  const activitiesResult = await supabase
    .from("actividades_jefe_equipo")
    .select("*")
    .order("hora_inicio", { ascending: false });
  if (activitiesResult.error) throw activitiesResult.error;
  const activities = activitiesResult.data || [];
  if (!activities.length) return [];

  const activityIds = activities.map((item) => Number(item.id));
  const [usersResult, tasksResult, brandsResult, storesResult, historyResult] = await Promise.all([
    supabase.from("usuarios").select("id,nombre,email"),
    supabase.from(await getTaskTableName()).select("*"),
    supabase.from("marcas").select("id,nombre"),
    supabase.from("tiendas").select("id,nombre"),
    supabase.from("actividades_jefe_equipo_historial").select("*").in("actividad_id", activityIds).order("created_at", { ascending: true }).order("id", { ascending: true })
  ]);
  if (usersResult.error) throw usersResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (brandsResult.error) throw brandsResult.error;
  if (storesResult.error) throw storesResult.error;
  if (historyResult.error) throw historyResult.error;

  const usersById = new Map((usersResult.data || []).map((item) => [Number(item.id), item]));
  const tasksById = new Map((tasksResult.data || []).map((item) => [Number(item.id), item]));
  const brandsById = new Map((brandsResult.data || []).map((item) => [Number(item.id), item]));
  const storesById = new Map((storesResult.data || []).map((item) => [Number(item.id), item]));
  const historyByActivity = new Map();
  (historyResult.data || []).forEach((item) => {
    const key = Number(item.actividad_id);
    if (!historyByActivity.has(key)) historyByActivity.set(key, []);
    historyByActivity.get(key).push(item);
  });
  return activities.map((item) => normalizeLiveActivity(
    item,
    usersById,
    tasksById,
    brandsById,
    storesById,
    historyByActivity.get(Number(item.id)) || []
  ));
}

async function taskWithScoringRules(taskId) {
  const tableName = await getTaskTableName();
  const [taskResult, rulesResult] = await Promise.all([
    supabase.from(tableName).select("*").eq("id", taskId).eq("es_operativa", true).maybeSingle(),
    supabase.from("reglas_puntaje").select("*").eq("tarea_id", taskId)
  ]);
  if (taskResult.error) throw taskResult.error;
  if (rulesResult.error) throw rulesResult.error;
  return taskResult.data ? applyScoringRules(taskResult.data, rulesResult.data || []) : null;
}

async function validateLiveActivityContext(body) {
  const taskId = Number(body.tarea_id);
  const workerId = Number(body.trabajador_id);
  if (!Number.isInteger(taskId) || taskId <= 0 || !Number.isInteger(workerId) || workerId <= 0) {
    throw new Error("Trabajador y tarea son obligatorios.");
  }
  const [task, workerResult] = await Promise.all([
    taskWithScoringRules(taskId),
    supabase.from("usuarios").select("id,rol,activo").eq("id", workerId).maybeSingle()
  ]);
  if (!task || !isActive(task.activo) || !isGroupLeaderTimeTask(task)) {
    throw new Error("Selecciona una tarea por tiempo valida.");
  }
  if (workerResult.error || !workerResult.data || !isTimedTaskWorkerRole(workerResult.data.rol) || !isActive(workerResult.data.activo)) {
    throw new Error("Selecciona un operante o lider de equipo activo.");
  }
  return { task, taskId, workerId };
}

async function insertLiveActivityHistory(activityId, quantity, userId, type, points = null) {
  let result = await supabase.from("actividades_jefe_equipo_historial").insert({
    actividad_id: activityId,
    cantidad: quantity,
    registrado_por: userId,
    tipo: type,
    puntaje: points
  });
  if (isPrimaryKeySequenceConflict(result.error)) {
    result = await supabase.from("actividades_jefe_equipo_historial").insert({
      id: await nextTableId("actividades_jefe_equipo_historial"),
      actividad_id: activityId,
      cantidad: quantity,
      registrado_por: userId,
      tipo: type,
      puntaje: points
    });
  }
  if (result.error) throw result.error;
}

async function handleCreateLiveGroupLeaderActivity(request, response) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const { task, taskId, workerId } = await validateLiveActivityContext(body);
    const start = new Date(body.hora_inicio || "");
    if (Number.isNaN(start.getTime())) {
      sendJson(response, 400, { error: "Selecciona una hora de inicio valida." });
      return;
    }
    if (start.getTime() > Date.now() + 60000) {
      sendJson(response, 400, { error: "La hora de inicio no puede estar en el futuro." });
      return;
    }
    const startLimaDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: ATTENDANCE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(start);
    if (startLimaDate !== currentLimaDate()) {
      sendJson(response, 400, { error: "La hora de inicio debe pertenecer al dia actual en Lima." });
      return;
    }
    const openResult = await supabase.from("actividades_jefe_equipo").select("id").eq("trabajador_id", workerId).eq("estado", "EN_CURSO").maybeSingle();
    if (openResult.error) throw openResult.error;
    if (openResult.data) {
      sendJson(response, 409, { error: "El operante ya tiene una actividad en curso. Finalizala antes de iniciar otra." });
      return;
    }

    const liveFields = getTaskFieldFlags(task);
    const liveRequired = getTaskRequiredFlags(task);
    const allowsStore = liveFields.tienda;
    const requiresStore = allowsStore && liveRequired.tienda;
    const tiendaId = nullableNumber(body.tienda_id);
    const guideNumber = String(body.numero_guia || body.codigo_guia || "").trim();
    if (requiresStore && !tiendaId) {
      sendJson(response, 400, { error: `Selecciona una tienda para ${taskTitle(task)}.` });
      return;
    }
    if (guideNumber && !liveFields.guia) {
      sendJson(response, 400, { error: `El numero de guia no esta disponible para ${taskTitle(task)}.` });
      return;
    }
    if (tiendaId) {
      const storeResult = await supabase.from("tiendas").select("id,activo").eq("id", tiendaId).maybeSingle();
      if (storeResult.error || !storeResult.data || !isActive(storeResult.data.activo)) {
        sendJson(response, 400, { error: "Selecciona una tienda activa y valida." });
        return;
      }
    }
    const payload = {
      encargado_id: Number(session.id),
      trabajador_id: workerId,
      tarea_id: taskId,
      fecha_registro: currentLimaDate(),
      hora_inicio: start.toISOString(),
      cantidad: 0,
      puntaje: null,
      numero_guia: guideNumber || null,
      lote: null,
      marca_id: null,
      tienda_id: allowsStore ? tiendaId : null,
      observacion: String(body.observacion || body.detalle || "").trim() || null,
      estado: "EN_CURSO",
      updated_at: new Date().toISOString()
    };
    const result = await supabase.rpc("iniciar_actividad_jefe_equipo", {
      p_encargado_id: payload.encargado_id,
      p_trabajador_id: payload.trabajador_id,
      p_tarea_id: payload.tarea_id,
      p_fecha_registro: payload.fecha_registro,
      p_hora_inicio: payload.hora_inicio,
      p_numero_guia: payload.numero_guia,
      p_lote: payload.lote,
      p_marca_id: payload.marca_id,
      p_tienda_id: payload.tienda_id,
      p_observacion: payload.observacion
    });
    if (result.error?.code === "23505") {
      sendJson(response, 409, { error: "El operante ya tiene una actividad en curso." });
      return;
    }
    if (result.error) throw result.error;
    const createdActivity = Array.isArray(result.data) ? result.data[0] : result.data;
    const activity = (await selectLiveGroupLeaderActivities()).find((item) => Number(item.id) === Number(createdActivity.id));
    sendJson(response, 201, { activity });
  } catch (error) {
    if (/obligatorios|valida|activo/i.test(String(error?.message || "")) && !operationsSchemaMissing(error)) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    handleOperationsError(response, error, "No se pudo iniciar la actividad.");
  }
}

async function handleUpdateLiveGroupLeaderActivity(request, response, activityId) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const currentResult = await supabase.from("actividades_jefe_equipo").select("*").eq("id", activityId).maybeSingle();
    if (currentResult.error) throw currentResult.error;
    const current = currentResult.data;
    if (!current) {
      sendJson(response, 404, { error: "Actividad no encontrada." });
      return;
    }
    if (Number(current.encargado_id) !== Number(session.id)) {
      sendJson(response, 403, { error: "Solo el jefe que inicio la actividad puede actualizarla." });
      return;
    }
    if (current.estado !== "EN_CURSO") {
      sendJson(response, 409, { error: "La actividad ya fue finalizada y no admite mas cambios." });
      return;
    }
    const task = await taskWithScoringRules(current.tarea_id);
    if (!task || !isActive(task.activo) || !isGroupLeaderTimeTask(task)) {
      sendJson(response, 409, { error: "La tarea de esta actividad ya no esta activa o disponible." });
      return;
    }
    const fields = getTaskFieldFlags(task);
    const required = getTaskRequiredFlags(task);
    const supportsMetadata = fields.marca || fields.lote;
    const hasBrandField = Object.hasOwn(body, "marca_id");
    const hasLoteField = Object.hasOwn(body, "lote");
    const hasUnexpectedBrand = hasBrandField && body.marca_id !== null && body.marca_id !== "";
    const hasUnexpectedLote = hasLoteField && String(body.lote || "").trim() !== "";
    if (!fields.marca && hasUnexpectedBrand) {
      sendJson(response, 400, { error: `La marca no esta disponible para ${taskTitle(task)}.` });
      return;
    }
    if (!fields.lote && hasUnexpectedLote) {
      sendJson(response, 400, { error: `El lote no esta disponible para ${taskTitle(task)}.` });
      return;
    }
    if (!supportsMetadata && Boolean(body.actualizar_datos)) {
      sendJson(response, 400, { error: `${taskTitle(task)} no tiene datos adicionales que actualizar.` });
      return;
    }
    let marcaId = fields.marca
      ? (hasBrandField ? nullableNumber(body.marca_id) : nullableNumber(current.marca_id))
      : null;
    const lote = fields.lote
      ? (hasLoteField ? String(body.lote || "").trim().toUpperCase() || null : current.lote || null)
      : null;
    if (lote && lote.length > 100) {
      sendJson(response, 400, { error: "El codigo de lote no puede superar 100 caracteres." });
      return;
    }
    if (hasBrandField && body.marca_id !== null && body.marca_id !== "" && (!Number.isInteger(marcaId) || marcaId <= 0)) {
      sendJson(response, 400, { error: "Selecciona una marca valida." });
      return;
    }
    if (marcaId) {
      const brandResult = await supabase.from("marcas").select("id").eq("id", marcaId).maybeSingle();
      if (brandResult.error) throw brandResult.error;
      if (!brandResult.data) {
        sendJson(response, 400, { error: "Selecciona una marca valida." });
        return;
      }
    }
    const metadataOnly = Boolean(body.actualizar_datos);
    const quantity = metadataOnly ? Number(current.cantidad || 0) : Number(body.cantidad);
    if (!Number.isInteger(quantity) || quantity < 0) {
      sendJson(response, 400, { error: "La cantidad debe ser un numero entero mayor o igual a cero." });
      return;
    }
    if (quantity < Number(current.cantidad || 0)) {
      sendJson(response, 400, { error: "La cantidad no puede ser menor que la ultima cantidad registrada." });
      return;
    }
    const finishRequested = Boolean(body.finalizar) || Boolean(body.hora_fin);
    if (finishRequested && fields.marca && required.marca && !marcaId) {
      sendJson(response, 400, { error: `Selecciona una marca para ${taskTitle(task)}.` });
      return;
    }
    if (finishRequested && fields.lote && required.lote && !lote) {
      sendJson(response, 400, { error: `Ingresa un lote para ${taskTitle(task)}.` });
      return;
    }
    if (metadataOnly && finishRequested) {
      sendJson(response, 400, { error: "Guarda los datos o finaliza la actividad, pero no ambas acciones en modo solo datos." });
      return;
    }
    const metadataChanged = supportsMetadata && (
      Number(marcaId || 0) !== Number(current.marca_id || 0) ||
      String(lote || "") !== String(current.lote || "")
    );
    if (!finishRequested && quantity === Number(current.cantidad || 0) && !metadataChanged && !metadataOnly) {
      sendJson(response, 400, { error: "Ingresa una cantidad mayor para registrar un nuevo avance." });
      return;
    }

    if (!finishRequested) {
      const updateResult = await supabase.rpc("actualizar_actividad_jefe_equipo", {
        p_actividad_id: activityId,
        p_encargado_id: Number(session.id),
        p_cantidad: quantity,
        p_hora_fin: null,
        p_marca_id: marcaId,
        p_lote: lote,
        p_actualizar_datos: metadataChanged || metadataOnly
      });
      if (updateResult.error) throw updateResult.error;
      if (!updateResult.data) {
        sendJson(response, 409, { error: "La actividad fue modificada por otra solicitud. Actualiza la pantalla." });
        return;
      }
      const activity = (await selectLiveGroupLeaderActivities()).find((item) => Number(item.id) === Number(activityId));
      sendJson(response, 200, { activity });
      return;
    }

    if (quantity <= 0) {
      sendJson(response, 400, { error: "Para finalizar, la cantidad debe ser mayor a cero." });
      return;
    }
    if (supportsMetadata && !marcaId) {
      sendJson(response, 400, { error: "Selecciona una marca antes de finalizar la actividad de Etiquetado." });
      return;
    }
    const finish = new Date(body.hora_fin || "");
    const start = new Date(current.hora_inicio);
    if (Number.isNaN(finish.getTime()) || finish <= start || finish.getTime() > Date.now() + 60000) {
      sendJson(response, 400, { error: "La hora fin debe ser posterior al inicio y no puede estar en el futuro." });
      return;
    }
    const closeResult = await supabase.rpc("actualizar_actividad_jefe_equipo", {
      p_actividad_id: activityId,
      p_encargado_id: Number(session.id),
      p_cantidad: quantity,
      p_hora_fin: finish.toISOString(),
      p_marca_id: marcaId,
      p_lote: lote,
      p_actualizar_datos: supportsMetadata
    });
    if (closeResult.error?.code === "23514") {
      sendJson(response, 409, { error: closeResult.error.message || "La actividad o sus reglas cambiaron. Actualiza la pantalla e intenta nuevamente." });
      return;
    }
    if (closeResult.error) throw closeResult.error;
    const activity = (await selectLiveGroupLeaderActivities()).find((item) => Number(item.id) === Number(activityId));
    sendJson(response, 200, { activity });
  } catch (error) {
    handleOperationsError(response, error, "No se pudo actualizar la actividad.");
  }
}

async function handleCancelLiveGroupLeaderActivity(request, response, activityId) {
  try {
    const session = requireSessionRole(request, response, ["lider de equipo", "otros"]);
    if (!session) return;
    const currentResult = await supabase.from("actividades_jefe_equipo").select("id,encargado_id,estado,registro_tarea_id").eq("id", activityId).maybeSingle();
    if (currentResult.error) throw currentResult.error;
    if (!currentResult.data) {
      sendJson(response, 404, { error: "Actividad no encontrada." });
      return;
    }
    if (Number(currentResult.data.encargado_id) !== Number(session.id)) {
      sendJson(response, 403, { error: "Solo el jefe que inicio la actividad puede cancelarla." });
      return;
    }
    if (currentResult.data.estado !== "EN_CURSO" || currentResult.data.registro_tarea_id) {
      sendJson(response, 409, { error: "Solo se pueden cancelar actividades que siguen en curso." });
      return;
    }
    const deleteResult = await supabase.from("actividades_jefe_equipo").delete().eq("id", activityId).eq("estado", "EN_CURSO").select("id").maybeSingle();
    if (deleteResult.error) throw deleteResult.error;
    sendJson(response, 200, { deleted: Boolean(deleteResult.data) });
  } catch (error) {
    handleOperationsError(response, error, "No se pudo cancelar la actividad.");
  }
}

async function loadIncidentData() {
  const [usersResult, tasksResult, storesResult, areasResult, incidentsResult] = await Promise.all([
    supabase.from("usuarios").select("id,nombre,email,rol,activo").order("id", { ascending: true }),
    supabase.from("tarea_error").select("id,nombre,activo").order("id", { ascending: true }),
    supabase.from("tiendas").select("id,nombre,activo").order("id", { ascending: true }),
    supabase.from("areas_departamento").select("id,nombre").order("nombre", { ascending: true }),
    supabase
      .from("registro_errores")
      .select("id_error,turno,tarea_error_id,tienda_id,numero_guia,numero_lote,observacion,tipo_error,usuario_id,fecha_error,area_id")
      .order("fecha_error", { ascending: false })
  ]);

  if (usersResult.error) throw usersResult.error;
  if (tasksResult.error) throw tasksResult.error;
  if (storesResult.error) throw storesResult.error;
  if (areasResult.error) throw areasResult.error;
  if (incidentsResult.error) throw incidentsResult.error;

  const stores = (storesResult.data || []).filter((store) => isActive(store.activo));
  const storeNames = new Map((storesResult.data || []).map((store) => [Number(store.id), store.nombre]));
  const userNames = new Map((usersResult.data || []).map((user) => [Number(user.id), user.nombre || user.email]));
  const taskNames = new Map((tasksResult.data || []).map((task) => [Number(task.id), taskTitle(task)]));
  const areaNames = new Map((areasResult.data || []).map((area) => [Number(area.id), area.nombre]));
  const incidents = (incidentsResult.data || []).map((incident) => ({
    ...incident,
    tienda_nombre: storeNames.get(Number(incident.tienda_id)) || "",
    usuario_nombre: userNames.get(Number(incident.usuario_id)) || "",
    tarea_nombre: taskNames.get(Number(incident.tarea_error_id)) || "",
    area_nombre: areaNames.get(Number(incident.area_id)) || ""
  }));

  return {
    workers: (usersResult.data || []).filter((user) => isActive(user.activo)),
    tasks: (tasksResult.data || []).filter((task) => isActive(task.activo)),
    stores,
    areas: areasResult.data || [],
    incidents
  };
}

async function handleIncidentContext(request, response) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"])) return;
    sendJson(response, 200, await loadIncidentData());
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudieron cargar las incidencias." });
  }
}

async function handleCreateIncident(request, response) {
  try {
    const session = requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"]);
    if (!session) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const workerId = Number(body.usuario_id);
    const taskId = Number(body.tarea_error_id);
    const storeId = Number(body.tienda_id);
    const turno = String(body.turno || "").trim().toLowerCase();
    const guideNumber = String(body.numero_guia || "").trim();
    const lotNumber = String(body.numero_lote || "").trim();
    const errorType = String(body.tipo_error || "").trim().toUpperCase();
    const incidentDate = String(body.fecha_error || currentLimaDate()).trim();
    const areaId = Number(body.area_id);
    const isAreaIncident = ["incidencia", "error"].includes(turno);

    if (![taskId, storeId].every((id) => Number.isInteger(id) && id > 0)) {
      sendJson(response, 400, { error: "Tarea y tienda son obligatorias." });
      return;
    }
    if (!turno || !errorType) {
      sendJson(response, 400, { error: "Turno y tipo de error son obligatorios." });
      return;
    }
    const parsedIncidentDate = new Date(`${incidentDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate)
      || Number.isNaN(parsedIncidentDate.getTime())
      || parsedIncidentDate.toISOString().slice(0, 10) !== incidentDate
      || incidentDate > currentLimaDate()) {
      sendJson(response, 400, { error: "Selecciona una fecha del error valida que no este en el futuro." });
      return;
    }
    if (!["CONTENIDO", "LIBERADO"].includes(errorType)) {
      sendJson(response, 400, { error: "El tipo de error debe ser CONTENIDO o LIBERADO." });
      return;
    }
    if (!["turno regular", "incidencia", "error", "turno extra"].includes(turno)) {
      sendJson(response, 400, { error: "Selecciona un turno valido." });
      return;
    }
    if (isAreaIncident && (!Number.isInteger(areaId) || areaId <= 0)) {
      sendJson(response, 400, { error: "Selecciona un area valida." });
      return;
    }
    if (!isAreaIncident && (!Number.isInteger(workerId) || workerId <= 0)) {
      sendJson(response, 400, { error: "Selecciona un trabajador activo." });
      return;
    }

    const [workerResult, taskResult, storeResult, areaResult] = await Promise.all([
      isAreaIncident ? Promise.resolve({ data: null, error: null }) : supabase.from("usuarios").select("id,nombre,email,rol,activo").eq("id", workerId).maybeSingle(),
      supabase.from("tarea_error").select("id,nombre,activo").eq("id", taskId).maybeSingle(),
      supabase.from("tiendas").select("id,nombre,activo").eq("id", storeId).maybeSingle(),
      isAreaIncident ? supabase.from("areas_departamento").select("id,nombre").eq("id", areaId).maybeSingle() : Promise.resolve({ data: null, error: null })
    ]);

    const worker = workerResult.data;
    const task = taskResult.data;
    const store = storeResult.data;
    const area = areaResult.data;
    if (!isAreaIncident && (workerResult.error || !worker || !isActive(worker.activo))) {
      sendJson(response, 400, { error: "Selecciona un trabajador activo." });
      return;
    }
    if (taskResult.error || !task || !isActive(task.activo)) {
      sendJson(response, 400, { error: "Selecciona una tarea activa habilitada para incidencias." });
      return;
    }
    if (storeResult.error || !store || !isActive(store.activo)) {
      sendJson(response, 400, { error: "Selecciona una tienda activa." });
      return;
    }
    if (isAreaIncident && (areaResult.error || !area)) {
      sendJson(response, 400, { error: "Selecciona un area valida." });
      return;
    }

    const payload = {
      turno: isAreaIncident ? "incidencia" : turno,
      tarea_error_id: task.id,
      tienda_id: store.id,
      numero_guia: guideNumber,
      numero_lote: lotNumber || null,
      observacion: body.observacion ? String(body.observacion).trim() : null,
      tipo_error: errorType,
      usuario_id: isAreaIncident ? null : worker.id,
      area_id: isAreaIncident ? area.id : null,
      fecha_error: incidentDate
    };
    let result = await supabase.from("registro_errores").insert(payload).select("*").single();
    if (isPrimaryKeySequenceConflict(result.error)) {
      result = await supabase
        .from("registro_errores")
        .insert({ ...payload, id_error: await nextTableId("registro_errores", "id_error") })
        .select("*")
        .single();
    }
    if (result.error) {
      sendJson(response, 500, { error: result.error.message });
      return;
    }
    sendJson(response, 201, { incident: { ...result.data, tienda_nombre: store.nombre } });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "No se pudo guardar la incidencia." });
  }
}

async function handleUpdateIncident(request, response, incidentId) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"])) return;
    const body = JSON.parse((await readBody(request)) || "{}");
    const turno = String(body.turno || "").trim().toLowerCase();
    const isAreaIncident = ["incidencia", "error"].includes(turno);
    const payload = {
      turno: isAreaIncident ? "incidencia" : turno,
      tarea_error_id: Number(body.tarea_error_id),
      tienda_id: Number(body.tienda_id),
      numero_guia: String(body.numero_guia || "").trim(),
      numero_lote: String(body.numero_lote || "").trim() || null,
      observacion: String(body.observacion || "").trim() || null,
      tipo_error: String(body.tipo_error || "").trim().toUpperCase(),
      usuario_id: isAreaIncident ? null : Number(body.usuario_id),
      area_id: isAreaIncident ? Number(body.area_id) : null,
      fecha_error: String(body.fecha_error || "").trim()
    };
    if (!Number.isInteger(incidentId) || incidentId <= 0) throw invalidGroupRecord("Registro de error invalido.");
    if (![payload.tarea_error_id, payload.tienda_id].every((id) => Number.isInteger(id) && id > 0)) {
      throw invalidGroupRecord("Tarea y tienda son obligatorias.");
    }
    if (!["CONTENIDO", "LIBERADO"].includes(payload.tipo_error)) {
      throw invalidGroupRecord("El tipo de error es obligatorio.");
    }
    if (!["turno regular", "incidencia", "turno extra"].includes(payload.turno)) {
      throw invalidGroupRecord("Selecciona un turno valido.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.fecha_error) || payload.fecha_error > currentLimaDate()) {
      throw invalidGroupRecord("Selecciona una fecha valida que no este en el futuro.");
    }
    if (isAreaIncident && (!Number.isInteger(payload.area_id) || payload.area_id <= 0)) {
      throw invalidGroupRecord("Selecciona un area valida.");
    }
    if (!isAreaIncident && (!Number.isInteger(payload.usuario_id) || payload.usuario_id <= 0)) {
      throw invalidGroupRecord("Selecciona un trabajador activo.");
    }
    const result = await supabase
      .from("registro_errores")
      .update(payload)
      .eq("id_error", incidentId)
      .select("*")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw invalidGroupRecord("El registro de error no existe.", 404);
    sendJson(response, 200, { incident: result.data });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "No se pudo actualizar el error." });
  }
}

async function handleDeleteIncident(request, response, incidentId) {
  try {
    if (!requireSessionRole(request, response, ["administrador", "lider de equipo", "otros"])) return;
    if (!Number.isInteger(incidentId) || incidentId <= 0) throw invalidGroupRecord("Registro de error invalido.");
    const result = await supabase.from("registro_errores").delete().eq("id_error", incidentId).select("id_error").maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw invalidGroupRecord("El registro de error no existe.", 404);
    sendJson(response, 200, { deleted: Number(result.data.id_error) });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.message || "No se pudo eliminar el error." });
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".svg": "image/svg+xml"
  };
  return types[extension] || "application/octet-stream";
}

function serveStatic(request, response) {
  if (!fs.existsSync(distDir)) {
    sendJson(response, 404, { error: "Ejecuta npm.cmd run build antes de usar npm.cmd start." });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const safePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  let filePath = path.resolve(distDir, safePath);

  if (!filePath.startsWith(distDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  response.writeHead(200, { "content-type": contentTypeFor(filePath) });
  fs.createReadStream(filePath).pipe(response);
}

export async function handleRequest(request, response, { serveFiles = true } = {}) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const apiUrl = new URL(request.url, `http://${request.headers.host}`);
  const apiPath = decodeURIComponent(apiUrl.pathname);
  const trainingProfileMatch = apiPath.match(/^\/api\/users\/(\d+)\/trainings\/?$/);
  const trainingCourseMatch = apiPath.match(/^\/api\/users\/(\d+)\/trainings\/(CAP\s+\d+)\/?$/i);
  const trainingStatusMatch = apiPath.match(/^\/api\/trainings\/status\/(CAP\s+\d+)\/?$/i);
  const trainingCourseUpdateMatch = apiPath.match(/^\/api\/trainings\/courses\/(CAP\s+\d+)\/?$/i);
  const encargadoUpdateMatch = apiPath.match(/^\/api\/trainings\/encargados\/(\d+)\/?$/);
  const attendanceReportSettingMatch = apiPath.match(/^\/api\/attendance-report\/settings\/(\d+)\/?$/);
  const attendanceReportSendMatch = apiPath.match(/^\/api\/attendance-report\/settings\/(\d+)\/send\/?$/);
  const activityReportSettingMatch = apiPath.match(/^\/api\/activity-report\/settings\/(\d+)\/?$/);
  const activityReportSendMatch = apiPath.match(/^\/api\/activity-report\/settings\/(\d+)\/send\/?$/);
  const activityReportPreviewMatch = apiPath.match(/^\/api\/activity-report\/settings\/(\d+)\/preview\/?$/);
  const groupLeaderActivityMatch = apiPath.match(/^\/api\/group-leader\/activities\/(\d+)\/?$/);
  const groupLeaderRecordMatch = apiPath.match(/^\/api\/group-leader\/records\/(\d+)\/?$/);

  if (/^\/api\/health\/?$/.test(apiPath) && request.method === "GET") {
    sendJson(response, 200, {
      ok: true,
      apiVersion: 11,
      features: [
        "attendance-report",
        "attendance-report-schedules",
        "activity-report-shifts",
        "activity-report-schedules",
        "attendance-early-exit",
        "live-group-activities",
        "live-footwear-dashboard",
        "worker-live-progress",
        "group-history-times",
        "editable-group-history",
        "lote-stage-dates"
      ]
    });
    return;
  }

  if (trainingProfileMatch && request.method === "GET") {
    await handleReadUserTrainingProfile(request, response, Number(trainingProfileMatch[1]));
    return;
  }

  if (trainingCourseMatch && request.method === "PUT") {
    await handleUpdateUserTraining(
      request,
      response,
      Number(trainingCourseMatch[1]),
      trainingCourseMatch[2].toUpperCase().replace(/\s+/g, " ")
    );
    return;
  }

  if (/^\/api\/trainings\/courses\/?$/.test(apiPath) && request.method === "GET") {
    const includeInactive = apiUrl.searchParams.get("incluir_inactivos") === "1" || apiUrl.searchParams.get("all") === "1";
    await handleReadTrainingCourses(request, response, includeInactive);
    return;
  }

  if (/^\/api\/trainings\/courses\/?$/.test(apiPath) && request.method === "POST") {
    await handleCreateTrainingCourse(request, response);
    return;
  }

  if (trainingCourseUpdateMatch && request.method === "PUT") {
    await handleUpdateTrainingCourse(request, response, trainingCourseUpdateMatch[1]);
    return;
  }

  if (trainingCourseUpdateMatch && request.method === "DELETE") {
    await handleDeleteTrainingCourse(request, response, trainingCourseUpdateMatch[1]);
    return;
  }

  if (/^\/api\/trainings\/bulk\/?$/.test(apiPath) && request.method === "PUT") {
    await handleBulkUpdateTraining(request, response);
    return;
  }

  if (trainingStatusMatch && request.method === "GET") {
    await handleReadTrainingStatus(request, response, trainingStatusMatch[1]);
    return;
  }

  if (/^\/api\/trainings\/encargados\/?$/.test(apiPath) && request.method === "GET") {
    const includeInactive = apiUrl.searchParams.get("all") === "1";
    await handleReadEncargados(request, response, includeInactive);
    return;
  }

  if (/^\/api\/trainings\/encargados\/?$/.test(apiPath) && request.method === "POST") {
    await handleCreateEncargado(request, response);
    return;
  }

  if (encargadoUpdateMatch && request.method === "PATCH") {
    await handleUpdateEncargado(request, response, Number(encargadoUpdateMatch[1]));
    return;
  }

  if (request.url?.startsWith("/api/login") && request.method === "POST") {
    await handleLogin(request, response);
    return;
  }

  if (/^\/api\/dashboard\/?$/.test(apiPath) && request.method === "GET") {
    await handleReadFootwearDashboard(request, response);
    return;
  }

  if (request.url?.startsWith("/api/users") && request.method === "GET") {
    await handleReadUsers(request, response);
    return;
  }

  if (request.url?.startsWith("/api/personnel-movements") && request.method === "GET") {
    await handleReadPersonnelMovements(request, response);
    return;
  }

  if (request.url?.startsWith("/api/brands") && request.method === "GET") {
    await handleReadBrands(request, response);
    return;
  }

  if (request.url?.startsWith("/api/brands/") && ["PATCH", "DELETE"].includes(request.method)) {
    const brandId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateBrand(request, response, brandId);
    else await handleDeleteBrand(request, response, brandId);
    return;
  }

  if (request.url?.startsWith("/api/brands") && request.method === "POST") {
    await handleCreateBrand(request, response);
    return;
  }

  if (request.url?.startsWith("/api/users/") && ["PATCH", "DELETE"].includes(request.method)) {
    const userId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateUser(request, response, userId);
    else await handleDeleteUser(request, response, userId);
    return;
  }

  if (request.url?.startsWith("/api/users") && request.method === "POST") {
    await handleCreateUser(request, response);
    return;
  }

  if (request.url?.startsWith("/api/tasks/") && ["PATCH", "DELETE"].includes(request.method)) {
    const taskId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateTask(request, response, taskId);
    else await handleDeleteTask(request, response, taskId);
    return;
  }

  if (request.url?.startsWith("/api/tasks") && request.method === "GET") {
    await handleReadTasks(request, response);
    return;
  }

  if (request.url?.startsWith("/api/tasks") && request.method === "POST") {
    await handleCreateTask(request, response);
    return;
  }

  if (request.url?.startsWith("/api/task-score-ranges") && request.method === "GET") {
    await handleReadTaskScoreRanges(request, response);
    return;
  }

  if (request.url?.startsWith("/api/task-score-ranges") && request.method === "PUT") {
    await handleReplaceTaskScoreRanges(request, response);
    return;
  }

  if (request.url?.startsWith("/api/task-score-ranges") && request.method === "DELETE") {
    await handleDeleteTaskScoreRanges(request, response);
    return;
  }

  if (request.url?.startsWith("/api/stores/") && ["PATCH", "DELETE"].includes(request.method)) {
    const storeId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateStore(request, response, storeId);
    else await handleDeleteStore(request, response, storeId);
    return;
  }

  if (request.url?.startsWith("/api/stores") && request.method === "GET") {
    await handleReadStores(request, response);
    return;
  }

  if (request.url?.startsWith("/api/stores") && request.method === "POST") {
    await handleCreateStore(request, response);
    return;
  }

  if (request.url?.startsWith("/api/lotes/general") && request.method === "GET") {
    await handleReadGeneralLoteAccumulations(request, response);
    return;
  }

  if (request.url?.startsWith("/api/lotes/") && ["PATCH", "DELETE"].includes(request.method)) {
    const loteId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateLote(request, response, loteId);
    else await handleDeleteLote(request, response, loteId);
    return;
  }

  if (request.url?.startsWith("/api/lotes") && request.method === "GET") {
    await handleReadLotes(request, response);
    return;
  }

  if (request.url?.startsWith("/api/lotes") && request.method === "POST") {
    await handleCreateLote(request, response);
    return;
  }

  if (request.url?.startsWith("/api/guias/import") && request.method === "POST") {
    await handleImportGuias(request, response);
    return;
  }

  if (request.url?.startsWith("/api/guias/items") && request.method === "GET") {
    await handleReadGuiaItems(request, response);
    return;
  }

  if (request.url?.startsWith("/api/guias") && request.method === "GET") {
    await handleReadGuias(request, response);
    return;
  }

  if (request.url?.startsWith("/api/log-asistencias") && request.method === "GET") {
    await handleReadLogAsistencias(request, response);
    return;
  }

  if (request.url?.startsWith("/api/amonestaciones/") && request.method === "DELETE") {
    const amonestacionId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    await handleDeleteAmonestacion(request, response, amonestacionId);
    return;
  }

  if (request.url?.startsWith("/api/amonestaciones") && request.method === "GET") {
    await handleReadAmonestaciones(request, response);
    return;
  }

  if (request.url?.startsWith("/api/amonestaciones") && request.method === "POST") {
    await handleCreateAmonestacion(request, response);
    return;
  }

  if (/^\/api\/attendance-report\/settings\/?$/.test(apiPath) && request.method === "GET") {
    await handleReadAttendanceReportSettings(request, response);
    return;
  }

  if (/^\/api\/attendance-report\/settings\/?$/.test(apiPath) && request.method === "POST") {
    await handleCreateAttendanceReportSettings(request, response);
    return;
  }

  if (/^\/api\/attendance-report\/settings\/?$/.test(apiPath) && request.method === "PUT") {
    await handleUpdateAttendanceReportSettings(request, response);
    return;
  }

  if (attendanceReportSendMatch && request.method === "POST") {
    await handleSendAttendanceReport(request, response, Number(attendanceReportSendMatch[1]));
    return;
  }

  if (attendanceReportSettingMatch && request.method === "PUT") {
    await handleUpdateAttendanceReportSettings(request, response, Number(attendanceReportSettingMatch[1]));
    return;
  }

  if (attendanceReportSettingMatch && request.method === "DELETE") {
    await handleDeleteAttendanceReportSettings(request, response, Number(attendanceReportSettingMatch[1]));
    return;
  }

  if (/^\/api\/attendance-report\/send\/?$/.test(apiPath) && request.method === "POST") {
    await handleSendAttendanceReport(request, response);
    return;
  }

  if (/^\/api\/activity-report\/settings\/?$/.test(apiPath) && request.method === "GET") {
    await handleReadActivityReportSettings(request, response);
    return;
  }

  if (/^\/api\/activity-report\/settings\/?$/.test(apiPath) && request.method === "POST") {
    await handleCreateActivityReportSettings(request, response);
    return;
  }

  if (/^\/api\/activity-report\/settings\/?$/.test(apiPath) && request.method === "PUT") {
    await handleUpdateActivityReportSettings(request, response);
    return;
  }

  if (activityReportSendMatch && request.method === "POST") {
    await handleSendActivityReport(request, response, Number(activityReportSendMatch[1]));
    return;
  }

  if (activityReportPreviewMatch && request.method === "GET") {
    await handlePreviewActivityReport(request, response, Number(activityReportPreviewMatch[1]));
    return;
  }

  if (activityReportSettingMatch && request.method === "PUT") {
    await handleUpdateActivityReportSettings(request, response, Number(activityReportSettingMatch[1]));
    return;
  }

  if (activityReportSettingMatch && request.method === "DELETE") {
    await handleDeleteActivityReportSettings(request, response, Number(activityReportSettingMatch[1]));
    return;
  }

  if (/^\/api\/activity-report\/preview\/?$/.test(apiPath) && request.method === "GET") {
    await handlePreviewActivityReport(request, response);
    return;
  }

  if (/^\/api\/activity-report\/send\/?$/.test(apiPath) && request.method === "POST") {
    await handleSendActivityReport(request, response);
    return;
  }

  if (request.url?.startsWith("/api/attendances") && request.method === "GET") {
    await handleReadAttendances(request, response);
    return;
  }

  if (request.url?.startsWith("/api/attendances") && request.method === "PUT") {
    await handleMarkAttendance(request, response);
    return;
  }

  if (/^\/api\/operational-records\/?$/.test(apiPath) && request.method === "GET") {
    await handleReadOperationalRecords(request, response);
    return;
  }

  if (request.url?.startsWith("/api/activity-logs") && request.method === "GET") {
    await handleReadActivityLogs(request, response);
    return;
  }

  if (request.url?.startsWith("/api/activity-logs") && request.method === "POST") {
    await handleCreateActivityLog(request, response);
    return;
  }

  if (request.url?.startsWith("/api/activity-records/") && ["PATCH", "DELETE"].includes(request.method)) {
    const recordId = Number(new URL(request.url, `http://${request.headers.host}`).pathname.split("/").pop());
    if (request.method === "PATCH") await handleUpdateActivityRecord(request, response, recordId);
    else await handleDeleteActivityRecord(request, response, recordId);
    return;
  }

  if (request.url?.startsWith("/api/group-leader/context") && request.method === "GET") {
    await handleGroupLeaderContext(request, response);
    return;
  }

  if (/^\/api\/group-leader\/average-reference\/?$/.test(apiPath) && request.method === "PUT") {
    await handleUpdateAverageReference(request, response);
    return;
  }

  if (/^\/api\/average-references\/?$/.test(apiPath) && request.method === "GET") {
    await handleReadAverageReferences(request, response);
    return;
  }

  if (/^\/api\/worker\/live-progress\/?$/.test(apiPath) && request.method === "GET") {
    await handleWorkerLiveProgress(request, response);
    return;
  }

  if (/^\/api\/group-leader\/activities\/?$/.test(apiPath) && request.method === "POST") {
    await handleCreateLiveGroupLeaderActivity(request, response);
    return;
  }

  if (groupLeaderActivityMatch && request.method === "PUT") {
    await handleUpdateLiveGroupLeaderActivity(request, response, Number(groupLeaderActivityMatch[1]));
    return;
  }

  if (groupLeaderActivityMatch && request.method === "DELETE") {
    await handleCancelLiveGroupLeaderActivity(request, response, Number(groupLeaderActivityMatch[1]));
    return;
  }

  if (/^\/api\/group-leader\/records\/?$/.test(apiPath) && request.method === "POST") {
    await handleCreateGroupLeaderRecord(request, response);
    return;
  }

  if (groupLeaderRecordMatch && request.method === "PUT") {
    await handleUpdateGroupLeaderRecord(request, response, Number(groupLeaderRecordMatch[1]));
    return;
  }

  if (groupLeaderRecordMatch && request.method === "DELETE") {
    await handleDeleteGroupLeaderRecord(request, response, Number(groupLeaderRecordMatch[1]));
    return;
  }

  const incidentMatch = apiPath.match(/^\/api\/incidents\/(\d+)\/?$/);

  if (request.url?.startsWith("/api/incidents/context") && request.method === "GET") {
    await handleIncidentContext(request, response);
    return;
  }

  if (request.url?.startsWith("/api/incidents") && request.method === "POST") {
    await handleCreateIncident(request, response);
    return;
  }

  if (incidentMatch && request.method === "PUT") {
    await handleUpdateIncident(request, response, Number(incidentMatch[1]));
    return;
  }

  if (incidentMatch && request.method === "DELETE") {
    await handleDeleteIncident(request, response, Number(incidentMatch[1]));
    return;
  }

  if (apiPath === "/api" || apiPath.startsWith("/api/")) {
    sendJson(response, 404, { error: "Ruta de API no encontrada." });
    return;
  }
  if (serveFiles) serveStatic(request, response);
  else sendJson(response, 404, { error: "Ruta de API no encontrada." });
}

const isMainModule = modulePath && process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (isMainModule) {
  const server = http.createServer((request, response) => handleRequest(request, response));
  server.listen(port, "127.0.0.1", () => {
    console.log(`Servidor local listo en http://127.0.0.1:${port}`);
  });
}
