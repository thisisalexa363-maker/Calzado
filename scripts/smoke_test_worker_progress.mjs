import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

function readEnv() {
  return Object.fromEntries(
    fs.readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
      })
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const env = readEnv();
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const origin = `http://127.0.0.1:${process.env.API_PORT || env.API_PORT || 5180}`;

async function api(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function loginFor(role) {
  const result = await db
    .from("usuarios")
    .select("id,email,password_hash")
    .eq("rol", role)
    .eq("activo", true)
    .limit(1)
    .single();
  if (result.error) throw result.error;
  const login = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ email: result.data.email, password: result.data.password_hash })
  });
  assert(login.response.ok && login.payload.sessionToken, `No se pudo iniciar sesión como ${role}.`);
  return { id: Number(result.data.id), auth: { authorization: `Bearer ${login.payload.sessionToken}` } };
}

const operante = await loginFor("operante");
const progress = await api("/api/worker/live-progress", { headers: operante.auth });
assert(progress.response.ok, progress.payload.error || "La consulta de progreso falló.");
assert(Array.isArray(progress.payload.activities), "La respuesta no incluye la lista de actividades.");
assert(
  progress.payload.activities.every((activity) => Number(activity.trabajador_id) === operante.id),
  "El endpoint expuso actividades de otro operante."
);

const administrator = await loginFor("administrador");
const forbidden = await api("/api/worker/live-progress", { headers: administrator.auth });
assert(forbidden.response.status === 403, "Un administrador no debe consumir la vista privada del operante.");

const leader = await loginFor("lider de equipo");
const allWorkerRecords = await api("/api/operational-records?source=normal&page=1&pageSize=25&includeCatalogs=true", {
  headers: leader.auth
});
assert(allWorkerRecords.response.ok, allWorkerRecords.payload.error || "El líder no pudo consultar los registros de todos los operantes.");
assert(Array.isArray(allWorkerRecords.payload.records), "La consulta del líder no devolvió registros paginados.");

const workerAllRecords = await api("/api/operational-records?source=normal&page=1&pageSize=25", {
  headers: operante.auth
});
assert(workerAllRecords.response.status === 403, "Un operante no debe consultar los registros de todos los operantes.");

console.log(JSON.stringify({
  ok: true,
  workerId: operante.id,
  activitiesVisible: progress.payload.activities.length,
  migrationRequired: Boolean(progress.payload.operationsMigrationRequired),
  administratorStatus: forbidden.response.status,
  leaderAllRecordsStatus: allWorkerRecords.response.status,
  leaderRecordsVisible: allWorkerRecords.payload.records.length,
  workerAllRecordsStatus: workerAllRecords.response.status
}, null, 2));
