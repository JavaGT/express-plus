import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LEASES_PER_STREAM = 16;
const MAX_RETAINED_PER_LEASE = 16 * 1024 * 1024;
const MAX_RETAINED_PER_STREAM = 64 * 1024 * 1024;
const MAX_UNRESOLVED_SPLITS = 256;

function base64url(bytes) {
  return bytes.toString('base64url');
}

function randomToken() {
  return base64url(randomBytes(TOKEN_BYTES));
}

function fail(message) {
  throw new Error(`annotated-text authoring stream: ${message}`);
}

function now() {
  return new Date().toISOString();
}

function clientNonceHash(nonce) {
  return createHash('sha256').update(nonce).digest('hex');
}

export function allocateStreamToken() {
  return randomToken();
}

export function allocateLeaseToken() {
  return randomToken();
}

export function allocatePositionToken() {
  return randomToken();
}

export function allocateGroupToken() {
  return randomToken();
}

export function allocateSnapshotToken() {
  return randomToken();
}

export function allocateClientNonce() {
  return randomToken();
}

export function hashClientNonce(nonce) {
  return clientNonceHash(nonce);
}

export function ensureStream({ db, prefix, documentId, principalType, principalId }) {
  const existing = db.prepare(`SELECT id, expires_at FROM ${prefix}_authoring_stream WHERE document_id = ? AND principal_type = ? AND principal_id = ?`).get(documentId, principalType, principalId);
  if (existing) {
    const expiresAt = new Date(existing.expires_at).getTime();
    const hasLiveLease = db.prepare(`SELECT 1 FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at > ?`).get(existing.id, now());
    if (expiresAt > Date.now() || hasLiveLease) {
      const usedAt = now();
      db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(usedAt, new Date(Date.now() + LEASE_TTL_MS).toISOString(), existing.id);
      return { id: existing.id, created: false };
    }
    db.prepare(`DELETE FROM ${prefix}_authoring_stream WHERE id = ?`).run(existing.id);
  }
  const id = randomToken();
  // Streams do not outlive their leases.  A stream expiration is only a
  // backstop for a never-used stream, not a second retention policy.
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  db.prepare(`INSERT INTO ${prefix}_authoring_stream (id, document_id, principal_type, principal_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, documentId, principalType, principalId, now(), now(), expiresAt);
  return { id, created: true };
}

export function ensureLease({ db, prefix, streamId, clientNonceHash }) {
  const existing = db.prepare(`SELECT id, acknowledged_fence, expires_at FROM ${prefix}_authoring_lease WHERE stream_id = ? AND client_nonce_hash = ?`).get(streamId, clientNonceHash);
  if (existing) {
    const expiresAt = new Date(existing.expires_at).getTime();
    if (expiresAt > Date.now()) {
      const newExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
      db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run(newExpiresAt, existing.id);
      db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(now(), newExpiresAt, streamId);
      return { id: existing.id, created: false, acknowledgedFence: existing.acknowledged_fence };
    }
    clearLeaseChildren(db, prefix, existing.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(existing.id);
  }
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM ${prefix}_authoring_lease WHERE stream_id = ?`).get(streamId).cnt;
  if (count >= MAX_LEASES_PER_STREAM) {
    const expired = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at < ? ORDER BY expires_at ASC LIMIT 1`).get(streamId, now());
    if (expired) {
      clearLeaseChildren(db, prefix, expired.id);
      db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(expired.id);
    } else {
      return null;
    }
  }
  const id = randomToken();
  const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  db.prepare(`INSERT INTO ${prefix}_authoring_lease (id, stream_id, client_nonce_hash, acknowledged_fence, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, streamId, clientNonceHash, 0, now(), expiresAt);
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(now(), expiresAt, streamId);
  return { id, created: true, acknowledgedFence: 0 };
}

export const AUTHORING_STREAM_LIMITS = Object.freeze({
  leaseTtlMs: LEASE_TTL_MS,
  maxLeasesPerStream: MAX_LEASES_PER_STREAM,
  maxRetainedPerLease: MAX_RETAINED_PER_LEASE,
  maxRetainedPerStream: MAX_RETAINED_PER_STREAM,
  maxUnresolvedSplits: MAX_UNRESOLVED_SPLITS,
});

function clearLeaseChildren(db, prefix, leaseId) {
  db.prepare(`DELETE FROM ${prefix}_authoring_position WHERE lease_id = ?`).run(leaseId);
  db.prepare(`DELETE FROM ${prefix}_authoring_group WHERE lease_id = ?`).run(leaseId);
  db.prepare(`DELETE FROM ${prefix}_authoring_snapshot WHERE lease_id = ?`).run(leaseId);
  db.prepare(`DELETE FROM ${prefix}_authoring_split WHERE lease_id = ?`).run(leaseId);
  db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint WHERE lease_id = ?`).run(leaseId);
}

export function resolveStream({ db, prefix, streamToken, documentId, principalType, principalId }) {
  const stream = db.prepare(`SELECT * FROM ${prefix}_authoring_stream WHERE id = ? AND document_id = ? AND principal_type = ? AND principal_id = ?`).get(streamToken, documentId, principalType, principalId);
  if (!stream) return null;
  const hasLiveLease = db.prepare(`SELECT 1 FROM ${prefix}_authoring_lease WHERE stream_id = ? AND expires_at > ?`).get(stream.id, now());
  const expiresAt = new Date(stream.expires_at).getTime();
  if (expiresAt <= Date.now() && !hasLiveLease) {
    clearStream(db, prefix, stream.id);
    return null;
  }
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(now(), new Date(Date.now() + LEASE_TTL_MS).toISOString(), stream.id);
  return stream;
}

export function resolveLease({ db, prefix, leaseToken, streamId }) {
  const lease = db.prepare(`SELECT * FROM ${prefix}_authoring_lease WHERE id = ? AND stream_id = ?`).get(leaseToken, streamId);
  if (!lease) return null;
  const expiresAt = new Date(lease.expires_at).getTime();
  if (expiresAt <= Date.now()) {
    clearLeaseChildren(db, prefix, lease.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(lease.id);
    return null;
  }
  // Any authenticated lease use is activity. This keeps the stream alive through
  // its live lease rather than an independent stream-age deadline.
  const newExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run(newExpiresAt, lease.id);
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ?, expires_at = ? WHERE id = ?`).run(now(), newExpiresAt, streamId);
  return lease;
}

