import { scope, everyone, grant, read, tick, date, schedule } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity } from '../src/internal.mjs';
import { generateDDL } from '../src/ddl.mjs';
import { createServer, durableMutationVariant } from '../src/pipeline.mjs';
import { principal as makePrincipal } from '../src/principal.mjs';
import { admitSystemMutation, startClockTriggers, tickSource } from '../src/schedule.mjs';

// ============================================================
// Tick fire-path via startClockTriggers + admission tests.
//
// Clock trigger, not an authority. Immediate scan + interval:
// discover matching while → dispatch under tick principal →
// durable beforeProjection admission. ONE reconciliation path.

// ---- Shared helpers ----

function seededDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec('CREATE TABLE _Cursor (scope TEXT PRIMARY KEY, lastSeq INTEGER)');
  return db;
}

function makeAppWithTick(entityDef, entityName) {
  const db = seededDb();
  for (const sql of generateDDL(entityDef)) db.exec(sql);

  const app = workbench({ db, entities: [entityDef] });
  const boundEntity = app.entity(entityDef);

  const entities = new Map();
  entities.set(boundEntity.name, boundEntity);

  const server = createServer({
    handlers: boundEntity.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundEntity.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundEntity;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  return { db, entity: boundEntity, entities, server, entityName };
}

// Poll helper: wait for a condition, retrying at ~10ms intervals.
function poll(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      try {
        const result = fn();
        return resolve(result);
      } catch (err) {
        if (Date.now() - start < timeoutMs) {
          setTimeout(check, intervalMs);
        } else {
          reject(err);
        }
      }
    }
    check();
  });
}

// ============================================================
// unit: tick fire-path
// ============================================================
test('startClockTriggers tick fires rows matching while, skips non-matching', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('TestDisc', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  db.prepare('INSERT INTO TestDisc (id, status) VALUES (?, ?)').run('r1', 'alive');
  db.prepare('INSERT INTO TestDisc (id, status) VALUES (?, ?)').run('r2', 'dead');
  const now = Date.now();

  const calls = [];
  const clock = startClockTriggers({
    db, entities: [Blog], dispatch: (a) => calls.push(a), now: () => now,
  });
  clock.stop();
  assert.equal(calls.length, 1, 'only the alive row fires');
  assert.equal(calls[0].type, 'TestDisc.update');
  assert.equal(calls[0].payload.id, 'r1');
  assert.equal(calls[0].payload.status, 'moving');
  assert.equal(calls[0].principal.attributes.source, tickSource('TestDisc', 'update'));
});

