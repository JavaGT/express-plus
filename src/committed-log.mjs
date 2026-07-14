// The committed _Log — the single durable event store.
//
// This module owns the _Log table (DDL, append, read, dedupe) so pipeline.mjs
// and serve.mjs share one surface rather than each carrying inline SQL against
// the same table. One canonical source for the durable log shape — a second
// copy of a _Log query is the exact seam where the two paths drift.
//
// The _Log row shape: scope, seq, eventType, eventData (JSON), actionId,
// committedAt (ISO string). Per-scope seq is monotonic; PRIMARY KEY (scope, seq).

import { readSeq as cursorReadSeq } from './cursor.mjs';

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
  PRIMARY KEY (scope, actionId)
);`;
}

export function frameworkLogDDL() {
  return [logTableDDL(), logIndexDDL(), cursorTableDDL(), actionReceiptTableDDL()];
}

// ---- read ----

// readSeq — the per-scope committed sequence counter. Delegates to the canonical
// cursor.mjs read so there is one SQL path to _Cursor.
export function readSeq(db, scope) {
  return cursorReadSeq(db, scope);
}

// eventsFor — read every event for an actionId (dedupe). Returns raw DB rows
// with eventData parsed, ordered by scope + seq.
export function eventsFor(db, actionId) {
  const rows = db.prepare(
    'SELECT * FROM _Log WHERE actionId = :actionId ORDER BY scope, seq',
  ).all({ actionId });
  return rows.map((r) => ({
    ...r,
    data: JSON.parse(r.eventData),
  }));
}

// receiptFor — read the owning-stream action receipt for (scope, actionId), or
// undefined when the action was never committed under that owning scope. The
// dedupe check for durable dispatch/dispatchBatch (Wave 4.9): unlike eventsFor,
// this is scoped by the action's own owning scope, so the same actionId reused
// under a different owning scope is a distinct, independent action.
export function receiptFor(db, scope, actionId) {
  const row = db.prepare(
    'SELECT * FROM _ActionReceipt WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope, actionId });
  if (!row) return undefined;
  return { ...row, eventRefs: JSON.parse(row.eventRefs) };
}

// eventsFromReceipt — resolve a receipt's stored `eventRefs` back into full
// events, in the exact order the refs were recorded (the stable emission
// ordinal). A ref pointing at a row that no longer exists (retention pruning
// having outrun the receipt) is skipped rather than thrown — the receipt still
// proves the action committed; a pruned event is gone from every path, not
// just replay.
export function eventsFromReceipt(db, receipt, parseEventType) {
  const stmt = db.prepare('SELECT * FROM _Log WHERE scope = :scope AND seq = :seq');
  const events = [];
  for (const ref of receipt.eventRefs) {
    const row = stmt.get({ scope: ref.scope, seq: ref.seq });
    if (row) events.push(rowToEvent(row, parseEventType));
  }
  return events;
}

// insertReceipt — record the owning-stream action receipt inside the caller's
// open transaction, immediately after the same action's events (if any) are
// appended to _Log. Atomic with the append: both land in the same commit, or
// neither does.
export function insertReceipt(db, scope, actionId, committedAt, events) {
  db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs) VALUES (:scope, :actionId, :committedAt, :eventRefs)',
  ).run({
    scope,
    actionId,
    committedAt,
    eventRefs: JSON.stringify(events.map((e) => ({ scope: e.scope, seq: e.seq }))),
  });
}

// readSince — read events for a scope with seq > cursor, ordered by seq.
// Returns raw rows with eventData parsed. Used by the resync route.
export function readSince(db, scope, cursor) {
  const rows = db.prepare(
    'SELECT * FROM _Log WHERE scope = :scope AND seq > :cursor ORDER BY seq',
  ).all({ scope, cursor });
  return rows.map((r) => ({
    ...r,
    data: JSON.parse(r.eventData),
  }));
}

// minSeqForScope — the oldest retained event seq for a scope. Used by the
// resync route to detect a gap that can never be filled (cursor-behind-retention).
// Returns null when the scope has no events.
export function minSeqForScope(db, scope) {
  const row = db.prepare(
    'SELECT MIN(seq) AS min FROM _Log WHERE scope = :scope',
  ).get({ scope });
  return row?.min ?? null;
}

// rowToEvent — rebuild an event object from a durable _Log row. Shared by
// the dedupe path: a re-sent actionId returns its previously-committed events
// without re-running the handler. The row→event shape has ONE definition.
export function rowToEvent(row, parseEventType) {
  let handle;
  try {
    handle = parseEventType(row.eventType);
  } catch {
    handle = undefined;
  }
  const event = {
    type: row.eventType,
    scope: row.scope,
    seq: row.seq,
    actionId: row.actionId,
    committedAt: row.committedAt,
    data: row.eventData ? (typeof row.eventData === 'string' ? JSON.parse(row.eventData) : row.eventData) : null,
  };
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
export function appendEvents(db, events) {
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
export function retentionPrune(db, cutoffIso) {
  db.prepare('DELETE FROM _Log WHERE committedAt < :cutoff').run({ cutoff: cutoffIso });
}
