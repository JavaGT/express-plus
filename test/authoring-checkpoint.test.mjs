import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  acknowledgeAndPruneSnapshot,
  ensureLease,
  ensureStream,
  issueAuthoringSnapshot,
  issuePositionFrame,
  recordSplit,
  resolvePosition,
} from '../src/annotated-text-authoring-stream.mjs';
import { annotatedTextAuthoringStreamDDL } from '../src/annotated-text-field.mjs';
import { runWorkbenchMigrations, appliedWorkbenchVersion } from '../src/workbench-migrations.mjs';

const prefix = 'Doc_body';

// Canonical (fresh-DB) authoring stream tables, exactly as the package DDL emits.
function baseDocTable() {
  return 'CREATE TABLE Doc (id TEXT PRIMARY KEY);';
}

function insertDoc(db, documentId) {
  db.prepare('INSERT OR IGNORE INTO Doc (id) VALUES (?)').run(documentId);
}

function setupCanonical() {
  const db = new DatabaseSync(':memory:');
  db.exec(baseDocTable());
  for (const sql of annotatedTextAuthoringStreamDDL('Doc', 'body')) db.exec(sql);
  return db;
}

function wireDoc(db, ...documentIds) {
  for (const id of documentIds) db.prepare('INSERT OR IGNORE INTO Doc (id) VALUES (?)').run(id);
}

// Legacy (pre-dedup) authoring stream tables: repeated family_checkpoint,
// no checkpoint table, no checkpoint_id column.
function setupLegacy() {
  const db = new DatabaseSync(':memory:');
  db.exec(baseDocTable());
  db.exec(`
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, block_id TEXT, family_checkpoint TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_group (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, group_id TEXT, visible_blocks TEXT NOT NULL, assignable INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
    CREATE TABLE ${prefix}_authoring_split (lease_id TEXT NOT NULL, temporary_block TEXT NOT NULL, authoritative_block_id TEXT NOT NULL, position_token TEXT NOT NULL, action_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fence INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (lease_id, temporary_block));
  `);
  return db;
}

// A large, valid text-family checkpoint. All positions from one snapshot basis
// share it — this is the shape whose 100x repetition used to blow the cap.
function largeCheckpoint(blockCount = 100) {
  const blockIds = [];
  const elements = {};
  for (let i = 0; i < blockCount; i += 1) {
    const blockId = `block-${i}`;
    elements[blockId] = {
      id: blockId,
      type: 'text',
      text: `T${String(i).padStart(6, '0')}`.repeat(7200),
      run: [{ style: 'plain' }],
    };
    blockIds.push(blockId);
  }
  return {
    id: 'unit-test-basis',
    checkpoint: { version: 1, frontier: blockIds, elements },
    blocks: blockIds,
  };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

function retainedBytesForLease(db, prefix, leaseId) {
  const byteSum = (sql, ...params) => Number(db.prepare(sql).get(...params).bytes ?? 0);
  const positionBytes = byteSum(
    `SELECT COALESCE(SUM(length(CAST(token AS BLOB)) + length(CAST(lease_id AS BLOB)) + length(CAST(issued_fence AS BLOB)) + length(CAST(block_id AS BLOB)) + length(CAST(checkpoint_id AS BLOB))), 0) AS bytes FROM ${prefix}_authoring_position WHERE lease_id = ?`,
    leaseId,
  );
  const checkpointBytes = byteSum(
    `SELECT COALESCE(SUM(length(CAST(family_checkpoint AS BLOB))), 0) AS bytes FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`,
    leaseId,
  );
  return positionBytes + checkpointBytes;
}

test('A1: production-shape bootstrap — one checkpoint, 100 positions, fits cap', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-1');
  const stream = ensureStream({ db, prefix, documentId: 'doc-1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const familyCheckpoint = largeCheckpoint(100);

  assert.ok(Buffer.byteLength(JSON.stringify(familyCheckpoint), 'utf8') > 700_000, 'fixture checkpoint too small');

  const positions = Array.from({ length: 100 }, (_, i) => ({ blockId: `block-${i}`, familyCheckpoint, visibleAtIssue: true }));
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions, groups: [] });
  assert.ok(snapshot);

  assert.equal(count(db, `${prefix}_authoring_position`), 100);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);
  const distinct = db.prepare(`SELECT COUNT(DISTINCT checkpoint_id) AS c FROM ${prefix}_authoring_position`).get().c;
  assert.equal(distinct, 1);

  const retained = retainedBytesForLease(db, prefix, lease.id);
  assert.ok(retained < 16 * 1024 * 1024, `retained bytes too large: ${retained}`);
});

