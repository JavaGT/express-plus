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

// createServer({ handlers, authorize }) — the server-side mutation handler
// (SPEC §7). It runs one pipeline for every action: authorize (outside the
// transaction) → dedupe by action id → run the handler → assign each emitted
// event a per-scope monotonic sequence number → append to the durable log → fan
// out. This is the in-memory kernel; persistence (node:sqlite) is the engaged
// seam added later WITHOUT changing this shape (persistence opt-in by engaged
// seam, AGENTS.md). The log is the single durable record — one reconciliation
// path, no second apply path.
//
// `authorize` is REQUIRED and fails closed: there is no default. A default
// `() => true` would admit every action (fail OPEN), the opposite of the route
// gate's default-on requireUser(). Authorization is always an explicit function
// (AGENTS.md: never a magic default); omitting it is a load-time error. When
// Phase 2 wires this kernel to a request path, `authorize` is where the route
// gate + grant engine compose — it is not a second, looser auth path.
export function createServer({ handlers = {}, authorize } = {}) {
  if (typeof authorize !== 'function') {
    throw new Error(
      `createServer requires an authorize function. There is no default — a ` +
        `default-open authorize would admit every action (fail open). ` +
        `Authorization is always an explicit function: pass ` +
        `authorize: ({ type, payload, principal }) => boolean.`,
    );
  }
  const log = [];                 // the durable, append-only event log
  const sequences = new Map();    // scope → last assigned sequence number
  const dispatched = new Map();   // action id → the events it produced (dedupe)

  function nextSeq(scope) {
    const seq = (sequences.get(scope) ?? 0) + 1;
    sequences.set(scope, seq);
    return seq;
  }

  function dispatch({ actionId, type, payload, principal }) {
    // Idempotent dedupe: a re-sent action returns its stored events without
    // re-running the handler — no duplicate state change (SPEC §7).
    if (dispatched.has(actionId)) {
      return { granted: true, deduped: true, events: dispatched.get(actionId) };
    }

    // Authorize BEFORE the log is touched (outside the transaction). A denied
    // action appends nothing.
    if (!authorize({ type, payload, principal })) {
      return { granted: false, events: [] };
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
