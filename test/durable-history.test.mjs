import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { durableHistory } from '../src/index.mjs';
import { createServer, executeFrameworkDDL } from '../src/internal.mjs';
import { retentionPrune } from '../src/committed-log.mjs';

const principal = Object.freeze({ type: 'user', id: 'u1', attributes: {} });
const scope = 'Document:1';

function historyDescriptor(authorize = () => true) {
  return durableHistory({
    authorize,
    inverse: ({ action }) => ({
      type: 'document.set',
      scope: action.scope,
      payload: { value: action.events[0].data.before },
    }),
  });
}

function makeServer(db, history = historyDescriptor(), cursorPolicy, annotatedHistory) {
  return createServer({
    db,
    history,
    cursorPolicy,
    annotatedHistory,
    authorize: () => true,
    handlers: {
      'document.set': ({ payload }) => [{
        type: 'document.changed',
        scope,
        data: { before: payload.before ?? null, value: payload.value },
      }],
      'Document.body.apply': ({ payload }) => [{
        type: 'Document.body.applied',
        scope,
        data: payload,
      }],
      'explicit.eligible': ({ payload }) => [{
        type: 'explicit.changed',
        scope,
        data: payload,
      }],
      'explicit.excluded': ({ payload }) => [{
        type: 'explicit.changed',
        scope,
        data: payload,
      }],
      'AnnotatedDoc.body.operation': ({ payload }) => [{
        type: 'AnnotatedDoc.body.operated',
        scope: 'AnnotatedDoc:1',
        data: payload,
      }],
      'mixed.set': ({ payload }) => [{
        type: 'AnnotatedDoc.created',
        scope: 'AnnotatedDoc:1',
        data: payload,
      }],
    },
  });
}

async function set(server, { actionId, value, before, session }) {
  return server.dispatch({
    actionId,
    type: 'document.set',
    payload: { value, before },
    principal,
    scope,
    history: { session },
  });
}

test('durable action/event reads and session cursor survive restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workbench-history-'));
  const filename = path.join(dir, 'history.db');
  try {
    let db = new DatabaseSync(filename);
    executeFrameworkDDL(db);
    let server = makeServer(db);
    await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
    db.close();

    db = new DatabaseSync(filename);
    executeFrameworkDDL(db);
    server = makeServer(db);
    const actions = await server.history.actions({ scope, principal });
    const events = await server.history.events({ scope, principal });
    const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, 'document.set');
    assert.deepEqual(actions[0].payload, { value: 1, before: 0 });
    assert.equal(actions[0].events[0].data.value, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(cursor, { undo: 1, redo: 0 });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two sessions have independent undo cursors', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-b' });

  await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'undo-a1' });

  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 1 });
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-b' }), { undo: 1, redo: 0 });
});

test('undo then redo dispatch through the committed pipeline', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 7, before: 0, session: 'tab-a' });

  const undone = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'undo-a1' });
  const redone = await server.history.redo({ scope, principal, session: 'tab-a', actionId: 'redo-a1' });

  assert.equal(undone.ok, true);
  assert.equal(undone.events[0].data.value, 0);
  assert.equal(redone.ok, true);
  assert.equal(redone.events[0].data.value, 7);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
  assert.deepEqual(
    (await server.history.actions({ scope, principal })).map((entry) => entry.operation),
    ['action', 'undo', 'redo'],
  );
});

test('a new action after undo truncates that session redo stack', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-a' });
  await server.history.undo({ scope, principal, session: 'tab-a' });
  await set(server, { actionId: 'a3', value: 3, before: 1, session: 'tab-a' });

  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
  const redo = await server.history.redo({ scope, principal, session: 'tab-a' });
  assert.equal(redo.empty, true);
});

test('registered .apply action defaults eligible when no cursorPolicy excludes it', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  const result = await server.dispatch({
    actionId: 'text-a1',
    type: 'Document.body.apply',
    payload: { id: '1', operation: ['workbench.text'] },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('generated CRDT .apply is excluded via cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['Document.body.apply', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'text-a1',
    type: 'Document.body.apply',
    payload: { id: '1', operation: ['workbench.text'] },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('non-.apply action explicitly excluded via cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'excl-a1',
    type: 'explicit.excluded',
    payload: { value: 1 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  assert.deepEqual(cursor, { undo: 0, redo: 0 });
});

test('explicitly eligible action via cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.eligible', 'eligible']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'elig-a1',
    type: 'explicit.eligible',
    payload: { value: 1 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  assert.deepEqual(cursor, { undo: 1, redo: 0 });
});

test('invalid cursorPolicy value throws at startup', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['document.set', 'invalid']]);
  assert.throws(
    () => makeServer(db, undefined, cursorPolicy),
    /cursorPolicy: invalid policy 'invalid'/,
  );
});

