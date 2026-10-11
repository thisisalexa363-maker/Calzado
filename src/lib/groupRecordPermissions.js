export const GROUP_RECORD_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const GROUP_RECORD_LOCK_MESSAGE = "No se puede editar ni eliminar este registro: el plazo de 24 horas desde su creacion termino.";

export function isGroupRecordLocked(record, now = Date.now()) {
  const createdAt = record?.created_at ? Date.parse(record.created_at) : NaN;
  return !Number.isFinite(createdAt) || now >= createdAt + GROUP_RECORD_EDIT_WINDOW_MS;
}

export function assertGroupRecordEditable(record, now = Date.now()) {
  if (isGroupRecordLocked(record, now)) {
    const error = new Error(GROUP_RECORD_LOCK_MESSAGE);
    error.statusCode = 403;
    throw error;
  }
}
