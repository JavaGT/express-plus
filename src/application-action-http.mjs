// Package-owned browser transport for registered actions and explicitly
// opted-in generated entity CRUD. It deliberately accepts one opaque envelope
// instead of exposing entity-specific REST writes.

import { BodyError, readRequestBody } from './http-body.mjs';
import { failure, isWorkbenchFailure } from './outcome.mjs';
import { sendFailure } from './http-failure.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { scopeOf } from './scope-handle.mjs';

const ACTION_PATH = '/workbench/actions';
const BATCH_ACTION_PATH = '/workbench/actions/batch';
const HISTORY_PATH = '/workbench/history';
const MAX_STRING_LENGTH = 512;
const historyHttpDispatchers = new WeakMap();
const batchHttpDispatchers = new WeakMap();
const APPLICATION_HTTP_CRUD_VERBS = new Set(['create', 'update', 'remove']);

export function installHistoryHttpDispatcher(app, dispatch) {
  historyHttpDispatchers.set(app, dispatch);
}

export function installBatchHttpDispatcher(app, dispatch) {
  batchHttpDispatchers.set(app, dispatch);
}

function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function actionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length < 3 || keys.length > 5 || keys.some((key) => !['actionId', 'scope', 'type', 'payload', 'clientId'].includes(key))) return null;
  const { actionId, scope, type, payload, clientId } = body;
  if (![actionId, type].every((value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH)) return null;
  if (scope !== undefined && (typeof scope !== 'string' || scope.length === 0 || scope.length > MAX_STRING_LENGTH)) return null;
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > MAX_STRING_LENGTH)) return null;
  if (!isJsonValue(payload)) return null;
  return { actionId, ...(scope === undefined ? {} : { scope }), type, payload, ...(clientId === undefined ? {} : { clientId }) };
}

function batchActionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length < 3 || keys.length > 4 || keys.some((key) => !['actionId', 'scope', 'actions', 'clientId'].includes(key))) return null;
  const { actionId, scope, actions, clientId } = body;
  if (typeof actionId !== 'string' || actionId.length === 0 || actionId.length > MAX_STRING_LENGTH) return null;
  if (typeof scope !== 'string' || scope.length === 0 || scope.length > MAX_STRING_LENGTH) return null;
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > MAX_STRING_LENGTH)) return null;
  if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).length !== 2) return true;
    return typeof action.type !== 'string' || action.type.length === 0 || action.type.length > MAX_STRING_LENGTH || !isJsonValue(action.payload);
  })) return null;
  return { actionId, scope, actions, ...(clientId === undefined ? {} : { clientId }) };
}

function validPrincipal(principal) {
  return principal
    && typeof principal === 'object'
    && typeof principal.type === 'string'
    && typeof principal.id === 'string'
    && principal.type !== 'anonymous';
}

function historyRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { actionId, scope, session, command } = body;
  const allowed = ['actionId', 'scope', 'session', 'command'];
  if (Object.keys(body).length !== allowed.length || Object.keys(body).some((key) => !allowed.includes(key))) return null;
  if (!['undo', 'redo'].includes(command)
    || ![actionId, scope, session].every((value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH)) return null;
  return { actionId, scope, session };
}

function parseGeneratedCrudType(type) {
  const dot = type.lastIndexOf('.');
  if (dot <= 0 || dot === type.length - 1) return null;
  const verb = type.slice(dot + 1);
  if (!APPLICATION_HTTP_CRUD_VERBS.has(verb)) return null;
  return { entityName: type.slice(0, dot), verb };
}

function resolveInheritedOwnerScope(app, entity, verb, payload) {
  const inherit = entity.inherit;
  if (!inherit) return null;
  if (verb === 'create') {
    const ownerId = payload?.[inherit.via];
    if (typeof ownerId !== 'string' || ownerId.length === 0) return null;
    return scopeOf(inherit.parent, ownerId).key;
  }
  const id = payload?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const row = app.db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(id);
  if (!row) return null;
  const ownerId = row[inherit.via];
  if (typeof ownerId !== 'string' || ownerId.length === 0) return null;
  if (Object.hasOwn(payload, inherit.via) && payload[inherit.via] !== ownerId) return null;
  return scopeOf(inherit.parent, ownerId).key;
}

function admitsAnnotatedTextAction(app, request) {
  for (const entity of app.entities.values()) {
    const annotatedEntries = Object.entries(entity.fields).filter(([, field]) => field.kind === 'annotatedText');
    const annotatedFields = annotatedEntries.map(([name]) => name);
    if (annotatedFields.length === 0) continue;
    const id = request.payload?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    let owningScope;
    if (request.type === `${entity.name}.create`) {
      try { owningScope = resolveAnnotatedTextOwningScope(annotatedEntries[0][1], entity.fields, request.payload).key; } catch { return false; }
    } else {
      const row = app.db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(id);
      if (!row) return false;
      owningScope = resolveAnnotatedTextOwningScope(annotatedEntries[0][1], entity.fields, row).key;
    }
    // Project-shell sessions always send their subscribed scope. Generated
    // document actions may accept it only when it is the declared owner scope.
    if (request.scope !== undefined && request.scope !== owningScope) return false;
    request.scope = owningScope;
    if (request.type === `${entity.name}.create` || request.type === `${entity.name}.annotatedText.retire`) return true;
    if (request.payload?.version === 9
      && annotatedFields.some((field) => request.type === `${entity.name}.${field}.operation`)) return true;
  }
  return false;
}

