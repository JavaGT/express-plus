// CRUD dispatch for entity routes: list, read, create, update, remove.
//
// The route gate already admitted the request; here the SECOND default-on auth
// layer runs: the row grant's SQL scope (which rows are visible) and its .can
// capability (what may be done). Both must pass. A missing db is fail-closed (500):
// an entity CRUD route cannot serve without persistence.

import { randomUUID } from 'node:crypto';
import { ValidationError, type FieldDescriptor } from './field-strategy.ts';
import { readProjectedCursors } from './projected-async.ts';
import { projectedCursorHeaders, type HttpResponseLike } from './http-response.ts';
import { mayRow } from './row-grant.ts';
import type { EntityRecord } from './row-grant.ts';
import { createAuthorizationAdapter, type AuthorizationAdapter } from './authorization-adapter.ts';
import { scopeOf } from './scope-handle.ts';
import { failure, type WorkbenchFailure } from './outcome.ts';
import { sendFailure, type SendJson } from './http-failure.ts';
import { readDeletedRowAnchor } from './deleted-row-anchor.ts';
import { rawRow } from './entity/query.ts';
import type { Principal } from './principal.ts';

// The default authorization adapter (S5/A2) — THE admission path for REST CRUD
// dispatch. It wraps the framework row-grant (mayRow / mayVerb /
// fieldCapabilities) as its default implementation, so existing callers of
// those module functions are unchanged. An app injects its own adapter via
// listen({ authorization }) to swap the policy engine without touching HTTP,
// sockets, or DB state.
const DEFAULT_AUTHORIZATION: AuthorizationAdapter = createAuthorizationAdapter();

// Loose persistence/app handles. The entity compiler and kernel are authored in
// modules that own their full shapes; these seams only need the surfaces below.
export interface StatementLike {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}

export interface DbLike {
  prepare(sql: string): StatementLike;
}

export interface CrudEntity {
  name: string;
  fields: Readonly<Record<string, FieldDescriptor>>;
  scopeFilter(principal: Principal): { sql: string; params: Record<string, unknown> };
  deserializeRow(row: unknown): Record<string, unknown>;
  [key: string]: unknown;
}

export interface KernelResult {
  ok?: boolean;
  failure?: WorkbenchFailure;
  events?: readonly { data: Record<string, unknown> }[];
  resultData?: unknown;
}

export interface KernelLike {
  dispatch(action: unknown): Promise<KernelResult>;
}

export interface CrudAppLike {
  db?: DbLike;
  kernel?: KernelLike;
  writeQueue?: { run<T>(fn: () => Promise<T> | T): Promise<T> };
  [key: string]: unknown;
}

export interface RowAuthorization {
  row?: Record<string, unknown>;
  status?: 403 | 404;
  historical?: boolean;
}

