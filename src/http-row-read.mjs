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

export async function authorizeRead(app, entity, id, principal, preRow = null) {
  const row = preRow ?? readScopedRow(app, entity, id, principal);
  if (!row) return { status: 404 };
  if (!(await mayRow(entity, 'read', row, principal))) return { status: 403 };
  return { row };
}
