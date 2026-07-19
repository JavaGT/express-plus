import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { durableHistory } from '../src/index.mjs';
import { createServer, executeFrameworkDDL } from '../src/internal.mjs';

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

function makeServer(db, history = historyDescriptor()) {
  return createServer({
    db,
    history,
    authorize: () => true,
    handlers: {
      'document.set': ({ payload }) => [{
        type: 'document.changed',
        scope,
        data: { before: payload.before ?? null, value: payload.value },
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