// One kernel mutation through the write queue, translating the failure modes
// shared by create/update/remove: queue starvation → 503, validation → 400
// (remove opts out — its {id} payload has nothing to validate, so a
// ValidationError there is a real bug and propagates), grant deny → 403.
// Responds and returns null on failure; returns the successful result otherwise.
async function runKernelMutation(
  app: CrudAppLike,
  kernel: KernelLike,
  res: HttpResponseLike,
  sendJson: SendJson,
  action: unknown,
  { validation400 = true }: { validation400?: boolean } = {},
): Promise<KernelResult | null> {
  let result: KernelResult;
  try {
    result = await app.writeQueue!.run(() => kernel.dispatch(action));
  } catch (err) {
    if ((err as { status?: unknown } | null | undefined)?.status === 503) {
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

export function readScopedRow(
  app: CrudAppLike,
  entity: CrudEntity,
  id: string,
  principal: Principal,
): Record<string, unknown> | undefined {
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);
  return app.db!
    .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
    .get({ ...scopeParams, id });
}

// `allowDeletedAnchor` is a narrow, explicit opt-in (default off — every
// existing caller is unaffected). When set and the live row is gone, it falls
// back to the row's captured deleted-row history anchor (Wave 3.7 Contract 1)
// and runs the SAME row-admission check against that historical snapshot. This
// is not a second auth engine and not a second "current row" source: it never
// resurrects CRUD or list visibility, only lets a principal who held a grant
// AT THE TIME OF DELETION continue past the row-gate for a historical read
// (events-since). A denial on the historical path returns 404, matching a
// genuinely-nonexistent row — indistinguishable from the outside, so a
// non-owner cannot use the response to learn the row ever existed.
export async function authorizeRow(
  app: CrudAppLike,
  entity: CrudEntity,
  verb: string,
  id: string,
  principal: Principal,
  preRow: Record<string, unknown> | null = null,
  { allowDeletedAnchor = false, authorization }: { allowDeletedAnchor?: boolean; authorization?: AuthorizationAdapter } = {},
): Promise<RowAuthorization> {
  const row = preRow ?? readScopedRow(app, entity, id, principal);
  if (row) {
    // Authorization and route hydration have different ownership: grants see a
    // materialized copy, while callers retain the stored row for one later
    // hydration at their public boundary.
    const materialized = entity.deserializeRow({ ...row });
    if (!(await admitEntityRow(authorization, entity, verb, materialized, principal))) return { status: 403 };
    return { row };
  }
  if (allowDeletedAnchor) {
    const anchorRow = readDeletedRowAnchor(app.db! as unknown as Parameters<typeof readDeletedRowAnchor>[0], entity.name, id);
    const materialized = anchorRow ? entity.deserializeRow({ ...(anchorRow as Record<string, unknown>) }) : undefined;
    if (materialized && (await admitEntityRow(authorization, entity, verb, materialized, principal))) {
      return { row: anchorRow as Record<string, unknown>, historical: true };
    }
  }
  return { status: 404 };
}

// The one row-admission call every REST CRUD verb makes (S5/A2). When an
// adapter is provided it is THE admission path — its decision is final. With
// no adapter (a direct authorizeRow caller), the framework default mayRow runs,
// preserving the pre-adapter behavior exactly.
async function admitEntityRow(
  authorization: AuthorizationAdapter | undefined,
  entity: CrudEntity,
  verb: string,
  row: unknown,
  principal: Principal,
): Promise<boolean> {
  if (!authorization) return mayRow(entity as unknown as EntityRecord, verb, row, principal);
  const decision = await authorization.admit({
    category: 'entity',
    verb,
    principal,
    entity: entity as unknown as EntityRecord,
    row,
    resourceId: (row as { id?: unknown } | null | undefined)?.id as string | null | undefined,
  });
  return decision.admitted;
}

export interface DispatchCrudOptions {
  entity: CrudEntity;
  verb: string;
  fieldName?: string;
  db: DbLike | null | undefined;
  principal: Principal;
  params: Record<string, string>;
  body: unknown;
  actionId?: unknown;
  app: CrudAppLike | null | undefined;
  res: HttpResponseLike;
  sendJson: SendJson;
  committedEventHeaders: (result: unknown, actionId: string, scope: string | null) => Record<string, string>;
  authorization?: AuthorizationAdapter;
}

// DB-backed dispatch for one admitted verb. Every row admission on every verb
// (list/read/update/remove/fieldApply) consults the authorization adapter —
// the injected one when provided, else the framework default. The adapter is
// THE admission path; this dispatcher never runs a second row-grant engine.
export async function dispatchCrud({ entity, verb, fieldName, db, principal, params, body, actionId: requestedActionId, app, res,
  sendJson, committedEventHeaders, authorization }: DispatchCrudOptions): Promise<void> {
  if (!db) {
    sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    return;
  }
  const actionId = typeof requestedActionId === 'string' && requestedActionId.length > 0 ? requestedActionId : randomUUID();
  const table = entity.name;
  const { sql: where, params: scopeParams } = entity.scopeFilter(principal);
  const authz = authorization ?? DEFAULT_AUTHORIZATION;

  if (verb === 'list') {
    const rows = db.prepare(`SELECT * FROM ${table} AS t0 WHERE ${where}`).all(scopeParams)
      .map((row) => entity.deserializeRow(row));
    // Post-filter through the SAME row-admission engine `read` uses — the SQL
    // scope decides VISIBILITY, the .can body decides the read CAPABILITY. A
    // grant can admit a row via scope yet deny read in .can; without this list
    // would leak it (one auth path: list + read agree). mayRow owns inherit and
    // scope-only handling so list does not re-derive the skip.
    const listed: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (await admitEntityRow(authz, entity, 'list', row, principal)) listed.push(row);
    }
    const cursorHeaders = projectedCursorHeaders(readProjectedCursors(db as unknown as Parameters<typeof readProjectedCursors>[0], entity as unknown as Parameters<typeof readProjectedCursors>[1]));
    sendJson(res, 200, listed, { 'x-workbench-action-id': actionId, ...cursorHeaders });
    return;
  }

  if (verb === 'read') {
    // Scoped load + capability check: absent-or-invisible → 404, denied → 403.
    const auth = await authorizeRow(app as CrudAppLike, entity, 'read', params.id, principal, null, { authorization: authz });
    if (auth.status) {
      const denied = auth.status === 404
        ? failure('not-found', 'not found')
        : failure('denied', 'forbidden');
      return void sendFailure(sendJson, res, denied);
    }
    const cursorHeaders = projectedCursorHeaders(readProjectedCursors(db as unknown as Parameters<typeof readProjectedCursors>[0], entity as unknown as Parameters<typeof readProjectedCursors>[1]));
    sendJson(res, 200, entity.deserializeRow({ ...auth.row }), { 'x-workbench-action-id': actionId, ...cursorHeaders });
    return;
  }

  if (verb === 'create') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const result = await runKernelMutation(app, kernel, res, sendJson, { actionId, type: `${table}.create`, payload: body, principal });
    if (!result) return;
    const id = result.events![0].data.id;
    const created = rawRow(db, table, id);
    sendJson(res, 201, entity.deserializeRow(created), committedEventHeaders(result, actionId, scopeOf(table, id).key));
    return;
  }

  if (verb === 'update') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const auth = await authorizeRow(app as CrudAppLike, entity, 'update', params.id, principal, null, { authorization: authz });
    if (auth.status) {
      const denied = auth.status === 404
        ? failure('not-found', 'not found')
        : failure('denied', 'forbidden');
      return void sendFailure(sendJson, res, denied);
    }
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.update`,
      payload: { ...(body as Record<string, unknown>), id: params.id },
      principal,
    });
    if (!result) return;
    const updated = rawRow(db, table, params.id);
    sendJson(res, 200, entity.deserializeRow(updated), committedEventHeaders(result, actionId, scopeOf(table, params.id).key));
    return;
  }

  if (verb === 'fieldApply') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const descriptor = entity.fields[fieldName as string];
    if (descriptor?.kind !== 'crdt' || descriptor.type !== 'text') {
      return void sendFailure(sendJson, res, failure('not-found', 'not found'));
    }
    const auth = await authorizeRow(app as CrudAppLike, entity, 'update', params.id, principal, null, { authorization: authz });
    if (auth.status) {
      return void sendFailure(sendJson, res, failure(auth.status === 404 ? 'not-found' : 'denied', auth.status === 404 ? 'not found' : 'forbidden'));
    }
    const bodyRecord = body as { operation?: unknown } | null | undefined;
    const result = await runKernelMutation(app, kernel, res, sendJson, {
      actionId,
      type: `${table}.${fieldName as string}.apply`,
      payload: { id: params.id, operation: bodyRecord?.operation },
      principal,
    });
    if (!result) return;
    const updated = rawRow(db, table, params.id);
    sendJson(res, 200, entity.deserializeRow(updated), committedEventHeaders(result, actionId, scopeOf(table, params.id).key));
    return;
  }

  if (verb === 'remove') {
    const kernel = app?.kernel;
    if (!kernel) return void sendFailure(sendJson, res, failure('internal', 'Internal error.'));
    const auth = await authorizeRow(app as CrudAppLike, entity, 'remove', params.id, principal, null, { authorization: authz });
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
