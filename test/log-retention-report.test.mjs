// logRetentionReport — the read-only dry-run for the log retention reaper.
// Guards against databases that predate a framework table, reports the same
// cutoff predicate `retentionPrune` deletes under, and surfaces the receipt
// payload bytes retention does NOT reclaim (resultData is the replay spine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { generateFrameworkDDL, executeFrameworkDDL } from '../build/ddl.mjs';
import { logRetentionReport } from '../build/committed-log.mjs';

const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z';
const RECENT = '2026-09-05T12:00:00.000Z';

function openFrameworkDb() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  executeFrameworkDDL(db);
  return db;
}

test('reports rows, bytes, and the oldest commit a cutoff would reclaim', () => {
  const db = openFrameworkDb();
  const insertLog = db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)');
  insertLog.run('s', 1, 'x.y', JSON.stringify({ pad: 'p'.repeat(100) }), 'act-1', OLD);
  insertLog.run('s', 2, 'x.y', JSON.stringify({ pad: 'q'.repeat(20) }), 'act-2', RECENT);
  db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation, actionData, resultData) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('s', 'act-1', OLD, '[]', 'action', JSON.stringify({ pad: 'a'.repeat(64) }), JSON.stringify({ actionId: 'act-1', confirmedThrough: 4 }));
  db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation, actionData, resultData) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('s', 'act-2', RECENT, '[]', 'action', JSON.stringify({ pad: 'b'.repeat(64) }), JSON.stringify({ actionId: 'act-2', confirmedThrough: 5 }));
  db.prepare('INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects) VALUES (?, ?, ?, ?, ?)')
    .run('s', 'act-1', OLD, 'fact', '[]');

  const report = logRetentionReport(db, 1, NOW);

  assert.equal(report.cutoffIso, '2026-09-05T00:00:00.000Z');
  assert.equal(report.log.totalRows, 2);
  assert.equal(report.log.rowsPruned, 1);
  assert.equal(report.log.bytesPruned, JSON.stringify({ pad: 'p'.repeat(100) }).length);
  assert.equal(report.log.oldestCommittedAt, OLD);
  assert.equal(report.receipt.totalRows, 2);
  assert.equal(report.receipt.rowsExpired, 1);
  assert.equal(report.receipt.actionDataBytesNulled, JSON.stringify({ pad: 'a'.repeat(64) }).length);
  assert.equal(report.receipt.resultDataBytesRetained > 0, true, 'resultData is reported as retained, not reclaimed');
  assert.equal(report.privateActionFact.rowsPruned, 1);
  assert.equal(report.privateActionFact.bytesPruned, 'fact'.length);

  const after = logRetentionReport(db, 1, NOW);
  assert.deepEqual(after, report, 'the report is read-only and deterministic');
});

test('reports zeros against a database without the framework tables', () => {
  const db = new DatabaseSync(':memory:');
  const report = logRetentionReport(db, 30, NOW);
  assert.equal(report.log.totalRows, 0);
  assert.equal(report.log.oldestCommittedAt, null);
  assert.equal(report.receipt.totalRows, 0);
  assert.equal(report.privateActionFact.rowsPruned, 0);
});
