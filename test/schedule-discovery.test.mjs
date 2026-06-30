// P6d step 4a: schedule `with` payload grammar + CRUD-verb validation + field identity resolution + discoverDueSchedules
// Tests for: with object/function, CRUD verb restriction, field identity matching, and pure due-discovery function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, date, text, scope, everyone, grant, read,
  generateDDL, executeFrameworkDDL,
} from '../src/index.mjs';
import { schedule, discoverDueSchedules } from '../src/schedule.mjs';
import { setActiveDb } from '../src/db.mjs';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  return db;
}

// ============================================================
// with: OBJECT PAYLOAD
// ============================================================

test('schedule.at with { with: { ... } } object stores the object', () => {
  const publishedAt = date();
  const trigger = schedule.at(publishedAt, { with: { published: true } });
  assert.equal(trigger.kind, 'schedule.at');
  assert.deepEqual(trigger.with, { published: true });
});

test('schedule.after with { with: { ... } } object stores the object', () => {
  const createdAt = date();
  const trigger = schedule.after(createdAt, '1h', { with: { reminded: true } });
  assert.equal(trigger.kind, 'schedule.after');
  assert.deepEqual(trigger.with, { reminded: true });
});

test('schedule.at rejects with: boolean (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { with: true }),
    /schedule \.at: 'with' must be an object or a function/,
  );
  assert.throws(
    () => schedule.at(f, { with: false }),
    /schedule \.at: 'with' must be an object or a function/,
  );
});

test('schedule.after rejects with: array (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.after(f, '1h', { with: [1, 2, 3] }),
    /schedule \.after: 'with' must be an object or a function/,
  );
});

test('schedule.at rejects with: string (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { with: 'not-an-object' }),
    /schedule \.at: 'with' must be an object or a function/,
  );
});

test('schedule.at with { with: null } is valid (omitted/sentinel)', () => {
  const f = date();
  const trigger = schedule.at(f, { with: null });
  assert.strictEqual(trigger.with, null);
});

test('schedule.at without with option: with is undefined', () => {
  const f = date();
  const trigger = schedule.at(f);
  assert.strictEqual(trigger.with, undefined);
});

// ============================================================
// with: FUNCTION PAYLOAD
// ============================================================

test('schedule.at with { with: fn } stores the function', () => {
  const f = date();
  const payloadFn = ({ row }) => ({ computed: row.id });
  const trigger = schedule.at(f, { with: payloadFn });
  assert.equal(typeof trigger.with, 'function');
  assert.strictEqual(trigger.with, payloadFn);
});

test('schedule.after with { with: fn } stores the function', () => {
  const f = date();
  const payloadFn = ({ row }) => ({ rowId: row.id });
  const trigger = schedule.after(f, 1000, { with: payloadFn });
  assert.equal(typeof trigger.with, 'function');
});

test('schedule.at rejects with: number (fail-closed)', () => {
  const f = date();
  assert.throws(
    () => schedule.at(f, { with: 123 }),
    /schedule \.at: 'with' must be an object or a function/,
  );
});

// ============================================================
// CRUD VERB VALIDATION
// ============================================================

test('entity with schedule.create: valid CRUD verb', () => {
  const publishedAt = date();
  const Blog = entity('ScheduleCreateTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      create: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog.schedule.create);
  assert.equal(Blog.schedule.create.kind, 'schedule.at');
});

test('entity with schedule.update: valid CRUD verb', () => {
  const publishedAt = date();
  const Blog = entity('ScheduleUpdateTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog.schedule.update);
});

test('entity with schedule.remove: valid CRUD verb', () => {
  const publishedAt = date();
  const Blog = entity('ScheduleRemoveTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      remove: schedule.at(publishedAt),
    },
  });
  assert.ok(Blog.schedule.remove);
});

test('entity with non-CRUD verb (publish) throws at load (fail-closed)', () => {
  const publishedAt = date();
  assert.throws(
    () => entity('BadVerbEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
      fields: { publishedAt },
      schedule: {
        publish: schedule.at(publishedAt),
      },
    }),
    /schedule verb 'publish' must be one of create \| update \| remove/,
  );
});

