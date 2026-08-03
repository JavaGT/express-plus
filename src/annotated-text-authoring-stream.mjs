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
    if (expiresAt > Date.now()) {
      db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ? WHERE id = ?`).run(now(), existing.id);
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
}

export function resolveStream({ db, prefix, streamToken, documentId, principalType, principalId }) {
  const stream = db.prepare(`SELECT * FROM ${prefix}_authoring_stream WHERE id = ? AND document_id = ? AND principal_type = ? AND principal_id = ?`).get(streamToken, documentId, principalType, principalId);
  if (!stream) return null;
  const expiresAt = new Date(stream.expires_at).getTime();
  if (expiresAt <= Date.now()) {
    clearStream(db, prefix, stream.id);
    return null;
  }
  db.prepare(`UPDATE ${prefix}_authoring_stream SET last_used_at = ? WHERE id = ?`).run(now(), stream.id);
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
  return lease;
}

export function resolvePosition({ db, prefix, positionToken, leaseId }) {
  const position = db.prepare(`SELECT * FROM ${prefix}_authoring_position WHERE token = ? AND lease_id = ?`).get(positionToken, leaseId);
  if (!position) return null;
  return position;
}

export function resolveGroup({ db, prefix, groupToken, leaseId }) {
  return db.prepare(`SELECT * FROM ${prefix}_authoring_group WHERE token = ? AND lease_id = ?`).get(groupToken, leaseId) || null;
}

export function issueGroupFrame({ db, prefix, leaseId, groupId, visibleBlocks, assignable, fence }) {
  if (!hasCapacity({ db, prefix, leaseId })) return null;
  const token = randomToken();
  db.prepare(`INSERT INTO ${prefix}_authoring_group (token, lease_id, issued_fence, group_id, visible_blocks, assignable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, leaseId, fence, groupId, JSON.stringify(visibleBlocks), assignable ? 1 : 0, now());
  return { token };
}

