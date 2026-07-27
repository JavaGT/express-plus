import { eventsFromReceipt, insertReceipt, receiptFor, rowToEvent } from './committed-log.mjs';
import { parseEventType } from './event-handle.mjs';
import { txn, upsert } from './driver.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

const HISTORY_DESCRIPTOR = Symbol('workbench.durable-history');

function forbidden() {
  return Object.assign(new Error('forbidden'), { status: 403 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function principalKey(principal) {
  if (!principal || principal.id == null) throw forbidden();
  return `${principal.type ?? 'principal'}:${String(principal.id)}`;
}

function parseJson(value, fallback) {
  return value == null ? fallback : JSON.parse(value);
}

function historyStack(value, name) {
  const stack = parseJson(value, []);
  if (!Array.isArray(stack) || stack.some((actionId) => typeof actionId !== 'string' || actionId.length === 0)) {
    throw new TypeError(`malformed history cursor ${name}`);
  }
  return stack;
}

function actionFromRow(db, row) {
  const receipt = {
    ...row,
    eventRefs: Array.isArray(row.eventRefs) ? row.eventRefs : parseJson(row.eventRefs, []),
  };
  return Object.freeze({
    scope: row.scope,
    order: row.historyOrder,
    actionId: row.actionId,
    type: row.actionType,
    payload: parseJson(row.actionData, null),
    principal: row.principalKey,
    session: row.sessionId,
    operation: row.operation,
    committedAt: row.committedAt,
    events: Object.freeze(eventsFromReceipt(db, receipt, parseEventType)),
  });
}

function cursorRow(db, key, receiptIsEligible = () => true) {
  const row = db.prepare(
    `SELECT past, future FROM _HistoryCursor
     WHERE principalKey = :principalKey AND sessionId = :sessionId AND scope = :scope`,
  ).get(key);
  if (row) return { past: historyStack(row.past, 'past'), future: historyStack(row.future, 'future') };
  const receipts = db.prepare(
    `SELECT actionId, actionType, actionData, operation FROM _ActionReceipt
     WHERE scope = :scope AND principalKey = :principalKey AND sessionId = :sessionId
     ORDER BY historyOrder`,
  ).all(key);
  const cursor = { past: [], future: [] };
  for (const receipt of receipts) {
    if (receipt.operation === 'action') {
      if (!receiptIsEligible(receipt)) continue;
      cursor.past.push(receipt.actionId);
      cursor.future = [];
    } else if (receipt.operation === 'undo') {
      const actionId = cursor.past.pop();
      if (actionId !== undefined) cursor.future.push(actionId);
    } else if (receipt.operation === 'redo') {
      const actionId = cursor.future.pop();
      if (actionId !== undefined) cursor.past.push(actionId);
    }
  }
  return cursor;
}

function sameCursor(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeCursor(db, key, cursor) {
  upsert(db, {
    table: '_HistoryCursor',
    keyColumns: ['principalKey', 'sessionId', 'scope'],
    columns: ['past', 'future'],
    values: { ...key, past: JSON.stringify(cursor.past), future: JSON.stringify(cursor.future) },
  });
}

async function admitted(config, context) {
  if (!await config.authorize(context)) throw forbidden();
}

export function durableHistory({ authorize, actions = {} } = {}) {
  if (typeof authorize !== 'function') {
    throw new TypeError('durableHistory requires an authorize function');
  }
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new TypeError('durableHistory actions must be an object');
  }
  for (const [type, rule] of Object.entries(actions)) {
    if (!rule || typeof rule !== 'object' || typeof rule.inverse !== 'function'
      || (rule.redo !== undefined && typeof rule.redo !== 'function')) {
      throw new TypeError(`durableHistory action '${type}' requires inverse and optional redo functions`);
    }
  }
  return Object.freeze({ [HISTORY_DESCRIPTOR]: true, authorize, actions: Object.freeze({ ...actions }) });
}

export function createDurableHistoryRuntime({ db, descriptor, dispatch, cursorPolicy, annotatedHistory = null }) {
  if (!db) throw new Error('durable history requires a durable database');
  if (!descriptor?.[HISTORY_DESCRIPTOR]) {
    throw new TypeError('history must be created with durableHistory(...)');
  }
  if (cursorPolicy !== undefined) {
    if (!(cursorPolicy instanceof Map)) {
      throw new TypeError('cursorPolicy must be a Map if provided');
    }
    for (const [type, policy] of cursorPolicy) {
      if (typeof type !== 'string' || (policy !== 'eligible' && policy !== 'excluded')) {
        throw new TypeError(`cursorPolicy: invalid policy '${String(policy)}' for action '${type}'`);
      }
    }
  }
  const resolvedPolicy = cursorPolicy ?? new Map();
  const annotatedEntities = annotatedHistory?.entities ?? new Set();
  const annotatedActionTypes = annotatedHistory?.actionTypes ?? new Set();

  function isAnnotatedScope(scope) {
    return annotatedEntities.has(tryParseScopeKey(scope)?.entity);
  }

  function receiptContainsAnnotatedText(receipt) {
    if (annotatedActionTypes.has(receipt.actionType)) return true;
    if (receipt.actionType === '$batch') {
      let actions;
      try { actions = parseJson(receipt.actionData, null); } catch { return true; }
      if (!Array.isArray(actions) || actions.some((action) => !action || typeof action.type !== 'string')) return true;
      if (actions.some((action) => annotatedActionTypes.has(action.type))) return true;
    }
    let refs;
    try { refs = Array.isArray(receipt.eventRefs) ? receipt.eventRefs : parseJson(receipt.eventRefs, []); } catch { return true; }
    if (!Array.isArray(refs) || refs.some((ref) => !ref || typeof ref.scope !== 'string' || !Number.isSafeInteger(ref.seq) || ref.seq < 1)) return true;
    return refs.some((ref) => isAnnotatedScope(ref.scope));
  }

  function scopeContainsAnnotatedText(scope) {
    if (isAnnotatedScope(scope)) return true;
    const receipts = db.prepare('SELECT actionType, actionData, eventRefs FROM _ActionReceipt WHERE scope = :scope').all({ scope });
    return receipts.some(receiptContainsAnnotatedText);
  }

  function requireReadableHistory(scope) {
    if (scopeContainsAnnotatedText(scope)) throw forbidden();
  }

  function cursorPolicyFor(type) {
    if (!descriptor.actions[type]) return 'excluded';
    return resolvedPolicy.get(type) ?? 'eligible';
  }

  function receiptIsEligible(receipt) {
    if (receipt.operation !== 'action') return false;
    if (receipt.actionType === '$batch') {
      const actions = parseJson(receipt.actionData, null);
      return Array.isArray(actions) && actions.every((action) =>
        action && typeof action.type === 'string' && cursorPolicyFor(action.type) === 'eligible');
    }
    return typeof receipt.actionType === 'string' && cursorPolicyFor(receipt.actionType) === 'eligible';
  }

  function identity({ scope, session, principal }) {
    return {
      scope: requireText(scope, 'scope'),
      sessionId: requireText(session, 'session'),
      principalKey: principalKey(principal),
    };
  }

  function receiptMetadata(request, operation = 'action') {
    const session = request.history?.session;
    return {
      actionType: request.type ?? '$batch',
      actionData: request.type ? request.payload : request.actions,
      principalKey: principalKey(request.principal),
      sessionId: session ?? null,
      operation,
    };
  }

  function normalCommit(request) {
    const metadata = receiptMetadata(request);
    if (!request.history?.session || request.principal?.type !== 'user') {
      return { metadata, apply: undefined };
    }
    // Batch: if any action is excluded, exclude cursor entry
    if (request.actions) {
      const allEligible = request.actions.every(
        (action) => cursorPolicyFor(action.type) !== 'excluded',
      );
      if (!allEligible) return { metadata, apply: undefined };
    } else if (cursorPolicyFor(request.type) === 'excluded') {
      return { metadata, apply: undefined };
    }
    const key = identity({ scope: request.scope, session: request.history.session, principal: request.principal });
    const expected = cursorRow(db, key, receiptIsEligible);
    return {
      metadata,
      apply(dbInTxn) {
        const current = cursorRow(dbInTxn, key, receiptIsEligible);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        writeCursor(dbInTxn, key, { past: [...current.past, request.actionId], future: [] });
      },
    };
  }

  async function actions({ scope, principal, after = 0, limit = 100 } = {}) {
    requireText(scope, 'scope');
    await admitted(descriptor, { operation: 'read', scope, principal });
    requireReadableHistory(scope);
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare(`SELECT * FROM _ActionReceipt WHERE scope = :scope AND historyOrder > :after ORDER BY historyOrder LIMIT :limit`)
      .all({ scope, after, limit }).map((row) => actionFromRow(db, row));
  }

  async function events({ scope, principal, after = 0, limit = 100 } = {}) {
    requireText(scope, 'scope');
    await admitted(descriptor, { operation: 'read', scope, principal });
    requireReadableHistory(scope);
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare('SELECT * FROM _Log WHERE scope = :scope AND seq > :after ORDER BY seq LIMIT :limit')
      .all({ scope, after, limit }).map((row) => rowToEvent(row, parseEventType));
  }

  function revision(value) {
    return `${value.past.length}:${value.future.length}:${value.past.at(-1) ?? ''}:${value.future.at(-1) ?? ''}`;
  }

  async function cursor(args = {}) {
    const key = identity(args);
    await admitted(descriptor, { operation: 'read', scope: key.scope, session: args.session, principal: args.principal });
    const value = cursorRow(db, key, receiptIsEligible);
    const result = { undo: value.past.length, redo: value.future.length };
    Object.defineProperty(result, 'revision', { value: revision(value), enumerable: true });
    return Object.freeze(result);
  }

  async function move(operation, args = {}) {
    const key = identity(args);
    await admitted(descriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
    const operationId = requireText(args.actionId, 'actionId');
    const expectedRevision = requireText(args.revision, 'revision');
    const retry = receiptFor(db, key.scope, operationId);
    if (retry) {
      if (retry.operation !== operation || retry.principalKey !== key.principalKey || retry.sessionId !== key.sessionId) {
        throw conflict('history action id is already bound to another operation');
      }
      const retried = { ok: true, deduped: true, events: Object.freeze(eventsFromReceipt(db, retry, parseEventType)) };
      if (retry.actionType === '$history.empty') retried.empty = true;
      return Object.freeze(retried);
    }
    const expected = cursorRow(db, key, receiptIsEligible);
    if (expectedRevision !== revision(expected)) throw conflict('history cursor is stale');
    if (scopeContainsAnnotatedText(key.scope)) throw forbidden();
    const source = operation === 'undo' ? expected.past : expected.future;
    const targetId = source[source.length - 1];
    if (!targetId) {
      const now = new Date().toISOString();
      await txn(db, async () => {
        await admitted(descriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
        const current = cursorRow(db, key, receiptIsEligible);
        if (!sameCursor(current, expected)) throw conflict('history cursor changed during dispatch');
        insertReceipt(db, key.scope, operationId, now, [], {
          actionType: '$history.empty', actionData: { version: 1 }, principalKey: key.principalKey,
          sessionId: key.sessionId, operation,
        });
      });
      return Object.freeze({ ok: true, deduped: false, events: [], empty: true });
    }
    const receipt = receiptFor(db, key.scope, targetId);
    if (!receipt) throw new Error(`history action '${targetId}' is no longer retained`);
    if (receiptContainsAnnotatedText(receipt)) throw forbidden();
    const action = actionFromRow(db, receipt);
    const rule = descriptor.actions[action.type];
    if (!rule) throw conflict(`history action '${action.type}' is not undoable`);
    const translate = operation === 'undo' ? rule.inverse : rule.redo;
    const translated = translate
      ? await translate({ action, principal: args.principal, session: args.session })
      : { type: action.type, payload: action.payload, scope: action.scope };
    if (!translated || typeof translated.type !== 'string') {
      throw new TypeError(`durableHistory ${operation === 'undo' ? 'inverse' : 'redo'} must return an action`);
    }
    if (annotatedActionTypes.has(translated.type)) throw forbidden();
    if (translated.scope !== undefined && translated.scope !== key.scope) {
      throw new TypeError(`durableHistory ${operation === 'undo' ? 'inverse' : 'redo'} must keep the original history scope`);
    }
    const transition = {
      metadata: {
        actionType: translated.type,
        actionData: translated.payload,
        principalKey: key.principalKey,
        sessionId: key.sessionId,
        operation,
      },
      async apply(dbInTxn) {
        await admitted(descriptor, { operation, scope: key.scope, session: args.session, principal: args.principal, action });
        const current = cursorRow(dbInTxn, key, receiptIsEligible);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        const past = [...current.past];
        const future = [...current.future];
        if (operation === 'undo') future.push(past.pop());
        else past.push(future.pop());
        writeCursor(dbInTxn, key, { past, future });
      },
    };
    return dispatch({
      actionId: operationId,
      type: translated.type,
      payload: translated.payload ?? {},
      principal: args.principal,
      scope: key.scope,
      _historyCommit: transition,
    });
  }

  return Object.freeze({
    // Internal diagnostics only. The public application surface deliberately
    // exposes cursor/move operations, not canonical payload materialization.
    actions,
    events,
    cursor,
    undo: (args) => move('undo', args),
    redo: (args) => move('redo', args),
    normalCommit,
  });
}
