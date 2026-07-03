import { bindReadScope } from './scope-sql.mjs';
import { mayRow } from './row-grant.mjs';

export function readScopedRow(app, entity, id, principal) {
  const bound = bindReadScope(entity.readScope, principal);
  const where = bound ? bound.sql : '1=1';
  const scopeParams = bound ? bound.params : {};
  const row = app.db
    .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
    .get({ ...scopeParams, id });
  return entity.deserializeRow(row);
}

// Scoped row load + capability check for one verb. Absent-or-invisible → 404
// (do not distinguish, fail closed); visible but denied by .can → 403.
export async function authorizeRow(app, entity, verb, id, principal, preRow = null) {
  const row = preRow ?? readScopedRow(app, entity, id, principal);
  if (!row) return { status: 404 };
  if (!(await mayRow(entity, verb, row, principal))) return { status: 403 };
  return { row };
}
