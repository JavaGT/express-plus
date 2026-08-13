// Wave 3.6 parity fixtures. These intentionally-red contracts stay TODO until
// Wave 4.9 chooses and migrates the destination action-receipt/log shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createServer, generateFrameworkDDL } from '../build/internal.mjs';

const principal = { type: 'user', id: 'identity-fixture-user' };

function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  return db;
}

function request(actionId, id) {
  return {
    actionId,
    type: 'fixture.emit',
    payload: { id },
    principal,
    // The public request contract already carries scope. Wave 4.9 must make it
    // part of durable action identity instead of ignoring it at runtime.
    scope: `Project:${id}`,
  };
}

test('Wave 4.9: the same action ID remains independent in two owning scopes', async () => {
  const db = openDb();
  const server = createServer({
    db,
    authorize: () => true,
    handlers: {
      'fixture.emit': ({ payload }) => [{
        type: 'fixture.emitted',
        scope: `Project:${payload.id}`,
        data: { id: payload.id },
      }],
    },
  });

  const first = await server.dispatch(request('shared-action', 'one'));
  const second = await server.dispatch(request('shared-action', 'two'));

  assert.equal(first.deduped, false);
  assert.equal(second.deduped, false);
  assert.deepEqual(second.events.map((event) => event.scope), ['Project:two']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('shared-action').count, 2);
  db.close();
});

test('Wave 4.9: a retry preserves exact interleaved multi-scope emission order', async () => {
  const db = openDb();
  const emitted = [
    { type: 'fixture.first', scope: 'Project:beta', data: { n: 1 } },
    { type: 'fixture.middle', scope: 'Project:alpha', data: { n: 2 } },
    { type: 'fixture.last', scope: 'Project:beta', data: { n: 3 } },
  ];
  const server = createServer({
    db,
    authorize: () => true,
    handlers: { 'fixture.interleave': () => emitted },
  });
  const dispatch = () => server.dispatch({
    actionId: 'interleaved-action',
    type: 'fixture.interleave',
    payload: {},
    principal,
    scope: 'Project:owner',
  });

  const committed = await dispatch();
  const retried = await dispatch();

  assert.equal(retried.deduped, true);
  assert.deepEqual(
    retried.events.map((event) => event.type),
    committed.events.map((event) => event.type),
  );
  db.close();
});

test('Wave 4.9: a committed zero-event action dedupes without handler re-entry', async () => {
  const db = openDb();
  let handlerCalls = 0;
  const server = createServer({
    db,
    authorize: () => true,
    handlers: { 'fixture.noop': () => { handlerCalls += 1; return []; } },
  });
  const dispatch = () => server.dispatch({
    actionId: 'zero-event-action',
    type: 'fixture.noop',
    payload: {},
    principal,
    scope: 'Project:owner',
  });

  const committed = await dispatch();
  const retried = await dispatch();

  assert.deepEqual(committed.events, []);
  assert.equal(retried.deduped, true);
  assert.deepEqual(retried.events, []);
  assert.equal(handlerCalls, 1);
  db.close();
});

test('Wave 4.9: a zero-event action receipt survives database reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-action-receipt-'));
  const path = join(directory, 'fixture.sqlite');
  let handlerCalls = 0;
  const makeServer = (db) => createServer({
    db,
    authorize: () => true,
    handlers: { 'fixture.noop': () => { handlerCalls += 1; return []; } },
  });
  const dispatch = (server) => server.dispatch({
    actionId: 'restart-zero-event-action',
    type: 'fixture.noop',
    payload: {},
    principal,
    scope: 'Project:owner',
  });

  try {
    let db = openDb(path);
    await dispatch(makeServer(db));
    db.close();

    db = openDb(path);
    const retried = await dispatch(makeServer(db));
    assert.equal(retried.deduped, true);
    assert.deepEqual(retried.events, []);
    assert.equal(handlerCalls, 1);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Wave 4.9: a non-empty zero-event batch has the same durable receipt', async () => {
  const db = openDb();
  let handlerCalls = 0;
  const server = createServer({
    db,
    authorize: () => true,
    handlers: { 'fixture.noop': () => { handlerCalls += 1; return []; } },
  });
  const dispatch = () => server.dispatchBatch({
    actionId: 'zero-event-batch',
    actions: [{ type: 'fixture.noop', payload: {}, scope: 'Project:owner' }],
    principal,
  });

  const committed = await dispatch();
  const retried = await dispatch();

  assert.deepEqual(committed.events, []);
  assert.equal(retried.deduped, true);
  assert.deepEqual(retried.events, []);
  assert.equal(handlerCalls, 1);
  db.close();
});