export function issuePositionFrame({ db, prefix, leaseId, blockId, fence, familyCheckpoint, visibleAtIssue }) {
  if (!hasCapacity({ db, prefix, leaseId })) return null;
  const token = randomToken();
  db.prepare(`INSERT INTO ${prefix}_authoring_position (token, lease_id, issued_fence, block_id, family_checkpoint, visible_at_issue, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(token, leaseId, fence, blockId, JSON.stringify(familyCheckpoint), visibleAtIssue ? 1 : 0, now());
  return { token, blockId };
}

export function issueSnapshot({ db, prefix, leaseId, fence }) {
  if (!hasCapacity({ db, prefix, leaseId })) return null;
  const id = randomToken();
  db.prepare(`INSERT INTO ${prefix}_authoring_snapshot (id, lease_id, fence, issued_at) VALUES (?, ?, ?, ?)`).run(id, leaseId, fence, now());
  return { id, fence };
}

export function acknowledgeSnapshot({ db, prefix, snapshotId, leaseId }) {
  const existing = db.prepare(`SELECT id, lease_id, fence, acknowledged_at FROM ${prefix}_authoring_snapshot WHERE id = ? AND lease_id = ?`).get(snapshotId, leaseId);
  if (!existing) return null;
  if (existing.acknowledged_at) return { fence: existing.fence, alreadyAcknowledged: true };
  db.prepare(`UPDATE ${prefix}_authoring_snapshot SET acknowledged_at = ? WHERE id = ?`).run(now(), snapshotId);
  db.prepare(`UPDATE ${prefix}_authoring_lease SET acknowledged_fence = MAX(acknowledged_fence, ?) WHERE id = ?`).run(existing.fence, leaseId);
  // Explicit acknowledgement is the only pruning trigger. Retain the snapshot
  // itself as the lease-scoped idempotency marker.
  return { fence: existing.fence, alreadyAcknowledged: false };
}

function retainedBytes(db, prefix, leaseId) {
  return db.prepare(`SELECT COALESCE(SUM(length(token) + length(family_checkpoint) + length(block_id) + 64), 0) AS bytes FROM ${prefix}_authoring_position WHERE lease_id = ?`)
    .get(leaseId).bytes
    + db.prepare(`SELECT COALESCE(SUM(length(id) + 64), 0) AS bytes FROM ${prefix}_authoring_snapshot WHERE lease_id = ?`)
      .get(leaseId).bytes;
}

function hasCapacity({ db, prefix, leaseId }) {
  const leaseBytes = retainedBytes(db, prefix, leaseId);
  if (leaseBytes >= MAX_RETAINED_PER_LEASE) return false;
  const streamId = db.prepare(`SELECT stream_id FROM ${prefix}_authoring_lease WHERE id = ?`).get(leaseId)?.stream_id;
  if (!streamId) return false;
  const streamBytes = db.prepare(`SELECT COALESCE(SUM(length(position.token) + length(position.family_checkpoint) + length(position.block_id) + 64), 0) AS bytes FROM ${prefix}_authoring_position AS position JOIN ${prefix}_authoring_lease AS lease ON lease.id = position.lease_id WHERE lease.stream_id = ?`).get(streamId).bytes
    + db.prepare(`SELECT COALESCE(SUM(length(snapshot.id) + 64), 0) AS bytes FROM ${prefix}_authoring_snapshot AS snapshot JOIN ${prefix}_authoring_lease AS lease ON lease.id = snapshot.lease_id WHERE lease.stream_id = ?`).get(streamId).bytes;
  return streamBytes < MAX_RETAINED_PER_STREAM;
}

export function prunePositions({ db, prefix, leaseId, fence, snapshotId, visibleBlockIds, retainedSnapshotIds }) {
  const positions = db.prepare(`SELECT * FROM ${prefix}_authoring_position WHERE lease_id = ? AND issued_fence < ? AND token NOT IN (SELECT position_token FROM ${prefix}_authoring_split WHERE lease_id = ?)`).all(leaseId, fence, leaseId);
  for (const pos of positions) {
    if (pos.block_id && visibleBlockIds && !visibleBlockIds.has(pos.block_id)) {
      db.prepare(`DELETE FROM ${prefix}_authoring_position WHERE token = ?`).run(pos.token);
    } else if (pos.issued_fence < fence && pos.visible_at_issue) {
      db.prepare(`DELETE FROM ${prefix}_authoring_position WHERE token = ?`).run(pos.token);
    }
  }
  const splits = db.prepare(`SELECT * FROM ${prefix}_authoring_split WHERE lease_id = ? AND fence < ?`).all(leaseId, fence);
  for (const split of splits) {
    if (visibleBlockIds && visibleBlockIds.has(split.authoritative_block_id)) {
      db.prepare(`DELETE FROM ${prefix}_authoring_split WHERE lease_id = ? AND temporary_block = ?`).run(leaseId, split.temporary_block);
    }
  }
  const currentSnapshots = new Set(db.prepare(`SELECT id FROM ${prefix}_authoring_snapshot WHERE lease_id = ?`).all(leaseId).map((r) => r.id));
  for (const id of currentSnapshots) {
    if (id !== snapshotId && !retainedSnapshotIds?.has(id)) {
      db.prepare(`DELETE FROM ${prefix}_authoring_snapshot WHERE id = ?`).run(id);
    }
  }
}

export function recordSplit({ db, prefix, leaseId, temporaryBlock, authoritativeBlockId, positionToken, actionId, mutationId, fence }) {
  const existing = db.prepare(`SELECT * FROM ${prefix}_authoring_split WHERE lease_id = ? AND temporary_block = ?`).get(leaseId, temporaryBlock);
  if (existing) {
    if (existing.authoritative_block_id !== authoritativeBlockId) {
      fail('split temporary block conflict');
    }
    return { duplicate: true, existing };
  }
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM ${prefix}_authoring_split WHERE lease_id = ?`).get(leaseId).cnt;
  if (count >= MAX_UNRESOLVED_SPLITS) {
    return null;
  }
  db.prepare(`INSERT OR IGNORE INTO ${prefix}_authoring_split (lease_id, temporary_block, authoritative_block_id, position_token, action_id, mutation_id, fence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(leaseId, temporaryBlock, authoritativeBlockId, positionToken, actionId, mutationId, fence, now());
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
  const orphaned = db.prepare(`SELECT s.id FROM ${prefix}_authoring_stream s WHERE NOT EXISTS (SELECT 1 FROM ${prefix}_authoring_lease l WHERE l.stream_id = s.id) AND s.expires_at < ?`).all(now());
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
