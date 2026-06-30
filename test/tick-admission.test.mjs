// P6d Spine A step 4: admitTickedMutation admission gate (isolated).
// Tests for: admitTickedMutation admits/denies based on principal kind,
// source binding, verb declaration, row existence, while predicate,
// payload match, tick-kind gating.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { entity, text, scope, everyone, grant, read, generateDDL, schedule, date, tick } from '../src/index.mjs';
import { admitTickedMutation, tickSource } from '../src/schedule.mjs';

// ============================================================
// SETUP HELPERS
// ============================================================

function makeDb() {
  return new DatabaseSync(':memory:');
}

// Entity with a tick.hz trigger for admission tests: fires when status === 'moving'.
function makeTickEntity() {
  const status = text();
  return entity('AdmitTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status },
    schedule: {
      update: tick.hz(60, {
        while: ({ fields }) => fields.status.is('moving'),
        with: { status: 'stopped' },
      }),
    },
  });
}

function seedRow(db, tableName, id, status) {
  db.prepare(`INSERT INTO ${tableName} (id, status) VALUES (?, ?)`).run(id, status);
}

// ============================================================
// ADMIT: matching row + while-holds + matching payload
// ============================================================

test('admitTickedMutation ADMITS on present-row + while-holds + matching payload', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);

  seedRow(db, 'AdmitTick', 'row1', 'moving');
  const now = Date.now();

  const source = tickSource('AdmitTick', 'update');
  const principal = { type: 'system', attributes: { source } };

  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'stopped' },
    principal,
    db,
    now,
  });
  assert.equal(granted, true, 'present-row + while-holds + exact declared payload → admitted');
});

// ============================================================
// DENY: non-system principal
// ============================================================

test('admitTickedMutation DENIES a non-system principal (fail closed)', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);
  seedRow(db, 'AdmitTick', 'row1', 'moving');
  const now = Date.now();

  const principal = { type: 'user', id: 'someone' };
  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'stopped' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'non-system principal → deny');
});

// ============================================================
// DENY: wrong source
// ============================================================

test('admitTickedMutation DENIES wrong source', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);
  seedRow(db, 'AdmitTick', 'row1', 'moving');
  const now = Date.now();

  const principal = { type: 'system', attributes: { source: 'Other.update' } };
  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'stopped' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'wrong source → deny');
});

// ============================================================
// DENY: undeclared verb
// ============================================================

test('admitTickedMutation DENIES undeclared verb (verb not in entity.schedule)', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);
  seedRow(db, 'AdmitTick', 'row1', 'moving');
  const now = Date.now();

  const source = tickSource('AdmitTick', 'remove'); // 'remove' not declared
  const principal = { type: 'system', attributes: { source } };
  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'remove',
    rowId: 'row1',
    payload: {},
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'undeclared verb → deny');
});

// ============================================================
// DENY: missing row (TOCTOU)
// ============================================================

test('admitTickedMutation DENIES missing row (TOCTOU)', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);
  // No row inserted — pretend it was deleted after discovery.
  const now = Date.now();

  const source = tickSource('AdmitTick', 'update');
  const principal = { type: 'system', attributes: { source } };
  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'update',
    rowId: 'gone',
    payload: { status: 'stopped' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'missing row → deny (TOCTOU-safe)');
});

// ============================================================
// DENY: while-fails (row doesn&#39;t satisfy while predicate)
// ============================================================

test('admitTickedMutation DENY while-fails (row does not satisfy while predicate)', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);
  // Status is 'idle' — the while predicate is status === 'moving'
  seedRow(db, 'AdmitTick', 'row1', 'idle');
  const now = Date.now();

  const source = tickSource('AdmitTick', 'update');
  const principal = { type: 'system', attributes: { source } };
  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'stopped' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'while no longer holds → deny');
});

// ============================================================
// DENY: arbitrary payload (hijack attempt)
// ============================================================