test('A2: capacity refusal — oversized single basis refuses atomically', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-2');
  const stream = ensureStream({ db, prefix, documentId: 'doc-2', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  ensureStream({ db, prefix, documentId: 'doc-2', principalType: 'user', principalId: 'u1' });

  // A single basis whose ONE checkpoint already exceeds the 16 MiB cap must be
  // refused as a unit: no partial checkpoint/position rows may survive.
  const familyCheckpoint = largeCheckpoint(1);
  familyCheckpoint.checkpoint.elements['block-0'].text = 'X'.repeat(18 * 1024 * 1024);
  const positions = [{ blockId: 'block-0', familyCheckpoint, visibleAtIssue: true }];

  const result = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions, groups: [] });
  assert.equal(result, null, 'oversized single basis must be refused');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'no partial checkpoint from refused issuance');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no partial positions from refused issuance');
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_lease WHERE id = ?`).get(lease.id), 'lease survives refusal');
});

test('A2b: capacity refusal — churn beyond the cap refuses while prior state survives', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-2b');
  const stream = ensureStream({ db, prefix, documentId: 'doc-2b', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const positions = Array.from({ length: 100 }, (_, i) => ({ blockId: `block-${i}`, familyCheckpoint: largeCheckpoint(100), visibleAtIssue: true }));
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions, groups: [] });
  assert.ok(snapshot);
  const basisCheckpoint = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).get(lease.id).id;

  // Distinct ~1MB checkpoints per churn frame: 20 frames overshoot the cap.
  let refused = 0;
  let fitted = 0;
  for (let i = 0; i < 20; i += 1) {
    const churnCheckpoint = { ...largeCheckpoint(1), id: `churn-${i}` };
    churnCheckpoint.checkpoint.elements['block-0'].text = 'Y'.repeat(1024 * 1024 + (i * 1024));
    const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: `churn-${i}`, fence: 2, familyCheckpoint: churnCheckpoint, visibleAtIssue: true });
    if (frame) fitted += 1;
    else refused += 1;
  }
  assert.ok(refused > 0, `expected its refined churn frames to be refused (fitted=${fitted})`);

  // Prior valid state survives untouched.
  assert.equal(count(db, `${prefix}_authoring_position WHERE issued_fence = 1`), 100, 'prior snapshot positions must survive');
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(basisCheckpoint), 'prior basis checkpoint must survive');
  assert.equal(count(db, `${prefix}_authoring_position`), 100 + fitted, 'only fitted churn positions exist');
});

test('A3: ack/prune keeps tracked checkpoint until unreferenced then removes it', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-3');
  const stream = ensureStream({ db, prefix, documentId: 'doc-3', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const checkpointA = largeCheckpoint(10);
  const snapshotA = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: Array.from({ length: 10 }, (_, i) => ({ blockId: `a-${i}`, familyCheckpoint: checkpointA, visibleAtIssue: true })), groups: [] });
  const checkpointIdA = db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(snapshotA.positionFrames[0].token).checkpoint_id;
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // A replacement basis shares nothing; both bases stay tracked.
  const snapshotB = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: Array.from({ length: 5 }, (_, i) => ({ blockId: `b-${i}`, familyCheckpoint: largeCheckpoint(5), visibleAtIssue: true })), groups: [] });
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 2);

  // Acknowledge A. Its own position fence equals its fence so nothing prunes,
  // but the snapshot becomes the idempotency marker and A's checkpoint stays
  // referenced.
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotA.snapshot.id });
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(checkpointIdA), 'checkpoint A survives while referenced');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 2);

  // Acknowledge B. A's positions (fence 1 < 2) are no longer protected by an
  // outstanding snapshot and are pruned; checkpoint A becomes unreferenced and
  // the sweep removes it. B's checkpoint survives.
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotB.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(checkpointIdA), undefined, 'unreferenced checkpoint A removed');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'B checkpoint survives');

  // A third basis C replaces B (B already acknowledged): now B's checkpoint is
  // unreferenced after prune and is removed.
  const checkpointIdB = db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(snapshotB.positionFrames[0].token).checkpoint_id;
  const snapshotC = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 3, positions: Array.from({ length: 3 }, (_, i) => ({ blockId: `c-${i}`, familyCheckpoint: largeCheckpoint(3), visibleAtIssue: true })), groups: [] });
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotC.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(checkpointIdB), undefined, 'B checkpoint removed after its positions pruned');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'only C checkpoint remains');
  assert.equal(count(db, `${prefix}_authoring_position`), 3, 'anew acknowledged snapshot keeps its own positions');
});

test('A4: split lifecycle inherits checkpoint and protects it until resolved', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-4');
  const stream = ensureStream({ db, prefix, documentId: 'doc-4', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const basis = largeCheckpoint(3);
  const snapshotA = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'left', familyCheckpoint: basis, visibleAtIssue: true }], groups: [] });
  const source = db.prepare(`SELECT * FROM ${prefix}_authoring_position WHERE token = ?`).get(snapshotA.positionFrames[0].token);
  const sourceCheckpointId = source.checkpoint_id;

  // Split-created frame inherits the source position's checkpoint_id.
  const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: 'right', fence: 1, familyCheckpoint: basis, checkpointId: source.checkpoint_id, visibleAtIssue: true });
  assert.ok(frame);
  assert.equal(db.prepare(`SELECT checkpoint_id FROM ${prefix}_authoring_position WHERE token = ?`).get(frame.token).checkpoint_id, sourceCheckpointId);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'split must not copy the payload');

  // Unresolved split protects the split position and therefore the checkpoint.
  recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: 'temp', authoritativeBlockId: 'right', positionToken: frame.token, actionId: 'a1', mutationId: 'm1', fence: 1 });
  const snapshotB = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: [{ blockId: 'right', familyCheckpoint: largeCheckpoint(2), visibleAtIssue: true }], groups: [] });

  // Acknowledge A first: nothing prunes (fence 1 not < 1) and the unresolved
  // split still protects the source checkpoint.
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotA.snapshot.id });
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(sourceCheckpointId), 'unresolved split protects the checkpoint');

  // Acknowledge B: B covers the split authoritative block 'right', deleting the
  // split; the split frame and source position (fence 1 < 2, uncovered)
  // become prunable; the checkpoint is then unreferenced and removed.
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshotB.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_checkpoint WHERE id = ?`).get(sourceCheckpointId), undefined, 'resolved split releases the checkpoint when unreferenced');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'only the snapshot B checkpoint remains');
  assert.equal(count(db, `${prefix}_authoring_position`), 1, 'only snapshot B position remains');
});

