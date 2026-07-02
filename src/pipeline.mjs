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

// Lazy import of effect compiler (avoids circular dependency at module load time).
import { readSeq } from './cursor.mjs';
import { lifecycleVerb, parseEventType } from './event-handle.mjs';

// Use createRequire for dynamic import in ES module context.
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
let _effectModule = null;
function _getEffectModule() {
  if (!_effectModule) {
    _effectModule = _require('./effect-compiler.mjs');
  }
  return _effectModule;
}

// `action(type)` — declare an imperative request type. The handler that turns it
// into events is attached later by the entity/dispatch wiring.
export function action(type) {
  return Object.freeze({ brand: 'action', type });
}

// `event(type, reduce)` — declare a past-tense fact and the reducer that folds
// it into state. The reducer is required; omitting it fails closed at load.
export function event(type, reduce) {
  const handle = type?.brand === 'event-handle' ? type : undefined;
  const eventType = handle ? handle.type : type;
  if (typeof reduce !== 'function') {
    throw new Error(
      `event('${eventType}') has no reducer. An event with no reducer is a ` +
        `load-time error (SPEC §7): ingest is the only place an event becomes ` +
        `state, and it folds the event through this reducer. Declare one: ` +
        `event('${eventType}', (state, payload) => next).`,
    );
  }
  return Object.freeze({ brand: 'event', handle, type: eventType, reduce });
}

// ---- Shared in-txn event application core ----
//
// This is the core that BOTH the outer dispatch and the effect runtime use.
// It appends events to _Log (with per-scope seq), runs projection consumers,
// blob adopter (if any), and post-handler authorize — all inside the caller's
// open transaction. Effects JOIN the outer txn; they do NOT re-BEGIN.
//
// This is the "singular system" implementation (AGENTS.md): one event-application
// path, called by both the outer dispatch and in-txn effects (ADR #6, #22).

function eventWithHandle(event, handle) {
  const out = { ...event };
  Object.defineProperty(out, 'handle', { value: handle, enumerable: false });
  return Object.freeze(out);
}

function eventWithParsedHandle(event) {
  if (event?.handle?.brand === 'event-handle') return eventWithHandle(event, event.handle);
  try {
    return eventWithHandle(event, parseEventType(event.type));
  } catch {
    return event;
  }
}

export const NOW = Symbol('workbench.now');

