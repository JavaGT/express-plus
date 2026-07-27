import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { txn } from './driver.mjs';
import { principalKeyOf } from './principal.mjs';

function failure(code) { const error = new Error(code); error.code = code; throw error; }
function token() { return randomBytes(32).toString('base64url'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

async function bytesOf(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (!bytes || typeof bytes[Symbol.asyncIterator] !== 'function') throw new TypeError('bytes must be Uint8Array or AsyncIterable<Uint8Array>');
  const chunks = [];
  let size = 0;
  for await (const chunk of bytes) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('streamed blob chunk must be Uint8Array');
    chunks.push(chunk); size += chunk.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function principalKey(principal) {
  const key = principalKeyOf(principal);
  if (!key) failure('UNAUTHENTICATED');
  return key;
}

export function declaredBlobField(field) {
  const keys = field && typeof field === 'object' ? Object.keys(field) : [];
  if (!field || typeof field.actionName !== 'string' || typeof field.field !== 'string'
    || keys.some((key) => !['actionName', 'field', 'deletionActionName'].includes(key))
    || (field.deletionActionName !== undefined && typeof field.deletionActionName !== 'string')) {
    throw new TypeError('declaredBlobField requires actionName and field');
  }
  return Object.freeze({ ...field });
}

export function createPendingBlobLifecycle(app, options) {
  const fields = (options?.fields ?? []).map(declaredBlobField);
  if (!Number.isFinite(options?.pendingTtlMs) || options.pendingTtlMs < 0 || !Number.isFinite(options?.adoptedRecoveryTtlMs) || options.adoptedRecoveryTtlMs < 0) {
    throw new TypeError('blobLifecycle requires non-negative pendingTtlMs and adoptedRecoveryTtlMs');
  }
  const byActionField = new Map(fields.map((field) => [`${field.actionName}:${field.field}`, field]));
  if (byActionField.size !== fields.length) throw new TypeError('blobLifecycle fields must not contain duplicate actionName/field pairs');
  async function stage(principal, request) {
    return app.writeQueue.run(() => stageInQueue(principal, request));
  }
  async function stageInQueue(principal, request) {
    if (!request || typeof request.scopeId !== 'string' || !request.scopeId || typeof request.resourceId !== 'string' || !request.resourceId) throw new TypeError('scopeId and resourceId are required');
    const authenticatedPrincipalKey = principalKey(principal);
    if (request.scopeId.includes('/') || request.scopeId === '.' || request.scopeId === '..' || request.resourceId.includes('/') || request.resourceId === '.' || request.resourceId === '..') throw new TypeError('scopeId and resourceId must be single safe path segments');
    const pendingKey = `${request.scopeId}/${request.resourceId}.${hash(authenticatedPrincipalKey)}.pending`;
    const existing = app.db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(pendingKey);
    if (existing) failure('PENDING_KEY_EXISTS');
    const bytes = await bytesOf(request.bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const claimToken = token();
    const blob = app.blobs.upload({ bytes, mime: request.mediaType });
    try {
      app.db.prepare(`INSERT INTO _PendingBlob
        (pendingKey, blobId, claimTokenHash, principalKey, contentDigest, byteLength, status, scopeId, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(pendingKey, blob.id, hash(claimToken), authenticatedPrincipalKey, digest, bytes.length, request.scopeId, new Date().toISOString());
    } catch (error) {
      try { app.blobs.discardPending(blob.id); } catch {}
      throw error;
    }
    return Object.freeze({ claim: Object.freeze({ pendingKey, claimToken }), pendingKey, byteLength: bytes.length, contentDigest: digest });
  }
  async function validateClaim({ claim, field, actionName, actionId, authenticatedPrincipal, scopeId, committedEventId }) {
    if (!claim || typeof claim.pendingKey !== 'string' || typeof claim.claimToken !== 'string') failure('INVALID_PENDING_BLOB_CLAIM');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE pendingKey = ?').get(claim.pendingKey);
    if (!row || !timingSafeEqual(Buffer.from(hash(claim.claimToken)), Buffer.from(row.claimTokenHash))) failure('INVALID_PENDING_BLOB_CLAIM');
    const declaration = byActionField.get(`${actionName}:${field}`);
    if (!declaration) failure('UNDECLARED_BLOB_FIELD');
    if (row.principalKey !== principalKey(authenticatedPrincipal)) failure('PENDING_BLOB_WRONG_PRINCIPAL');
    if (row.scopeId !== scopeId) failure('PENDING_BLOB_WRONG_SCOPE');
    if (row.status === 'claimed' && row.actionId === actionId) return Object.freeze({ blobId: row.blobId });
    if (row.status !== 'pending') failure('PENDING_BLOB_ALREADY_CLAIMED');
    if (Date.now() - Date.parse(row.createdAt) >= options.pendingTtlMs) failure('PENDING_BLOB_EXPIRED');
    const claimed = app.db.prepare(`UPDATE _PendingBlob SET status = 'claimed', actionId = ?, committedEventId = ?, scopeId = ?, claimedAt = ?
      WHERE pendingKey = ? AND status = 'pending'`).run(actionId, committedEventId, scopeId, new Date().toISOString(), row.pendingKey);
    if (!claimed.changes) failure('PENDING_BLOB_ALREADY_CLAIMED');
    // BlobStore adoption is metadata-only and shares the dispatch transaction
    // with the claim, event log, projection, and receipt.
    if (app.blobs.adopt(app.db, row.blobId).adopted !== 1) failure('BLOB_UNAVAILABLE');
    return Object.freeze({ blobId: row.blobId });
  }
  async function requestDeletion({ blobId, actionName, actionId, scopeId }) {
    const declaration = fields.find((field) => field.deletionActionName === actionName);
    if (!declaration) return false;
    if (typeof blobId !== 'string') failure('INVALID_CLAIMED_BLOB_REF');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId);
    if (!row || row.status === 'deleted') failure('BLOB_NOT_FOUND');
    if (row.scopeId !== scopeId) failure('BLOB_DELETE_WRONG_SCOPE');
    if (row.status === 'delete-requested') return true;
    const changed = app.db.prepare(`UPDATE _PendingBlob SET status = 'delete-requested', deleteActionId = ?
      WHERE blobId = ? AND status IN ('claimed', 'finalized', 'recovery-failed')`).run(actionId, blobId);
    if (!changed.changes) failure('BLOB_DELETE_CONFLICT');
    return true;
  }
  function markRecoveryFailure(row, error) {
    const claimedAt = Date.parse(row.claimedAt ?? row.createdAt);
    const expired = Number.isFinite(claimedAt) && Date.now() - claimedAt >= options.adoptedRecoveryTtlMs;
    app.db.prepare(`UPDATE _PendingBlob SET recoveryFailure = ?, status = CASE WHEN ? THEN 'recovery-failed' ELSE status END
      WHERE pendingKey = ?`).run(String(error?.message ?? error), expired ? 1 : 0, row.pendingKey);
  }
  async function reconcile() {
    const deleting = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'delete-requested'").all();
    for (const row of deleting) {
      try {
        app.blobs.discard(row.blobId);
        app.db.prepare("DELETE FROM _PendingBlob WHERE pendingKey = ? AND status = 'delete-requested'").run(row.pendingKey);
      } catch (error) {
        markRecoveryFailure(row, error);
      }
    }
    const claimed = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'claimed'").all();
    for (const row of claimed) {
      try {
        const bytes = app.blobs.readRange(row.blobId);
        if (bytes.length !== row.byteLength || createHash('sha256').update(bytes).digest('hex') !== row.contentDigest) {
          markRecoveryFailure(row, 'BLOB_UNAVAILABLE');
          continue;
        }
        app.blobs.finalize(row.blobId);
        app.db.prepare("UPDATE _PendingBlob SET status = 'finalized', finalizedAt = ?, recoveryFailure = NULL WHERE pendingKey = ? AND status = 'claimed'")
          .run(new Date().toISOString(), row.pendingKey);
      } catch (error) {
        // The claimed generation remains durable and readable from its verified
        // pending slot while a later boot reconciliation retries finalization.
        markRecoveryFailure(row, error);
      }
    }
  }
  async function reap() {
    const stale = new Date(Date.now() - options.pendingTtlMs).toISOString();
    await txn(app.db, () => {
      const rows = app.db.prepare("SELECT pendingKey, blobId FROM _PendingBlob WHERE status = 'pending' AND createdAt < ?").all(stale);
      for (const row of rows) {
        app.blobs.discardPending(row.blobId);
        app.db.prepare("DELETE FROM _PendingBlob WHERE pendingKey = ? AND status = 'pending'").run(row.pendingKey);
      }
    });
  }
  function readClaimed(blobId) {
    const row = app.db.prepare("SELECT * FROM _PendingBlob WHERE blobId = ? AND status IN ('claimed', 'finalized')").get(blobId);
    if (!row) failure('BLOB_UNAVAILABLE');
    try {
      const bytes = app.blobs.readRange(blobId);
      if (bytes.length !== row.byteLength || createHash('sha256').update(bytes).digest('hex') !== row.contentDigest) throw new Error('BLOB_UNAVAILABLE');
      return bytes;
    } catch (error) {
      markRecoveryFailure(row, error);
      failure('BLOB_UNAVAILABLE');
    }
  }
  return Object.freeze({
    stage,
    validateClaim,
    requestDeletion,
    readClaimed,
    reconcile,
    reap,
    // Finalization is package-owned post-commit work. Reconciliation scans the
    // durable claim table, so a crash before this callback is equivalent to a
    // missed wake and is recovered on the next boot.
    consumer: async () => reconcile(),
    fields,
    options: Object.freeze({ ...options }),
  });
}

export function pendingBlobStager(workbench, authenticatedPrincipal) {
  if (!workbench.pendingBlobLifecycle) throw new Error('blobLifecycle is not configured');
  return Object.freeze({ stage: (request) => workbench.pendingBlobLifecycle.stage(authenticatedPrincipal, request) });
}

export function readClaimedBlob(workbench, blobId) {
  if (!workbench.pendingBlobLifecycle) throw new Error('blobLifecycle is not configured');
  return workbench.pendingBlobLifecycle.readClaimed(blobId);
}
