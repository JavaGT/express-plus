import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTHORING_STREAM_LIMITS, acknowledgeAndPruneSnapshot, ensureLease, ensureStream,
  issueAuthoringSnapshot, issuePositionFrame, recordSplit, resolveLease, resolveStream,
} from '../src/annotated-text-authoring-stream.mjs';

const prefix = 'Doc_body';

function setup() {
  const db = new DatabaseSync(':memory:');
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

test('authoring streams retain the actual principal type as part of identity', () => {
  const db = setup();
  const user = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'same-id' });
  const apiKey = ensureStream({ db, prefix, documentId: 'd1', principalType: 'apiKey', principalId: 'same-id' });

  assert.notEqual(user.id, apiKey.id);
  assert.equal(resolveStream({ db, prefix, streamToken: user.id, documentId: 'd1', principalType: 'apiKey', principalId: 'same-id' }), null);
  assert.equal(resolveStream({ db, prefix, streamToken: user.id, documentId: 'd1', principalType: 'user', principalId: 'same-id' }).id, user.id);
});

test('an active lease keeps its stream usable past the stream timestamp', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  db.prepare(`UPDATE ${prefix}_authoring_stream SET expires_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', stream.id);

  assert.equal(resolveStream({ db, prefix, streamToken: stream.id, documentId: 'd1', principalType: 'user', principalId: 'u1' }).id, stream.id);
  assert.equal(resolveLease({ db, prefix, leaseToken: lease.id, streamId: stream.id }).id, lease.id);
  assert.ok(new Date(db.prepare(`SELECT expires_at FROM ${prefix}_authoring_stream WHERE id = ?`).get(stream.id).expires_at).getTime() > Date.now());
});

test('group capacity refusal rolls back the complete snapshot issue', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const result = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 1,
    positions: [{ blockId: 'visible', familyCheckpoint: { checkpoint: 'small' }, visibleAtIssue: true }],
    groups: [{ groupId: 'group', visibleBlocks: ['x'.repeat(AUTHORING_STREAM_LIMITS.maxRetainedPerLease)], assignable: true }],
  });

  assert.equal(result, null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_position`).get().count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_group`).get().count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_snapshot`).get().count, 0);
});

test('split records count toward the unresolved split cap', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const insert = db.prepare(`INSERT INTO ${prefix}_authoring_split (lease_id, temporary_block, authoritative_block_id, position_token, action_id, mutation_id, fence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < AUTHORING_STREAM_LIMITS.maxUnresolvedSplits; index += 1) insert.run(lease.id, `temp-${index}`, `block-${index}`, `position-${index}`, `action-${index}`, `mutation-${index}`, 1, '2026-01-01T00:00:00.000Z');

  assert.equal(recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: 'one-too-many', authoritativeBlockId: 'block', positionToken: 'position', actionId: 'action', mutationId: 'mutation', fence: 2 }), null);
});

test('acknowledgement atomically preserves frames named by an older outstanding snapshot', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const older = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'older', familyCheckpoint: {}, visibleAtIssue: true }], groups: [] });
  const current = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: [{ blockId: 'current', familyCheckpoint: {}, visibleAtIssue: true }], groups: [] });

  assert.deepEqual(acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: current.snapshot.id }), { fence: 2, alreadyAcknowledged: false });
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(older.positionFrames[0].token));
  assert.equal(db.prepare(`SELECT acknowledged_at FROM ${prefix}_authoring_snapshot WHERE id = ?`).get(older.snapshot.id).acknowledged_at, null);
  assert.equal(db.prepare(`SELECT acknowledged_fence FROM ${prefix}_authoring_lease WHERE id = ?`).get(lease.id).acknowledged_fence, 2);
  assert.deepEqual(acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: current.snapshot.id }), { fence: 2, alreadyAcknowledged: true });
});

test('acknowledging a replacement eventually prunes an acknowledged predecessor frame', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const predecessor = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 1, positions: [{ blockId: 'same', familyCheckpoint: {}, visibleAtIssue: true }], groups: [] });
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: predecessor.snapshot.id });
  const replacement = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: [{ blockId: 'same', familyCheckpoint: {}, visibleAtIssue: true }], groups: [] });

  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(predecessor.positionFrames[0].token),
    'queued actions may still use the predecessor token before replacement acknowledgement');
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: replacement.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(predecessor.positionFrames[0].token), undefined);
});

test('a pruning failure rolls back acknowledgement and lease advancement', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const predecessor = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: 'old', fence: 1, familyCheckpoint: {}, visibleAtIssue: true });
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: [{ blockId: 'current', familyCheckpoint: {}, visibleAtIssue: true }], groups: [] });
  db.exec(`CREATE TRIGGER reject_authoring_prune BEFORE DELETE ON ${prefix}_authoring_position WHEN OLD.token = '${predecessor.token}' BEGIN SELECT RAISE(ABORT, 'prune rejected'); END;`);

  assert.throws(() => acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshot.snapshot.id }), /prune rejected/);
  assert.equal(db.prepare(`SELECT acknowledged_at FROM ${prefix}_authoring_snapshot WHERE id = ?`).get(snapshot.snapshot.id).acknowledged_at, null);
  assert.equal(db.prepare(`SELECT acknowledged_fence FROM ${prefix}_authoring_lease WHERE id = ?`).get(lease.id).acknowledged_fence, 0);
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(predecessor.token));
});

test('acknowledgement prunes only covered split records and their predecessor frame', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const splitFrame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: 'right', fence: 1, familyCheckpoint: {}, visibleAtIssue: true });
  const unresolvedFrame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: 'unknown', fence: 1, familyCheckpoint: {}, visibleAtIssue: true });
  recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: 'covered', authoritativeBlockId: 'right', positionToken: splitFrame.token, actionId: 'a1', mutationId: 'm1', fence: 1 });
  recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: 'unknown', authoritativeBlockId: 'unknown', positionToken: unresolvedFrame.token, actionId: 'a2', mutationId: 'm2', fence: 1 });
  const snapshot = issueAuthoringSnapshot({ db, prefix, leaseId: lease.id, fence: 2, positions: [{ blockId: 'right', familyCheckpoint: {}, visibleAtIssue: true }], groups: [] });

  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshot.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_split WHERE temporary_block = 'covered'`).get(), undefined);
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(splitFrame.token), undefined);
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_split WHERE temporary_block = 'unknown'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(unresolvedFrame.token));
});

test('split duplicate requires an exact lease-local outcome match', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const split = { db, prefix, leaseId: lease.id, temporaryBlock: 'temp', authoritativeBlockId: 'right', positionToken: 'position', actionId: 'action', mutationId: 'mutation', fence: 1 };

  assert.deepEqual(recordSplit(split), { duplicate: false });
  assert.equal(recordSplit(split).duplicate, true);
  assert.throws(() => recordSplit({ ...split, mutationId: 'other' }), /split temporary block conflict/);
  assert.throws(() => recordSplit({ ...split, positionToken: 'other-position' }), /split temporary block conflict/);
  assert.throws(() => recordSplit({ ...split, fence: 2 }), /split temporary block conflict/);
});