test('cursorPolicy must be a Map if provided', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  assert.throws(
    () => makeServer(db, undefined, {}),
    /cursorPolicy must be a Map/,
  );
});

test('request history cannot override cursorPolicy', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['Document.body.apply', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatch({
    actionId: 'no-override',
    type: 'Document.body.apply',
    payload: { id: '1', operation: ['workbench.text'] },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('excluded action receipt has action metadata', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  await server.dispatch({
    actionId: 'excl-meta',
    type: 'explicit.excluded',
    payload: { value: 42 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  const row = db.prepare(
    'SELECT actionType, actionData, principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?',
  ).get('excl-meta');
  assert.equal(row.actionType, 'explicit.excluded');
  assert.ok(row.actionData);
  assert.equal(row.principalKey, 'user:u1');
  assert.equal(row.sessionId, 'tab-a');
});

test('sessionless action receipt has metadata without principalKey or sessionId', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await server.dispatch({
    actionId: 'sessionless-a1',
    type: 'document.set',
    payload: { value: 1 },
    principal,
    scope,
  });
  const row = db.prepare(
    'SELECT actionType, actionData, principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?',
  ).get('sessionless-a1');
  assert.equal(row.actionType, 'document.set');
  assert.ok(row.actionData);
  assert.equal(row.principalKey, null);
  assert.equal(row.sessionId, null);
});

test('sessionless excluded action receipt has metadata', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  await server.dispatch({
    actionId: 'sessless-excl',
    type: 'explicit.excluded',
    payload: { value: 99 },
    principal,
    scope,
  });
  const row = db.prepare(
    'SELECT actionType, actionData, principalKey, sessionId, operation FROM _ActionReceipt WHERE actionId = ?',
  ).get('sessless-excl');
  assert.equal(row.actionType, 'explicit.excluded');
  assert.ok(JSON.parse(row.actionData));
  assert.equal(row.principalKey, null);
  assert.equal(row.sessionId, null);
  assert.equal(row.operation, 'action');
});

test('mixed batch: excluded action excludes cursor entry for whole batch', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([
    ['explicit.excluded', 'excluded'],
    ['document.set', 'eligible'],
  ]);
  const server = makeServer(db, undefined, cursorPolicy);
  const result = await server.dispatchBatch({
    actionId: 'batch-mixed',
    actions: [
      { type: 'document.set', payload: { value: 1, before: 0 } },
      { type: 'explicit.excluded', payload: { value: 99 } },
    ],
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 0, redo: 0 });
});

test('multi-event cursor shows one cursor entry per eligible action', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([
    ['document.set', 'eligible'],
    ['explicit.excluded', 'excluded'],
  ]);
  const server = makeServer(db, undefined, cursorPolicy);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await server.dispatch({
    actionId: 'excl1',
    type: 'explicit.excluded',
    payload: { value: 99 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-a' });
  await server.dispatch({
    actionId: 'excl2',
    type: 'explicit.excluded',
    payload: { value: 100 },
    principal,
    scope,
    history: { session: 'tab-a' },
  });
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
});

test('missing cursor reconstructs only eligible receipts and undo targets the latest', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const cursorPolicy = new Map([['explicit.excluded', 'excluded']]);
  const server = makeServer(db, undefined, cursorPolicy);
  await set(server, { actionId: 'eligible-a1', value: 1, before: 0, session: 'tab-a' });
  await server.dispatch({
    actionId: 'excluded-a1', type: 'explicit.excluded', payload: { value: 99 },
    principal, scope, history: { session: 'tab-a' },
  });
  await set(server, { actionId: 'eligible-a2', value: 2, before: 1, session: 'tab-a' });
  db.prepare('DELETE FROM _HistoryCursor').run();

  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
  const undone = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'undo-rebuilt' });
  assert.equal(undone.ok, true);
  assert.equal(undone.events[0].data.value, 1);
});

test('missing cursor reconstructs undo and redo transitions', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  await set(server, { actionId: 'a2', value: 2, before: 1, session: 'tab-a' });
  await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'undo-a2' });
  db.prepare('DELETE FROM _HistoryCursor').run();

  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 1 });
  const redone = await server.history.redo({ scope, principal, session: 'tab-a', actionId: 'redo-a2' });
  assert.equal(redone.ok, true);
  db.prepare('DELETE FROM _HistoryCursor').run();
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 2, redo: 0 });
});

test('history inverse rejects a translated action in another scope', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const history = durableHistory({
    authorize: () => true,
    inverse: () => ({ type: 'document.set', scope: 'Document:other', payload: { value: 0 } }),
  });
  const server = makeServer(db, history);
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  await assert.rejects(
    server.history.undo({ scope, principal, session: 'tab-a', actionId: 'undo-cross-scope' }),
    /must keep the original history scope/,
  );
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
});

