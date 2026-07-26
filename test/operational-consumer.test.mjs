import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { principal, defineOperationalEvent, operationalConsumer } from '../src/index.mjs';
import { entity } from '../src/internal.mjs';
import { text, grant, read, write, subscribe } from '../src/index.mjs';
import { operationalConsumerAdmin } from '../src/server.mjs';

function consumer(results, terminal = false) {
  return operationalConsumer({
    name: 'search.index', declarationVersion: 'v1', projectionId: 'search.v1', effectId: 'index.v1',
    event: defineOperationalEvent({ eventType: 'Note.created', fields: ['id', 'title'], project: (fields, metadata) => ({ id: fields.id, title: fields.title, event: metadata.committedEventId }) }),
    idempotencyKey: ({ metadata }) => `search:${metadata.committedEventId}`,
    handle: async (delivery) => {
      results.push(delivery);
      return terminal ? { kind: 'terminal', code: 'POISON', detail: 'bad document' } : { kind: 'ack' };
    },
  });
}

async function appWith(t, operationalConsumers) {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { title: text(), secret: text(), grant: () => grant(read, write, subscribe) });
  const app = workbench({ db, entities: [Note], operationalConsumers });
  app.mount('/notes', app.entity('Note'));
  app.listen(0);
  await app.ready;
  t.after(async () => { await app.shutdown(); db.close(); });
  return app;
}

test('operational consumers receive only declared projected payload and trusted metadata', async (t) => {
  const delivered = [];
  const app = await appWith(t, [consumer(delivered)]);
  const outcome = await app.dispatch({ actionId: 'action-1', type: 'Note.create', payload: { id: 'n1', title: 'visible', secret: 'never exposed' }, principal: principal({ type: 'user', id: 'u1' }) });
  assert.equal(outcome.ok, true);
  assert.equal(delivered.length, 1);
  assert.deepEqual(Object.keys(delivered[0]).sort(), ['idempotencyKey', 'metadata', 'payload']);
  assert.deepEqual(delivered[0].payload, { id: 'n1', title: 'visible', event: `${outcome.events[0].scope}:1` });
  assert.equal('secret' in delivered[0].payload, false);
  assert.equal(delivered[0].metadata.actionId, 'action-1');
});

test('terminal failures block progress until the sole retryFailure transition', async (t) => {
  const delivered = [];
  const app = await appWith(t, [consumer(delivered, true)]);
  await app.dispatch({ actionId: 'action-2', type: 'Note.create', payload: { id: 'n2', title: 'poison', secret: 'x' }, principal: principal({ type: 'user', id: 'u1' }) });
  const admin = operationalConsumerAdmin(app);
  const failures = await admin.listFailures('search.index');
  assert.equal(failures.length, 1);
  await admin.retryFailure(failures[0]);
  assert.equal(delivered.length, 2, 'retry replays the same durable record');
});

test('changed declarations under the same operational name fail closed', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', { title: text(), grant: () => grant(read, write, subscribe) });
  const first = workbench({ db, entities: [Note], operationalConsumers: [consumer([])] });
  first.mount('/notes', first.entity('Note'));
  await first.start();
  await first.shutdown();
  const changed = operationalConsumer({ ...consumer([]), effectId: 'index.v2' });
  const second = workbench({ db, entities: [Note], operationalConsumers: [changed] });
  second.mount('/notes', second.entity('Note'));
  await assert.rejects(second.start(), /declaration changed/);
  db.close();
});
