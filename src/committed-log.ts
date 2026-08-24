// The committed _Log — the single durable event store.
//
// This module owns the _Log table (DDL, append, read, dedupe) so pipeline.mjs
// and serve.mjs share one surface rather than each carrying inline SQL against
// the same table. One canonical source for the durable log shape — a second
// copy of a _Log query is the exact seam where the two paths drift.
//
// The _Log row shape: scope, seq, eventType, eventData (JSON), actionId,
// committedAt (ISO string). Per-scope seq is monotonic; PRIMARY KEY (scope, seq).

import { readSeq as cursorReadSeq, type CursorDatabase } from './cursor.ts';
import { parseEventType, type EventIdentityHandle } from './event-handle.ts';
import { prepareCached, txn, type DbHandle } from './driver.ts';
import { noHistoryReceiptTableDDL } from './no-history-receipt.ts';
import { canonicalStringify } from './canonical-json.ts';
import { liveRevisionTableDDL } from './live-revision.ts';
import { invalidationLedgerTableDDL } from './invalidation-ledger.ts';
import { sweepFactDependencies } from './private-action-fact-dependency.ts';
import { createHash } from 'node:crypto';
import { readV16Brand, v16CapabilityBytesDigest, parseStoredV16OperatedEvent, serializeV16OperatedEvent, type OperatedWireEnvelope } from './annotated-text-operated-event.ts';

// The no-history lane (S3/A2) surfaces through this module alongside the
// durable _Log/_ActionReceipt surfaces, so the boot DDL and the kernel have one
// aggregate import. The minimized receipt and the per-resource revision are
// owned by no-history-receipt.ts and live-revision.ts; this module only
// aggregates their DDL into frameworkLogDDL() and re-exports their accessors.
export {
  noHistoryReceiptTableDDL,
  insertNoHistoryReceipt,
  noHistoryReceiptFor,
  type NoHistoryReceipt,
  type NoHistoryReceiptInput,
} from './no-history-receipt.ts';
export {
  liveRevisionTableDDL,
  bumpRevision,
  readRevision,
  guardExpectedRevision,
  expectedRevisionConflict,
} from './live-revision.ts';
export { invalidationLedgerTableDDL } from './invalidation-ledger.ts';

// ---- DDL ----

export function logTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _Log (
  scope TEXT NOT NULL,
  seq INTEGER NOT NULL,
  eventType TEXT NOT NULL,
  eventData TEXT NOT NULL,
  actionId TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (scope, seq)
);`;
}

export function cursorTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _Cursor (
  scope TEXT NOT NULL PRIMARY KEY,
  lastSeq INTEGER NOT NULL
);`;
}

export function logIndexDDL() {
  return 'CREATE INDEX IF NOT EXISTS idx__Log_actionId ON _Log (actionId);';
}

// V16 capability claims (#149 round 3, Findings 3+4). One row per consumed
// nonce capability. Written inside the SAME transaction as the _Log insert,
// so a rollback restores the capability automatically (legitimate retry works
// again) and a commit makes the consumption permanent (exactly-once forever).
// Process restart is handled by SQLite journal recovery; retention pruning
// bounds the table.
export function v16CapabilityClaimTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _V16CapabilityClaim (
  nonce TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  bytes_digest TEXT NOT NULL
);`;
}

// The owning-stream action receipt (Wave 4.9). Durable dispatch dedupe keys on
// (scope, actionId) — the action's OWNING scope (the dispatch request's own
// `scope`, distinct from any individual emitted event's scope) — so the same
// actionId reused across two owning scopes is independent action identity, not
// a collision. `eventRefs` is the stored result: a JSON array of `{scope, seq}`
// _Log row references in exact original emission order (the stable emission
// ordinal), so a replayed dedupe reconstructs `events` in the order the handler
// returned them even when the action spans multiple event scopes. The receipt
// row is written even for a zero-event action, so a no-op action is durably
// idempotent across a retry (and a process restart) without a handler re-run.
// A dispatch that omits the optional public `scope` field keys on the empty
// string — every scope-less dispatch shares that one bucket, reproducing the
// pre-Wave-4.9 global-by-actionId dedupe exactly for callers that don't opt in.
export function actionReceiptTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _ActionReceipt (
  scope TEXT NOT NULL,
  actionId TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  eventRefs TEXT NOT NULL,
  historyOrder INTEGER,
  actionType TEXT,
  actionData TEXT,
  principalKey TEXT,
   sessionId TEXT,
   operation TEXT NOT NULL DEFAULT 'action',
   resultData TEXT,
   historyRootActionId TEXT,
   historyTargetActionId TEXT,
   historyOutcome TEXT,
  PRIMARY KEY (scope, actionId)
);`;
}