test('A5: hydrate — resolvePosition returns family_checkpoint for consumers', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-5');
  const stream = ensureStream({ db, prefix, documentId: 'doc-5', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const familyCheckpoint = largeCheckpoint(2);
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'b', familyCheckpoint, visibleAtIssue: true }], groups: [] });

  const resolved = resolvePosition({ db, prefix, positionToken: snapshot.positionFrames[0].token, leaseId: lease.id });
  assert.ok(resolved, 'resolvePosition must hydrate a position');
  assert.ok(resolved.family_checkpoint, 'family_checkpoint must be present for consumers');
  assert.deepEqual(JSON.parse(resolved.family_checkpoint), familyCheckpoint);
});

test('A6: concurrent leases isolate checkpoints', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-6');
  const stream = ensureStream({ db, prefix, documentId: 'doc-6', principalType: 'user', principalId: 'u1' });
  const lease1 = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client-1' });
  const lease2 = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client-2' });

  issueAuthoringSnapshot({ db, prefix, leaseId: lease1.id, fence: 1, positions: Array.from({ length: 5 }, (_, i) => ({ blockId: `a-${i}`, familyCheckpoint: largeCheckpoint(5), visibleAtIssue: true })), groups: [] });
  issueAuthoringSnapshot({ db, prefix, leaseId: lease2.id, fence: 1, positions: Array.from({ length: 3 }, (_, i) => ({ blockId: `b-${i}`, familyCheckpoint: largeCheckpoint(3), visibleAtIssue: true })), groups: [] });

  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease1.id}'`), 1);
  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease2.id}'`), 1);
  const ids1 = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).all(lease1.id).map((row) => row.id);
  const ids2 = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).all(lease2.id).map((row) => row.id);
  assert.equal(ids1.some((id) => ids2.includes(id)), false, 'leases must not share checkpoints');

  // Expire lease1: its checkpoint is removed, lease2 is untouched.
  db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), lease1.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_position WHERE lease_id = ?`).run(lease1.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint WHERE lease_id = ? AND NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_position WHERE checkpoint_id = ${prefix}_authoring_checkpoint.id)`).run(lease1.id);
  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease1.id}'`), 0);
  assert.equal(count(db, `${prefix}_authoring_checkpoint WHERE lease_id = '${lease2.id}'`), 1);
});

