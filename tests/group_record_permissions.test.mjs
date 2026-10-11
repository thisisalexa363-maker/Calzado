import assert from "node:assert/strict";
import test from "node:test";
import { isGroupRecordLocked, assertGroupRecordEditable } from "../src/lib/groupRecordPermissions.js";

const created = "2026-10-11T10:00:00-05:00";
const deadline = Date.parse("2026-10-12T15:00:00Z");
test("editing and deletion expire exactly 24 hours after creation", () => {
  const record = { created_at: created };
  assert.equal(isGroupRecordLocked(record, deadline - 1), false);
  assert.doesNotThrow(() => assertGroupRecordEditable(record, deadline - 1));
  assert.equal(isGroupRecordLocked(record, deadline), true);
  assert.throws(() => assertGroupRecordEditable(record, deadline), { statusCode: 403 });
  assert.equal(isGroupRecordLocked(record, deadline + 1), true);
});
test("updating the record or changing its work date does not extend the deadline", () => {
  assert.equal(isGroupRecordLocked({ created_at: created, updated_at: new Date(deadline).toISOString(), fecha_registro: "2026-10-12" }, deadline), true);
});
test("records without a valid creation timestamp cannot be changed", () => {
  for (const created_at of [null, undefined, "", "invalid"]) {
    assert.equal(isGroupRecordLocked({ created_at }, deadline), true);
    assert.throws(() => assertGroupRecordEditable({ created_at }, deadline), { statusCode: 403 });
  }
});