export function resolvePosition({ db, prefix, positionToken, leaseId }) {
  const position = db.prepare(`SELECT position.*, checkpoint.family_checkpoint AS family_checkpoint FROM ${prefix}_authoring_position AS position LEFT JOIN ${prefix}_authoring_checkpoint AS checkpoint ON checkpoint.id = position.checkpoint_id WHERE position.token = ? AND position.lease_id = ?`).get(positionToken, leaseId);
  if (!position) return null;
  return position;
}

export function resolveGroup({ db, prefix, groupToken, leaseId }) {
  return db.prepare(`SELECT * FROM ${prefix}_authoring_group WHERE token = ? AND lease_id = ?`).get(groupToken, leaseId) || null;
}

export function issueGroupFrame({ db, prefix, leaseId, groupId, visibleBlocks, assignable, fence }) {
  const token = randomToken();
  const visibleBlocksJson = JSON.stringify(visibleBlocks);
  const createdAt = now();
  if (!hasCapacity({ db, prefix, leaseId, bytes: rowBytes([token, leaseId, fence, groupId, visibleBlocksJson, assignable ? 1 : 0, createdAt]) })) return null;
  db.prepare(`INSERT INTO ${prefix}_authoring_group (token, lease_id, issued_fence, group_id, visible_blocks, assignable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, leaseId, fence, groupId, visibleBlocksJson, assignable ? 1 : 0, createdAt);
  return { token };
}

function ensureCheckpointForBasis({ db, prefix, leaseId, familyCheckpoint }) {
  const serialized = JSON.stringify(familyCheckpoint);
  const existing = db.prepare(`SELECT id FROM ${prefix}_authoring_checkpoint WHERE lease_id = ? AND family_checkpoint = ? LIMIT 1`).get(leaseId, serialized);
  if (existing) return existing.id;
  const id = randomToken();
  db.prepare(`INSERT INTO ${prefix}_authoring_checkpoint (id, lease_id, family_checkpoint, created_at) VALUES (?, ?, ?, ?)`).run(id, leaseId, serialized, now());
  return id;
}

export function issuePositionFrame({ db, prefix, leaseId, blockId, fence, familyCheckpoint, checkpointId, visibleAtIssue }) {
  const token = randomToken();
  const resolvedCheckpointId = checkpointId ?? ensureCheckpointForBasis({ db, prefix, leaseId, familyCheckpoint });
  const createdAt = now();
  if (!hasCapacity({ db, prefix, leaseId, bytes: rowBytes([token, leaseId, fence, blockId, resolvedCheckpointId, visibleAtIssue ? 1 : 0, createdAt]) })) {
    db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint AS checkpoint WHERE checkpoint.id = ? AND NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_position WHERE checkpoint_id = checkpoint.id)`).run(resolvedCheckpointId);
    return null;
  }
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, checkpoint_id, visible_at_issue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, leaseId, fence, blockId, resolvedCheckpointId, visibleAtIssue ? 1 : 0, createdAt);
  return { token, blockId };
}

