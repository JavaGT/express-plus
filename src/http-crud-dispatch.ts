// @ts-nocheck
// CRUD dispatch for entity routes: list, read, create, update, remove.
//
// The route gate already admitted the request; here the SECOND default-on auth
// layer runs: the row grant's SQL scope (which rows are visible) and its .can
// capability (what may be done). Both must pass. A missing db is fail-closed (500):
// an entity CRUD route cannot serve without persistence.

import { randomUUID } from 'node:crypto';
import { ValidationError } from './field-strategy.ts';
import { readProjectedCursors } from './projected-async.ts';
import { projectedCursorHeaders } from './http-response.ts';
import { mayRow } from './row-grant.ts';
import { scopeOf } from './scope-handle.ts';
import { failure } from './outcome.ts';
import { sendFailure } from './http-failure.ts';
import { readDeletedRowAnchor } from './deleted-row-anchor.ts';

// One kernel mutation through the write queue, translating the failure modes
// shared by create/update/remove: queue starvation → 503, validation → 400
// (remove opts out — its {id} payload has nothing to validate, so a
// ValidationError there is a real bug and propagates), grant deny → 403.
// Responds and returns null on failure; returns the successful result otherwise.
async function runKernelMutation(app, kernel, res, sendJson, action, { validation400 = true } = {}) {
  let result;
  try {
    result = await app.writeQueue.run(() => kernel.dispatch(action));
  } catch (err) {
    if (err?.status === 503) {
      sendFailure(sendJson, res, failure('conflict', 'service busy'), { status: 503 });
      return null;
    }
    if (validation400 && err instanceof ValidationError) {
      sendFailure(sendJson, res, failure('invalid-input', err.message));
      return null;
    }
    throw err;
  }
  if (!result.ok) {
    sendFailure(sendJson, res, result.failure);
    return null;
  }
  return result;
}

export function readScopedRow(app, entity, id, principal) {
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);
  return app.db
    .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
    .get({ ...scopeParams, id });
}

// `allowDeletedAnchor` is a narrow, explicit opt-in (default off — every
// existing caller is unaffected). When set and the live row is gone, it falls
// back to the row's captured deleted-row history anchor (Wave 3.7 Contract 1)
// and runs the SAME mayRow grant check against that historical snapshot. This
// is not a second auth engine and not a second "current row" source: it never
// resurrects CRUD or list visibility, only lets a principal who held a grant
// AT THE TIME OF DELETION continue past the row-gate for a historical read
// (events-since). A denial on the historical path returns 404, matching a
// genuinely-nonexistent row — indistinguishable from the outside, so a
// non-owner cannot use the response to learn the row ever existed.
export async function authorizeRow(app, entity, verb, id, principal, preRow = null, { allowDeletedAnchor = false } = {}) {
  const row = preRow ?? readScopedRow(app, entity, id, principal);
  if (row) {
    // Authorization and route hydration have different ownership: grants see a
    // materialized copy, while callers retain the stored row for one later
    // hydration at their public boundary.
    const materialized = entity.deserializeRow({ ...row });
    if (!(await mayRow(entity, verb, materialized, principal))) return { status: 403 };
    return { row };
  }
  if (allowDeletedAnchor) {
    const anchorRow = readDeletedRowAnchor(app.db, entity.name, id);
    const materialized = anchorRow && entity.deserializeRow({ ...anchorRow });
    if (materialized && (await mayRow(entity, verb, materialized, principal))) {
      return { row: anchorRow, historical: true };
    }
  }
  return { status: 404 };
}

// DB-backed dispatch for one admitted verb.
export async function dispatchCrud({ entity, verb, fieldName, db, principal, params, body, actionId: requestedActionId, app, res,
  sendJson, committedEventHeaders, mayRow }) {
  if (!db) {
    sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    return;
  }
  const actionId = typeof requestedActionId === 'string' && requestedActionId.length > 0 ? requestedActionId : randomUUID();
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
    const auth = await authorizeRow(app, entity, 'read', params.id, principal);
    if (auth.status) {
      const denied = auth.status === 404
        ? failure('not-found', 'not found')
        : failure('denied', 'forbidden');
      return void sendFailure(sendJson, res, denied);
    }
    const cursorHeaders = projectedCursorHeaders(readProjectedCursors(db, entity));
    sendJson(res, 200, entity.deserializeRow({ ...auth.row }), { 'x-workbench-action-id': actionId, ...cursorHeaders });
    return;
  }

  if (verb === 'create') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const result = await runKernelMutation(app, kernel, res, sendJson, { actionId, type: `${table}.create`, payload: body, principal });
    if (!result) return;
    const id = result.events[0].data.id;
    const created = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE t0.id = :id`)
      .get({ id });
    sendJson(res, 201, entity.deserializeRow(created), committedEventHeaders(result, actionId, scopeOf(table, id).key));
    return;
  }

  if (verb === 'update') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const auth = await authorizeRow(app, entity, 'update', params.id, principal);
    if (auth.status) {
      const denied = auth.status === 404
        ? failure('not-found', 'not found')
        : failure('denied', 'forbidden');
      return void sendFailure(sendJson, res, denied);
    }
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.update`,
      payload: { ...body, id: params.id },
      principal,
    });
    if (!result) return;
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    sendJson(res, 200, entity.deserializeRow(updated), committedEventHeaders(result, actionId, scopeOf(table, params.id).key));
    return;
  }

  if (verb === 'fieldApply') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const descriptor = entity.fields[fieldName];
    if (descriptor?.kind !== 'crdt' || descriptor.type !== 'text') {
      return void sendFailure(sendJson, res, failure('not-found', 'not found'));
    }
    const auth = await authorizeRow(app, entity, 'update', params.id, principal);
    if (auth.status) {
      return void sendFailure(sendJson, res, failure(auth.status === 404 ? 'not-found' : 'denied', auth.status === 404 ? 'not found' : 'forbidden'));
    }
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.${fieldName}.apply`,
      payload: { id: params.id, operation: body?.operation },
      principal,
    });
    if (!result) return;
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    sendJson(res, 200, entity.deserializeRow(updated), committedEventHeaders(result, actionId, scopeOf(table, params.id).key));
    return;
  }

  if (verb === 'remove') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const auth = await authorizeRow(app, entity, 'remove', params.id, principal);
    if (auth.status) {
      const denied = auth.status === 404
        ? failure('not-found', 'not found')
        : failure('denied', 'forbidden');
      return void sendFailure(sendJson, res, denied);
    }
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.remove`,
      payload: { id: params.id },
      principal,
    }, { validation400: false });
    if (!result) return;
    res.writeHead(204, committedEventHeaders(result, actionId, scopeOf(table, params.id).key));
    res.end();
    return;
  }

  // an unknown verb is fail-closed (the routing table only mints the five).
  sendFailure(sendJson, res, failure('internal', 'Internal error.'));
}