// Deep-walk an event's `data`, replacing every NOW token with the commit-time
// `now` ISO string. Returns a fresh structure (does not mutate the handler's
// emitted object — which may be frozen). Only recurses into PLAIN objects and
// arrays — a Date, Buffer, or class instance passes through untouched (a Date's
// ISO form comes from its toJSON at serialization; flattening it to {} would
// lose the value).
function isPlainObject(v) {
  if (!v || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function resolveNowTokens(value, now) {
  if (value === NOW) return now;
  if (Array.isArray(value)) return value.map((v) => resolveNowTokens(v, now));
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveNowTokens(value[k], now);
    return out;
  }
  return value;
}

export function noAdmission() {
  return Object.freeze({
    beforeProjection: async () => true,
    afterProjection: async () => true,
  });
}

export function noBlobAdapter() {
  return Object.freeze({
    adoptInTxn: async () => {},
  });
}

function requireAdmission(granted) {
  if (!granted) throw Object.assign(new Error('forbidden'), { status: 403 });
}

function effectEventsFor(registry) {
  if (!registry) return null;
  return (event, { now, actionId, depth, maxEffectDepth, db }) => {
    const { executeEffectsForEvent } = _getEffectModule();
    return executeEffectsForEvent(event, registry, { now, actionId, depth, maxDepth: maxEffectDepth, db });
  };
}

export function durableMutationVariant({
  projectionConsumers = [],
  admission = noAdmission(),
  blobAdapter = noBlobAdapter(),
  effectsRegistry = null,
  postCommitConsumers = [],
} = {}) {
  const effectsExecutor = effectEventsFor(effectsRegistry);
  const variant = {
    name: 'durable.mutation',
    async applyInTxn(db, events, {
      now,
      actionId,
      nextSeq,
      principal,
      depth = 0,
      maxEffectDepth = 8,
      payload,
    } = {}) {
      const finalizedEvents = [];

      // Pre-projection admission — runs IN-TXN against the PRE-mutation row,
      // before the _Log append and before projection. Denial leaves zero
      // footprint. This shallow module interface keeps scheduler admission on
      // the durable variant instead of exporting low-level append/authorize
      // primitives across the seam.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
        const verb = lifecycleVerb(withHandle.handle);
        if (!verb) continue;
        requireAdmission(await admission.beforeProjection({
          entityName: withHandle.handle.entity,
          verb,
          principal,
          eventType: withHandle.type,
          event: withHandle,
          db,
          now,
          payload,
        }));
      }

      // Append events to _Log with per-scope sequence numbers. NOW tokens in the
      // event data are resolved to the commit-time ISO here (ADR #24) — before
      // serialization, so the token never reaches _Log.
      for (const e of events) {
        const withHandle = eventWithParsedHandle(e);
        const scope = withHandle.scope;
        const seq = nextSeq(scope);
        const data = resolveNowTokens(withHandle.data ?? {}, now);
        db.prepare(
          'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(scope, seq, withHandle.type, JSON.stringify(data), actionId, now);
        finalizedEvents.push(eventWithHandle({ ...withHandle, data, seq, actionId, committedAt: now }, withHandle.handle));
      }

      // Projection consumers — materialize entity rows from events.
      for (const consumer of projectionConsumers) {
        for (const ev of finalizedEvents) {
          if (consumer.eventTypes.includes(ev.type)) {
            consumer.apply(ev, db);
          }
        }
      }

      // Blob adoption is in-txn and atomic with the log + projection writes.
      await blobAdapter.adoptInTxn(db, finalizedEvents);

      // Post-projection admission — runs IN-TXN after projection. Create
      // row-grants need this deep visibility: the row exists only after the
      // projection consumer has materialized it.
      for (const ev of finalizedEvents) {
        const verb = lifecycleVerb(ev.handle);
        if (!verb) continue;
        requireAdmission(await admission.afterProjection({
          entityName: ev.handle.entity,
          verb,
          principal,
          eventType: ev.type,
          event: ev,
          db,
          now,
          payload,
        }));
      }

      // Effects recurse through this SAME named variant. The implementation is
      // local to the variant so dispatch and batch get identical depth behavior
      // and leverage one pipeline interface rather than an options lattice.
      if (effectsExecutor && depth < maxEffectDepth) {
        for (const ev of finalizedEvents) {
          const effectEvents = effectsExecutor(ev, { now, actionId, depth: depth + 1, maxEffectDepth, db });
          if (effectEvents && effectEvents.length > 0) {
            const effectPrincipal = effectEvents[0]?._effectPrincipal ?? principal;
            await variant.applyInTxn(db, effectEvents, {
              now,
              actionId,
              nextSeq,
              principal: effectPrincipal,
              depth: depth + 1,
              maxEffectDepth,
              payload,
            });
          }
        }
      }

      return finalizedEvents;
    },
    async afterCommit(events, context) {
      for (const consumer of postCommitConsumers) {
        try {
          await consumer(events, context);
        } catch {
          // a post-commit fan-out failure never undoes the committed dispatch
        }
      }
    },
  };
  return Object.freeze(variant);
}

// createServer({ handlers, authorize, db, effects }) — the server-side mutation handler
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
// Effects fire in-txn on committed CRUD events, re-entering through the SAME
// durable variant interface (ADR #6, #22). A target grant DENY rolls back the
// origin (in-txn atomic). Depth cap prevents runaway chains.
//
// `authorize` is REQUIRED and fails closed: there is no default. A default
// `() => true` would admit every action (fail OPEN), the opposite of the route
// rowToEvent — rebuild an event object from a durable `_Log` row. Used by the
// dedupe path: a re-sent actionId returns its previously-committed events
// without re-running the handler. Shared by `dispatch` and `dispatchBatch` so
// the row→event shape has ONE definition (a second copy would be the exact seam
// where the two paths drift — AGENTS.md → singular system).
function rowToEvent(row) {
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
    data: JSON.parse(row.eventData),
  };
  return handle ? eventWithHandle(event, handle) : Object.freeze(event);
}

