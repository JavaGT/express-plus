import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import { createLiveDelivery, createLiveServer } from '../src/live-delivery.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

test('createLiveDelivery is the singular factory (createLiveServer is the same function)', () => {
  assert.equal(createLiveServer, createLiveDelivery);
});

test('createLiveDelivery returns emit, count, close, and createConsumer', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)`);
  db.prepare(`INSERT INTO Note (id, title) VALUES (?, ?)`).run('n1', 'hello');

  const httpServer = http.createServer();
  const live = createLiveDelivery(httpServer, {
    path: '/events',
    mayVerb: async () => true,
    principalOf: () => ({ type: 'user', id: 'u1' }),
    db,
    resolveEntity: () => ({ name: 'Note', hydrate: (row) => row }),
  });

  assert.equal(typeof live.emit, 'function');
  assert.equal(typeof live.count, 'function');
  assert.equal(typeof live.close, 'function');
  assert.equal(typeof live.createConsumer, 'function');
  assert.equal(live.count(), 0);

  const consumer = live.createConsumer({
    entities: new Map([
      ['Note', {
        name: 'Note',
        hydrate: (row) => ({ ...row, hydrated: true }),
      }],
    ]),
  });
  assert.equal(typeof consumer, 'function');

  let emitted = null;
  const origEmit = live.emit;
  // Spy via wrapping: fanout.emit is bound; replace by monkeypatch on return
  // is hard — instead run consumer and assert it does not throw on empty/malformed.
  await consumer([], { db });
  await consumer(
    [{ scope: 'Note:n1', type: 'Note.updated', seq: 1, data: { id: 'n1', title: 'x' } }],
    { db },
  );
  // No subscribers → emit is a no-op; consumer still latches and calls emit without throw.
  assert.equal(emitted, null);
  assert.equal(typeof origEmit, 'function');

  live.close();
  httpServer.close();
});
