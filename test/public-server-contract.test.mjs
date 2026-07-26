import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createLiveDelivery,
  readCommittedCursor,
} from '../src/server.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, '2026-07-26T00:00:00.000Z');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq')
    .run(scope, seq);
}

function noteEntity() {
  return {
    name: 'Note',
    fields: { title: { kind: 'value' } },
    grant: [],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
}

test('server exposes committed cursors without raw event delivery', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'Project:project-1',
    1,
    'Project.renamed',
    JSON.stringify({ name: 'Field notes' }),
    'action-1',
    '2026-07-13T00:00:00.000Z',
  );
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)')
    .run('Project:project-1', 1);

  assert.equal(readCommittedCursor(db, 'Project:project-1'), 1);
  db.close();
});

test('server exposes the transport-neutral live delivery factory', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const live = createLiveDelivery({
    db,
    entities: new Map(),
    mayVerb: async () => true,
  });

  assert.equal(typeof live.subscribe, 'function');
  assert.equal(typeof live.wake, 'function');
  assert.equal('emit' in live, false);
  assert.equal('close' in live, false);
  db.close();
});

test('public live delivery waits for activation, strips raw event data, and requires cancellation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, secret TEXT)');
  db.prepare('INSERT INTO Note (id, title, secret) VALUES (?, ?, ?)').run('n1', 'visible', 'raw-secret');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible', secret: 'raw-secret', operation: 'raw-operation' });

  const live = createLiveDelivery({
    db,
    entities: new Map([['Note', noteEntity()]]),
    mayVerb: async () => true,
  });
  assert.throws(() => live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, deliver: async () => {},
  }), /requires an AbortSignal/);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: aborted.signal, deliver: async () => {},
  }), /subscription is aborted/);

  const batches = [];
  const controller = new AbortController();
  const subscription = await live.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: controller.signal,
    deliver: async (batch) => { batches.push(batch); },
  });
  live.wake('Note:n1');
  assert.equal(batches.length, 0, 'a paused subscription cannot deliver before acknowledgement');
  await Promise.all([subscription.activate(), subscription.activate()]);

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [{
    type: 'event', entity: 'Note', id: 'n1', seq: 1, seqSpan: [1, 1],
    event: {
      type: 'Note.updated', scope: 'Note:n1', seq: 1, actionId: 'action-1',
      committedAt: '2026-07-26T00:00:00.000Z', data: { id: 'n1', title: 'visible' },
    },
  }]);
  assert.equal(JSON.stringify(batches).includes('raw-secret'), false);
  assert.equal(JSON.stringify(batches).includes('raw-operation'), false);

  appendEvent(db, 'Note:n1', 2, 'Note.title.operated', { operation: 'another-raw-operation' });
  live.wake('Note:n1');
  await sleep(20);
  assert.deepEqual(batches[1], [{
    type: 'resync', entity: 'Note', id: 'n1', seq: 2, reason: 'recipient-snapshot-required',
  }]);
  assert.equal(JSON.stringify(batches).includes('another-raw-operation'), false);

  controller.abort();
  db.close();
});

test('public live delivery does not acknowledge a rejected batch', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'visible');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible' });

  const live = createLiveDelivery({ db, entities: new Map([['Note', noteEntity()]]), mayVerb: async () => true });
  const failing = new AbortController();
  const failed = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: failing.signal,
    deliver: async () => { throw new Error('SSE write failed'); },
  });
  await assert.rejects(() => failed.activate(), /delivery callback threw/);

  const batches = [];
  const retry = new AbortController();
  const resumed = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: retry.signal,
    deliver: async (batch) => { batches.push(batch); },
  });
  await resumed.activate();
  assert.equal(batches[0][0].seq, 1);

  retry.abort();
  db.close();
});
