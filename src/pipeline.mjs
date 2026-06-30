// The mutation pipeline's type kernel: Action and Event (SPEC §7).
//
// An ACTION is an imperative client request that may be rejected. An EVENT is a
// past-tense fact the server emitted — it already happened. They are distinct
// branded types so neither is mistaken for the other: an action is dispatched
// and authorized; an event is folded into state through its reducer.
//
// The reducer is NON-OPTIONAL on an event (SPEC §7): an event with no reducer is
// a load-time error, because `ingest` is the only place an event becomes client
// state and it has nothing to fold without one — there is no second apply path
// (AGENTS.md, one reconciliation path).

// `action(type)` — declare an imperative request type. The handler that turns it
// into events is attached later by the entity/dispatch wiring.
export function action(type) {
  return Object.freeze({ brand: 'action', type });
}

// `event(type, reduce)` — declare a past-tense fact and the reducer that folds
// it into state. The reducer is required; omitting it fails closed at load.
export function event(type, reduce) {
  if (typeof reduce !== 'function') {
    throw new Error(
      `event('${type}') has no reducer. An event with no reducer is a ` +
        `load-time error (SPEC §7): ingest is the only place an event becomes ` +
        `state, and it folds the event through this reducer. Declare one: ` +
        `event('${type}', (state, payload) => next).`,
    );
  }
  return Object.freeze({ brand: 'event', type, reduce });
}