test('entity with non-CRUD verb (archive) throws at load', () => {
  const publishedAt = date();
  assert.throws(
    () => entity('BadVerbEntity2', {
      grant: scope(() => everyone()).can(() => grant(read)),
      fields: { publishedAt },
      schedule: {
        archive: schedule.at(publishedAt),
      },
    }),
    /schedule verb 'archive' must be one of create \| update \| remove/,
  );
});

// ============================================================
// FIELD IDENTITY RESOLUTION
// ============================================================

test('schedule field identity-resolves to fieldName on validated entry', () => {
  const publishedAt = date();
  const Blog = entity('FieldNameResolveTest', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  assert.strictEqual(Blog.schedule.update.field, publishedAt);
  assert.strictEqual(Blog.schedule.update.fieldName, 'publishedAt');
});

test('schedule with non-declared field throws at load', () => {
  const fakeField = { kind: 'value', type: 'date' };
  assert.throws(
    () => entity('BadFieldEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
      fields: { title: text() },
      schedule: {
        update: schedule.at(fakeField),
      },
    }),
    /schedule 'update': field descriptor is not a declared field on entity/,
  );
});

test('schedule field must be date/number (value kind, comparable)', () => {
  const txt = text();
  assert.throws(
    () => entity('BadFieldTypeEntity', {
      grant: scope(() => everyone()).can(() => grant(read)),
      fields: { title: txt },
      schedule: {
        update: schedule.at(txt),
      },
    }),
    /schedule 'update': field 'title' must be a date or number field/,
  );
});

// ============================================================
// discoverDueSchedules: schedule.at
// ============================================================