test('A8: migration — legacy schema upgrades atomically, preserves durable data', () => {
  const db = setupLegacy();
  // Populate a legacy stream with full chip-slot state.
  const stream = ensureStream({ db, prefix, documentId: 'doc-7', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('pos-1', lease.id, 1, 'block-1', JSON.stringify({ a: 1 }), 1, new Date().toISOString());
  db.prepare(`INSERT INTO ${prefix}_authoring_group (token, lease_id, issued_fence, group_id, visible_blocks, assignable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('group-1', lease.id, 1, 'g1', '[]', 1, new Date().toISOString());
  db.prepare(`INSERT INTO ${prefix}_authoring_snapshot (id, lease_id, fence, issued_at, acknowledged_at) VALUES (?, ?, ?, ?, ?)`).run('snap-1', lease.id, 1, new Date().toISOString(), null);
  db.prepare(`INSERT INTO ${prefix}_authoring_snapshot_position (snapshot_id, position_token) VALUES (?, ?)`).run('snap-1', 'pos-1');
  db.prepare(`INSERT INTO ${prefix}_authoring_split (lease_id, temporary_block, authoritative_block_id, position_token, action_id, mutation_id, fence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(lease.id, 'temp-1', 'block-1', 'pos-1', 'a1', 'm1', 1, new Date().toISOString());

  // Durable/table state deliberately NOT authoring ephemeral — keep a marker table.
  db.exec(`CREATE TABLE durable_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare('INSERT INTO durable_marker (id, value) VALUES (?, ?)').run('m1', 'keep');

  // Run the built-in Workbench migration (fresh apply).
  runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), 1);

  // Canonical shape: position has checkpoint_id NOT NULL, no family_checkpoint.
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('checkpoint_id'), 'position must have checkpoint_id after migration');
  assert.ok(positionColumns.has('family_checkpoint') === false, 'legacy family_checkpoint column removed');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'all legacy ephemeral state cleared up front');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no legacy positions preserved');

  // Durable data + committed log untouched.
  assert.ok(db.prepare(`SELECT 1 FROM durable_marker WHERE id = 'm1'`).get());

  // Fresh bootstrap works on the migrated schema.
  const freshStream = ensureStream({ db, prefix, documentId: 'doc-8', principalType: 'user', principalId: 'u1' });
  const freshLease = ensureLease({ db, prefix, streamId: freshStream.id, clientNonceHash: 'client-fresh' });
  const snap = issueAuthoringSnapshot({ db, prefix, leaseId: freshLease.id, fence: 1, positions: [{ blockId: 'b', familyCheckpoint: largeCheckpoint(2), visibleAtIssue: true }], groups: [] });
  assert.ok(snap);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // Second startup is a no-op.
  runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), 1);
});

test('A8-rollback: induced migration failure rolls back and leaves legacy schema intact', () => {
  const db = setupLegacy();
  const stream = ensureStream({ db, prefix, documentId: 'doc-9', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('pos-1', lease.id, 1, 'block-1', JSON.stringify({ a: 1 }), 1, new Date().toISOString());

  // Durable marker table that will be preserved even on failure.
  db.exec(`CREATE TABLE durable_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare('INSERT INTO durable_marker (id, value) VALUES (?, ?)').run('keep', 'keep');

  // Force the migration to fail after partial work (READONLY dir on SQLite or
  // a trigger that aborts the rebuild). Simplest: a BEFORE DELETE trigger on
  // legacy position that aborts — failure inside the exclusive txn rolls back.
  db.exec(`CREATE TRIGGER fail_migration BEFORE DELETE ON ${prefix}_authoring_position BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() => runWorkbenchMigrations(db), /injected failure/);

  // Rollback: legacy shape preserved, version not recorded, no partial state.
  assert.equal(appliedWorkbenchVersion(db), 0, 'no version on rollback');
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('family_checkpoint'), 'legacy position column preserved after rollback');
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = 'pos-1'`).get(), 'legacy position row survives rollback');
  assert.ok(db.prepare(`SELECT 1 FROM durable_marker WHERE id = 'keep'`).get());

  // With the trigger removed, the same run succeeds (idempotent re-apply after rollback).
  db.exec(`DROP TRIGGER fail_migration`);
  runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), 1);
});

test('A8-fresh: migration on a fresh canonical DB is a structural no-op with preserved lineage', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-10');
  const stream = ensureStream({ db, prefix, documentId: 'doc-10', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  // Pre-migration issuance exists; a canonical family must survive v1 intact.
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'b', familyCheckpoint: { id: 'fresh', checkpoint: { version: 1, frontier: ['b'], elements: { b: { id: 'b', type: 'text', text: 'x', run: [] } } }, blocks: ['b'] }, visibleAtIssue: true }], groups: [] });
  assert.equal(count(db, `${prefix}_authoring_position`), 1);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1);

  // Fresh DB → migration v1 is a genuine canonical-skip no-op, then re-run no-op.
  runWorkbenchMigrations(db);
  runWorkbenchMigrations(db);
  assert.equal(appliedWorkbenchVersion(db), 1);

  // Issued canonical data survives the migration untouched (no clear/rebuild).
  assert.equal(count(db, `${prefix}_authoring_position`), 1, 'canonical positions preserved by migration');
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 1, 'canonical checkpoint preserved by migration');
  const checksum = db.prepare(`SELECT length(family_checkpoint) AS len FROM ${prefix}_authoring_checkpoint`).get().len;
  assert.ok(checksum > 0, 'checkpoint payload survives');

  // The canonical structure must already be in place (new DDL emitted it);
  // the migration does not regress it.
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.equal(positionColumns.has('checkpoint_id'), true, 'checkpoint_id present');
  assert.equal(positionColumns.has('family_checkpoint'), false, 'no family_checkpoint column');
});

