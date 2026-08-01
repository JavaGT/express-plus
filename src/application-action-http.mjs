// Package-owned browser transport for registered actions. It deliberately
// accepts one opaque envelope instead of exposing entity-specific REST writes.

import { readSeq } from './cursor.mjs';
import { BodyError, readRequestBody } from './http-body.mjs';
import { failure, isWorkbenchFailure } from './outcome.mjs';
import { sendFailure } from './http-failure.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';

const ACTION_PATH = '/workbench/actions';
const BATCH_ACTION_PATH = '/workbench/actions/batch';
const HISTORY_PATH = '/workbench/history';
const MAX_STRING_LENGTH = 512;
const historyHttpDispatchers = new WeakMap();
const batchHttpDispatchers = new WeakMap();

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

function admitsApplicationHttpAction(app, request) {
  if (app.actions.some((action) => action.type === request.type)) return true;

  // Generated entity handlers are not a public mutation catalog. Annotated
  // text is the one generated browser grammar: derive its exact closed set from
  // registered declarations, and bind lifecycle requests to their document
  // scope rather than recognizing action-name prefixes.
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
    if ([6, 7].includes(request.payload?.version)
      && annotatedFields.some((field) => request.type === `${entity.name}.${field}.operation`)) return true;
  }
  return false;
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
  // Registered declarations are an explicit public mutation contract. Do not
  // let this generic transport reach generated entity CRUD kernel handlers.
  if (url.pathname === ACTION_PATH && !admitsApplicationHttpAction(app, request)) {
    sendFailure(sendJson, res, failure('unknown-action', 'action is not available'));
    return true;
  }
  if (url.pathname === BATCH_ACTION_PATH && request.actions.some((action) => !app.actions.some((declared) => declared.type === action.type))) {
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

  // A cursor read after dispatch is a conservative receipt fence: a concurrent
  // commit can only make the client require a newer authorized snapshot.
  const confirmedThrough = readSeq(app.db, request.scope);
  app._applicationLiveDelivery?.wake(request.scope);
  sendJson(res, 200, { ok: true, actionId: request.actionId, confirmedThrough });
  return true;
}

export { ACTION_PATH, BATCH_ACTION_PATH, HISTORY_PATH };