test('history authorization fails closed', async () => {
  assert.throws(
    () => durableHistory({ inverse: () => ({ type: 'x' }) }),
    /requires an authorize function/,
  );
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db, historyDescriptor(() => false));
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  await assert.rejects(server.history.actions({ scope, principal }), { status: 403 });
  await assert.rejects(server.history.undo({ scope, principal, session: 'tab-a' }), { status: 403 });
});

test('annotated history reads deny before canonical receipts or events materialize', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const annotatedHistory = {
    entities: new Set(['AnnotatedDoc']),
    actionTypes: new Set(['AnnotatedDoc.body.operation']),
  };
  const server = makeServer(db, undefined, undefined, annotatedHistory);
  await server.dispatch({
    actionId: 'annotated-a1', type: 'AnnotatedDoc.body.operation', scope: 'AnnotatedDoc:1', principal,
    payload: { operation: ['secret operation'], family: { text: 'secret body' } }, history: { session: 'tab-a' },
  });

  await assert.rejects(server.history.actions({ scope: 'AnnotatedDoc:1', principal }), { status: 403 });
  await assert.rejects(server.history.events({ scope: 'AnnotatedDoc:1', principal }), { status: 403 });
  await assert.rejects(server.history.undo({ scope: 'AnnotatedDoc:1', principal, session: 'tab-a' }), { status: 403 });
  assert.deepEqual(await server.history.cursor({ scope: 'AnnotatedDoc:1', principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('receipt references deny mixed history even after annotated log retention', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const annotatedHistory = {
    entities: new Set(['AnnotatedDoc']),
    actionTypes: new Set(['AnnotatedDoc.body.operation']),
  };
  const server = makeServer(db, undefined, undefined, annotatedHistory);
  await server.dispatch({
    actionId: 'mixed-a1', type: 'mixed.set', scope: 'custom:1', principal,
    payload: { text: 'secret canonical fact' }, history: { session: 'tab-a' },
  });

  retentionPrune(db, '9999-01-01T00:00:00.000Z');
  await assert.rejects(server.history.actions({ scope: 'custom:1', principal, after: 99, limit: 1 }), { status: 403 });
  await assert.rejects(server.history.events({ scope: 'custom:1', principal, after: 99, limit: 1 }), { status: 403 });
});

test('malformed receipt metadata denies history before canonical materialization', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db, undefined, undefined, {
    entities: new Set(['AnnotatedDoc']),
    actionTypes: new Set(['AnnotatedDoc.body.operation']),
  });
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });
  db.prepare("UPDATE _ActionReceipt SET eventRefs = '[{}]' WHERE scope = :scope AND actionId = 'a1'").run({ scope });
  await assert.rejects(server.history.actions({ scope, principal }), { status: 403 });
  await assert.rejects(server.history.events({ scope, principal }), { status: 403 });
  db.prepare("UPDATE _ActionReceipt SET actionType = '$batch', actionData = '{\"type\":\"document.set\"}', eventRefs = '[]' WHERE scope = :scope AND actionId = 'a1'").run({ scope });
  await assert.rejects(server.history.actions({ scope, principal }), { status: 403 });
});

test('undo denies a zero-event receipt owned by an annotated scope', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const annotatedHistory = {
    entities: new Set(['AnnotatedDoc']),
    actionTypes: new Set(['AnnotatedDoc.body.operation']),
  };
  const server = makeServer(db, undefined, undefined, annotatedHistory);
  const annotatedScope = 'AnnotatedDoc:1';
  await server.dispatch({
    actionId: 'zero-event', type: 'document.set', scope: annotatedScope, principal,
    payload: { value: 'secret receipt', before: null }, history: { session: 'tab-a' },
  });
  await assert.rejects(server.history.undo({ scope: annotatedScope, principal, session: 'tab-a' }), { status: 403 });
});

test('history rejects an inverse translated to an annotated operation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const history = durableHistory({
    authorize: () => true,
    inverse: ({ action }) => ({ type: 'AnnotatedDoc.body.operation', scope: action.scope, payload: {} }),
  });
  const server = makeServer(db, history, undefined, {
    entities: new Set(['AnnotatedDoc']),
    actionTypes: new Set(['AnnotatedDoc.body.operation']),
  });
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  await assert.rejects(server.history.undo({ scope, principal, session: 'tab-a' }), { status: 403 });
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});

test('in-transaction history denial rolls back inverse event, receipt, and cursor', async () => {
  let undoChecks = 0;
  const authorize = ({ operation }) => operation !== 'undo' || ++undoChecks === 1;
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const server = makeServer(db, historyDescriptor(authorize));
  await set(server, { actionId: 'a1', value: 1, before: 0, session: 'tab-a' });

  const result = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'undo-denied' });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'denied');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), { undo: 1, redo: 0 });
});