// commitEvents — the durable transaction brace shared by `dispatch` and
// `dispatchBatch`: BEGIN IMMEDIATE → durable variant applyInTxn → COMMIT →
// post-commit fan-out, with ROLLBACK on error and a graceful 403. A denial from
// the admission seam is deliberate and returned as `{granted:false}`, not thrown.
// The `payload` argument is the admission context each caller threads through:
// `dispatch` passes its single action's `payload`, `dispatchBatch` passes the
// `actions` array. The two genuinely differ there, so the brace is extracted but
// the `payload` value stays per-caller. Throws non-403 errors after rolling back;
// returns `{events}` on success or `{granted:false, events:[]}` on a 403 in-txn.
async function commitEvents(db, events, { now, actionId, nextSeq, principal, payload, pipeline }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const committed = await pipeline.applyInTxn(db, events, {
      now, actionId, nextSeq, principal, payload,
    });
    db.exec('COMMIT');
    // Post-commit fan-out (eng-review §D3). Consumers run AFTER commit — an
    // out-of-band effect (live WS fan-out, blob file finalize, job enqueue,
    // webhook) cannot join the DB txn, so the named variant owns it here:
    // independently durable and retried on its own, never rolling back origin.
    await pipeline.afterCommit(committed, { db, actionId });
    return { granted: true, events: committed };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    // A 403 from the in-txn admission seam is a deliberate denial (spec #5) —
    // return denied gracefully rather than throwing.
    if (err.status === 403) {
      return { granted: false, events: [] };
    }
    throw err;
  }
}