// History-order allocation for _ActionReceipt (#124). A per-scope monotonic
// counter row replaces SELECT MAX(historyOrder)+1, which read every retained
// receipt for the scope inside each commit. The counter also preserves an
// ordering guarantee that MAX()+1 loses under erasure: applyErasureDirective
// deletes receipt rows, so the maximum can move BACKWARDS and a later commit
// would reuse an order value already consumed by a reader's keyset pagination
// cursor (historyOrder > :after). Counter values are strictly increasing over
// time per scope, so surviving rows keep their relative order and no value is
// ever reused. The row is seeded lazily from any pre-counter maximum, which
// upgrades existing databases in place; after seeding, allocation is O(1).
export function historyOrderCounterTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _HistoryOrderCounter (
  scope TEXT PRIMARY KEY,
  lastOrder INTEGER NOT NULL
);`;
}

// Receipt history reads order by historyOrder within a scope (durable-history
// keyset pagination, cursor reconstruction, erasure census). Declared here so
// the framework object census sees it; executeFrameworkDDL defers CREATION to
// ensureActionReceiptColumns, because the historyOrder column only exists on
// legacy databases after that migration runs.
export function actionReceiptHistoryIndexDDL() {
  return 'CREATE INDEX IF NOT EXISTS idx__ActionReceipt_scope_history ON _ActionReceipt (scope, historyOrder);';
}

export function committedRevisionTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _CommittedRevision (
   name TEXT PRIMARY KEY,
   revision INTEGER NOT NULL
 );
 INSERT OR IGNORE INTO _CommittedRevision (name, revision) VALUES ('actions', 0);`;
}