test('admitTickedMutation DENY arbitrary payload (hijack attempt)', () => {
  const db = makeDb();
  const AdmitTick = makeTickEntity();
  for (const sql of generateDDL(AdmitTick)) db.exec(sql);
  seedRow(db, 'AdmitTick', 'row1', 'moving');
  const now = Date.now();

  const source = tickSource('AdmitTick', 'update');
  const principal = { type: 'system', attributes: { source } };
  // Declared payload is { status: 'stopped' }, but this tries to send { status: 'hijacked' }
  const granted = admitTickedMutation({
    entity: AdmitTick,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'hijacked' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'arbitrary payload → deny; ticked principal cannot write-anything');
});

// ============================================================
// DENY: schedule.at/after trigger routed through tick gate
// ============================================================

test('admitTickedMutation DENY a schedule.at trigger through this gate', () => {
  const db = makeDb();
  const status = text();
  const createdAt = date();
  const schedAt = entity('AdmitSchedAt', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status, createdAt },
    schedule: {
      update: schedule.at(createdAt, {
        while: ({ fields }) => fields.status.is('draft'),
        with: { status: 'published' },
      }),
    },
  });
  for (const sql of generateDDL(schedAt)) db.exec(sql);
  db.prepare('INSERT INTO AdmitSchedAt (id, status, createdAt) VALUES (?, ?, ?)').run('row1', 'draft', Date.now() - 1000);
  const now = Date.now();

  // Use the tickSource-derived source string — but the trigger is schedule.at, not tick.
  const source = tickSource('AdmitSchedAt', 'update');
  const principal = { type: 'system', attributes: { source } };
  const granted = admitTickedMutation({
    entity: schedAt,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'published' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'schedule.at trigger denied through admitTickedMutation gate (only ticks)');
});

// ============================================================
// CONFIRM: no due-check runs on a tick
// ============================================================

test('admitTickedMutation: no due-check runs (tick row with no date field still admitted)', () => {
  const db = makeDb();
  const status = text();
  const NoDate = entity('NoDateTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status },
    schedule: {
      update: tick.every('5m', {
        while: ({ fields }) => fields.status.is('ready'),
        with: { processed: true },
      }),
    },
  });
  for (const sql of generateDDL(NoDate)) db.exec(sql);
  seedRow(db, 'NoDateTick', 'row1', 'ready');
  const now = Date.now();

  const source = tickSource('NoDateTick', 'update');
  const principal = { type: 'system', attributes: { source } };
  const granted = admitTickedMutation({
    entity: NoDate,
    verb: 'update',
    rowId: 'row1',
    payload: { processed: true },
    principal,
    db,
    now,
  });
  assert.equal(granted, true, 'tick gate admits even with no date field (no due-check)');
});

// ============================================================
// SCHEDULE.AFTER ALSO DENIED
// ============================================================

// Fix the schedAfter test to use a unique entity name.
test('admitTickedMutation DENY a schedule.after trigger through this gate', () => {
  const db = makeDb();
  const status = text();
  const createdAt = date();
  const schedAfter = entity('AdmitSchedAfter', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: { status, createdAt },
    schedule: {
      update: schedule.after(createdAt, 30000, {
        while: ({ fields }) => fields.status.is('idle'),
        with: { status: 'done' },
      }),
    },
  });
  for (const sql of generateDDL(schedAfter)) db.exec(sql);
  seedRow(db, 'AdmitSchedAfter', 'row1', 'idle');
  const now = Date.now();

  const source = tickSource('AdmitSchedAfter', 'update');
  const principal = { type: 'system', attributes: { source } };
  const granted = admitTickedMutation({
    entity: schedAfter,
    verb: 'update',
    rowId: 'row1',
    payload: { status: 'done' },
    principal,
    db,
    now,
  });
  assert.equal(granted, false, 'schedule.after trigger denied through admitTickedMutation gate');
});