// gate's default-on requireUser(). Authorization is always an explicit function
// (AGENTS.md: never a magic default); omitting it is a load-time error. When
// Phase 2 wires this kernel to a request path, `authorize` is where the route
// gate + grant engine compose — it is not a second, looser auth path.
export function createServer({ handlers = {}, authorize, db, pipeline = durableMutationVariant() } = {}) {
  if (typeof authorize !== 'function') {
    throw new Error(
      `createServer requires an authorize function. There is no default — a ` +
        `default-open authorize would admit every action (fail open). ` +
        `Authorization is always an explicit function: pass ` +
        `authorize: ({ type, payload, principal }) => boolean.`,
    );
  }
  if (db && pipeline?.name !== 'durable.mutation') {
    throw new Error(`durable createServer requires the 'durable.mutation' pipeline variant.`);
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

    function dispatchBatch({ actionId, actions = [], principal }) {
      if (actions.length === 0) return { granted: true, deduped: false, events: [] };
      for (const a of actions) {
        if (!authorize({ type: a.type, payload: a.payload, principal })) {
          return { granted: false, events: [] };
        }
      }
      if (dispatched.has(actionId)) {
        return { granted: true, deduped: true, events: dispatched.get(actionId) };
      }
      const allEmitted = [];
      for (const a of actions) {
        const handler = handlers[a.type];
        if (typeof handler !== 'function') {
          throw new Error(`no handler registered for action type '${a.type}'.`);
        }
        allEmitted.push(...handler({ payload: a.payload, principal }));
      }
      const events = allEmitted.map((e) =>
        Object.freeze({ ...e, seq: nextSeq(e.scope), actionId }));
      for (const e of events) log.push(e);
      dispatched.set(actionId, events);
      return { granted: true, deduped: false, events };
    }

    return { dispatch, dispatchBatch, log };
  }

  // ---- durable path (db engaged) — async, SQLite-backed ----

  function nextSeq(scope) {
    const seq = readSeq(db, scope) + 1;
    db.prepare(
      'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?',
    ).run(scope, seq, seq);
    return seq;
  }

  // The durable dispatch: authorize (outside txn) → dedupe by actionId →
  // run handler → commit events inside a write transaction.
  async function dispatch({ actionId, type, payload, principal }) {
    // Fork C — AUTHORIZE FIRST (outside the transaction). A retried action by a
    // since-revoked principal returns denied (403).
    const authResult = await authorize({ type, payload, principal });
    if (!authResult) {
      return { granted: false, events: [] };
    }

    // Dedupe by actionId: a re-sent action returns its committed events without
    // re-running the handler (SPEC §7).
    const existing = db.prepare(
      'SELECT * FROM _Log WHERE actionId = ? ORDER BY scope, seq',
    ).all(actionId);
    if (existing.length > 0) {
      return { granted: true, deduped: true, events: existing.map(rowToEvent) };
    }

    const handler = handlers[type];
    if (typeof handler !== 'function') {
      throw new Error(`no handler registered for action type '${type}'.`);
    }

    // Run the handler — events only, no DB writes (Fork A: entity-as-projection).
    // The handler may be sync or async.
    const emitted = await handler({ payload, principal });

    // Apply events inside a write transaction using the shared brace.
    // node:sqlite's DatabaseSync is single-writer; BEGIN/COMMIT serialize writes.
    const now = new Date().toISOString();
    const committed = await commitEvents(db, emitted, {
      now, actionId, nextSeq, principal, payload, pipeline,
    });
    if (!committed.granted) return committed;
    return { granted: true, deduped: false, events: committed.events };
  }

  // dispatchBatch({ actionId, actions, principal }) — the batched mutation
  // (SPEC §11, ADR #13). N actions across one or more entities run in ONE
  // transaction = ONE composed commit (one actionId, one `now`). The batch is
  // all-or-nothing: any authorize/handler/post-grant denial rolls back the
  // ENTIRE batch (a half-applied multi-entity mutation is exactly the split the
  // one-transaction guarantee forbids). This is the singular-system extension
  // of `dispatch`: the same authorize→handler→durable variant path, looped over
  // N actions but with ONE BEGIN/COMMIT bracketing the concatenated events — not
  // a second pipeline (AGENTS.md). Effects fire in-txn exactly as in `dispatch`.
  async function dispatchBatch({ actionId, actions = [], principal }) {
    if (actions.length === 0) {
      return { granted: true, deduped: false, events: [] };
    }

    // Authorize EVERY action FIRST (outside the txn). Fail fast before any
    // write: a denied sub-action never opens the transaction, so a revoked
    // principal cannot poison a partial batch.
    for (const a of actions) {
      const authResult = await authorize({ type: a.type, payload: a.payload, principal });
      if (!authResult) return { granted: false, events: [] };
    }

    // Dedupe the whole batch by its single actionId.
    const existing = db.prepare(
      'SELECT * FROM _Log WHERE actionId = ? ORDER BY scope, seq',
    ).all(actionId);
    if (existing.length > 0) {
      return { granted: true, deduped: true, events: existing.map(rowToEvent) };
    }

    // Run every handler, concatenating their emitted events. Handlers are pure
    // (events only, no DB writes — Fork A), so the batch runs them in order and
    // folds all events into one commitEvents pass below.
    const allEmitted = [];
    for (const a of actions) {
      const handler = handlers[a.type];
      if (typeof handler !== 'function') {
        throw new Error(`no handler registered for action type '${a.type}'.`);
      }
      const emitted = await handler({ payload: a.payload, principal });
      allEmitted.push(...emitted);
    }

    const now = new Date().toISOString();
    const committed = await commitEvents(db, allEmitted, {
      now, actionId, nextSeq, principal, payload: actions, pipeline,
    });
    if (!committed.granted) return committed;
    return { granted: true, deduped: false, events: committed.events };
  }

  return { dispatch, dispatchBatch, db, log: [] };  // log is the durable _Log table; empty array for compat
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