export function historyCursorTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _HistoryCursor (
  principalKey TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  scope TEXT NOT NULL,
  past TEXT NOT NULL,
  future TEXT NOT NULL,
  PRIMARY KEY (principalKey, sessionId, scope)
);`;
}

export function frameworkLogDDL() {
  return [
    logTableDDL(),
    logIndexDDL(),
    v16CapabilityClaimTableDDL(),
    cursorTableDDL(),
    actionReceiptTableDDL(),
    actionReceiptHistoryIndexDDL(),
    historyOrderCounterTableDDL(),
    committedRevisionTableDDL(),
    historyCursorTableDDL(),
    // S3/A2 no-history lane: the minimized receipt + per-resource revision.
    // Existing _Log/_ActionReceipt tables and their invariants are untouched.
    noHistoryReceiptTableDDL(),
    liveRevisionTableDDL(),
    invalidationLedgerTableDDL(),
  ];
}

// ---- read ----

// readSeq — the per-scope committed sequence counter. Delegates to the canonical
// cursor.mjs read so there is one SQL path to _Cursor.
export function readSeq(db: CursorDatabase | null | undefined, scope: string): number {
  return cursorReadSeq(db, scope);
}

/**
 * The ONE log-row decoder (Finding 1). Every `_Log.eventData` read goes
 * through here: version-16 rows are dispatched through the strict stored
 * parser — duplicate keys, noncanonical bytes, and over-limits fail closed
 * with fixed opaque signatures BEFORE any value is produced — using the event
 * handle's entity/field for the error context; every other version keeps its
 * plain JSON.parse. A v16-looking row whose type is not an operated handle is
 * rejected: raw v16 bytes may only ride on `<entity>.<field>.operated`.
 */
export function decodeLogRowData(row: LogRowLike): unknown {
  const text = row.eventData as string | null;
  if (!text) return null;
  let probe: unknown;
  try {
    probe = JSON.parse(text);
  } catch {
    // Even the structural probe must not crash non-v16 readers; strictness
    // for v16 is enforced below through the strict parser.
    return JSON.parse(text);
  }
  if (probe && typeof probe === 'object' && !Array.isArray(probe) && (probe as { version?: unknown }).version === 16) {
    let entity = 'Unknown';
    let field = 'unknown';
    try {
      const handle = parseEventType(row.eventType as string);
      if (handle.kind === 'native' && handle.nativeName === 'operated') {
        entity = handle.entity;
        field = handle.field;
      } else {
        throw new Error('not an operated handle');
      }
    } catch {
      throw new Error('v16 eventData reached a non-operated event type');
    }
    return parseStoredV16OperatedEvent(text, { entity, field });
  }
  return probe;
}

/**
 * Consumer-safe variant of the one log-row decoder for background effect
 * consumers (Finding 1, review round 2). Identical v16 strictness — a
 * tampered/duplicate-key/noncanonical v16 row throws the same fixed opaque
 * signatures — but a non-v16 row's malformed JSON degrades to `fallback`
 * exactly as those consumers behaved before, preserving their existing
 * error boundaries.
 */
export function decodeConsumerLogRowData(row: LogRowLike, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const decoded = decodeLogRowData(row);
    return (decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : fallback);
  } catch (error) {
    // Only genuine v16 strictness failures propagate; plain JSON errors on
    // non-v16 rows keep the consumer's legacy degrade-to-fallback behavior.
    const text = row.eventData as string | null;
    let probe: unknown;
    try { probe = text ? JSON.parse(text) : undefined; } catch { return fallback; }
    if (probe && typeof probe === 'object' && !Array.isArray(probe) && (probe as { version?: unknown }).version === 16) {
      throw error;
    }
    return fallback;
  }
}

// eventsFor — read every event for an actionId (dedupe). Returns raw DB rows
// with eventData parsed, ordered by scope + seq.
export function eventsFor(db: DbHandle, actionId: string): LogEvent[] {
  const rows = prepareCached(db,
    'SELECT * FROM _Log WHERE actionId = :actionId ORDER BY scope, seq',
  ).all({ actionId });
  return rows.map((r) => ({
    ...r,
    data: decodeLogRowData(r as unknown as LogRowLike),
  }) as LogEvent);
}

// receiptFor — read the owning-stream action receipt for (scope, actionId), or
// undefined when the action was never committed under that owning scope. The
// dedupe check for durable dispatch/dispatchBatch (Wave 4.9): unlike eventsFor,
// this is scoped by the action's own owning scope, so the same actionId reused
// under a different owning scope is a distinct, independent action.
export function receiptFor(db: DbHandle, scope: string, actionId: string): ParsedReceipt | undefined {
  const row = prepareCached(db,
    'SELECT * FROM _ActionReceipt WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope, actionId });
  if (!row) return undefined;
  return {
    ...row,
    eventRefs: JSON.parse(row.eventRefs as string),
    resultData: row.resultData ? JSON.parse(row.resultData as string) : null,
  } as ParsedReceipt;
}

// eventsFromReceipt — resolve a receipt's stored `eventRefs` back into full
// events, in the exact order the refs were recorded (the stable emission
// ordinal). A ref pointing at a row that no longer exists (retention pruning
// having outrun the receipt) is skipped rather than thrown — the receipt still
// proves the action committed; a pruned event is gone from every path, not
// just replay.
export function eventsFromReceipt(db: DbHandle, receipt: ParsedReceipt, parseEventType: EventTypeParser): LogEvent[] {
  const stmt = prepareCached(db, 'SELECT * FROM _Log WHERE scope = :scope AND seq = :seq');
  const events: LogEvent[] = [];
  for (const ref of receipt.eventRefs) {
    const row = stmt.get({ scope: ref.scope, seq: ref.seq });
    if (row) events.push(rowToEvent(row as unknown as LogRowLike, parseEventType));
  }
  return events;
}

// insertReceipt — record the owning-stream action receipt inside the caller's
// open transaction, immediately after the same action's events (if any) are
// appended to _Log. Atomic with the append: both land in the same commit, or
// neither does. History order comes from the per-scope monotonic counter row
// (historyOrderCounterTableDDL), bumped in this same transaction.
export function insertReceipt(db: DbHandle, scope: string, actionId: string, committedAt: string, events: LogEvent[], metadata: ReceiptMetadata = {}): number {
  // Seed the counter from any pre-counter receipts so an upgraded database
  // continues its existing sequence; a no-op once the row exists.
  prepareCached(db,
    `INSERT INTO _HistoryOrderCounter (scope, lastOrder)
     VALUES (:scope, COALESCE((SELECT MAX(historyOrder) FROM _ActionReceipt WHERE scope = :scope), 0))
     ON CONFLICT(scope) DO NOTHING`,
  ).run({ scope });
  const historyOrder = prepareCached(db,
    'SELECT lastOrder + 1 AS next FROM _HistoryOrderCounter WHERE scope = :scope',
  ).get({ scope })!.next as number;
  prepareCached(db,
    'UPDATE _HistoryOrderCounter SET lastOrder = :next WHERE scope = :scope',
  ).run({ scope, next: historyOrder });
  prepareCached(db,
    `INSERT INTO _ActionReceipt
       (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation, resultData, historyRootActionId, historyTargetActionId, historyOutcome)
     VALUES
       (:scope, :actionId, :committedAt, :eventRefs, :historyOrder, :actionType, :actionData, :principalKey, :sessionId, :operation, :resultData, :historyRootActionId, :historyTargetActionId, :historyOutcome)`,
  ).run({
    scope,
    actionId,
    committedAt,
    eventRefs: JSON.stringify(events.map((e) => ({ scope: e.scope, seq: e.seq }))),
    historyOrder,
    actionType: metadata.actionType ?? null,
    actionData: canonicalStringify(metadata.actionData ?? null),
    principalKey: metadata.principalKey ?? null,
    sessionId: metadata.sessionId ?? null,
    operation: metadata.operation ?? 'action',
    resultData: metadata.resultData === undefined ? null : JSON.stringify(metadata.resultData),
    historyRootActionId: metadata.historyRootActionId ?? null,
    historyTargetActionId: metadata.historyTargetActionId ?? null,
    historyOutcome: metadata.historyOutcome ?? null,
  });
  // This survives receipt erasure and is transactionally paired with every
  // committed action, unlike SQLite's reusable implicit rowid.
  prepareCached(db, "UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
  return historyOrder;
}

// readSince — read events for a scope with seq > cursor, ordered by seq.
// Returns raw rows with eventData decoded through the one log-row decoder.
// Used by the resync route and live delivery.
export function readSince(db: DbHandle, scope: string, cursor: number): LogEvent[] {
  const rows = prepareCached(db,
    'SELECT * FROM _Log WHERE scope = :scope AND seq > :cursor ORDER BY seq',
  ).all({ scope, cursor });
  return rows.map((r) => ({
    ...r,
    data: decodeLogRowData(r as unknown as LogRowLike),
  }) as LogEvent);
}

// minSeqForScope — the oldest retained event seq for a scope. Used by the
// resync route to detect a gap that can never be filled (cursor-behind-retention).
// Returns null when the scope has no events.
export function minSeqForScope(db: DbHandle, scope: string): number | null {
  const row = prepareCached(db,
    'SELECT MIN(seq) AS min FROM _Log WHERE scope = :scope',
  ).get({ scope });
  return (row?.min as number | null) ?? null;
}

// rowToEvent — rebuild an event object from a durable _Log row. Shared by
// the dedupe path: a re-sent actionId returns its previously-committed events
// without re-running the handler. The row→event shape has ONE definition, and
// v16 rows are strictly decoded (Finding 1).
export function rowToEvent(row: LogRowLike, parseEventType: EventTypeParser): LogEvent {
  let handle: EventIdentityHandle | undefined;
  try {
    handle = parseEventType(row.eventType as string);
  } catch {
    handle = undefined;
  }
  const event = {
    type: row.eventType as string,
    scope: row.scope as string,
    seq: row.seq as number,
    actionId: row.actionId as string,
    committedAt: row.committedAt as string,
    data: row.eventData ? decodeLogRowData(row) : null,
  } as unknown as LogEvent;
  if (handle) {
    const out = { ...event };
    Object.defineProperty(out, 'handle', { value: handle, enumerable: false });
    return Object.freeze(out);
  }
  return Object.freeze(event);
}

// ---- write ----

// appendEvents — insert finalized events into _Log inside the caller's open
// transaction. Each event must already carry its resolved data, scope, seq,
// actionId, and committedAt. The caller handles NOW-token resolution and
// per-scope sequence assignment before calling this.
//
// A package-branded v16 operated event carries its canonical `_Log.eventData`
// text precomputed by the sole constructor (annotated-text-operated-event.ts);
// it is inserted verbatim so the durable bytes are byte-identical to what the
// canonicalizer produced. Applications cannot supply the brand or
// pre-serialized text: `data` must literally be that constructor's return.
export function appendEvents(db: DbHandle, events: AppendedEvent[]) {
  const stmt = prepareCached(db,
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (:scope, :seq, :eventType, :eventData, :actionId, :committedAt)',
  );
  for (const e of events) {
    stmt.run({
      scope: e.scope,
      seq: e.seq,
      eventType: e.type,
      eventData: serializeAppendedEventData(db, e),
      actionId: e.actionId,
      committedAt: e.committedAt,
    });
  }
}

// retentionPrune — delete log entries older than a cutoff date. Used by the
// log retention reaper (serve.mjs). Runs under the writeQueue mutex.
export function retentionPrune(db: DbHandle, cutoffIso: string) {
  return txn(db, () => {
    const expired = new Set(db.prepare(
      'SELECT scope, actionId FROM _ActionReceipt WHERE committedAt < :cutoff',
    ).all({ cutoff: cutoffIso }).map((row) => `${row.scope as string}\u0000${row.actionId as string}`));
    const cursors = db.prepare('SELECT * FROM _HistoryCursor').all();
    const update = db.prepare('UPDATE _HistoryCursor SET past = ?, future = ? WHERE principalKey = ? AND sessionId = ? AND scope = ?');
    for (const cursor of cursors) {
      const filter = (json: string) => JSON.parse(json).filter((frame: unknown) => {
        const actionId = typeof frame === 'string' ? frame : (frame as { rootActionId?: unknown } | null | undefined)?.rootActionId;
        return typeof actionId === 'string' && !expired.has(`${cursor.scope as string}\u0000${actionId}`);
      });
      update.run(JSON.stringify(filter(cursor.past as string)), JSON.stringify(filter(cursor.future as string)), cursor.principalKey, cursor.sessionId, cursor.scope);
    }
    db.prepare('UPDATE _ActionReceipt SET actionData = NULL WHERE committedAt < :cutoff').run({ cutoff: cutoffIso });
    db.prepare('DELETE FROM _PrivateActionFact WHERE committedAt < :cutoff').run({ cutoff: cutoffIso });
    // Keep the erasure prerequisite index exactly aligned with the surviving
    // facts — this sweep runs outside any cascade guarantee (design §5).
    sweepFactDependencies(db);
    db.prepare('DELETE FROM _Log WHERE committedAt < :cutoff').run({ cutoff: cutoffIso });
  });
}

// ---- shared shapes ----

export type EventTypeParser = (eventType: string) => EventIdentityHandle;

export interface LogRow {
  scope: string;
  seq: number;
  eventType: string;
  eventData: string;
  actionId: string;
  committedAt: string;
}

export interface LogEvent extends LogRow {
  data: Record<string, unknown> | null;
}

export interface LogRowLike {
  scope: unknown;
  seq: unknown;
  eventType: unknown;
  eventData: unknown;
  actionId: unknown;
  committedAt: unknown;
}

export interface AppendedEvent {
  scope: string;
  seq: number;
  type: string;
  data?: unknown;
  /**
   * Single-use v16 admission capability minted by constructV16RegionEvent.
   * Required only when `data` lost its brand (pipeline deep copy); consumed
   * exactly once and bound to canonical bytes + document identity.
   */
  v16Capability?: { nonce: string };
  actionId: string;
  committedAt: string;
}

// One durable-bytes decision per appended event. A version-16 operated
// envelope is admitted ONLY through one of two capability proofs (Finding 3,
// review round 2):
//   1. BRAND — the object is literally the constructor's frozen return
//      (module-private symbol stamp) and its bytes match the stamp.
//   2. NONCE CAPABILITY — for the pipeline's symbol-stripping deep copy, the
//      caller supplies `v16Capability.nonce`; claimV16NonceCapability consumes
//      it exactly once and binds it to canonical bytes + document identity.
// Clones, replays, stale/duplicate reuse, mutated bytes, and post-restart
// tokens all fail BEFORE the _Log insert. Everything else keeps stable
// stringify.
function serializeAppendedEventData(db: DbHandle, event: AppendedEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && !Array.isArray(data) && data.version === 16) {
    // Canonicalize the incoming datum FIRST (bounded accounting applies to any
    // claimant).
    const canonical = serializeV16OperatedEvent(data as OperatedWireEnvelope);
    const documentId = typeof data.id === 'string' ? data.id : '';
    const bytesDigest = v16CapabilityBytesDigest(canonical);

    // Durable one-shot claim (Findings 3+4, round 3): the claim row is written
    // in the SAME transaction as the _Log insert. ROLLBACK removes it — a
    // failed compound action restores the capability so a legitimate retry
    // succeeds; COMMIT makes consumption permanent, so replay/duplicate/
    // post-restart reuse of the same nonce fails forever. The claim is taken
    // BEFORE any write is finalized and bound to document + exact bytes.
    const nonce = resolveAdmissionNonce(event, data, canonical, documentId);
    let claimChanges: number;
    try {
      const claimed = prepareCached(db,
        'INSERT INTO _V16CapabilityClaim (nonce, document_id, bytes_digest) VALUES (?, ?, ?)',
      );
      claimChanges = Number(claimed.run(nonce, documentId, bytesDigest).changes);
    } catch (error) {
      // A PRIMARY KEY conflict is a nonce REUSE — same fail-closed signature
      // as every other admission failure (no distinguishing oracle).
      if (/UNIQUE constraint failed: _V16CapabilityClaim.nonce/.test(String((error as Error).message))) {
        throw new Error('operated v16 admission capability was missing, reused, or expired');
      }
      throw error;
    }
    if (claimChanges === 0) {
      throw new Error('operated v16 admission capability was missing, reused, or expired');
    }
    if (!v16ClaimMatches(db, nonce, documentId, bytesDigest)) {
      throw new Error('operated v16 admission capability was missing, reused, or expired');
    }
    return canonical;
  }
  return JSON.stringify(event.data ?? {});
}

// Resolve which capability proof this append carries:
//  - brand: the object IS the constructor's frozen return; its stamp must
//    match the re-serialized bytes. Its nonce comes from the brand itself.
//  - capability: a pipeline-copied envelope (brand stripped by Object.keys)
//    carries the nonce on the appended event frame.
function resolveAdmissionNonce(event: AppendedEvent, data: Record<string, unknown>, canonical: string, documentId: string): string {
  // The nonce is a pure function of the minting (document ‖ exact bytes), so
  // it can be re-derived and VERIFIED here — a forged/random nonce fails this
  // equality exactly like a missing one, with no distinguishing oracle.
  const expected = v16AdmissionNonce(documentId, canonical);
  const branded = readV16Brand(data);
  if (branded !== null) {
    if (canonical !== branded.eventDataText || branded.nonce !== expected) {
      throw new Error('noncanonical operated v16 eventData reached _Log');
    }
    return expected;
  }
  const supplied = (event as { v16Capability?: { nonce?: unknown } }).v16Capability?.nonce;
  if (supplied !== expected) {
    throw new Error('operated v16 admission capability was missing, reused, or expired');
  }
  return expected;
}

/** Deterministic single-use admission token for a minted envelope. */
export function v16AdmissionNonce(documentId: string, canonicalText: string): string {
  return createHash('sha256')
    .update('workbench.v16.capability\u0000')
    .update(documentId)
    .update('\u0000')
    .update(canonicalText)
    .digest('hex');
}

function v16ClaimMatches(db: DbHandle, nonce: string, documentId: string, bytesDigest: string): boolean {
  const row = prepareCached(db,
    'SELECT document_id, bytes_digest FROM _V16CapabilityClaim WHERE nonce = ?',
  ).get(nonce) as { document_id: string; bytes_digest: string } | undefined;
  return !!row && row.document_id === documentId && row.bytes_digest === bytesDigest;
}

export interface EventRef {
  scope: string;
  seq: number;
}

export interface ParsedReceipt {
  scope: string;
  actionId: string;
  committedAt: string;
  eventRefs: EventRef[];
  resultData: unknown;
  historyOrder: number | null;
  actionType: string | null;
  actionData: string | null;
  principalKey: string | null;
  sessionId: string | null;
  operation: string;
  historyRootActionId: string | null;
  historyTargetActionId: string | null;
  historyOutcome: string | null;
}

export interface ReceiptMetadata {
  actionType?: string | null;
  actionData?: unknown;
  principalKey?: string | null;
  sessionId?: string | null;
  operation?: string;
  resultData?: unknown;
  historyRootActionId?: string | null;
  historyTargetActionId?: string | null;
  historyOutcome?: string | null;
}