test('A8-incomplete: partial authoring family fails closed and rolls back', () => {
  const db = setupLegacy();
  wireDoc(db, 'doc-10b');
  // Omit the authoring_group table → incomplete legacy family.
  db.exec('DROP TABLE Doc_body_authoring_group');

  assert.throws(() => runWorkbenchMigrations(db), /incomplete authoring stream table family/);
  assert.equal(appliedWorkbenchVersion(db), 0, 'no version recorded on fail-closed refusal');
  // The legacy position table is untouched (nothing cleared).
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('family_checkpoint'), 'legacy position table preserved on refusal');
});

test('A8-parity: migrated schema matches fresh canonical schema exactly', () => {
  const fresh = setupCanonical();
  const migrated = setupLegacy();
  // Populate a legacy row so the rebuild runs, then migrate.
  const stream = ensureStream({ db: migrated, prefix, documentId: 'd', principalType: 'user', principalId: 'u' });
  const lease = ensureLease({ db: migrated, prefix, streamId: stream.id, clientNonceHash: 'c' });
  migrated.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES ('p1', ?, 1, 'b1', '{"a":1}', 1, '2020-01-01')`).run(lease.id);
  migrated.prepare(`INSERT INTO ${prefix}_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES ('lease-x', 's1', 'n1', 0, '2020-01-01', '2099-01-01')`).run();
  runWorkbenchMigrations(migrated);

  const describe = (db) => ({
    position: db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => `${r.name}:${r.type}:${r.notnull}:${r.pk}:${r.dflt_value ?? ''}`),
    checkpoint: db.prepare(`PRAGMA table_info(${prefix}_authoring_checkpoint)`).all().map((r) => `${r.name}:${r.type}:${r.notnull}:${r.pk}:${r.dflt_value ?? ''}`),
    fkeys: db.prepare(`PRAGMA foreign_key_list(${prefix}_authoring_position)`).all().sort((a, b) => a.id - b.id).map((r) => `${r.table}:${r.from}:${r.to}:${r.on_delete}`),
  });
  assert.deepEqual(describe(migrated), describe(fresh), 'position/checkpoint schema identical after migration vs fresh canonical');
});

test('A-emptyp: a snapshot with zero visible blocks issues without touching checkpoints', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-emptyp');
  const stream = ensureStream({ db, prefix, documentId: 'doc-emptyp', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });

  const result = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [], groups: [{ groupId: 'g1', visibleBlocks: ['b1'], assignable: true }] });
  assert.ok(result, 'empty-positions snapshot issues successfully');
  assert.equal(result.positionFrames.length, 0);
  assert.equal(result.groupFrames.length, 1);
  assert.equal(count(db, `${prefix}_authoring_checkpoint`), 0, 'no checkpoint created for empty positions');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'no position rows for empty positions');
});

test('A9: contract parity — envelope/token fixtures unchanged', () => {
  const db = setupCanonical();
  wireDoc(db, 'doc-11');
  const stream = ensureStream({ db, prefix, documentId: 'doc-11', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'b', familyCheckpoint: { id: 'basis', checkpoint: { version: 1, frontier: ['b'], elements: { b: { id: 'b', type: 'text', text: 'x', run: [] } } }, blocks: ['b'] }, visibleAtIssue: true }], groups: [] });

  assert.ok(snapshot.snapshot.id);
  assert.ok(snapshot.positionFrames.length === 1);
  const frame = snapshot.positionFrames[0];
  assert.ok(frame.token, 'position token still opaque');
  assert.equal(frame.token.includes(':'), false, 'no checkpoint/lease structure leaks into the token');
  assert.equal(frame.blockId, 'b');
});

test('A10: app.prepareSchema upgrades a legacy authoring schema via the built-in lane', async () => {
  const internal = await import('../src/internal.mjs');
  const {
    annotation,
    annotatedText,
    entity: appEntity,
    measurement,
    ref,
    registerAnnotatedTextContract,
    registerAnnotatedTextStructuralExtension,
  } = internal;
  const workbench = internal.default;
  registerAnnotatedTextContract('checkpointA10Measurement', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('checkpointA10Measurement', Object.freeze({
    version: 1,
    validate() {}, edit() {},
    partition({ blockText, utf16Offset, payload }) {
      return Object.freeze({ version: 1, leftPayload: Object.freeze({ ...payload, text: blockText.slice(0, utf16Offset) }), rightPayload: Object.freeze({ ...payload, text: blockText.slice(utf16Offset) }) });
    },
    combine({ left, right }) { return Object.freeze({ version: 1, payload: Object.freeze({ text: `${left?.payload.text ?? ''}${right?.payload.text ?? ''}` }) }); },
  }));
  const db = new DatabaseSync(':memory:');
  // Legacy authoring tables (pre-dedup shape) AND the parent entity table.
  db.exec(`
    CREATE TABLE Transcript (id TEXT PRIMARY KEY);
    CREATE TABLE Project (id TEXT PRIMARY KEY);
    CREATE TABLE User (id TEXT PRIMARY KEY);
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, block_id TEXT, family_checkpoint TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_group (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, group_id TEXT, visible_blocks TEXT NOT NULL, assignable INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
    CREATE TABLE ${prefix}_authoring_split (lease_id TEXT NOT NULL, temporary_block TEXT NOT NULL, authoritative_block_id TEXT NOT NULL, position_token TEXT NOT NULL, action_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fence INTEGER NOT NULL, created_at TEXT NOT NULL);
  `);
  db.prepare(`INSERT INTO ${prefix}_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES ('lease-1', 's1', 'n1', 0, '2020-01-01', '2099-01-01')`).run();
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES ('pos-1', 'lease-1', 1, 'block-1', '{"a":1}', 1, '2020-01-01')`).run();

  const body = annotatedText({
    project: 'project',
    owner: 'owner',
    annotations: [annotation('note', { fields: {} })],
    measurements: [measurement('source', { extension: 'checkpointA10Measurement' })],
  });
  const TranscriptEntity = appEntity('Transcript', {
    project: ref('Project'),
    owner: ref('User'),
    body,
  });
  const app = workbench({ db, entities: [TranscriptEntity] });
  await app.prepareSchema();

  // The built-in migration rebuilt the position table into canonical shape.
  const positionColumns = new Set(db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name));
  assert.ok(positionColumns.has('checkpoint_id'), 'position has checkpoint_id after app boot');
  assert.ok(positionColumns.has('family_checkpoint') === false, 'legacy family_checkpoint column removed after app boot');
  const applied = db.prepare('SELECT MAX(version) AS v FROM _WorkbenchMigration').get();
  assert.equal(applied.v, 1, 'Workbench migration v1 recorded');
  assert.equal(count(db, `${prefix}_authoring_position`), 0, 'pre-migration legacy positions cleared');
  app.db.close();
});
