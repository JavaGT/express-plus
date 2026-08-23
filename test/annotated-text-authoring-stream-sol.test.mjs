import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTHORING_STREAM_LIMITS, acknowledgeAndPruneSnapshot, ensureLease, ensureStream,
  issueAuthoringSnapshot, issuePositionFrame, resolveLease, resolveStream,
  readAnnotatedTextFamilyCheckpoint,
} from '../build/annotated-text-authoring-stream.mjs';

const prefix = 'Doc_body';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_checkpoint (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, checkpoint_id TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
    CREATE TABLE ${prefix}_state (document_id TEXT PRIMARY KEY, family_checkpoint TEXT NOT NULL);
  `);
  return db;
}

test('family checkpoint accessor returns undefined when the state row is absent', () => {
  const db = setup();
  assert.equal(readAnnotatedTextFamilyCheckpoint(db, prefix, 'missing'), undefined);
  db.prepare(`INSERT INTO ${prefix}_state (document_id, family_checkpoint) VALUES (?, ?)`).run('d1', '{}');
  assert.equal(readAnnotatedTextFamilyCheckpoint(db, prefix, 'd1'), '{}');
});

function fatCheckpoint(label) {
  // Large enough that a few retained frames exhaust maxRetainedPerLease when
  // stacked with checkpoints + snapshot ownership rows.
  return { label, padding: 'x'.repeat(Math.floor(AUTHORING_STREAM_LIMITS.maxRetainedPerLease / 3)) };
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

test('position capacity refusal rolls back the complete snapshot issue', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  // Fill the lease near capacity with retained predecessor frames, then refuse
  // a snapshot whose single document frame cannot fit.
  for (let index = 0; index < 4; index += 1) {
    const issued = issueAuthoringSnapshot({
      db, prefix, leaseId: lease.id, fence: index + 1,
      positions: [{ familyCheckpoint: fatCheckpoint(`fill-${index}`), visibleAtIssue: true }],
    });
    if (!issued) break;
  }
  const beforePositions = db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_position`).get().count;
  const beforeSnapshots = db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_snapshot`).get().count;
  const result = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 99,
    positions: [{ familyCheckpoint: fatCheckpoint('overflow'), visibleAtIssue: true }],
  });
  // Capacity failure either refuses (null) or clears lease children and retries.
  // Either way the overflow frame must not leave a half-issued snapshot.
  if (result === null) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_position`).get().count, beforePositions);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_snapshot`).get().count, beforeSnapshots);
  } else {
    assert.equal(result.positionFrames.length, 1);
    assert.ok(result.snapshot?.id);
  }
});

test('acknowledgement atomically preserves frames named by an older outstanding snapshot', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const older = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 1,
    positions: [{ familyCheckpoint: { basis: 'older' }, visibleAtIssue: true }],
  });
  const current = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 2,
    positions: [{ familyCheckpoint: { basis: 'current' }, visibleAtIssue: true }],
  });

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
  const predecessor = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 1,
    positions: [{ familyCheckpoint: { basis: 'same' }, visibleAtIssue: true }],
  });
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: predecessor.snapshot.id });
  const replacement = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 2,
    positions: [{ familyCheckpoint: { basis: 'same' }, visibleAtIssue: true }],
  });

  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(predecessor.positionFrames[0].token),
    'queued actions may still use the predecessor token before replacement acknowledgement');
  acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: replacement.snapshot.id });
  assert.equal(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(predecessor.positionFrames[0].token), undefined);
});

test('a pruning failure rolls back acknowledgement and lease advancement', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const predecessor = issuePositionFrame({
    db, prefix, leaseId: lease.id, fence: 1, familyCheckpoint: { basis: 'old' }, visibleAtIssue: true,
  });
  const snapshot = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 2,
    positions: [{ familyCheckpoint: { basis: 'current' }, visibleAtIssue: true }],
  });
  db.exec(`CREATE TRIGGER reject_authoring_prune BEFORE DELETE ON ${prefix}_authoring_position WHEN OLD.token = '${predecessor.token}' BEGIN SELECT RAISE(ABORT, 'prune rejected'); END;`);

  assert.throws(() => acknowledgeAndPruneSnapshot({ db, prefix, leaseId: lease.id, snapshotId: snapshot.snapshot.id }), /prune rejected/);
  assert.equal(db.prepare(`SELECT acknowledged_at FROM ${prefix}_authoring_snapshot WHERE id = ?`).get(snapshot.snapshot.id).acknowledged_at, null);
  assert.equal(db.prepare(`SELECT acknowledged_fence FROM ${prefix}_authoring_lease WHERE id = ?`).get(lease.id).acknowledged_fence, 0);
  assert.ok(db.prepare(`SELECT 1 FROM ${prefix}_authoring_position WHERE token = ?`).get(predecessor.token));
});

test('issueAuthoringSnapshot returns one document-scoped position frame (no groupFrames)', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, documentId: 'd1', principalType: 'user', principalId: 'u1' });
  const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: 'client' });
  const issued = issueAuthoringSnapshot({
    db, prefix, leaseId: lease.id, fence: 1,
    positions: [{ familyCheckpoint: { basis: 'doc' }, visibleAtIssue: true, redactions: [] }],
  });
  assert.equal(issued.positionFrames.length, 1);
  assert.equal(typeof issued.positionFrames[0].token, 'string');
  assert.equal('groupFrames' in issued, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${prefix}_authoring_position`).get().count, 1);
});
