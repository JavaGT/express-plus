// Package-owned browser transport for registered actions. It deliberately
// accepts one opaque envelope instead of exposing entity-specific REST writes.

import { readSeq } from './cursor.mjs';
import { BodyError, readRequestBody } from './http-body.mjs';
import { failure, isWorkbenchFailure } from './outcome.mjs';
import { sendFailure } from './http-failure.mjs';

const ACTION_PATH = '/workbench/actions';
const HISTORY_PATH = '/workbench/history';
const MAX_STRING_LENGTH = 512;
const historyHttpDispatchers = new WeakMap();

export function installHistoryHttpDispatcher(app, dispatch) {
  historyHttpDispatchers.set(app, dispatch);
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
  if (keys.length !== 4 || keys.some((key) => !['actionId', 'scope', 'type', 'payload'].includes(key))) return null;
  const { actionId, scope, type, payload } = body;
  if (![actionId, scope, type].every((value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH)) return null;
  if (!isJsonValue(payload)) return null;
  return { actionId, scope, type, payload };
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
  const { actionId, scope, session, command, seq } = body;
  const allowed = command === 'undoToPoint'
    ? ['actionId', 'scope', 'session', 'command', 'seq']
    : ['actionId', 'scope', 'session', 'command'];
  if (Object.keys(body).length !== allowed.length || Object.keys(body).some((key) => !allowed.includes(key))) return null;
  if (!['undo', 'redo', 'undoToPoint'].includes(command)
    || ![actionId, scope, session].every((value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH)
    || (command === 'undoToPoint' && (!Number.isSafeInteger(seq) || seq < 0))) return null;
  return command === 'undoToPoint' ? { actionId, scope, session, seq } : { actionId, scope, session };
}

/** Handle the fixed HTTP skin for application-registered actions. */
export async function handleApplicationActionHttp(app, req, res, principalOf, sendJson) {
  const url = new URL(req.url ?? '/', 'http://workbench.local');
  if (url.pathname !== ACTION_PATH && url.pathname !== HISTORY_PATH) return false;
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
  const request = url.pathname === HISTORY_PATH ? historyRequest(body) : actionRequest(body);
  if (!request) {
    sendFailure(sendJson, res, failure('invalid-input', 'invalid action request'));
    return true;
  }
  // Registered declarations are an explicit public mutation contract. Do not
  // let this generic transport reach generated entity CRUD kernel handlers.
  if (url.pathname === ACTION_PATH && !app.actions.some((action) => action.type === request.type)) {
    sendFailure(sendJson, res, failure('unknown-action', 'action is not available'));
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
    : await app.dispatch({ ...request, principal });
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

export { ACTION_PATH, HISTORY_PATH };
