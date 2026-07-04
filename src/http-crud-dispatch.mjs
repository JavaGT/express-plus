// CRUD dispatch for entity routes: list, read, create, update, remove.
//
// The route gate already admitted the request; here the SECOND default-on auth
// layer runs: the row grant's SQL scope (which rows are visible) and its .can
// capability (what may be done). Both must pass. A missing db is fail-closed (500):
// an entity CRUD route cannot serve without persistence.

import { randomUUID } from 'node:crypto';
import { ValidationError } from './field-strategy.mjs';
import { readProjectedCursors } from './projected-async.mjs';
import { projectedCursorHeaders } from './http-response.mjs';

// One kernel mutation through the write queue, translating the failure modes
// shared by create/update/remove: queue starvation → 503, validation → 400
// (remove opts out — its {id} payload has nothing to validate, so a
// ValidationError there is a real bug and propagates), grant deny → 403.
// Responds and returns null on failure; returns the granted result otherwise.
async function runKernelMutation(app, kernel, res, sendJson, action, { validation400 = true } = {}) {
  let result;
  try {
    result = await app.writeQueue.run(() => kernel.dispatch(action));
  } catch (err) {
    if (err?.status === 503) {
      sendJson(res, 503, { error: 'service busy' });
      return null;
    }
    if (validation400 && err instanceof ValidationError) {
      sendJson(res, 400, { error: err.message });
      return null;
    }
    throw err;
  }
  if (!result.granted) {
    sendJson(res, 403, { error: 'forbidden' });
    return null;
  }
  return result;
}

// DB-backed dispatch for one admitted verb.
export async function dispatchCrud({ entity, verb, db, principal, params, body, app, res,
  sendJson, committedEventHeaders, authorizeRow, mayRow }) {
  if (!db) {
    sendJson(res, 500, { error: 'no database configured for entity dispatch' });
    return;
  }
  const actionId = randomUUID();
  const table = entity.name;
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);

  if (verb === 'list') {
    const rows = db.prepare(`SELECT * FROM ${table} AS t0 WHERE ${where}`).all(scopeParams)
      .map((row) => entity.deserializeRow(row));
    // Post-filter through the SAME mayRow('list') engine `read` uses — the SQL
    // scope decides VISIBILITY, the .can body decides the read CAPABILITY. A
    // grant can admit a row via scope yet deny read in .can; without this list
    // would leak it (one auth path: list + read agree). mayRow owns inherit and
    // scope-only handling so list does not re-derive the skip.
    const listed = [];
    for (const row of rows) {
      if (await mayRow(entity, 'list', row, principal)) listed.push(row);
    }
    const cursorHeaders = projectedCursorHeaders(readProjectedCursors(db, entity));
    sendJson(res, 200, listed, { 'x-workbench-action-id': actionId, ...cursorHeaders });
    return;
  }

  if (verb === 'read') {
    // Scoped load + capability check: absent-or-invisible → 404, denied → 403.
    const auth = await authorizeRow({ db }, entity, 'read', params.id, principal);
    if (auth.status) {
      return void sendJson(res, auth.status, { error: auth.status === 404 ? 'not found' : 'forbidden' });
    }
    const cursorHeaders = projectedCursorHeaders(readProjectedCursors(db, entity));
    sendJson(res, 200, auth.row, { 'x-workbench-action-id': actionId, ...cursorHeaders });
    return;
  }

  if (verb === 'create') {
    const kernel = app?.kernel;
    if (!kernel) return void sendJson(res, 500, { error: 'no mutation kernel configured' });
    const result = await runKernelMutation(app, kernel, res, sendJson, { actionId, type: `${table}.create`, payload: body, principal });
    if (!result) return;
    const id = result.events[0].data.id;
    const created = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE t0.id = :id`)
      .get({ id });
    entity.deserializeRow(created);
    sendJson(res, 201, created, committedEventHeaders(result, actionId, `${table}:${id}`));
    return;
  }

  if (verb === 'update') {
    const kernel = app?.kernel;
    if (!kernel) return void sendJson(res, 500, { error: 'no mutation kernel configured' });
    const auth = await authorizeRow({ db }, entity, 'update', params.id, principal);
    if (auth.status) {
      return void sendJson(res, auth.status, { error: auth.status === 404 ? 'not found' : 'forbidden' });
    }
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.update`,
      payload: { ...body, id: params.id },
      principal,
    });
    if (!result) return;
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    entity.deserializeRow(updated);
    sendJson(res, 200, updated, committedEventHeaders(result, actionId, `${table}:${params.id}`));
    return;
  }

  if (verb === 'remove') {
    const kernel = app?.kernel;
    if (!kernel) return void sendJson(res, 500, { error: 'no mutation kernel configured' });
    const auth = await authorizeRow({ db }, entity, 'remove', params.id, principal);
    if (auth.status) {
      return void sendJson(res, auth.status, { error: auth.status === 404 ? 'not found' : 'forbidden' });
    }
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.remove`,
      payload: { id: params.id },
      principal,
    }, { validation400: false });
    if (!result) return;
    res.writeHead(204, committedEventHeaders(result, actionId, `${table}:${params.id}`));
    res.end();
    return;
  }

  // an unknown verb is fail-closed (the routing table only mints the five).
  sendJson(res, 500, { error: `unknown verb '${verb}'` });
}
