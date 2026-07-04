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

export function frameworkLogDDL() {
  return [logTableDDL(), logIndexDDL(), cursorTableDDL()];
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
