import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { entity, scope, everyone, grant, read, tick, date, schedule } from '../src/index.mjs';
import { generateDDL } from '../src/ddl.mjs';
import { createServer, durableMutationVariant } from '../src/pipeline.mjs';
import { principal as makePrincipal } from '../src/principal.mjs';
import { admitSystemMutation, discoverDueSchedules, schedulerSource } from '../src/schedule.mjs';
import { startReaper } from '../src/reaper.mjs';

// ============================================================
// Schedule reaper tests — Phase A4b closing loop.
//
// The reaper is a CLOCK TRIGGER, not an authority (DECISIONLOG
// #19, #62). Each interval it discovers due rows via
// discoverDueSchedules, dispatches `update` under a scheduler
// system principal, and the dispatch spine routes through the
// durable variant's beforeProjection admission seam. ONE reconciliation path —
// no second auth path.
//
// Each dispatch has try/catch + stderr — one row's deny/throw
// NEVER aborts the sweep (mirror tick engine pattern).

// ---- Shared helpers ----

function seededDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  db.exec('CREATE TABLE _Cursor (scope TEXT PRIMARY KEY, lastSeq INTEGER)');
  return db;
}

// Build an app with system-mutation wiring that mirrors serve.mjs.
function makeAppWithSchedule(entityDef) {
  const db = seededDb();
  for (const sql of generateDDL(entityDef)) db.exec(sql);

  const entities = new Map();
  entities.set(entityDef.name, entityDef);

  const server = createServer({
    handlers: entityDef.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [entityDef.projection],
      admission: {
        beforeProjection: async ({ entityName: en, verb, principal: p, event, payload, db: hookDb, now }) => {
      if (p?.type !== 'system' || !p.attributes?.source) return true;
      const ent = entities.get(en);
      if (!ent) return false;
      return admitSystemMutation({
        entity: ent, verb, rowId: event?.data?.id,
        payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
      });
    },
        afterProjection: async () => true,
      },
    }),
  });

  return { db, entity: entityDef, entities, server };
}

// Poll helper: wait for a condition, retrying at ~10ms intervals.
function poll(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
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
// unit: startReaper no-op when no schedule triggers
// ============================================================
test('startReaper returns no-op {stop()} when no schedule triggers', () => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('NoSched', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: statusDesc },
    schedule: {
      // No schedule triggers at all
    },
  });
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  const reaper = startReaper({ db, entities, dispatch: () => {} });
  assert.doesNotThrow(() => reaper.stop());
  // stop() is a no-op — no timer was created
});

// ============================================================
// unit: startReaper no-op for tick-only entities
// ============================================================
test('startReaper returns no-op {stop()} for tick-only entities', () => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('TickOnly', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: statusDesc },
    schedule: {
      update: tick.hz(100, {
        while: ({ fields }) => fields.status.is('alive'),
        with: { status: 'moving' },
      }),
    },
  });
  const db = new DatabaseSync(':memory:');
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  const reaper = startReaper({ db, entities, dispatch: () => {} });
  assert.doesNotThrow(() => reaper.stop());
});

// ============================================================
// unit: discoverDueSchedules returns due rows
// ============================================================
test('discoverDueSchedules returns due schedule.at rows, excludes future-due', () => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('DiscDue', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const now = Date.now();
  // Past-due row
  db.prepare('INSERT INTO DiscDue (id, status, publishedAt) VALUES (?, ?, ?)').run('r1', 'draft', now - 5000);
  // Future-due row (should be excluded)
  db.prepare('INSERT INTO DiscDue (id, status, publishedAt) VALUES (?, ?, ?)').run('r2', 'draft', now + 50000);
  // Past-due but while fails
  db.prepare('INSERT INTO DiscDue (id, status, publishedAt) VALUES (?, ?, ?)').run('r3', 'archived', now - 5000);

  const results = discoverDueSchedules(db, [Blog], now);
  assert.equal(results.length, 1, 'only the past-due + while-matching row is discovered');
  assert.equal(results[0].entity, 'DiscDue');
  assert.equal(results[0].rowId, 'r1');
  assert.deepStrictEqual(results[0].payload, { status: 'published' });
});

// ============================================================
// unit: startReaper dispatch receives correct args
// ============================================================
test('startReaper calls dispatch with correct scheduler principal and payload', async (t) => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('ReapDispatch', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const now = Date.now();
  db.prepare('INSERT INTO ReapDispatch (id, status, publishedAt) VALUES (?, ?, ?)').run('r1', 'draft', now - 1000);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  let dispatchCall = null;
  const captureDispatch = (args) => { dispatchCall = args; };

  const reaper = startReaper({ db, entities, dispatch: captureDispatch, now: () => now });
  t.after(() => reaper.stop());

  // Wait for the dispatch call (reaper fires every 1s).
  await poll(() => {
    assert.ok(dispatchCall !== null, 'dispatch was called');
  });

  assert.ok(dispatchCall.actionId, 'dispatch carries actionId');
  assert.equal(dispatchCall.type, 'ReapDispatch.update');
  assert.equal(dispatchCall.principal.type, 'system');
  assert.equal(dispatchCall.principal.attributes.source, schedulerSource('ReapDispatch', 'update', 'publishedAt'));
  assert.equal(dispatchCall.payload.id, 'r1');
  assert.deepStrictEqual(dispatchCall.payload.status, 'published');
});