// ============================================================
// unit: admitSystemMutation direct
// ============================================================
test('admitSystemMutation admits an exact-match dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitDirect', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO AdmitDirect (id, status) VALUES (?, ?)').run('x1', 'alive');

  const principal = makePrincipal({ type: 'system', attributes: { source: 'AdmitDirect.update' } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x1',
    payload: { id: 'x1', status: 'moving' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, true, 'exact source + while-holds + exact with → admitted');
});

test('admitSystemMutation DENIES wrong payload', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitWrongPayload', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO AdmitWrongPayload (id, status) VALUES (?, ?)').run('x2', 'alive');

  const principal = makePrincipal({ type: 'system', attributes: { source: 'AdmitWrongPayload.update' } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x2',
    payload: { id: 'x2', status: 'hijacked' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'undeclared payload → deny (no write-anything)');
});

test('admitSystemMutation DENIES row deleted between discover + dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitTOCTOU', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  // No row inserted — row was "deleted" after discovery.

  const principal = makePrincipal({ type: 'system', attributes: { source: 'AdmitTOCTOU.update' } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'gone',
    payload: { id: 'gone', status: 'moving' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'TOCTOU: row vanished → deny');
});

test('admitSystemMutation DENIES non-system principal', () => {
  const db = new DatabaseSync(':memory:');
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitNonSystem', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status,

    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const principal = makePrincipal({ type: 'user', id: 'someone' });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x1',
    payload: { id: 'x1', status: 'moving' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'non-system principal → fail closed');
});

test('admitSystemMutation admits and denies the 3-part scheduler source through the same seam', () => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('AdmitSystemSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt, status,

    schedule: {
      update: schedule.at(publishedAt, {
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO AdmitSystemSchedule (id, publishedAt, status) VALUES (?, ?, ?)').run('s1', now - 1000, 'draft');

  const principal = makePrincipal({ type: 'system', attributes: { source: 'AdmitSystemSchedule.update.publishedAt' } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 's1',
    payload: { id: 's1', status: 'published' }, principal, db, now,
  });
  assert.equal(granted, true, '3-part scheduler source + due row + exact payload → admitted');

  db.prepare('UPDATE AdmitSystemSchedule SET publishedAt = ? WHERE id = ?').run(now + 100_000, 's1');
  const notDue = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 's1',
    payload: { id: 's1', status: 'published' }, principal, db, now,
  });
  assert.equal(notDue, false, '3-part scheduler source still re-checks due through the same seam');
});

// ============================================================
// e2e: tick source wired through beforeProjection admission
// ============================================================
test('e2e: tick dispatch updates row through projection', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const boundBlog = app.entity(Blog);

  // Seed a row matching while ('alive')
  db.prepare('INSERT INTO BlogTick (id, status) VALUES (?, ?)').run('b1', 'alive');

  const entities = new Map();
  entities.set(boundBlog.name, boundBlog);

  // Mirror production beforeProjection admission: tick branch + pass-through
  const server = createServer({
    handlers: boundBlog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundBlog.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundBlog;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  const clock = startClockTriggers({ db, entities, dispatch: server.dispatch });
  t.after(() => clock.stop()); // cleanup to avoid timer leaks

  // The engine fires at 50ms intervals (1000/20 hz). Poll for the mutation.
  await poll(() => {
    const row = db.prepare('SELECT status FROM BlogTick WHERE id = ?').get('b1');
    assert.equal(row?.status, 'moving', 'projection applied the declared with payload');
  }, { timeoutMs: 3000 });
});

test('listen tick dispatch waits behind the app write queue', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogTickQueue', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO BlogTickQueue (id, status) VALUES (?, ?)').run('bq1', 'alive');

  const app = workbench({ db }).mount('/ticks', Blog).listen(0, {
    principalOf: () => makePrincipal({ type: 'user', id: 'u1' }),
  });
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.ready;

  // Boot catch-up (immediate scan) may already have fired; reset so we can
  // observe a later interval dispatch behind a held write queue.
  db.prepare('UPDATE BlogTickQueue SET status = ? WHERE id = ?').run('alive', 'bq1');

  let releaseHold;
  const hold = app.writeQueue.run(() => new Promise((resolve) => { releaseHold = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const heldRow = db.prepare('SELECT status FROM BlogTickQueue WHERE id = ?').get('bq1');
  assert.equal(heldRow?.status, 'alive', 'timer dispatch must not bypass the held write queue');

  releaseHold();
  await hold;

  await poll(() => {
    const row = db.prepare('SELECT status FROM BlogTickQueue WHERE id = ?').get('bq1');
    assert.equal(row?.status, 'moving', 'queued tick dispatch runs after the write queue releases');
  }, { timeoutMs: 3000 });
});

test('e2e: while-fails — row not matching while is never mutated', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogWhileFail', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const boundBlog = app.entity(Blog);

  // Seed a row NOT matching while ('dead' ≠ 'alive')
  db.prepare('INSERT INTO BlogWhileFail (id, status) VALUES (?, ?)').run('b2', 'dead');

  const entities = new Map();
  entities.set(boundBlog.name, boundBlog);

  const server = createServer({
    handlers: boundBlog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundBlog.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundBlog;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  const clock = startClockTriggers({ db, entities, dispatch: server.dispatch });
  t.after(() => clock.stop());

  // After multiple intervals, the row must NOT have been mutated.
  await new Promise((resolve) => setTimeout(resolve, 250)); // ~5 intervals
  assert.doesNotThrow(() => clock.stop()); // verify engine didn't throw

  const row = db.prepare('SELECT status FROM BlogWhileFail WHERE id = ?').get('b2');
  assert.equal(row.status, 'dead', 'while-failed row stays unmutated');
});

test('e2e: TOCTOU — row deleted between discover and dispatch does not escape', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogTOCTOU', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const app = workbench({ db, entities: [Blog] });
  const boundBlog = app.entity(Blog);

  // Seed a matching row — it will be discovered.
  db.prepare('INSERT INTO BlogTOCTOU (id, status) VALUES (?, ?)').run('b3', 'alive');

  const entities = new Map();
  entities.set(boundBlog.name, boundBlog);

  const server = createServer({
    handlers: boundBlog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundBlog.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en) ?? boundBlog;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  const clock = startClockTriggers({ db, entities, dispatch: server.dispatch });
  t.after(() => clock.stop());

  // Delete the row on the first interval — the engine should discover it,
  // fail to dispatch (row gone), log stderr, and CONTINUE (no exception escapes).
  setTimeout(() => {
    db.prepare('DELETE FROM BlogTOCTOU WHERE id = ?').run('b3');
  }, 30);

  // After multiple intervals, the engine must still be alive (didn't crash).
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.doesNotThrow(() => clock.stop()); // engine survived the TOCTOU
});

test('e2e: engine with no tick triggers returns no-op', () => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogNoTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      // No tick triggers — only a regular field, no schedule at all.
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  const clock = startClockTriggers({ db, entities, dispatch: () => {} });
  assert.doesNotThrow(() => clock.stop()); // no-op stop is safe
});

test('e2e: engine dispatch error continues sweep (stderr, no throw)', async (t) => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogSweepContinue', {
    grant: scope(() => everyone()).can(() => grant(read)),
        status: statusDesc,

    schedule: {
      update: tick.hz(20, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);
  // Seed one matching row.
  db.prepare('INSERT INTO BlogSweepContinue (id, status) VALUES (?, ?)').run('b4', 'alive');

  const entities = new Map();
  entities.set(Blog.name, Blog);

  // A dispatch that throws — simulates beforeProjection admission rejecting a row.
  // Uses the REAL compiled Blog (whose `while` discovers the seeded row) so the
  // engine actually reaches dispatch each interval; the throw exercises the
  // per-row try/catch (one row's failure must NOT abort the sweep).
  let dispatchCount = 0;
  const throwingDispatch = () => {
    dispatchCount++;
    throw new Error('simulated auth deny');
  };

  const goodEntities = new Map([[Blog.name, Blog]]);

  const clock = startClockTriggers({ db, entities: goodEntities, dispatch: throwingDispatch });
  t.after(() => clock.stop());

  // After multiple intervals, the engine must have kept running (didn't crash)
  // and kept dispatching each pass despite every dispatch throwing.
  await new Promise((resolve) => setTimeout(resolve, 350)); // ~7 intervals
  assert.ok(dispatchCount > 0, 'engine kept dispatching despite errors');
  assert.doesNotThrow(() => clock.stop());
});