// createServer({ handlers, authorize, db }) — the server-side mutation handler
// (SPEC §7). It runs one pipeline for every action: authorize (outside the
// transaction, Fork C — authorize BEFORE dedupe) → dedupe by action id → run the
// handler → assign each emitted event a per-scope monotonic sequence number →
// append to the durable log → fan out.
//
// Persistence is OPT-IN by engaged seam (AGENTS.md): pass a node:sqlite
// DatabaseSync as `db` and events are appended to the `_Log` table with per-scope
// sequences from the `_Cursor` table. Without `db`, the in-memory kernel runs
// (backwards-compatible, for clients that don't need durability). Both paths share
// the same shape — the persistence seam changes WHERE state lands, never HOW.
//
// When `db` is engaged, `dispatch` is ASYNC (authorize may be async; the handler
// runs inside a serialized write transaction). When `db` is absent, `dispatch`
// stays synchronous for backwards compatibility.
//
// `authorize` is REQUIRED and fails closed: there is no default. A default
// `() => true` would admit every action (fail OPEN), the opposite of the route
// gate's default-on requireUser(). Authorization is always an explicit function
// (AGENTS.md: never a magic default); omitting it is a load-time error. When
// Phase 2 wires this kernel to a request path, `authorize` is where the route
// gate + grant engine compose — it is not a second, looser auth path.
export function createServer({ handlers = {}, authorize, db, projections: projectionConsumers = [], postHandlerAuthorize, blobAdopter, postCommitConsumers: postCommitConsumers = [] } = {}) {
  if (typeof authorize !== 'function') {
    throw new Error(
      `createServer requires an authorize function. There is no default — a ` +
        `default-open authorize would admit every action (fail open). ` +
        `Authorization is always an explicit function: pass ` +
        `authorize: ({ type, payload, principal }) => boolean.`,
    );
  }

  // ---- ephemeral path (no db) — synchronous, in-memory ----
  if (!db) {
    const log = [];                 // append-only event log
    const sequences = new Map();    // scope → last assigned sequence number
    const dispatched = new Map();   // action id → the events it produced (dedupe)

    function nextSeq(scope) {
      const seq = (sequences.get(scope) ?? 0) + 1;
      sequences.set(scope, seq);
      return seq;
    }

    function dispatch({ actionId, type, payload, principal }) {
      // Fork C — AUTHORIZE FIRST. A retried action by a since-revoked principal
      // returns denied (403), even if the mutation already committed. This
      // reverses the old kernel which checked dedupe before authorize.
      if (!authorize({ type, payload, principal })) {
        return { granted: false, events: [] };
      }

      // Idempotent dedupe: a re-sent action returns its stored events without
      // re-running the handler — no duplicate state change (SPEC §7).
      if (dispatched.has(actionId)) {
        return { granted: true, deduped: true, events: dispatched.get(actionId) };
      }

      const handler = handlers[type];
      if (typeof handler !== 'function') {
        throw new Error(`no handler registered for action type '${type}'.`);
      }

      // Run the handler, then assign each emitted event a per-scope monotonic
      // sequence number and append to the log.
      const emitted = handler({ payload, principal });
      const events = emitted.map((e) =>
        Object.freeze({ ...e, seq: nextSeq(e.scope), actionId }));
      for (const e of events) log.push(e);

      dispatched.set(actionId, events);
      return { granted: true, deduped: false, events };
    }

    return { dispatch, log };
  }

  // ---- durable path (db engaged) — async, SQLite-backed ----

  // nextSeq reads the persisted Cursor; assigns and upserts the new value.
  function nextSeq(scope) {
    const row = db.prepare(
      'SELECT lastSeq FROM _Cursor WHERE scope = ?',
    ).get(scope);
    const seq = (row?.lastSeq ?? 0) + 1;
    db.prepare(
      'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?',
    ).run(scope, seq, seq);
    return seq;
  }

  // The durable dispatch: authorize (outside txn) → open txn → dedupe by
  // actionId → run handler → assign per-scope seq → append to Log → commit.
  async function dispatch({ actionId, type, payload, principal }) {
    // Fork C — AUTHORIZE FIRST (outside the transaction). A retried action by a
    // since-revoked principal returns denied (403).
    const authResult = await authorize({ type, payload, principal });
    if (!authResult) {
      return { granted: false, events: [] };
    }

    // Dedupe by actionId: check the _Log table for a previous dispatch.
    const existing = db.prepare(
      'SELECT * FROM _Log WHERE actionId = ? ORDER BY scope, seq',
    ).all(actionId);
    if (existing.length > 0) {
      const events = existing.map((row) => Object.freeze({
        type: row.eventType,
        scope: row.scope,
        seq: row.seq,
        actionId: row.actionId,
        committedAt: row.committedAt,
        data: JSON.parse(row.eventData),
      }));
      return { granted: true, deduped: true, events };
    }

    const handler = handlers[type];
    if (typeof handler !== 'function') {
      throw new Error(`no handler registered for action type '${type}'.`);
    }

    // Run the handler — events only, no DB writes (Fork A: entity-as-projection).
    // The handler may be sync or async.
    const emitted = await handler({ payload, principal });

    // Assign per-scope seq and append to the Log inside a write transaction.
    // node:sqlite's DatabaseSync is single-writer; BEGIN/COMMIT serialize writes.
    const now = new Date().toISOString();
    const events = [];

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of emitted) {
        const scope = e.scope;
        const seq = nextSeq(scope);
        db.prepare(
          'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(scope, seq, e.type, JSON.stringify(e.data ?? {}), actionId, now);
        events.push(Object.freeze({ ...e, seq, actionId, committedAt: now }));
      }
      // Projection consumers run inside the txn — entity rows are derived from
      // committed events (Fork A: entity-as-projection). A projection failure
      // rolls back the whole dispatch txn (atomic: log event + projected row).
      for (const consumer of projectionConsumers) {
        for (const ev of events) {
          if (consumer.eventTypes.includes(ev.type)) {
            consumer.apply(ev, db);
          }
        }
      }
      // Blob adopt (in-txn) — atomic with the log append + projection writes
      // (spec #2). A denial below rolls back, leaving the blob 'pending' for the
      // reaper; only a committed dispatch adopts. The kernel never owns blob
      // field knowledge — `blobAdopter.resolve` (wired by the app from entity
      // metadata) returns the blob ids an event references. The post-commit
      // file rename (finalize) runs as a registered post-commit consumer below,
      // not an inline kernel call.
      if (blobAdopter) {
        const blobIds = new Set();
        for (const ev of events) {
          for (const id of blobAdopter.resolve(ev)) blobIds.add(id);
        }
        if (blobIds.size > 0) {
          blobAdopter.adopt(db, [...blobIds]);
        }
      }
      // In-txn post-handler row-grant hook (spec #5). Runs after projections
      // have written the materialized row. The entity name is parsed from the
      // event type (e.g. 'Note.created' → entity 'Note', verb 'update' from
      // 'Note.updated'). If postHandlerAuthorize returns false, the txn rolls
      // back and the dispatch returns denied.
      if (postHandlerAuthorize) {
        // Event-type suffix → row-grant verb. An explicit closed map, NOT
        // `.replace('d','')` (which removed the FIRST 'd' and turned 'updated'
        // into 'upated' — silently denying every update once the hook is wired).
        const VERB_FROM_EVENT = { created: 'create', updated: 'update', removed: 'remove' };
        for (const ev of events) {
          const dotIdx = ev.type.indexOf('.');
          if (dotIdx > 0) {
            const entityName = ev.type.slice(0, dotIdx);
            const suffix = ev.type.slice(dotIdx + 1);
            const verb = VERB_FROM_EVENT[suffix];
            if (!verb) continue;            // unknown event shape → can't authorize → skip
            const granted = await postHandlerAuthorize({
              entityName,
              verb,
              principal,
              eventType: ev.type,
              event: ev,
            });
            if (!granted) {
              throw Object.assign(new Error('forbidden'), { status: 403 });
            }
          }
        }
      }
      db.exec('COMMIT');
      // Post-commit fan-out (eng-review §D3). Consumers run AFTER commit — an
      // out-of-band effect (live WS fan-out, blob file finalize, job enqueue,
      // webhook) cannot join the DB txn, so it runs here: independently durable
      // and retried on its own, never rolling back the origin (AGENTS.md). A
      // consumer error is caught — the commit stands, and a crashed effect is
      // reconciled on its own pass (the reaper for blobs; a retry queue for
      // jobs). This loop retires the special-case post-commit hooks: blob
      // finalize and live fan-out are both registered consumers, not inline
      // kernel calls.
      for (const consumer of postCommitConsumers) {
        try {
          await consumer(events, { db, actionId });
        } catch {
          // a post-commit fan-out failure never undoes the committed dispatch
        }
      }
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      // A 403 from the post-handler row-grant hook is a deliberate denial
      // (spec #5) — return denied gracefully rather than throwing.
      if (err.status === 403) {
        return { granted: false, events: [] };
      }
      throw err;
    }

    return { granted: true, deduped: false, events };
  }

  return { dispatch, db, log: [] };  // log is the durable _Log table; empty array for compat
}