export function issueSnapshot({ db, prefix, leaseId, fence }) {
  const id = randomToken();
  const issuedAt = now();
  if (!hasCapacity({ db, prefix, leaseId, bytes: rowBytes([id, leaseId, fence, issuedAt, null]) })) return null;
  db.prepare(`INSERT INTO ${prefix}_authoring_snapshot (id, lease_id, fence, issued_at) VALUES (?, ?, ?, ?)`).run(id, leaseId, fence, issuedAt);
  return { id, fence };
}

// A snapshot is one retained unit. Capacity failure must not leave predecessor
// frames behind because those rows are unacknowledged and cannot be evicted.
export function issueAuthoringSnapshot({ db, prefix, leaseId, fence, positions, groups }) {
  db.exec('SAVEPOINT authoring_snapshot_issue');
  try {
    const checkpointId = positions.length > 0
      ? ensureCheckpointForBasis({ db, prefix, leaseId, familyCheckpoint: positions[0].familyCheckpoint })
      : null;
    const positionFrames = positions.map((position) => issuePositionFrame({ db, prefix, leaseId, fence, ...(checkpointId ? { checkpointId } : {}), ...position }));
    if (positionFrames.some((frame) => !frame)) throw new Error('capacity');
    const groupFrames = groups.map((group) => issueGroupFrame({ db, prefix, leaseId, fence, ...group }));
    if (groupFrames.some((frame) => !frame)) throw new Error('capacity');
    const snapshot = issueSnapshot({ db, prefix, leaseId, fence });
    if (!snapshot) throw new Error('capacity');
    const ownPosition = db.prepare(`INSERT INTO ${prefix}_authoring_snapshot_position (snapshot_id, position_token) VALUES (?, ?)`);
    for (const frame of positionFrames) ownPosition.run(snapshot.id, frame.token);
    db.exec('RELEASE authoring_snapshot_issue');
    return { positionFrames, groupFrames, snapshot };
  } catch (error) {
    db.exec('ROLLBACK TO authoring_snapshot_issue');
    db.exec('RELEASE authoring_snapshot_issue');
    if (error.message === 'capacity') return null;
    throw error;
  }
}

export function acknowledgeAndPruneSnapshot({ db, prefix, snapshotId, leaseId }) {
  db.exec('SAVEPOINT authoring_snapshot_acknowledge');
  try {
  const existing = db.prepare(`SELECT id, lease_id, fence, acknowledged_at FROM ${prefix}_authoring_snapshot WHERE id = ? AND lease_id = ?`).get(snapshotId, leaseId);
  if (!existing) {
    db.exec('ROLLBACK TO authoring_snapshot_acknowledge');
    db.exec('RELEASE authoring_snapshot_acknowledge');
    return null;
  }
  if (existing.acknowledged_at) {
    db.exec('RELEASE authoring_snapshot_acknowledge');
    return { fence: existing.fence, alreadyAcknowledged: true };
  }
  db.prepare(`UPDATE ${prefix}_authoring_snapshot SET acknowledged_at = ? WHERE id = ?`).run(now(), snapshotId);
  db.prepare(`UPDATE ${prefix}_authoring_lease SET acknowledged_fence = MAX(acknowledged_fence, ?) WHERE id = ?`).run(existing.fence, leaseId);

  // A split becomes known only after this snapshot carries its authoritative
  // block. Its receipt frame can then be retired with other predecessor frames.
  db.prepare(`DELETE FROM ${prefix}_authoring_split
    WHERE lease_id = ? AND fence <= ?
      AND EXISTS (
        SELECT 1 FROM ${prefix}_authoring_snapshot_position AS owned
        JOIN ${prefix}_authoring_position AS position ON position.token = owned.position_token
        WHERE owned.snapshot_id = ? AND position.block_id = ${prefix}_authoring_split.authoritative_block_id
      )`).run(leaseId, existing.fence, snapshotId);

  // Never invalidate a token that an outstanding snapshot can still name, a
  // split with an unresolved outcome still needs, or the acknowledged snapshot
  // itself issued. All predicates are lease-scoped.
  db.prepare(`DELETE FROM ${prefix}_authoring_position AS position
    WHERE position.lease_id = ? AND position.issued_fence < ?
      AND NOT EXISTS (
        SELECT 1 FROM ${prefix}_authoring_snapshot_position
        WHERE snapshot_id = ? AND position_token = position.token
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${prefix}_authoring_snapshot AS snapshot
        JOIN ${prefix}_authoring_snapshot_position AS owned ON owned.snapshot_id = snapshot.id
        WHERE snapshot.lease_id = position.lease_id
          AND snapshot.acknowledged_at IS NULL
          AND owned.position_token = position.token
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${prefix}_authoring_split AS split
        WHERE split.lease_id = position.lease_id AND split.position_token = position.token
      )`).run(leaseId, existing.fence, snapshotId);

  // The newly acknowledged snapshot is the idempotency marker. Older completed
  // snapshots need no marker; outstanding snapshots are deliberately retained.
  db.prepare(`DELETE FROM ${prefix}_authoring_snapshot
     WHERE lease_id = ? AND id <> ? AND acknowledged_at IS NOT NULL`).run(leaseId, snapshotId);
  db.prepare(`DELETE FROM ${prefix}_authoring_checkpoint AS checkpoint WHERE checkpoint.lease_id = ? AND NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_position AS position WHERE position.checkpoint_id = checkpoint.id)`).run(leaseId);
  db.exec('RELEASE authoring_snapshot_acknowledge');
  return { fence: existing.fence, alreadyAcknowledged: false };
  } catch (error) {
    db.exec('ROLLBACK TO authoring_snapshot_acknowledge');
    db.exec('RELEASE authoring_snapshot_acknowledge');
    throw error;
  }
}

