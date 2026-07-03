import { schedule, date, scope, everyone, grant, read } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { entity } from '../src/internal.mjs';
import { generateDDL } from '../src/ddl.mjs';
import { admitSystemMutation } from '../src/schedule.mjs';

// P6d Spine A step 4b — scheduler admission (Option A, in-txn re-check).
// A reaper-fired dispatch runs under a SCHEDULER SYSTEM PRINCIPAL. The scheduler
// principal is NOT a user with a row grant — its authority is the entity's
// DECLARED schedule. admitSystemMutation re-checks due/while/payload IN-TXN
// against the current row (TOCTOU: the row may have changed between discovery
// and dispatch) and admits ONLY the payload derived from the declared `with`.
// A scheduler principal may NEVER send an arbitrary payload (else "due" =
// "system write-anything"). Fail-closed on every mismatch. This is a SIBLING to
// the durable variant's afterProjection create row-grant — NOT a widened
// admitsEffects, NOT a second auth path (same dispatch spine, branch on principal kind).

function setupEntity(now) {
  const db = new DatabaseSync(':memory:');
  const publishedAt = date();
  const Blog = entity('BlogAdmit', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt, status: { kind: 'value', type: 'text' },

    schedule: {
      // Due when publishedAt <= now; the dispatched payload is FIXED by `with`.
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { published: true },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  return { db, Blog, publishedAt };
}

test('admitSystemMutation admits a matching scheduler dispatch (in-txn due + while + payload)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = { type: 'system', attributes: { source: 'BlogAdmit.update.publishedAt' } };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, true, 'a due + while-holding row with the exact declared payload is admitted');
});

test('admitSystemMutation DENIES a future-due row (not due at dispatch time)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now + 100_000, 'draft');

  const principal = { type: 'system', attributes: { source: 'BlogAdmit.update.publishedAt' } };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'TOCTOU: row was due at discovery but future at dispatch → deny');
});

test('admitSystemMutation DENIES when while no longer holds (in-txn re-check)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  // due AND status is 'archived' (NOT 'draft') — while fails.
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'archived');

  const principal = { type: 'system', attributes: { source: 'BlogAdmit.update.publishedAt' } };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'while predicate failed at dispatch time → deny (no second auth path; the declared will governs)');
});

test('admitSystemMutation DENIES an arbitrary payload (security: scheduler cannot write-anything)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = { type: 'system', attributes: { source: 'BlogAdmit.update.publishedAt' } };
  // A payload the schedule did NOT declare (owner hijack attempt):
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { owner: 'attacker' }, principal, db, now,
  });
  assert.equal(granted, false, 'dispatched payload must equal the declared `with` payload exactly');
});

test('admitSystemMutation DENIES a principal whose source is not this entity/verb/field', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  // A scheduler principal for a DIFFERENT source must not admit this dispatch.
  const principal = { type: 'system', attributes: { source: 'OtherEntity.update.publishedAt' } };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'principal source must bind to the declared schedule (BlogAdmit.update.publishedAt)');
});

test('admitSystemMutation DENIES a verb the entity did not declare a schedule for', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = { type: 'system', attributes: { source: 'BlogAdmit.remove.publishedAt' } };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'remove', rowId: 'row1',
    payload: {}, principal, db, now,
  });
  assert.equal(granted, false, 'no schedule declared for remove → deny (fail closed)');
});

test('admitSystemMutation DENIES a non-system principal (fail closed)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  db.prepare('INSERT INTO BlogAdmit (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', now - 1000, 'draft');

  const principal = { type: 'user', id: 'someone', attributes: {} };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'only a bound scheduler system principal goes through admitSystemMutation');
});

test('admitSystemMutation DENIES a missing row (TOCTOU: row deleted between discovery + dispatch)', () => {
  const { db, Blog } = setupEntity();
  const now = Date.now();
  // No row inserted — pretend it was deleted after discovery.
  const principal = { type: 'system', attributes: { source: 'BlogAdmit.update.publishedAt' } };
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'gone',
    payload: { published: true }, principal, db, now,
  });
  assert.equal(granted, false, 'row vanished between discovery + dispatch → deny');
});