function admitsGeneratedCrudAction(app, request) {
  const parsed = parseGeneratedCrudType(request.type);
  if (!parsed) return false;
  const entity = app.entities.get(parsed.entityName);
  if (!entity) return false;
  if (!entity.applicationHttpActions?.includes(parsed.verb)) return false;
  if (!entity.crudHandlers?.[request.type]) return false;
  const owningScope = resolveInheritedOwnerScope(app, entity, parsed.verb, request.payload);
  if (!owningScope) return false;
  if (request.scope === undefined || request.scope !== owningScope) return false;
  return true;
}

/** Single admission predicate for registered, opted-in CRUD, and annotated-text actions. */
export function admitsApplicationHttpAction(app, request) {
  if (app.actions.some((action) => action.type === request.type)) return true;
  if (admitsGeneratedCrudAction(app, request)) return true;
  return admitsAnnotatedTextAction(app, request);
}

function routeGateDenies(app, request, principal) {
  const parsed = parseGeneratedCrudType(request.type);
  if (!parsed) return false;
  const entity = app.entities.get(parsed.entityName);
  if (!entity?.applicationHttpActions?.includes(parsed.verb)) return false;
  const gate = entity.gate?.[parsed.verb];
  if (typeof gate !== 'function') return true;
  return !gate(principal);
}

/** Handle the fixed HTTP skin for application-registered actions. */
export async function handleApplicationActionHttp(app, req, res, principalOf, sendJson) {
  const url = new URL(req.url ?? '/', 'http://workbench.local');
  if (url.pathname !== ACTION_PATH && url.pathname !== BATCH_ACTION_PATH && url.pathname !== HISTORY_PATH) return false;
  if (req.method !== 'POST') {
    sendFailure(sendJson, res, failure('invalid-input', 'method not allowed'), { status: 405 });
    return true;
  }

  let body;
  try {
    body = await readRequestBody(req, { jsonOnly: true });
  } catch (error) {
    if (error instanceof BodyError) {
      sendFailure(sendJson, res, failure('invalid-input', error.message), { status: error.status });
      return true;
    }
    throw error;
  }
  const request = url.pathname === HISTORY_PATH ? historyRequest(body)
    : url.pathname === BATCH_ACTION_PATH ? batchActionRequest(body) : actionRequest(body);
  if (!request) {
    sendFailure(sendJson, res, failure('invalid-input', 'invalid action request'));
    return true;
  }
  // Registered declarations and explicit applicationHttpActions form the public
  // mutation contract. Kernel handler existence alone never admits a type.
  if (url.pathname === ACTION_PATH && !admitsApplicationHttpAction(app, request)) {
    sendFailure(sendJson, res, failure('unknown-action', 'action is not available'));
    return true;
  }
  if (url.pathname === BATCH_ACTION_PATH
    && request.actions.some((action) => !admitsApplicationHttpAction(app, { ...action, scope: request.scope }))) {
    sendFailure(sendJson, res, failure('unknown-action', 'batch action is not available'));
    return true;
  }

  let principal;
  try { principal = await principalOf(req); } catch {
    sendFailure(sendJson, res, failure('denied', 'authentication required'));
    return true;
  }
  if (!validPrincipal(principal)) {
    sendFailure(sendJson, res, failure('denied', 'authentication required'));
    return true;
  }

  if (url.pathname === ACTION_PATH && routeGateDenies(app, request, principal)) {
    sendFailure(sendJson, res, failure('denied', 'forbidden'));
    return true;
  }
  if (url.pathname === BATCH_ACTION_PATH
    && request.actions.some((action) => routeGateDenies(app, { ...action, scope: request.scope }, principal))) {
    sendFailure(sendJson, res, failure('denied', 'forbidden'));
    return true;
  }

  if (url.pathname === HISTORY_PATH && !app.history) {
    sendFailure(sendJson, res, failure('unknown-action', 'history is not available'));
    return true;
  }
  const result = url.pathname === HISTORY_PATH
    ? await historyHttpDispatchers.get(app)?.(body.command, { ...request, principal })
    : url.pathname === BATCH_ACTION_PATH
      ? await batchHttpDispatchers.get(app)?.({ ...request, principal, ...(request.clientId === undefined ? {} : { history: { session: request.clientId } }) })
       : await app.dispatch({ ...request, principal, ...(request.clientId === undefined ? {} : { history: { session: request.clientId } }) });
  if (!result?.ok) {
    sendFailure(sendJson, res, isWorkbenchFailure(result?.failure)
      ? result.failure
      : failure('internal', 'Internal error.'));
    return true;
  }

  app._applicationLiveDelivery?.wake(request.scope);
  const receipt = result.resultData;
  if (!receipt || receipt.version !== 1 || receipt.actionId !== request.actionId || !Number.isSafeInteger(receipt.confirmedThrough)) {
    sendFailure(sendJson, res, failure('internal', 'Action receipt is unavailable.'));
    return true;
  }
  sendJson(res, 200, { ok: true, ...receipt });
  return true;
}

export { ACTION_PATH, BATCH_ACTION_PATH, HISTORY_PATH };
