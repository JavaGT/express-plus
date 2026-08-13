import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createOperationalConsumers, defineOperationalEvent, operationalConsumer } from '../src/operational-consumer.mjs';

test('operational reconciliation reads only records beyond its durable per-scope cursor', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE _Log (scope TEXT NOT NULL, seq INTEGER NOT NULL, eventType TEXT NOT NULL, eventData TEXT NOT NULL, actionId TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (scope, seq));
    CREATE TABLE _ConsumerCursor (consumer TEXT NOT NULL, scope TEXT NOT NULL, lastSeq INTEGER NOT NULL, PRIMARY KEY (consumer, scope));
    CREATE TABLE _OperationalConsumerDeclaration (name TEXT PRIMARY KEY, declarationFingerprint TEXT NOT NULL);
    CREATE TABLE _OperationalConsumerFailure (consumer TEXT NOT NULL, scope TEXT NOT NULL, committedEventId TEXT NOT NULL, declarationFingerprint TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL, nextAttemptAt INTEGER, PRIMARY KEY (consumer, scope, committedEventId));
  `);
  db.prepare(`INSERT INTO _Log VALUES ('project:a', 1, 'Note.created', ?, 'old', '2026-08-13T00:00:00.000Z')`).run('x'.repeat(8 * 1024 * 1024));
  db.prepare(`INSERT INTO _Log VALUES ('project:a', 2, 'Note.created', '{"id":"new"}', 'new', '2026-08-13T00:00:01.000Z')`).run();
  db.prepare(`INSERT INTO _ConsumerCursor VALUES ('operational:search.index', 'project:a', 1)`).run();

  const delivered = [];
  const consumer = operationalConsumer({
    name: 'search.index', declarationVersion: 'v1', projectionId: 'search.v1', effectId: 'index.v1',
    event: defineOperationalEvent({ eventType: 'Note.created', fields: ['id'], project: (fields) => fields }),
    idempotencyKey: ({ metadata }) => metadata.committedEventId,
    handle: async (delivery) => { delivered.push(delivery); return { kind: 'ack' }; },
  });
  const runtime = createOperationalConsumers([consumer]);

  await runtime.reconcile(db);

  assert.deepEqual(delivered.map(({ metadata }) => metadata.committedEventId), ['project:a:2']);
  assert.equal(db.prepare(`SELECT lastSeq FROM _ConsumerCursor WHERE consumer = 'operational:search.index' AND scope = 'project:a'`).get().lastSeq, 2);
  runtime.stop();
  db.close();
});