test('admitSystemMutation recomputes the `with` function-form payload from the CURRENT row', () => {
  const db = new DatabaseSync(':memory:');
  const dueAt = date();
  const Todo = entity('TodoAdmit', {
    grant: scope(() => everyone()).can(() => grant(read)),
        title: { kind: 'value', type: 'text' }, dueAt,

    schedule: {
      update: schedule.at(dueAt, {
        // payload derived from the row at DISPATCH time, not discovery time.
        with: ({ row }) => ({ title: row.title + ' [DONE]' }),
      }),
    },
  });
  for (const sql of generateDDL(Todo)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO TodoAdmit (id, title, dueAt) VALUES (?, ?, ?)').run('t1', 'buy milk', now - 1000);

  const principal = { type: 'system', attributes: { source: 'TodoAdmit.update.dueAt' } };
  const granted = admitSystemMutation({
    entity: Todo, verb: 'update', rowId: 't1',
    payload: { title: 'buy milk [DONE]' }, principal, db, now,
  });
  assert.equal(granted, true, 'function-form with recomputed from current row matches the dispatched payload');

  // Mismatch (the row title changed since discovery → recomputed payload differs):
  db.prepare('UPDATE TodoAdmit SET title = ? WHERE id = ?').run('buy groceries', 't1');
  const granted2 = admitSystemMutation({
    entity: Todo, verb: 'update', rowId: 't1',
    payload: { title: 'buy milk [DONE]' }, principal, db, now,
  });
  assert.equal(granted2, false, 'payload recomputed from current row no longer matches the stale dispatched payload → deny');
});

test('admitSystemMutation: schedule.after due = row.field + delay <= now', () => {
  const db = new DatabaseSync(':memory:');
  const createdAt = date();
  const Task = entity('TaskAfter', {
    grant: scope(() => everyone()).can(() => grant(read)),
        createdAt, status: { kind: 'value', type: 'text' },

    schedule: {
      update: schedule.after(createdAt, 5000, { with: { status: 'stale' } }),
    },
  });
  for (const sql of generateDDL(Task)) db.exec(sql);
  const now = Date.now();
  // createdAt 10s ago + 5s delay = 5s before now → DUE
  db.prepare('INSERT INTO TaskAfter (id, createdAt, status) VALUES (?, ?, ?)').run('k1', now - 10_000, 'open');
  const principal = { type: 'system', attributes: { source: 'TaskAfter.update.createdAt' } };
  const granted = admitSystemMutation({
    entity: Task, verb: 'update', rowId: 'k1',
    payload: { status: 'stale' }, principal, db, now,
  });
  assert.equal(granted, true, 'after: field + delay <= now → due → admit');

  // createdAt 1s ago + 5s delay = 6s after now → NOT due
  db.prepare('UPDATE TaskAfter SET createdAt = ? WHERE id = ?').run(now - 1000, 'k1');
  const granted2 = admitSystemMutation({
    entity: Task, verb: 'update', rowId: 'k1',
    payload: { status: 'stale' }, principal, db, now,
  });
  assert.equal(granted2, false, 'after: field + delay > now → not due → deny');
});

// ============================================================
// END-TO-END: the wired dispatch spine admits / denies a scheduler principal
// through the durable variant's beforeProjection admission seam.
// ============================================================
import { createServer, durableMutationVariant } from '../src/pipeline.mjs';
import { principal as makePrincipal } from '../src/principal.mjs';

function setupAppServer() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _Log (scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT, actionId TEXT, committedAt TEXT)');
  const publishedAt = date();
  const status = { kind: 'value', type: 'text' };
  const Blog = entity('BlogE2E', {
    grant: scope(() => everyone()).can(() => grant(read)),
        publishedAt, status,

    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.exec('CREATE TABLE _Cursor (scope TEXT PRIMARY KEY, lastSeq INTEGER)');
  // The production durable variant seam (mirrored here): scheduler admission
  // runs before projection so admitSystemMutation re-checks due/while/with
  // against the row as it stood at discovery — NOT after this dispatch's own
  // projection has applied the payload. On denial it throws 403 with zero
  // footprint (no _Log row, no projection write).
  const server = createServer({
    handlers: Blog.crudHandlers,
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Blog.projection],
      admission: {
        beforeProjection: async ({ entityName, verb, principal: p, event, payload, db: hookDb, now }) => {
          if (p?.type !== 'system' || !p.attributes?.source) return true;
          return admitSystemMutation({
            entity: Blog, verb, rowId: event?.data?.id,
            payload, principal: p, db: hookDb ?? db, now: now ?? Date.now(),
          });
        },
        afterProjection: async () => true,
      },
    }),
  });
  return { db, Blog, server };
}

test('e2e: a bound scheduler dispatch is ADMITTED through the wired dispatch hook', async () => {
  const { db, Blog, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b1', now - 1000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-1',
    type: 'BlogE2E.update',
    payload: { id: 'b1', status: 'published' },
    principal: makePrincipal({ type: 'system', attributes: { source: 'BlogE2E.update.publishedAt' } }),
  });
  assert.equal(res.granted, true, 'scheduler principal dispatched the declared payload on a due+while-holding row');
  assert.ok(res.events?.length >= 1, 'the update event was committed');
  // The row was mutated by the projection:
  const row = db.prepare('SELECT * FROM BlogE2E WHERE id = ?').get('b1');
  assert.equal(row.status, 'published', 'projection applied the declared with payload (status: published)');
});

test('e2e: a scheduler principal sending an UNDECLARED payload is DENIED (write-anything hole)', async () => {
  const { db, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b2', now - 1000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-2',
    type: 'BlogE2E.update',
    payload: { id: 'b2', status: 'hijacked' }, // wrong value: schedule declared { status: 'published' }
    principal: makePrincipal({ type: 'system', attributes: { source: 'BlogE2E.update.publishedAt' } }),
  });
  assert.equal(res.granted, false, 'undeclared payload → deny; the scheduler principal cannot write-anything');
});

test('e2e: a scheduler principal with the WRONG source is DENIED', async () => {
  const { db, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b3', now - 1000, 'draft');

  const res = await server.dispatch({
    actionId: 'sched-3',
    type: 'BlogE2E.update',
    payload: { id: 'b3', status: 'published' },
    principal: makePrincipal({ type: 'system', attributes: { source: 'Other.update.publishedAt' } }),
  });
  assert.equal(res.granted, false, 'wrong source → deny; principal must bind to the declared schedule');
});

test('e2e: a scheduler dispatch on a NON-draft row (while-fails) is DENIED', async () => {
  const { db, server } = setupAppServer();
  const now = Date.now();
  db.prepare('INSERT INTO BlogE2E (id, publishedAt, status) VALUES (?, ?, ?)').run('b4', now - 1000, 'archived');

  const res = await server.dispatch({
    actionId: 'sched-4',
    type: 'BlogE2E.update',
    payload: { id: 'b4', status: 'published' },
    principal: makePrincipal({ type: 'system', attributes: { source: 'BlogE2E.update.publishedAt' } }),
  });
  assert.equal(res.granted, false, 'while no longer holds → deny (the declared will still governs)');
});