test('discoverDueSchedules: schedule.at finds past-due rows', () => {
  const db = setupDb();
  const publishedAt = date();
  const Blog = entity('BlogAtDiscovery', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt, { with: { published: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000; // 100s in past
  const futureTime = Date.now() + 100_000;

  // Insert rows
  db.prepare('INSERT INTO BlogAtDiscovery (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);
  db.prepare('INSERT INTO BlogAtDiscovery (id, publishedAt) VALUES (?, ?)').run('row2', futureTime);

  const results = discoverDueSchedules(db, [Blog], Date.now());
  assert.equal(results.length, 1, 'only past-due row should be found');
  assert.equal(results[0].entity, 'BlogAtDiscovery');
  assert.equal(results[0].verb, 'update');
  assert.equal(results[0].rowId, 'row1');
  assert.deepEqual(results[0].payload, { published: true });
});

test('discoverDueSchedules: schedule.at excludes future rows', () => {
  const db = setupDb();
  const publishedAt = date();
  const Blog = entity('BlogAtFuture', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const futureTime = Date.now() + 100_000;
  db.prepare('INSERT INTO BlogAtFuture (id, publishedAt) VALUES (?, ?)').run('row1', futureTime);

  const results = discoverDueSchedules(db, [Blog], Date.now());
  assert.equal(results.length, 0, 'future row should not be due');
});

// ============================================================
// discoverDueSchedules: schedule.after
// ============================================================

test('discoverDueSchedules: schedule.after finds rows where field + delay <= now', () => {
  const db = setupDb();
  const createdAt = date();
  const now = Date.now();
  const delay = 1000; // 1s

  const Todo = entity('TodoAfterDiscovery', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { createdAt },
    schedule: {
      update: schedule.after(createdAt, delay, { with: { reminded: true } }),
    },
  });
  for (const sql of generateDDL(Todo)) db.exec(sql);

  // Row created 2s ago: 2s + 1s delay = 3s > now, NOT due... wait, let me recalculate
  // If createdAt = now - 2000, and delay = 1000, then createdAt + delay = now - 1000 <= now → DUE
  const pastTime = now - 2000;
  // Row created 0.5s ago: 0.5s + 1s delay = 1.5s > now - 0.5s → now - 500 + 1000 = now + 500 > now → NOT DUE
  const recentTime = now - 500;

  db.prepare('INSERT INTO TodoAfterDiscovery (id, createdAt) VALUES (?, ?)').run('row1', pastTime);
  db.prepare('INSERT INTO TodoAfterDiscovery (id, createdAt) VALUES (?, ?)').run('row2', recentTime);

  const results = discoverDueSchedules(db, [Todo], now);
  assert.equal(results.length, 1, 'only the old enough row should be due');
  assert.equal(results[0].rowId, 'row1');
  assert.deepEqual(results[0].payload, { reminded: true });
});

// ============================================================
// with: FUNCTION RESOLVES PER-ROW
// ============================================================

test('discoverDueSchedules: with function receives full row', () => {
  const db = setupDb();
  const createdAt = date();
  const title = text();
  const now = Date.now();

  const payloadCalls = [];
  const payloadFn = ({ row }) => {
    payloadCalls.push(row);
    return { computed: row.id, title: row.title };
  };

  const Doc = entity('DocFnPayload', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { createdAt, title, owner: text() },
    schedule: {
      update: schedule.at(createdAt, { with: payloadFn }),
    },
  });
  for (const sql of generateDDL(Doc)) db.exec(sql);

  const pastTime = now - 100_000;
  db.prepare('INSERT INTO DocFnPayload (id, createdAt, title, owner) VALUES (?, ?, ?, ?)').run('row1', pastTime, 'Doc1', 'user1');
  db.prepare('INSERT INTO DocFnPayload (id, createdAt, title, owner) VALUES (?, ?, ?, ?)').run('row2', pastTime, 'Doc2', 'user2');

  const results = discoverDueSchedules(db, [Doc], now);
  assert.equal(results.length, 2, 'both rows due');
  assert.equal(payloadCalls.length, 2, 'function called for each row');
  assert.ok(payloadCalls.some((r) => r.id === 'row1'), 'function received row1');
  assert.ok(payloadCalls.some((r) => r.id === 'row2'), 'function received row2');

  // Check payloads include row data
  const row1Payload = results.find((r) => r.rowId === 'row1').payload;
  assert.equal(row1Payload.computed, 'row1');
  assert.equal(row1Payload.title, 'Doc1');
});

// ============================================================
// with: OMITTED → EMPTY PAYLOAD
// ============================================================

test('discoverDueSchedules: with omitted → payload: {}', () => {
  const db = setupDb();
  const publishedAt = date();

  const Blog = entity('BlogNoWith', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogNoWith (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);

  const results = discoverDueSchedules(db, [Blog], Date.now());
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].payload, {}, 'no with → empty payload');
});

// ============================================================
// while: NARROWING
// ============================================================

test('discoverDueSchedules: while predicate narrows results', () => {
  const db = setupDb();
  const status = text();
  const publishedAt = date();
  const now = Date.now();
  const pastTime = now - 100_000;

  const Blog = entity('BlogWhileNarrow', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status, publishedAt },
    schedule: {
      update: schedule.at(publishedAt, {
        while: ({ fields }) => fields.status.is('scheduled'),
        with: { action: 'process' },
      }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  // Insert rows: all past-due, but only one has status='scheduled'
  db.prepare('INSERT INTO BlogWhileNarrow (id, publishedAt, status) VALUES (?, ?, ?)').run('row1', pastTime, 'scheduled');
  db.prepare('INSERT INTO BlogWhileNarrow (id, publishedAt, status) VALUES (?, ?, ?)').run('row2', pastTime, 'draft');
  db.prepare('INSERT INTO BlogWhileNarrow (id, publishedAt, status) VALUES (?, ?, ?)').run('row3', pastTime, 'published');

  const results = discoverDueSchedules(db, [Blog], now);
  assert.equal(results.length, 1, 'only scheduled row should match');
  assert.equal(results[0].rowId, 'row1');
  assert.equal(results[0].payload.action, 'process');
});

// ============================================================
// MULTIPLE DUE ROWS
// ============================================================

test('discoverDueSchedules: multiple due rows all returned', () => {
  const db = setupDb();
  const publishedAt = date();

  const Blog = entity('BlogMultiple', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt, { with: { processed: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogMultiple (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);
  db.prepare('INSERT INTO BlogMultiple (id, publishedAt) VALUES (?, ?)').run('row2', pastTime);
  db.prepare('INSERT INTO BlogMultiple (id, publishedAt) VALUES (?, ?)').run('row3', pastTime);

  const results = discoverDueSchedules(db, [Blog], Date.now());
  assert.equal(results.length, 3, 'all three rows due');
  const ids = results.map((r) => r.rowId).sort();
  assert.deepEqual(ids, ['row1', 'row2', 'row3']);
});

// ============================================================
// NO SCHEDULE DECLARED
// ============================================================

test('discoverDueSchedules: entity with no schedule skipped', () => {
  const db = setupDb();
  const Blog = entity('BlogNoScheduleEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { title: text() },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const results = discoverDueSchedules(db, [Blog], Date.now());
  assert.deepEqual(results, [], 'no schedule → no results');
});

test('discoverDueSchedules: empty entities array returns []', () => {
  const db = setupDb();
  const results = discoverDueSchedules(db, [], Date.now());
  assert.deepEqual(results, []);
});

// ============================================================
// CLOCK INJECTION (now PARAMETER)
// ============================================================

test('discoverDueSchedules: clock injection - now BEFORE row time → empty', () => {
  const db = setupDb();
  const publishedAt = date();
  const baseNow = Date.now();
  const futureTime = baseNow + 1_000_000; // 1000s in future from our test's perspective

  const Blog = entity('BlogClockEarly', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  // Insert row with time far in the future relative to baseNow
  db.prepare('INSERT INTO BlogClockEarly (id, publishedAt) VALUES (?, ?)').run('row1', futureTime);

  // Check with now BEFORE row time (using baseNow as reference)
  const resultsEarly = discoverDueSchedules(db, [Blog], baseNow);
  assert.equal(resultsEarly.length, 0, 'now before row time → not due');

  // Check with now AFTER row time
  const late = futureTime + 1000;
  const resultsLate = discoverDueSchedules(db, [Blog], late);
  assert.equal(resultsLate.length, 1, 'now after row time → due');
});

// ============================================================
// MULTIPLE ENTITIES
// ============================================================

test('discoverDueSchedules: multiple entities with schedules', () => {
  const db = setupDb();
  const now = Date.now();
  const pastTime = now - 100_000;

  const blogPublishedAt = date();
  const Blog = entity('BlogMultiEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt: blogPublishedAt },
    schedule: {
      update: schedule.at(blogPublishedAt, { with: { source: 'blog' } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const todoDueAt = date();
  const Todo = entity('TodoMultiEntity', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { dueAt: todoDueAt },
    schedule: {
      update: schedule.at(todoDueAt, { with: { source: 'todo' } }),
    },
  });
  for (const sql of generateDDL(Todo)) db.exec(sql);

  db.prepare('INSERT INTO BlogMultiEntity (id, publishedAt) VALUES (?, ?)').run('b1', pastTime);
  db.prepare('INSERT INTO TodoMultiEntity (id, dueAt) VALUES (?, ?)').run('t1', pastTime);

  const results = discoverDueSchedules(db, [Blog, Todo], now);
  assert.equal(results.length, 2, 'one from each entity');
  const sources = results.map((r) => r.payload.source).sort();
  assert.deepEqual(sources, ['blog', 'todo']);
});

// ============================================================
// with: null (explicit sentinel)
// ============================================================

test('discoverDueSchedules: with: null treated as omitted → {}', () => {
  const db = setupDb();
  const publishedAt = date();

  const Blog = entity('BlogNullWith', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt, { with: null }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogNullWith (id, publishedAt) VALUES (?, ?)').run('row1', pastTime);

  const results = discoverDueSchedules(db, [Blog], Date.now());
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].payload, {}, 'with: null → empty payload');
});

// ============================================================
// with function shape: receives { row } with id
// ============================================================

test('with function receives row with id field', () => {
  const db = setupDb();
  const publishedAt = date();
  let receivedId = null;

  const payloadFn = ({ row }) => {
    receivedId = row.id;
    return { test: true };
  };

  const Blog = entity('BlogFnRowId', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { publishedAt },
    schedule: {
      update: schedule.at(publishedAt, { with: payloadFn }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);

  const pastTime = Date.now() - 100_000;
  db.prepare('INSERT INTO BlogFnRowId (id, publishedAt) VALUES (?, ?)').run('test-id-123', pastTime);

  discoverDueSchedules(db, [Blog], Date.now());
  assert.equal(receivedId, 'test-id-123', 'function should receive row.id');
});
