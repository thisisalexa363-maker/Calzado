import assert from "node:assert/strict";
import test from "node:test";
import {
  attendanceDisplayState,
  attendanceGroup,
  calculateCompletedActivityPoints,
  elapsedMinutes,
  validateActivityCardMetadata,
  validateAttendanceEdit,
  validateProgressQuantity
} from "../src/lib/operations.js";
import { limaDateTimeToISO } from "../src/lib/dates.js";
import { validateQuantityRanges } from "../src/lib/scoring.js";
import { groupLeaderRecordTiming, rejectSupportRecord } from "../server.mjs";

test("retiro anticipado conserva puntualidad y exige motivo", () => {
  assert.equal(validateAttendanceEdit({ estado: "ASISTENCIA", retiro_anticipado: true, tipo_retiro: "personal", motivo_retiro: "" }), "Ingresa el motivo del retiro anticipado.");
  assert.equal(validateAttendanceEdit({ estado: "TARDANZA", retiro_anticipado: true, tipo_retiro: "personal", motivo_retiro: "Cita medica" }), "");
  assert.equal(attendanceDisplayState({ estado: "ASISTENCIA", retiro_anticipado: true }), "Retiro anticipado");
});

test("el retiro por apoyo exige un tipo de retiro valido", () => {
  assert.match(validateAttendanceEdit({ estado: "ASISTENCIA", retiro_anticipado: true, motivo_retiro: "Apoyo en tienda X" }), /apoyo.*personal/i);
  assert.equal(validateAttendanceEdit({ estado: "ASISTENCIA", retiro_anticipado: true, tipo_retiro: "apoyo", motivo_retiro: "Apoyo en tienda X" }), "");
});

test("solo un trabajador presente puede retirarse anticipadamente", () => {
  assert.match(validateAttendanceEdit({ estado: "FALTA", retiro_anticipado: true, motivo_retiro: "Motivo" }), /presente/i);
  assert.match(validateAttendanceEdit({ estado: "PERMISO", retiro_anticipado: true, motivo_retiro: "Motivo" }), /presente/i);
  assert.equal(attendanceDisplayState({ estado: "DESCANSO_MEDICO" }), "Descanso Médico");
  assert.equal(attendanceDisplayState({ estado: "SUSPENSION" }), "Suspensión");
});

test("medio turno y apoyo tambien pueden retirarse anticipadamente", () => {
  assert.equal(validateAttendanceEdit({ estado: "MEDIO_TURNO", retiro_anticipado: true, tipo_retiro: "personal", motivo_retiro: "Motivo" }), "");
  assert.equal(validateAttendanceEdit({ estado: "APOYO", retiro_anticipado: true, tipo_retiro: "apoyo", motivo_retiro: "Motivo" }), "");
});

test("los estados de asistencia se agrupan en asistencia, tardanza o ausente", () => {
  assert.equal(attendanceGroup("ASISTENCIA"), "asistencia");
  assert.equal(attendanceGroup("MEDIO_TURNO"), "asistencia");
  assert.equal(attendanceGroup("APOYO"), "asistencia");
  assert.equal(attendanceGroup("TARDANZA"), "tardanza");
  assert.equal(attendanceGroup("FALTA"), "ausente");
  assert.equal(attendanceGroup("SUSPENSION"), "ausente");
  assert.equal(attendanceGroup("DESCANSO_MEDICO"), "ausente");
  assert.equal(attendanceGroup("PERMISO"), "ausente");
});

test("la cantidad acumulada no puede disminuir", () => {
  assert.match(validateProgressQuantity(120, 119), /no puede ser menor/i);
  assert.equal(validateProgressQuantity(120, 120), "");
  assert.equal(validateProgressQuantity(120, 150), "");
});

test("marca y lote se validan dentro de la tarjeta de Etiquetado", () => {
  assert.match(validateActivityCardMetadata({ requiresBrand: true, allowsLote: true, requireBrand: true }), /marca/i);
  assert.match(validateActivityCardMetadata({ requiresBrand: true, allowsLote: true, marcaId: 2, useLote: true, lote: "", requireBrand: true }), /codigo de lote/i);
  assert.equal(validateActivityCardMetadata({ requiresBrand: true, allowsLote: true, marcaId: 2, useLote: true, lote: " a05 ", requireBrand: true }), "");
  assert.equal(validateActivityCardMetadata({ requiresBrand: true, allowsLote: true, requireBrand: false }), "");
});

