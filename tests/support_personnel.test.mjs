import test from "node:test";
import assert from "node:assert/strict";
import { deleteSupportPersonRecord } from "../server.mjs";

function database(results) {
  const calls = [];
  return { calls, from(table) {
    const operation = { table, filters: [] };
    calls.push(operation);
    const query = {
      select() { return query; },
      eq(key, value) { operation.filters.push([key, value]); return query; },
      delete() { operation.action = "delete"; return query; },
      update(payload) { operation.action = "update"; operation.payload = payload; return query; },
      async maybeSingle() { return results.shift(); }
    };
    return query;
  } };
}

test("DNI incorrecto o ausente no permite eliminar", async () => {
  for (const dni of [undefined, "", "00000000"]) {
    const db = database([{ data: { id: 1, dni: "12345678" } }]);
    await assert.rejects(deleteSupportPersonRecord(db, 1, dni), { statusCode: 400 });
    assert.equal(db.calls.length, 1);
  }
});

test("persona que no es apoyo no se puede eliminar desde este recurso", async () => {
  const db = database([{ data: null }]);
  await assert.rejects(deleteSupportPersonRecord(db, 1, "12345678"), { statusCode: 404 });
  assert.deepEqual(db.calls[0].filters, [["id", 1], ["tipo", "Apoyo"]]);
  assert.equal(db.calls.length, 1);
});

test("elimina apoyo sin relaciones y restringe la operacion al tipo Apoyo", async () => {
  const db = database([{ data: { id: 1, dni: "12345678" } }, { data: { id: 1 } }]);
  assert.deepEqual(await deleteSupportPersonRecord(db, 1, "12345678"), { deleted: true, archived: false });
  assert.equal(db.calls[1].action, "delete");
  assert.deepEqual(db.calls[1].filters, [["id", 1], ["tipo", "Apoyo"]]);
});

test("conserva tareas relacionadas deshabilitando cuando la clave foranea impide eliminar", async () => {
  const db = database([{ data: { id: 1, dni: "12345678" } }, { error: { code: "23503" } }, { data: { id: 1 } }]);
  assert.deepEqual(await deleteSupportPersonRecord(db, 1, "12345678"), { deleted: false, archived: true });
  assert.deepEqual(db.calls[2].payload, { activo: false });
  assert.deepEqual(db.calls[2].filters, [["id", 1], ["tipo", "Apoyo"]]);
});

test("error de eliminacion no se presenta como exito ni deshabilita", async () => {
  const db = database([{ data: { id: 1, dni: "12345678" } }, { error: new Error("fallo") }]);
  await assert.rejects(deleteSupportPersonRecord(db, 1, "12345678"), /fallo/);
  assert.equal(db.calls.length, 2);
});
