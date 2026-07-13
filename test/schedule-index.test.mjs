import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  date, entity, everyone, executeFrameworkDDL, generateDDL, grant, read,
  schedule, scope, text, tick,
} from '../src/internal.mjs';
import { startClockTriggers } from '../src/schedule.mjs';

function executeEntity(db, entityDef) {
  executeFrameworkDDL(db);
  for (const sql of generateDDL(entityDef)) db.exec(sql);
}

function planDetails(db, sql, params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((row) => row.detail).join(' | ');
}

test('generated deadline index is used for schedule.at discovery', () => {
  const dueAt = date();
  const Scheduled = entity('IndexedDeadline', {
    grant: scope(() => everyone()).can(() => grant(read)),
    dueAt,
    schedule: { update: schedule.at(dueAt) },
  });
  const db = new DatabaseSync(':memory:');
  executeEntity(db, Scheduled);

  const plan = planDetails(
    db,
    `SELECT t0.id FROM IndexedDeadline AS t0
     WHERE t0.dueAt <= :now
       AND NOT EXISTS (
         SELECT 1 FROM _ScheduleReceipt AS receipt
         WHERE receipt.source = :source AND receipt.rowId = t0.id AND receipt.dueAt = t0.dueAt
       )`,
    { now: 1000, source: 'IndexedDeadline.update.dueAt' },
  );
  assert.match(plan, /SEARCH t0 USING (?:COVERING )?INDEX idx_IndexedDeadline_schedule_dueAt .*dueAt</);
});

test('schedule.after discovery compares the stored field to a cutoff without wrapping the column', () => {
  const createdAt = date();
  const Scheduled = entity('SargableAfter', {
    grant: scope(() => everyone()).can(() => grant(read)),
    createdAt,
    schedule: { update: schedule.after(createdAt, 5000) },
  });
  const db = new DatabaseSync(':memory:');
  executeEntity(db, Scheduled);
  db.prepare('INSERT INTO SargableAfter (id, createdAt) VALUES (?, ?)').run('due', 1000);
  const prepared = [];
  const instrumentedDb = {
    prepare(sql) {
      prepared.push(sql);
      return db.prepare(sql);
    },
  };

  const handle = startClockTriggers({
    db: instrumentedDb,
    entities: [Scheduled],
    dispatch() {},
    now: () => 7000,
  });
  handle.stop();

  const discoverySql = prepared.find((sql) => sql.includes('FROM SargableAfter AS t0'));
  assert.ok(discoverySql);
  assert.doesNotMatch(discoverySql, /CAST\s*\(\s*t0\.createdAt/i);
  assert.match(discoverySql, /t0\.createdAt <= :cutoff/);
});

test('generated tick index is used for a simple equality while predicate', () => {
  const status = text();
  const Ticked = entity('IndexedTick', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status,
    schedule: {
      update: tick.every('1s', {
        while: ({ fields }) => fields.status.is('alive'),
      }),
    },
  });
  const db = new DatabaseSync(':memory:');
  executeEntity(db, Ticked);

  const plan = planDetails(
    db,
    'SELECT t0.id FROM IndexedTick AS t0 WHERE t0.status = :status',
    { status: 'alive' },
  );
  assert.match(plan, /SEARCH t0 USING (?:COVERING )?INDEX idx_IndexedTick_schedule_status .*status/);
});
