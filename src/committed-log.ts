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
import type { EventIdentityHandle } from './event-handle.ts';
import { txn, type DbHandle } from './driver.ts';

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
  return [logTableDDL(), logIndexDDL(), cursorTableDDL(), actionReceiptTableDDL(), committedRevisionTableDDL(), historyCursorTableDDL()];
}

// ---- read ----

// readSeq — the per-scope committed sequence counter. Delegates to the canonical
// cursor.mjs read so there is one SQL path to _Cursor.
export function readSeq(db: CursorDatabase | null | undefined, scope: string): number {
  return cursorReadSeq(db, scope);
}

// eventsFor — read every event for an actionId (dedupe). Returns raw DB rows
// with eventData parsed, ordered by scope + seq.
export function eventsFor(db: DbHandle, actionId: string): LogEvent[] {
  const rows = db.prepare(
    'SELECT * FROM _Log WHERE actionId = :actionId ORDER BY scope, seq',
  ).all({ actionId });
  return rows.map((r) => ({
    ...r,
    data: JSON.parse(r.eventData as string),
  }) as LogEvent);
}

// receiptFor — read the owning-stream action receipt for (scope, actionId), or
// undefined when the action was never committed under that owning scope. The
// dedupe check for durable dispatch/dispatchBatch (Wave 4.9): unlike eventsFor,
// this is scoped by the action's own owning scope, so the same actionId reused
// under a different owning scope is a distinct, independent action.
export function receiptFor(db: DbHandle, scope: string, actionId: string): ParsedReceipt | undefined {
  const row = db.prepare(
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
  const stmt = db.prepare('SELECT * FROM _Log WHERE scope = :scope AND seq = :seq');
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
// neither does.
export function insertReceipt(db: DbHandle, scope: string, actionId: string, committedAt: string, events: LogEvent[], metadata: ReceiptMetadata = {}): number {
  const historyOrder = db.prepare(
    'SELECT COALESCE(MAX(historyOrder), 0) + 1 AS next FROM _ActionReceipt WHERE scope = :scope',
  ).get({ scope })!.next as number;
  db.prepare(
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
    actionData: JSON.stringify(metadata.actionData ?? null),
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
  db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
  return historyOrder;
}

// readSince — read events for a scope with seq > cursor, ordered by seq.
// Returns raw rows with eventData parsed. Used by the resync route.
export function readSince(db: DbHandle, scope: string, cursor: number): LogEvent[] {
  const rows = db.prepare(
    'SELECT * FROM _Log WHERE scope = :scope AND seq > :cursor ORDER BY seq',
  ).all({ scope, cursor });
  return rows.map((r) => ({
    ...r,
    data: JSON.parse(r.eventData as string),
  }) as LogEvent);
}

// minSeqForScope — the oldest retained event seq for a scope. Used by the
// resync route to detect a gap that can never be filled (cursor-behind-retention).
// Returns null when the scope has no events.
export function minSeqForScope(db: DbHandle, scope: string): number | null {
  const row = db.prepare(
    'SELECT MIN(seq) AS min FROM _Log WHERE scope = :scope',
  ).get({ scope });
  return (row?.min as number | null) ?? null;
}

// rowToEvent — rebuild an event object from a durable _Log row. Shared by
// the dedupe path: a re-sent actionId returns its previously-committed events
// without re-running the handler. The row→event shape has ONE definition.
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
    data: row.eventData ? (typeof row.eventData === 'string' ? JSON.parse(row.eventData) : (row.eventData as Record<string, unknown>)) : null,
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
export function appendEvents(db: DbHandle, events: AppendedEvent[]) {
  const stmt = db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (:scope, :seq, :eventType, :eventData, :actionId, :committedAt)',
  );
  for (const e of events) {
    stmt.run({
      scope: e.scope,
      seq: e.seq,
      eventType: e.type,
      eventData: JSON.stringify(e.data ?? {}),
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
  actionId: string;
  committedAt: string;
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
