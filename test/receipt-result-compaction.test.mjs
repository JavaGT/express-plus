// Receipt `resultData` compaction — the age-based seam that reclaims the
// payload bytes while preserving exactly the replay pair (`actionId`,
// `confirmedThrough`) every replayed receipt must carry. See
// compactReceiptResultData in src/committed-log.ts for the fail-closed rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { actionReceiptTableDDL, compactReceiptResultData } from '../build/committed-log.mjs';

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(actionReceiptTableDDL());
  return db;
}

function insertReceipt(db, { scope = 's', actionId, committedAt, resultData }) {
  db.prepare(
    `INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation, resultData)
     VALUES (?, ?, ?, '[]', 'action', ?)`
  ).run(scope, actionId, committedAt, resultData ?? null);
}

function receiptResult(db, scope, actionId) {
  const row = db.prepare('SELECT resultData FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, actionId);
  return row.resultData === null ? null : JSON.parse(row.resultData);
}

const OLD = '2020-01-01T00:00:00.000Z';
const NOW = new Date().toISOString();

test('compacts an old, provably replayable receipt down to the replay pair', () => {
  const db = openDb();
  insertReceipt(db, {
    actionId: 'act-1',
    committedAt: OLD,
    resultData: JSON.stringify({ actionId: 'act-1', confirmedThrough: 41, bigPayload: 'x'.repeat(1024) })
  });

  const compacted = compactReceiptResultData(db, NOW);
  assert.equal(compacted, 1);

  const result = receiptResult(db, 's', 'act-1');
  assert.equal(result.__workbenchCompactedResult.version, 1);
  assert.ok(result.__workbenchCompactedResult.reclaimedBytes > 0, 'records the reclaimed byte count for audit');
  assert.equal(result.actionId, 'act-1');
  assert.equal(result.confirmedThrough, 41);
  assert.equal(result.bigPayload, undefined, 'the stored payload is gone');
});

test('leaves protected, malformed, and inadmissible receipts untouched', () => {
  const db = openDb();
  // Mixed-tier replay envelope — the replay authority; losing it would turn a retry into a re-apply.
  insertReceipt(db, {
    actionId: 'act-mixed',
    committedAt: OLD,
    resultData: JSON.stringify({ __workbenchMixedReplay: true, actionId: 'act-mixed', confirmedThrough: 7 })
  });
  // Malformed JSON.
  insertReceipt(db, { actionId: 'act-malformed', committedAt: OLD, resultData: '{not json' });
  // No resultData at all.
  insertReceipt(db, { actionId: 'act-null', committedAt: OLD, resultData: null });
  // Result payload whose actionId does not match the receipt's own column.
  insertReceipt(db, {
    actionId: 'act-mismatch',
    committedAt: OLD,
    resultData: JSON.stringify({ actionId: 'other-action', confirmedThrough: 3 })
  });
  // confirmedThrough must be an integer to prove the replay cursor.
  insertReceipt(db, {
    actionId: 'act-cursor',
    committedAt: OLD,
    resultData: JSON.stringify({ actionId: 'act-cursor', confirmedThrough: '41' })
  });
  // Recent receipt — above the age cutoff.
  insertReceipt(db, {
    actionId: 'act-recent',
    committedAt: NOW,
    resultData: JSON.stringify({ actionId: 'act-recent', confirmedThrough: 9 })
  });

  assert.equal(compactReceiptResultData(db, NOW), 0, 'nothing is admissible');
  for (const actionId of ['act-mixed', 'act-malformed', 'act-null', 'act-mismatch', 'act-cursor', 'act-recent']) {
    const row = db.prepare('SELECT resultData FROM _ActionReceipt WHERE actionId = ?').get(actionId);
    assert.ok(row.resultData === null || !row.resultData.includes('__workbenchCompactedResult'), `${actionId} untouched`);
  }
});

test('the cutoff is strict and repeated sweeps are no-ops', () => {
  const db = openDb();
  const boundary = '2021-06-01T12:00:00.000Z';
  insertReceipt(db, {
    actionId: 'act-boundary',
    committedAt: boundary,
    resultData: JSON.stringify({ actionId: 'act-boundary', confirmedThrough: 1 })
  });

  assert.equal(compactReceiptResultData(db, boundary), 0, 'committedAt == cutoff is not past the cutoff');
  assert.equal(compactReceiptResultData(db, NOW), 1);
  assert.equal(
    compactReceiptResultData(db, NOW),
    0,
    'an already-compacted receipt never re-matches, so sweep N+1 reclaims nothing'
  );
});