function rowBytes(values) {
  return values.reduce((total, value) => total + (value === null || value === undefined ? 0 : Buffer.byteLength(String(value))), 0);
}

function retainedBytes(db, prefix, leaseId = null, streamId = null) {
  const total = (table, alias, columns) => {
    const filter = leaseId !== null ? ` WHERE ${alias}.lease_id = ?` : ` JOIN ${prefix}_authoring_lease AS lease ON lease.id = ${alias}.lease_id WHERE lease.stream_id = ?`;
    const parameter = leaseId ?? streamId;
    return Number(db.prepare(`SELECT COALESCE(SUM(${columns.map((column) => `COALESCE(length(CAST(${alias}.${column} AS BLOB)), 0)`).join(' + ')}), 0) AS bytes FROM ${prefix}_${table} AS ${alias}${filter}`).get(parameter).bytes);
  };
  return total('authoring_position', 'position', ['token', 'lease_id', 'issued_fence', 'block_id', 'checkpoint_id', 'visible_at_issue', 'created_at'])
    + Number(db.prepare(`SELECT COALESCE(SUM(length(CAST(checkpoint.family_checkpoint AS BLOB))), 0) AS bytes FROM ${prefix}_authoring_checkpoint AS checkpoint JOIN ${prefix}_authoring_lease AS lease ON lease.id = checkpoint.lease_id ${leaseId !== null ? 'WHERE checkpoint.lease_id = ?' : 'WHERE lease.stream_id = ?'}`).get(leaseId ?? streamId).bytes)
    + total('authoring_group', 'group_frame', ['token', 'lease_id', 'issued_fence', 'group_id', 'visible_blocks', 'assignable', 'created_at'])
    + total('authoring_snapshot', 'snapshot', ['id', 'lease_id', 'fence', 'issued_at', 'acknowledged_at'])
    + total('authoring_split', 'split', ['lease_id', 'temporary_block', 'authoritative_block_id', 'position_token', 'action_id', 'mutation_id', 'fence', 'created_at'])
    + Number(db.prepare(`SELECT COALESCE(SUM(length(CAST(owned.snapshot_id AS BLOB)) + length(CAST(owned.position_token AS BLOB))), 0) AS bytes
      FROM ${prefix}_authoring_snapshot_position AS owned
      JOIN ${prefix}_authoring_snapshot AS snapshot ON snapshot.id = owned.snapshot_id
      ${leaseId !== null ? 'WHERE snapshot.lease_id = ?' : `JOIN ${prefix}_authoring_lease AS lease ON lease.id = snapshot.lease_id WHERE lease.stream_id = ?`}`).get(leaseId ?? streamId).bytes);
}

