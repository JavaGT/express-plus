import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { text, grant, read, write, subscribe, principal } from '../src/index.mjs';
import {
  entity,
  generateDDL,
  executeFrameworkDDL,
  createServer,
  durableMutationVariant,
  buildDurableEffectsRegistry,
  createDurableEffectsConsumer,
  reconcileDurableEffects,
} from '../src/internal.mjs';
import { createJobQueue } from '../src/job-queue.mjs';
import { setActiveDb } from '../src/db.mjs';

const SECRET = 'durable-effects-test-secret';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db, { replace: true });
  executeFrameworkDDL(db);
  return db;
}

function mountEntity(db, entityRecord) {
  for (const sql of generateDDL(entityRecord)) db.exec(sql);
}

function testSourceEntity() {
  return entity('SourceDurableEffect', {
    title: text(),
    grant: () => grant(read, write, subscribe),
    effects: (Source) => [
      [Source.created, {
        durable: 'send-title',
        with: ({ delta, origin }) => ({ title: delta.title, sourceId: origin.id }),
      }],
    ],
  });
}

test('durable effect enqueues a job after commit and advances the consumer cursor', async () => {
  const db = setupDb();
  const Source = testSourceEntity();
  mountEntity(db, Source);
  const jobs = createJobQueue({ db, sharedSecret: SECRET, now: () => 1000 });
  const durableEffectsRegistry = buildDurableEffectsRegistry([Source]);
  const server = createServer({
    handlers: Source.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Source.projection],
      postCommitConsumers: [createDurableEffectsConsumer({ durableEffectsRegistry, jobs })],
      admission: { beforeProjection: async () => true, afterProjection: async () => true },
    }),
  });

  const { events } = await server.dispatch({
    actionId: 'create-source-1',
    type: 'SourceDurableEffect.create',
    payload: { title: 'Hello' },
    principal: principal({ type: 'user', id: 'u1' }),
  });
  const scope = events[0].scope;

  const job = db.prepare('SELECT id, kind, payload, status FROM _Job').get();
  assert.equal(job.kind, 'send-title');
  assert.equal(job.status, 'queued');
  assert.equal(job.id, `durable-effect:${scope}:1:send-title`);
  assert.deepEqual(JSON.parse(job.payload), {
    event: {
      type: 'SourceDurableEffect.created',
      scope,
      seq: 1,
      actionId: 'create-source-1',
    },
    data: { title: 'Hello', sourceId: scope.split(':')[1] },
  });
  const cursor = db.prepare('SELECT consumer, scope, lastSeq FROM _ConsumerCursor WHERE consumer = :c').get({ c: 'effect.durable' });
  assert.equal(cursor.consumer, 'effect.durable');
  assert.equal(cursor.scope, scope);
  assert.equal(cursor.lastSeq, 1);
  db.close();
});

test('reconcileDurableEffects enqueues missed jobs from _Log and is idempotent', async () => {
  const db = setupDb();
  const Source = testSourceEntity();
  mountEntity(db, Source);
  const jobs = createJobQueue({ db, sharedSecret: SECRET, now: () => 2000 });
  const scope = 'SourceDurableEffect:s1';
  Source.projection.apply(
    { type: 'SourceDurableEffect.created', scope, data: { id: 's1', title: 'Recovered' } },
    db,
  );
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    scope,
    1,
    'SourceDurableEffect.created',
    JSON.stringify({ id: 's1', title: 'Recovered' }),
    'create-source-2',
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)').run(scope, 1);
  const durableEffectsRegistry = buildDurableEffectsRegistry([Source]);

  assert.deepEqual(await reconcileDurableEffects(db, { durableEffectsRegistry, jobs }), { enqueued: 1 });
  assert.deepEqual(await reconcileDurableEffects(db, { durableEffectsRegistry, jobs }), { enqueued: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Job').get().n, 1);
  const cursor = db.prepare('SELECT consumer, scope, lastSeq FROM _ConsumerCursor WHERE consumer = :c').get({ c: 'effect.durable' });
  assert.equal(cursor.consumer, 'effect.durable');
  assert.equal(cursor.scope, scope);
  assert.equal(cursor.lastSeq, 1);
  db.close();
});

test('app.ready runs durable effect recovery sweep before serving', async (t) => {
  const db = setupDb();
  const app = workbench({ db, jobs: { sharedSecret: SECRET, now: () => 3000 } });
  const Source = testSourceEntity();
  const scope = 'SourceDurableEffect:s1';
  // Pre-seed a committed event whose post-commit enqueue never happened.
  mountEntity(db, Source);
  Source.projection.apply(
    { type: 'SourceDurableEffect.created', scope, data: { id: 's1', title: 'Boot' } },
    db,
  );
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    scope,
    1,
    'SourceDurableEffect.created',
    JSON.stringify({ id: 's1', title: 'Boot' }),
    'create-source-3',
    '2026-01-01T00:00:00.000Z',
  );
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)').run(scope, 1);
  app.mount('/source-durable-effect', Source);
  app.listen(0);
  t.after(() => { app.httpServer.close(); db.close(); });

  await app.ready;

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Job WHERE kind = ?').get('send-title').n, 1);
});