test("otras tareas no aceptan lote", () => {
  assert.match(validateActivityCardMetadata({ allowsLote: false, useLote: true, lote: "A05" }), /solo esta disponible/i);
});

test("la duracion se obtiene de inicio y fin", () => {
  assert.equal(elapsedMinutes("2026-08-13T08:00:00-05:00", "2026-08-13T09:25:00-05:00"), 85);
  assert.equal(elapsedMinutes("2026-08-13T09:25:00-05:00", "2026-08-13T08:00:00-05:00"), 0);
});

test("el puntaje final usa las reglas de cantidad", () => {
  const task = {
    tipo_medicion: "cantidad",
    reglas_puntaje: [
      { tipo_regla: "CANTIDAD", desde: 0, hasta: 20, puntos: 1 },
      { tipo_regla: "CANTIDAD", desde: 21, hasta: 40, puntos: 2 }
    ]
  };
  assert.equal(calculateCompletedActivityPoints(task, 20), 1);
  assert.equal(calculateCompletedActivityPoints(task, 21), 2);
  assert.equal(calculateCompletedActivityPoints(task, 41), 0);
});

test("convierte fecha y hora de Lima y permite cierres después de medianoche", () => {
  assert.equal(limaDateTimeToISO("2026-08-14", "00:15"), "2026-08-14T05:15:00.000Z");
  assert.equal(limaDateTimeToISO("", "00:15"), "");
});

test("el rango de 10 puntos debe quedar abierto", () => {
  const ranges = Array.from({ length: 10 }, (_, index) => ({
    desde: index * 10,
    hasta: index === 9 ? 999 : index * 10 + 9,
    puntos: index + 1
  }));
  assert.match(validateQuantityRanges(ranges), /sin limite|vacío|vacío/i);
  ranges[9].hasta = "";
  assert.equal(validateQuantityRanges(ranges), "");
});

test("el historial del jefe deriva fecha y minutos de inicio y fin", () => {
  const timing = groupLeaderRecordTiming(
    "2026-08-13T08:05:00-05:00",
    "2026-08-13T09:35:00-05:00",
    { now: new Date("2026-08-13T10:00:00-05:00").getTime() }
  );
  assert.equal(timing.fecha_registro, "2026-08-13");
  assert.equal(timing.tiempo_minutos, 90);
  assert.equal(timing.hora_inicio, "2026-08-13T13:05:00.000Z");
  assert.equal(timing.hora_fin, "2026-08-13T14:35:00.000Z");
});

test("el historial rechaza fin anterior, futuro y duraciones absurdas", () => {
  const now = new Date("2026-08-13T10:00:00-05:00").getTime();
  assert.throws(
    () => groupLeaderRecordTiming("2026-08-13T09:00:00-05:00", "2026-08-13T08:00:00-05:00", { now }),
    /posterior/i
  );
  assert.throws(
    () => groupLeaderRecordTiming("2026-08-13T09:00:00-05:00", "2026-08-13T10:05:00-05:00", { now }),
    /futuro/i
  );
  assert.throws(
    () => groupLeaderRecordTiming("2026-08-11T08:00:00-05:00", "2026-08-13T08:01:00-05:00", { now }),
    /24 horas/i
  );
});


test("bloquea registros fuera de tareas por tiempo para apoyo y permite usuarios normales", async () => {
  for (const tipo of ["Apoyo", "Normal", null]) {
    const database = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 7, tipo } }) }) }) }) };
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    assert.equal(await rejectSupportRecord(7, response, database), tipo === "Apoyo");
    if (tipo === "Apoyo") {
      assert.equal(response.status, 403);
      assert.match(response.body.error, /solo.*tareas con tiempo/);
    } else assert.equal(response.status, undefined);
  }
});

test("no permite continuar cuando falla la consulta del tipo de personal", async () => {
  const error = new Error("consulta fallida");
  const database = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ error }) }) }) }) };
  await assert.rejects(rejectSupportRecord(7, {}, database), /consulta fallida/);
});
