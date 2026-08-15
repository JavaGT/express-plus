import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { txn, type DbHandle } from './driver.ts';
import { principalKeyOf, type Principal } from './principal.ts';
import type { BlobErasureCategory, BlobLifecycleKind, BlobOwnership } from './blob-census.ts';
import type { BlobStore } from './blob-store.ts';
import { BlobSlotNotFoundError } from './fs-blobs.ts';

function failure(code: string): never { const error = new Error(code) as Error & { code?: string }; error.code = code; throw error; }
function token(): string { return randomBytes(32).toString('base64url'); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function bytesOf(bytes: unknown): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes;
  if (!bytes || typeof (bytes as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') throw new TypeError('bytes must be Uint8Array or AsyncIterable<Uint8Array>');
  const iterable = bytes as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of iterable) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('streamed blob chunk must be Uint8Array');
    chunks.push(chunk); size += chunk.length;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function principalKey(principal: Principal): string {
  const key = principalKeyOf(principal);
  if (!key) failure('UNAUTHENTICATED');
  return key;
}

export interface DeclaredBlobField {
  actionName: string;
  field: string;
  resourceField: string;
  purgeActionName?: string;
  /** The resource generation that owns these bytes (S6 #4); required. */
  owningResource: string;
  /** What erasure does with the bytes when the owning generation is removed; required. */
  erasureCategory: BlobErasureCategory;
  /** Explicit ownership model; defaults to exclusive. Hash equality never implies sharing (#7). */
  ownership?: BlobOwnership;
  /** Lifecycle stage the reference must reach before the bytes are reapable; defaults to finalize. */
  lifecycle?: BlobLifecycleKind;
  canonicalEventMetadata?: Readonly<{ byteLength?: readonly string[]; mediaType?: readonly string[] }>;
}

export function declaredBlobField(field: unknown): DeclaredBlobField {
  const candidate = field as { actionName?: unknown; field?: unknown; resourceField?: unknown; purgeActionName?: unknown; owningResource?: unknown; erasureCategory?: unknown; ownership?: unknown; lifecycle?: unknown; canonicalEventMetadata?: unknown } | null | undefined;
  const keys = candidate && typeof candidate === 'object' ? Object.keys(candidate) : [];
  const canonicalEventMetadata = candidate?.canonicalEventMetadata;
  const metadataKeys = canonicalEventMetadata && typeof canonicalEventMetadata === 'object' ? Object.keys(canonicalEventMetadata) : [];
  const validPath = (path: unknown): path is string[] => Array.isArray(path) && path.length > 0
    && path.every((part) => typeof part === 'string' && part.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(part));
  const isErasureCategory = (value: unknown): value is BlobErasureCategory =>
    value === 'deletable' || value === 'retained' || value === 'derived';
  const isOwnership = (value: unknown): value is BlobOwnership =>
    value === 'exclusive' || value === 'shared';
  const isLifecycleKind = (value: unknown): value is BlobLifecycleKind =>
    value === 'pending' || value === 'adopt' || value === 'finalize';
  if (!candidate || typeof candidate.actionName !== 'string' || typeof candidate.field !== 'string'
    || typeof candidate.resourceField !== 'string'
    || typeof candidate.owningResource !== 'string' || !candidate.owningResource
    || !isErasureCategory(candidate.erasureCategory)
    || keys.some((key) => !['actionName', 'field', 'resourceField', 'purgeActionName', 'owningResource', 'erasureCategory', 'ownership', 'lifecycle', 'canonicalEventMetadata'].includes(key))
    || (candidate.purgeActionName !== undefined && typeof candidate.purgeActionName !== 'string')
    || (candidate.ownership !== undefined && !isOwnership(candidate.ownership))
    || (candidate.lifecycle !== undefined && !isLifecycleKind(candidate.lifecycle))
    || (canonicalEventMetadata !== undefined && (!canonicalEventMetadata || typeof canonicalEventMetadata !== 'object'
      || metadataKeys.length === 0 || metadataKeys.some((key) => !['byteLength', 'mediaType'].includes(key))
      || metadataKeys.some((key) => !validPath((canonicalEventMetadata as Record<string, unknown>)[key]))))) {
    throw new TypeError('declaredBlobField requires actionName, field, resourceField, owningResource, and erasureCategory');
  }
  const fieldValue = candidate as DeclaredBlobField;
  return Object.freeze({ ...fieldValue, ...(canonicalEventMetadata === undefined ? {} : {
    canonicalEventMetadata: Object.freeze(Object.fromEntries(metadataKeys.map((key) => [key, Object.freeze([...(canonicalEventMetadata as Record<string, readonly string[]>)[key]])]))),
  }) });
}

export interface PendingBlobLifecycleOptions {
  fields: readonly DeclaredBlobField[];
  pendingTtlMs: number;
  adoptedRecoveryTtlMs: number;
}

/**
 * The S1/A6 recycle seam the delete path routes through (S6/A5): when the app
 * owns a recycle manager (`createRecycleManager` over the backup root with the
 * S6/A6 blob seam), a deleted generation is binned BEFORE its live bytes are
 * removed — every retained backup holding the generation moves its copy into
 * the recoverable recycle bin (idempotent per generation). See
 * BlobRecycleSeam in blob-store.ts — the recycle manager satisfies this shape.
 */
export interface PendingBlobRecycleSeam {
  bin(deletion: { generations: readonly string[] }): Promise<unknown>;
}

interface PendingBlobApp {
  writeQueue: { run<T>(fn: () => Promise<T> | T): Promise<T> };
  db: DbHandle;
  blobs: BlobStore;
  /** S1/A6 recycle seam (S6/A5). Optional; set by the app owner once the recycle manager exists. */
  blobRecycleSeam?: PendingBlobRecycleSeam | null;
  /**
   * The platform staleness/deletion contract (S4): a deleted generation is
   * signaled as a removed BlobStore row so derived stores (search/embeddings/
   * thumbnails) can drop generation-level material. S6 emits the signal; S4
   * consumes it; S8 wires lineage purge (#26).
   */
  searchStaleness?: { notifySourceChange(input: { entity: string; rowId: string; kind: string; committedAt: string; priority?: string; erasure?: boolean }): unknown } | null;
}

export interface StagePendingBlobRequest {
  scopeId: string;
  resourceId: string;
  bytes: Uint8Array | AsyncIterable<Uint8Array>;
  mediaType?: string;
}

export interface StagedPendingBlob {
  claim: { pendingKey: string; claimToken: string };
  pendingKey: string;
  byteLength: number;
  contentDigest: string;
}

export interface ClaimedBlob {
  blobId: string;
  resourceId: string;
  sha256: string;
  md5: string;
  byteLength: number;
  mediaType: string | null;
}

export interface ValidateClaimArgs {
  claim: unknown;
  field: string;
  resourceId: string;
  actionName: string;
  actionId: string;
  authenticatedPrincipal: Principal;
  scopeId: string;
  committedEventId: string;
}

export interface RequestDeletionArgs {
  blobId: unknown;
  resourceId: string;
  actionName: string;
  actionId: string;
  scopeId: string;
}

interface PendingBlobRow {
  pendingKey: string;
  blobId: string;
  claimTokenHash: string;
  principalKey: string;
  resourceId: string;
  contentDigest: string;
  byteLength: number;
  status: string;
  actionId: string | null;
  committedEventId: string | null;
  scopeId: string | null;
  createdAt: string;
  claimedAt: string | null;
  finalizedAt: string | null;
  deletedAt: string | null;
  deleteActionId: string | null;
  recoveryFailure: string | null;
}

export interface PendingBlobLifecycle {
  stage(principal: Principal, request: StagePendingBlobRequest): Promise<StagedPendingBlob>;
  validateClaim(args: ValidateClaimArgs): Promise<ClaimedBlob>;
  requestDeletion(args: RequestDeletionArgs): Promise<boolean>;
  readClaimed(blobId: string, range?: [start?: number, end?: number]): Buffer;
  status(blobId: string): string | null;
  reconcile(): Promise<void>;
  reap(): Promise<void>;
  consumer: () => Promise<void>;
  fields: readonly DeclaredBlobField[];
  options: Readonly<PendingBlobLifecycleOptions>;
}

export function createPendingBlobLifecycle(app: PendingBlobApp, options: PendingBlobLifecycleOptions): PendingBlobLifecycle {
  const fields = (options?.fields ?? []).map(declaredBlobField);
  if (!Number.isFinite(options?.pendingTtlMs) || options.pendingTtlMs < 0 || !Number.isFinite(options?.adoptedRecoveryTtlMs) || options.adoptedRecoveryTtlMs < 0) {
    throw new TypeError('blobLifecycle requires non-negative pendingTtlMs and adoptedRecoveryTtlMs');
  }
  const byActionField = new Map(fields.map((field): [string, DeclaredBlobField] => [`${field.actionName}:${field.field}`, field]));
  if (byActionField.size !== fields.length) throw new TypeError('blobLifecycle fields must not contain duplicate actionName/field pairs');
  async function stage(principal: Principal, request: StagePendingBlobRequest): Promise<StagedPendingBlob> {
    return app.writeQueue.run(() => stageInQueue(principal, request));
  }
  async function stageInQueue(principal: Principal, request: unknown): Promise<StagedPendingBlob> {
    const candidate = request as StagePendingBlobRequest | undefined;
    if (!candidate || typeof candidate.scopeId !== 'string' || !candidate.scopeId || typeof candidate.resourceId !== 'string' || !candidate.resourceId) throw new TypeError('scopeId and resourceId are required');
    const authenticatedPrincipalKey = principalKey(principal);
    if (candidate.scopeId.includes('/') || candidate.scopeId === '.' || candidate.scopeId === '..' || candidate.resourceId.includes('/') || candidate.resourceId === '.' || candidate.resourceId === '..') throw new TypeError('scopeId and resourceId must be single safe path segments');
    const pendingKey = `${candidate.scopeId}/${candidate.resourceId}.${hash(authenticatedPrincipalKey)}.pending`;
    const existing = app.db.prepare('SELECT 1 FROM _PendingBlob WHERE pendingKey = ?').get(pendingKey);
    if (existing) failure('PENDING_KEY_EXISTS');
    const bytes = await bytesOf(candidate.bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const claimToken = token();
    const blob = app.blobs.upload({ bytes, mime: candidate.mediaType });
    try {
      app.db.prepare(`INSERT INTO _PendingBlob
        (pendingKey, blobId, claimTokenHash, principalKey, resourceId, contentDigest, byteLength, status, scopeId, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(pendingKey, blob.id, hash(claimToken), authenticatedPrincipalKey, candidate.resourceId, digest, bytes.length, candidate.scopeId, new Date().toISOString());
    } catch (error) {
      try { app.blobs.discardPending(blob.id); } catch {}
      throw error;
    }
    return Object.freeze({ claim: Object.freeze({ pendingKey, claimToken }), pendingKey, byteLength: bytes.length, contentDigest: digest });
  }
  async function validateClaim({ claim, field, resourceId, actionName, actionId, authenticatedPrincipal, scopeId, committedEventId }: ValidateClaimArgs): Promise<ClaimedBlob> {
    const candidate = claim as { pendingKey?: unknown; claimToken?: unknown } | undefined;
    if (!candidate || typeof candidate.pendingKey !== 'string' || typeof candidate.claimToken !== 'string') failure('INVALID_PENDING_BLOB_CLAIM');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE pendingKey = ?').get(candidate.pendingKey) as PendingBlobRow | undefined;
    if (!row || !timingSafeEqual(Buffer.from(hash(candidate.claimToken)), Buffer.from(row.claimTokenHash))) failure('INVALID_PENDING_BLOB_CLAIM');
    const declaration = byActionField.get(`${actionName}:${field}`);
    if (!declaration) failure('UNDECLARED_BLOB_FIELD');
    if (row.principalKey !== principalKey(authenticatedPrincipal)) failure('PENDING_BLOB_WRONG_PRINCIPAL');
    if (row.scopeId !== scopeId) failure('PENDING_BLOB_WRONG_SCOPE');
    if (row.resourceId !== resourceId) failure('PENDING_BLOB_WRONG_RESOURCE');
    const metadata = app.blobs.stat(row.blobId);
    if (!metadata || metadata.sha256 !== row.contentDigest || metadata.size !== row.byteLength) failure('BLOB_UNAVAILABLE');
    const claimedBlob: ClaimedBlob = Object.freeze({ blobId: row.blobId, resourceId: row.resourceId, sha256: metadata.sha256, md5: metadata.md5, byteLength: metadata.size, mediaType: metadata.mime });
    if (row.status === 'claimed' && row.actionId === actionId) return claimedBlob;
    if (row.status !== 'pending') failure('PENDING_BLOB_ALREADY_CLAIMED');
    if (Date.now() - Date.parse(row.createdAt) >= options.pendingTtlMs) failure('PENDING_BLOB_EXPIRED');
    const claimed = app.db.prepare(`UPDATE _PendingBlob SET status = 'claimed', actionId = ?, committedEventId = ?, scopeId = ?, claimedAt = ?
      WHERE pendingKey = ? AND status = 'pending'`).run(actionId, committedEventId, scopeId, new Date().toISOString(), row.pendingKey);
    if (!claimed.changes) failure('PENDING_BLOB_ALREADY_CLAIMED');
    // BlobStore adoption is metadata-only and shares the dispatch transaction
    // with the claim, event log, projection, and receipt.
    if (app.blobs.adopt(app.db, row.blobId).adopted !== 1) failure('BLOB_UNAVAILABLE');
    return claimedBlob;
  }
  async function requestDeletion({ blobId, resourceId, actionName, actionId, scopeId }: RequestDeletionArgs): Promise<boolean> {
    const declaration = fields.find((field) => field.purgeActionName === actionName);
    if (!declaration) return false;
    if (typeof blobId !== 'string') failure('INVALID_CLAIMED_BLOB_REF');
    const row = app.db.prepare('SELECT * FROM _PendingBlob WHERE blobId = ?').get(blobId) as PendingBlobRow | undefined;
    if (!row || row.status === 'deleted') failure('BLOB_NOT_FOUND');
    if (row.scopeId !== scopeId) failure('BLOB_DELETE_WRONG_SCOPE');
    if (row.resourceId !== resourceId) failure('BLOB_DELETE_WRONG_RESOURCE');
    if (row.status === 'delete-requested') return true;
    const changed = app.db.prepare(`UPDATE _PendingBlob SET status = 'delete-requested', deleteActionId = ?, deletedAt = ?
      WHERE blobId = ? AND status IN ('claimed', 'finalized', 'recovery-failed')`).run(actionId, new Date().toISOString(), blobId);
    if (!changed.changes) failure('BLOB_DELETE_CONFLICT');
    return true;
  }
  function markRecoveryFailure(row: PendingBlobRow, error: unknown): void {
    const claimedAt = Date.parse(row.claimedAt ?? row.createdAt);
    const expired = Number.isFinite(claimedAt) && Date.now() - claimedAt >= options.adoptedRecoveryTtlMs;
    app.db.prepare(`UPDATE _PendingBlob SET recoveryFailure = ?, status = CASE WHEN ? THEN 'recovery-failed' ELSE status END
      WHERE pendingKey = ?`).run(String((error as { message?: unknown })?.message ?? error), expired ? 1 : 0, row.pendingKey);
  }
  // The claim-gated byte read (S6/A4 #1): a CLAIMED generation's bytes live in
  // the pending slot until reconcile finalizes them, then in the final slot.
  // The byte store serves no generic pending→final fallback for unclaimed
  // reads, so this resolves the slot explicitly — pending first (the common
  // claimed-but-not-yet-finalized case), final when the pending slot is already
  // gone (finalized, or finalized-but-status-update-lost). The caller has
  // already admitted the claim; this is never a public escape hatch. The
  // pending→final fallback keys on the byte store's TYPED missing-slot signal
  // (BlobSlotNotFoundError), never on a message string — a conforming backend
  // may phrase a missing slot however it likes.
  function readGeneration(blobId: string, range?: [start?: number, end?: number]): Buffer {
    try {
      return app.blobs.readPending(blobId, range);
    } catch (error) {
      if (!(error instanceof BlobSlotNotFoundError)) throw error;
      return app.blobs.readRange(blobId, range);
    }
  }
  // Record a delete-path retry WITHOUT the status flip markRecoveryFailure
  // performs: a 'delete-requested' row must stay 'delete-requested' so the
  // next reconcile sweep retries it. Flipping it to 'recovery-failed' (after
  // adoptedRecoveryTtlMs) would strand the deletion forever — that flip is for
  // claimed/finalize recovery only.
  function recordDeleteRetry(row: PendingBlobRow, error: unknown): void {
    app.db.prepare('UPDATE _PendingBlob SET recoveryFailure = ? WHERE pendingKey = ?')
      .run(String((error as { message?: unknown })?.message ?? error), row.pendingKey);
  }

  // The delete path (S6/A5 #4): discard the live bytes, route the generation
  // through the S1/A6 recycling bin (when a seam is owned), and emit the
  // derived-store deletion signal (when the staleness bridge is engaged) — ALL
  // three must succeed before the durable row is dropped. A failure at any
  // step records durable retry state and keeps the row, so the next sweep
  // re-runs it (discard + bin + signal are all idempotent). The deletion is
  // never reported complete until the row is gone.
  async function reconcileDeletion(row: PendingBlobRow): Promise<void> {
    app.blobs.discard(row.blobId);
    if (app.blobRecycleSeam) {
      await app.blobRecycleSeam.bin({ generations: [row.blobId] });
    }
    if (app.searchStaleness) {
      // Post-commit proof: the delete action's committedAt from the receipt,
      // falling back to the durable deletedAt (the instant the delete was
      // requested inside the committed action turn) — never a timestamp that
      // could precede commit.
      const receipt = app.db.prepare('SELECT committedAt FROM _ActionReceipt WHERE scope = ? AND actionId = ?')
        .get(row.scopeId, row.deleteActionId) as { committedAt?: string } | undefined;
      const committedAt = typeof receipt?.committedAt === 'string' && receipt.committedAt
        ? receipt.committedAt
        : (row.deletedAt ?? new Date().toISOString());
      try {
        app.searchStaleness.notifySourceChange({
          entity: 'BlobStore',
          rowId: row.blobId,
          kind: 'removed',
          committedAt,
          priority: 'high',
          erasure: true,
        });
      } catch (error) {
        // Post-commit isolation: a signal failure never undoes the discard, but
        // it MUST be retried — the durable row stays (outer catch records the
        // retry) so the derived store is told about the deletion before this
        // row is gone.
        throw error;
      }
    }
    app.db.prepare("DELETE FROM _PendingBlob WHERE pendingKey = ? AND status = 'delete-requested'").run(row.pendingKey);
  }

  async function reconcile(): Promise<void> {
    const deleting = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'delete-requested'").all() as unknown as PendingBlobRow[];
    for (const row of deleting) {
      try {
        await reconcileDeletion(row);
      } catch (error) {
        recordDeleteRetry(row, error);
      }
    }
    const claimed = app.db.prepare("SELECT * FROM _PendingBlob WHERE status = 'claimed'").all() as unknown as PendingBlobRow[];
    for (const row of claimed) {
      try {
        const bytes = readGeneration(row.blobId);
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
  async function reap(): Promise<void> {
    const stale = new Date(Date.now() - options.pendingTtlMs).toISOString();
    await txn(app.db, () => {
      const rows = app.db.prepare("SELECT pendingKey, blobId FROM _PendingBlob WHERE status = 'pending' AND createdAt < ?").all(stale) as Array<{ pendingKey: string; blobId: string }>;
      for (const row of rows) {
        app.blobs.discardPending(row.blobId);
        app.db.prepare("DELETE FROM _PendingBlob WHERE pendingKey = ? AND status = 'pending'").run(row.pendingKey);
      }
    });
  }
  // Claim admission for reads (S6/A4): pending bytes are served ONLY to the
  // uploader's claim, and only once the claim was admitted (the row is
  // 'claimed'/'finalized'). A staged-but-unclaimed blob id, a missing blob, or
  // a read whose bytes fail the digest attestation all yield the SAME generic
  // BLOB_UNAVAILABLE — never a distinguishable existence signal.
  function readClaimed(blobId: string, range?: [start?: number, end?: number]): Buffer {
    const row = app.db.prepare("SELECT * FROM _PendingBlob WHERE blobId = ? AND status IN ('claimed', 'finalized')").get(blobId) as PendingBlobRow | undefined;
    if (!row) failure('BLOB_UNAVAILABLE');
    let bytes: Buffer;
    try {
      bytes = readGeneration(blobId);
      if (bytes.length !== row.byteLength || createHash('sha256').update(bytes).digest('hex') !== row.contentDigest) throw new Error('BLOB_UNAVAILABLE');
    } catch (error) {
      markRecoveryFailure(row, error);
      failure('BLOB_UNAVAILABLE');
    }
    return range === undefined ? bytes : readGeneration(blobId, range);
  }
  function status(blobId: string): string | null {
    const row = app.db.prepare('SELECT status FROM _PendingBlob WHERE blobId = ?').get(blobId) as { status: string } | undefined;
    return row?.status ?? null;
  }
  return Object.freeze({
    stage,
    validateClaim,
    requestDeletion,
    readClaimed,
    status,
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

interface PendingBlobWorkbench {
  pendingBlobLifecycle?: PendingBlobLifecycle | null;
  writeQueue: { run<T>(fn: () => Promise<T> | T): Promise<T> };
}

export interface PendingBlobStager {
  stage(request: StagePendingBlobRequest): Promise<StagedPendingBlob>;
}

export function pendingBlobStager(workbench: PendingBlobWorkbench, authenticatedPrincipal: Principal): PendingBlobStager {
  const lifecycle = workbench.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');
  return Object.freeze({ stage: (request: StagePendingBlobRequest) => lifecycle.stage(authenticatedPrincipal, request) });
}

export function readClaimedBlob(workbench: PendingBlobWorkbench, blobId: string): Buffer {
  const lifecycle = workbench.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');
  return lifecycle.readClaimed(blobId);
}

export type ClaimedBlobLifecycleState =
  | Readonly<{ kind: 'available'; readRange(range?: [start?: number, end?: number]): Buffer }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'missing' }>;

export interface ClaimedBlobLifecycle {
  inspect(blobId: string): ClaimedBlobLifecycleState;
  reconcile(): Promise<void>;
}

export function claimedBlobLifecycle(workbench: PendingBlobWorkbench): ClaimedBlobLifecycle {
  const lifecycle = workbench?.pendingBlobLifecycle;
  if (!lifecycle) throw new Error('blobLifecycle is not configured');

  const inspect = (blobId: string): ClaimedBlobLifecycleState => {
    const status = lifecycle.status(blobId);
    if (status === null || status === 'deleted') return Object.freeze({ kind: 'missing' });
    if (status === 'recovery-failed') return Object.freeze({ kind: 'failed' });
    if (status !== 'finalized') return Object.freeze({ kind: 'pending' });
    try {
      lifecycle.readClaimed(blobId);
      return Object.freeze({
        kind: 'available',
        readRange: (range?: [start?: number, end?: number]) => lifecycle.readClaimed(blobId, range),
      });
    } catch {
      return Object.freeze({ kind: 'failed' });
    }
  };

  return Object.freeze({
    inspect,
    reconcile: () => workbench.writeQueue.run(() => lifecycle.reconcile()),
  });
}