// ============================================================
// unit: admitSystemMutation direct (gate unit test)
// ============================================================
test('admitSystemMutation admits an exact-match scheduler dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('AdmitSched', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO AdmitSched (id, status, publishedAt) VALUES (?, ?, ?)').run('x1', 'draft', Date.now() - 1000);

  const principal = makePrincipal({ type: 'system', attributes: { source: schedulerSource('AdmitSched', 'update', 'publishedAt') } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x1',
    payload: { id: 'x1', status: 'published' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, true, 'exact source + due + while-holds + exact with → admitted');
});

test('admitSystemMutation DENIES wrong payload', () => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('AdmitWrongPayload', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO AdmitWrongPayload (id, status, publishedAt) VALUES (?, ?, ?)').run('x2', 'draft', Date.now() - 1000);

  const principal = makePrincipal({ type: 'system', attributes: { source: schedulerSource('AdmitWrongPayload', 'update', 'publishedAt') } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x2',
    payload: { id: 'x2', status: 'hijacked' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'undeclared payload → deny (no write-anything)');
});

test('admitSystemMutation DENIES row deleted between discover + dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('AdmitTOCTOU', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  // No row inserted — row was "deleted" after discovery.

  const principal = makePrincipal({ type: 'system', attributes: { source: schedulerSource('AdmitTOCTOU', 'update', 'publishedAt') } });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'gone',
    payload: { id: 'gone', status: 'published' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'TOCTOU: row vanished → deny');
});

test('admitSystemMutation DENIES non-system principal', () => {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('AdmitNonSystem', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const principal = makePrincipal({ type: 'user', id: 'someone' });
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'x1',
    payload: { id: 'x1', status: 'published' }, principal, db, now: Date.now(),
  });
  assert.equal(granted, false, 'non-system principal → fail closed');
});

// ============================================================
// e2e: schedule source wired through beforeProjection admission
// ============================================================
test('e2e: reaper dispatch updates row through projection (ADMITTED)', async (t) => {
  const publishedAt = date();
  const Blog = entity('BlogSched', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });

  const { db, entities, server } = makeAppWithSchedule(Blog);

  // Seed a row past due with matching while (draft)
  const now = Date.now();
  db.prepare('INSERT INTO BlogSched (id, status, publishedAt) VALUES (?, ?, ?)').run('b1', 'draft', now - 1000);

  const reaper = startReaper({ db, entities, dispatch: server.dispatch });
  t.after(() => reaper.stop());

  // The reaper fires every 1s. Poll for the mutation.
  await poll(() => {
    const row = db.prepare('SELECT status FROM BlogSched WHERE id = ?').get('b1');
    assert.equal(row?.status, 'published', 'projection applied the declared with payload');
  }, { timeoutMs: 4000 });
});

test('e2e: while-fails — row with mismatched status stays unchanged (DENIED)', async (t) => {
  const publishedAt = date();
  const Blog = entity('BlogSchedDeny', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });

  const { db, entities, server } = makeAppWithSchedule(Blog);

  // Seed a row past due but status is 'archived' — while fails
  const now = Date.now();
  db.prepare('INSERT INTO BlogSchedDeny (id, status, publishedAt) VALUES (?, ?, ?)').run('b2', 'archived', now - 1000);

  const reaper = startReaper({ db, entities, dispatch: server.dispatch });
  t.after(() => reaper.stop());

  // After ~2 intervals, the row must NOT have been mutated.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const row = db.prepare('SELECT status FROM BlogSchedDeny WHERE id = ?').get('b2');
  assert.equal(row.status, 'archived', 'while-failed row stays unmutated');
});

test('e2e: entity with NO schedule triggers returns no-op reaper', () => {
  const statusDesc = { kind: 'value', type: 'text' };
  const Blog = entity('BlogNoSchedule', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: statusDesc },
    // No schedule at all
  });
  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  const reaper = startReaper({ db, entities, dispatch: () => {} });
  assert.doesNotThrow(() => reaper.stop());
});

test('e2e: reaper dispatch error continues sweep (stderr, no throw)', async (t) => {
  const publishedAt = date();
  const Blog = entity('BlogSweepCont', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });

  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);

  // Seed one matching row
  const now = Date.now();
  db.prepare('INSERT INTO BlogSweepCont (id, status, publishedAt) VALUES (?, ?, ?)').run('b4', 'draft', now - 1000);

  const entities = new Map();
  entities.set(Blog.name, Blog);

  // A dispatch that throws — exercises the per-row try/catch.
  let dispatchCount = 0;
  const throwingDispatch = () => {
    dispatchCount++;
    throw new Error('simulated auth deny');
  };

  const reaper = startReaper({ db, entities, dispatch: throwingDispatch });

  // After ~2 intervals, the engine must have kept running and kept dispatching.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.ok(dispatchCount > 0, 'engine kept dispatching despite errors');
  assert.doesNotThrow(() => reaper.stop());
});

// ============================================================
// error containment: discovery-phase throw
// ============================================================
test('reaper survives discovery-phase throw (bad table)', async (t) => {
  const publishedAt = date();
  const Blog = entity('BadTable', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status: { kind: 'value', type: 'text' }, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });

  const db = seededDb();
  for (const sql of generateDDL(Blog)) db.exec(sql);

  // Override the entity name with a non-existent table to trigger a SQL error.
  const entities = new Map();
  entities.set('BadTable', { ...Blog, name: 'NonExistentTable' });

  let dispatchCalled = false;
  const reaper = startReaper({
    db,
    entities,
    dispatch: () => { dispatchCalled = true; },
  });
  t.after(() => reaper.stop());

  // Wait for at least one interval — the outer try/catch should catch the SQL error.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // The timer is still alive (engine didn't crash), and dispatch was never called.
  assert.doesNotThrow(() => reaper.stop());
  assert.equal(dispatchCalled, false, 'dispatch was not called');
});