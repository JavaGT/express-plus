import { randomUUID } from 'node:crypto';

import { eventsFromReceipt, receiptFor, rowToEvent } from './committed-log.mjs';
import { parseEventType } from './event-handle.mjs';
import { upsert } from './driver.mjs';

const HISTORY_DESCRIPTOR = Symbol('workbench.durable-history');

function forbidden() {
  return Object.assign(new Error('forbidden'), { status: 403 });
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

function cursorRow(db, key) {
  const row = db.prepare(
    `SELECT past, future FROM _HistoryCursor
     WHERE principalKey = :principalKey AND sessionId = :sessionId AND scope = :scope`,
  ).get(key);
  if (row) return { past: parseJson(row.past, []), future: parseJson(row.future, []) };
  const past = db.prepare(
    `SELECT actionId FROM _ActionReceipt
     WHERE scope = :scope AND principalKey = :principalKey AND sessionId = :sessionId
       AND operation = 'action'
     ORDER BY historyOrder`,
  ).all(key).map((entry) => entry.actionId);
  return { past, future: [] };
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

export function durableHistory({ authorize, inverse, redo } = {}) {
  if (typeof authorize !== 'function') {
    throw new TypeError('durableHistory requires an authorize function');
  }
  if (typeof inverse !== 'function') {
    throw new TypeError('durableHistory requires an inverse function');
  }
  if (redo !== undefined && typeof redo !== 'function') {
    throw new TypeError('durableHistory redo must be a function');
  }
  return Object.freeze({ [HISTORY_DESCRIPTOR]: true, authorize, inverse, redo });
}

export function createDurableHistoryRuntime({ db, descriptor, dispatch }) {
  if (!db) throw new Error('durable history requires a durable database');
  if (!descriptor?.[HISTORY_DESCRIPTOR]) {
    throw new TypeError('history must be created with durableHistory(...)');
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
      principalKey: session ? principalKey(request.principal) : null,
      sessionId: session ?? null,
      operation,
    };
  }

  function normalCommit(request) {
    if (!request.history?.session) return null;
    // A CRDT operation has no generic inverse: replaying the same immutable
    // operation is idempotent, not redo, and a compensating edit needs fresh
    // identities plus the current observed frontier.
    if (typeof request.type === 'string' && request.type.endsWith('.apply')) return null;
    const key = identity({ scope: request.scope, session: request.history.session, principal: request.principal });
    const expected = cursorRow(db, key);
    return {
      metadata: receiptMetadata(request),
      apply(dbInTxn) {
        const current = cursorRow(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        writeCursor(dbInTxn, key, { past: [...current.past, request.actionId], future: [] });
      },
    };
  }

  async function actions({ scope, principal, after = 0, limit = 100 } = {}) {
    requireText(scope, 'scope');
    await admitted(descriptor, { operation: 'read', scope, principal });
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare(
      `SELECT * FROM _ActionReceipt WHERE scope = :scope AND historyOrder > :after
       ORDER BY historyOrder LIMIT :limit`,
    ).all({ scope, after, limit }).map((row) => actionFromRow(db, row));
  }

  async function events({ scope, principal, after = 0, limit = 100 } = {}) {
    requireText(scope, 'scope');
    await admitted(descriptor, { operation: 'read', scope, principal });
    if (!Number.isInteger(after) || after < 0) throw new TypeError('after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    return db.prepare(
      'SELECT * FROM _Log WHERE scope = :scope AND seq > :after ORDER BY seq LIMIT :limit',
    ).all({ scope, after, limit }).map((row) => rowToEvent(row, parseEventType));
  }

  async function cursor(args = {}) {
    const key = identity(args);
    await admitted(descriptor, { operation: 'read', scope: key.scope, session: args.session, principal: args.principal });
    const value = cursorRow(db, key);
    return Object.freeze({ undo: value.past.length, redo: value.future.length });
  }

  async function move(operation, args = {}) {
    const key = identity(args);
    await admitted(descriptor, { operation, scope: key.scope, session: args.session, principal: args.principal });
    const expected = cursorRow(db, key);
    const source = operation === 'undo' ? expected.past : expected.future;
    const targetId = source[source.length - 1];
    if (!targetId) return Object.freeze({ ok: true, deduped: false, events: [], empty: true });
    const receipt = receiptFor(db, key.scope, targetId);
    if (!receipt) throw new Error(`history action '${targetId}' is no longer retained`);
    const action = actionFromRow(db, receipt);
    const translate = operation === 'undo' ? descriptor.inverse : descriptor.redo;
    const translated = translate
      ? await translate({ action, principal: args.principal, session: args.session })
      : { type: action.type, payload: action.payload, scope: action.scope };
    if (!translated || typeof translated.type !== 'string') {
      throw new TypeError(`durableHistory ${operation === 'undo' ? 'inverse' : 'redo'} must return an action`);
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
        const current = cursorRow(dbInTxn, key);
        if (!sameCursor(current, expected)) throw new Error('history cursor changed during dispatch');
        const past = [...current.past];
        const future = [...current.future];
        if (operation === 'undo') future.push(past.pop());
        else past.push(future.pop());
        writeCursor(dbInTxn, key, { past, future });
      },
    };
    return dispatch({
      actionId: args.actionId ?? randomUUID(),
      type: translated.type,
      payload: translated.payload ?? {},
      principal: args.principal,
      scope: translated.scope ?? key.scope,
      _historyCommit: transition,
    });
  }

  return Object.freeze({
    actions,
    events,
    cursor,
    undo: (args) => move('undo', args),
    redo: (args) => move('redo', args),
    normalCommit,
  });
}