// createClient({ events }) — the client-side reconciliation path (SPEC §7 stage
// 7, §7.1). `ingest` is the ONLY place an event becomes client state: it folds
// each event through its declared reducer exactly once and advances a per-scope
// sequence cursor. The same ingest handles the client's own echoed events and
// foreign live events — there is no second apply path (AGENTS.md, one
// reconciliation path).
//
// Replay, per incoming event's seq vs expected (cursor + 1):
//  - duplicate (seq < expected) — idempotent skip; no fold, cursor unchanged.
//  - gap       (seq > expected) — do NOT apply; signal a resync.
//  - next      (seq == expected) — reduce once, advance the cursor.
export function createClient({ events = [] } = {}) {
  // Reducer registry, keyed by event type. An event type with no reducer here
  // has nothing to fold — ingesting it is an error, not a silent drop.
  const reducers = new Map(events.map((e) => [e.type, e.reduce]));

  const states = new Map();   // scope → folded state
  const cursors = new Map();  // scope → last applied sequence number

  const cursor = (scope) => cursors.get(scope) ?? 0;
  const state = (scope) => states.get(scope);

  // Bootstrap: adopt a snapshot and set the cursor to the snapshot's sequence
  // BEFORE any live event is ingested. Ordering is load-bearing — a live event
  // ingested before the snapshot would resync into an empty state and then be
  // overwritten, losing the event (SPEC §7.1).
  function bootstrap(scope, snapshot, seq) {
    states.set(scope, snapshot);
    cursors.set(scope, seq);
  }

  function ingest(incoming) {
    const { type, scope, seq } = incoming;
    const reduce = reducers.get(type);
    if (typeof reduce !== 'function') {
      throw new Error(
        `no reducer for event type '${type}'. The client can only ingest event ` +
          `types it was created with. Declare event('${type}', reduce) and pass ` +
          `it in createClient({ events }).`,
      );
    }

    const expected = cursor(scope) + 1;
    if (seq < expected) {
      // duplicate — idempotent skip (a later live redelivery of an own event).
      return { applied: false, duplicate: true };
    }
    if (seq > expected) {
      // gap — a missing event sits between; do not apply, signal resync.
      return { applied: false, resync: true };
    }

    // next — fold exactly once and advance the cursor.
    states.set(scope, reduce(state(scope) ?? {}, incoming));
    cursors.set(scope, seq);
    return { applied: true };
  }

  return { ingest, bootstrap, state, cursor };
}
