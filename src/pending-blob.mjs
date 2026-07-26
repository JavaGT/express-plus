import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { txn } from './driver.mjs';

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

function principalId(principal) {
  if (!principal?.id) failure('UNAUTHENTICATED');
  return principal.id;
}

export function declaredBlobField(field) {
  if (!field || typeof field.actionName !== 'string' || typeof field.field !== 'string' || typeof field.validator !== 'function') {
    throw new TypeError('declaredBlobField requires actionName, field, and validator');
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
    if (!request || typeof request.projectId !== 'string' || !request.projectId || typeof request.fileId !== 'string' || !request.fileId) throw new TypeError('projectId and fileId are required');
    const pendingKey = `${request.projectId}/${request.fileId}.pending`;
    const existing = app.db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(pendingKey);
    if (existing) failure('PENDING_KEY_EXISTS');
    const bytes = await bytesOf(request.bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const claimToken = token();
    const blob = app.blobs.upload({ bytes, mime: request.mediaType });
    try {
      app.db.prepare(`INSERT INTO _PendingBlob
        (pendingKey, blobId, claimTokenHash, principalId, contentDigest, byteLength, status, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(pendingKey, blob.id, hash(claimToken), principalId(principal), digest, bytes.length, new Date().toISOString());
    } catch (error) {
      try { app.blobs.reap({ ttl: 0, blobColumns: [] }); } catch {}
      throw error;
    }
    return Object.freeze({ claim: Object.freeze({ pendingKey, claimToken }), pendingKey, byteLength: bytes.length, contentDigest: digest });
  }
  async function validateClaim({ claim, field, actionName, actionId, authenticatedPrincipalId, scopeId, committedEventId }) {
    if (!claim || typeof claim.pendingKey !== 'string' || typeof claim.claimToken !== 'string') failure('INVALID_PENDING_BLOB_CLAIM');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE pendingKey = ?').get(claim.pendingKey);
    if (!row || !timingSafeEqual(Buffer.from(hash(claim.claimToken)), Buffer.from(row.claimTokenHash))) failure('INVALID_PENDING_BLOB_CLAIM');
    if (row.status === 'claimed' && row.actionId === actionId) return Object.freeze({ blobId: row.blobId });
    if (row.status !== 'pending') failure('PENDING_BLOB_ALREADY_CLAIMED');
    if (row.principalId !== authenticatedPrincipalId) failure('PENDING_BLOB_WRONG_PRINCIPAL');
    const declaration = byActionField.get(`${actionName}:${field}`);
    if (!declaration) failure('UNDECLARED_BLOB_FIELD');
    const decision = await declaration.validator(Object.freeze({ actionName, actionId, authenticatedPrincipalId, scopeId, committedEventId, pendingKey: row.pendingKey, contentDigest: row.contentDigest, byteLength: row.byteLength }));
    if (!decision || decision.allow !== true) failure(decision?.code ?? 'BLOB_CLAIM_DENIED');
    const claimed = app.db.prepare(`UPDATE _PendingBlob SET status = 'claimed', actionId = ?, committedEventId = ?, scopeId = ?
      WHERE pendingKey = ? AND status = 'pending'`).run(actionId, committedEventId, scopeId, row.pendingKey);
    if (!claimed.changes) failure('PENDING_BLOB_ALREADY_CLAIMED');
    // BlobStore adoption is metadata-only and shares the dispatch transaction
    // with the claim, event log, projection, and receipt.
    app.blobs.adopt(app.db, row.blobId);
    return Object.freeze({ blobId: row.blobId });
  }
  async function reconcile() {
    const claimed = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'claimed'").all();
    for (const row of claimed) {
      try {
        const bytes = app.blobs.readRange(row.blobId);
        if (bytes.length !== row.byteLength || createHash('sha256').update(bytes).digest('hex') !== row.contentDigest) {
          app.db.prepare("UPDATE _PendingBlob SET status = 'recovery-failed' WHERE pendingKey = ?").run(row.pendingKey);
          continue;
        }
        app.blobs.finalize(row.blobId);
        app.db.prepare("UPDATE _PendingBlob SET status = 'finalized' WHERE pendingKey = ? AND status = 'claimed'").run(row.pendingKey);
      } catch {
        // The claimed generation remains durable and readable from its verified
        // pending slot while a later boot reconciliation retries finalization.
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
  return Object.freeze({
    stage,
    validateClaim,
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