function hasCapacity({ db, prefix, leaseId, bytes = 0 }) {
  const leaseBytes = retainedBytes(db, prefix, leaseId);
  if (leaseBytes + bytes > MAX_RETAINED_PER_LEASE) return false;
  const streamId = db.prepare(`SELECT stream_id FROM ${prefix}_authoring_lease WHERE id = ?`).get(leaseId)?.stream_id;
  if (!streamId) return false;
  return retainedBytes(db, prefix, null, streamId) + bytes <= MAX_RETAINED_PER_STREAM;
}

export function recordSplit({ db, prefix, leaseId, temporaryBlock, authoritativeBlockId, positionToken, actionId, mutationId, fence }) {
  const existing = db.prepare(`SELECT * FROM ${prefix}_authoring_split WHERE lease_id = ? AND temporary_block = ?`).get(leaseId, temporaryBlock);
  if (existing) {
    if (existing.authoritative_block_id !== authoritativeBlockId ||
        existing.position_token !== positionToken ||
        existing.action_id !== actionId ||
        existing.mutation_id !== mutationId ||
        existing.fence !== fence) {
      fail('split temporary block conflict');
    }
    return { duplicate: true, existing };
  }
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM ${prefix}_authoring_split WHERE lease_id = ?`).get(leaseId).cnt;
  if (count >= MAX_UNRESOLVED_SPLITS) {
    return null;
  }
  const createdAt = now();
  if (!hasCapacity({ db, prefix, leaseId, bytes: rowBytes([leaseId, temporaryBlock, authoritativeBlockId, positionToken, actionId, mutationId, fence, createdAt]) })) return null;
  try {
    db.prepare(`INSERT INTO ${prefix}_authoring_split (lease_id, temporary_block, authoritative_block_id, position_token, action_id, mutation_id, fence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(leaseId, temporaryBlock, authoritativeBlockId, positionToken, actionId, mutationId, fence, createdAt);
  } catch (error) {
    const raced = db.prepare(`SELECT * FROM ${prefix}_authoring_split WHERE lease_id = ? AND temporary_block = ?`).get(leaseId, temporaryBlock);
    if (raced && raced.authoritative_block_id === authoritativeBlockId && raced.position_token === positionToken && raced.action_id === actionId && raced.mutation_id === mutationId && raced.fence === fence) {
      return { duplicate: true, existing: raced };
    }
    throw error;
  }
  return { duplicate: false };
}

export function resolveSplit({ db, prefix, leaseId, temporaryBlock }) {
  return db.prepare(`SELECT * FROM ${prefix}_authoring_split WHERE lease_id = ? AND temporary_block = ?`).get(leaseId, temporaryBlock) || null;
}

export function clearStream(db, prefix, streamId) {
  const leases = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ?`).all(streamId);
  for (const lease of leases) clearLeaseChildren(db, prefix, lease.id);
  db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE stream_id = ?`).run(streamId);
  db.prepare(`DELETE FROM ${prefix}_authoring_stream WHERE id = ?`).run(streamId);
}

export function clearExpiredLeases(db, prefix) {
  const expired = db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE expires_at < ?`).all(now());
  for (const lease of expired) {
    clearLeaseChildren(db, prefix, lease.id);
    db.prepare(`DELETE FROM ${prefix}_authoring_lease WHERE id = ?`).run(lease.id);
  }
  const orphaned = db.prepare(`SELECT s.id FROM ${prefix}_authoring_stream s WHERE NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_lease l WHERE l.stream_id = s.id AND l.expires_at > ?)` ).all(now());
  for (const stream of orphaned) db.prepare(`DELETE FROM ${prefix}_authoring_stream WHERE id = ?`).run(stream.id);
}

export function clearAuthoringState(db, prefix, documentId) {
  const streams = db.prepare(`SELECT id FROM ${prefix}_authoring_stream WHERE document_id = ?`).all(documentId);
  for (const stream of streams) clearStream(db, prefix, stream.id);
}

export function buildAuthoringEnvelope({ db, prefix, streamToken, leaseToken, leaseId, snapshotToken, fence, positionFrames, groupFrames = [], splitResolutions }) {
  return {
    version: 1,
    stream: streamToken,
    lease: leaseToken,
    snapshot: snapshotToken,
    acknowledgementFence: fence,
    positionFrames: positionFrames.map((f) => ({ blockId: f.blockId, positionToken: f.token })),
    groupFrames: groupFrames.map((f) => ({ groupToken: f.token })),
    splitResolutions: splitResolutions || [],
  };
}
