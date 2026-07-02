// Live fan-out core — subscription registry, delivery-time re-authorization,
// pace buffers, and delivery-layer delta shadows. The WebSocket transport and
// subscribe-time admission stay in live.mjs; this module owns what happens after
// a subscription has been admitted and after a committed event is ready to fan out.

import { anonymous } from './principal.mjs';
import { mayRow } from './row-grant.mjs';
import { PACE_STRATEGIES } from './field-pace.mjs';
import { computeDelta } from './field-delta.mjs';
import { EventKind, parseEventType } from './event-handle.mjs';

const PREV_STATE_MAX = 10_000;

export function createLiveFanout({ mayVerb = null } = {}) {
  // Subscription registry: Map<entity, Map<id, Map<conn, SubSpec>>>
  // SubSpec = { fields: object|null, latch: true, pace: object|null }
  const byEntity = new Map();

  // Per-connection subscription keys (`${entity}:${id}`) mirror byEntity so a
  // disconnect can purge in O(subs) without scanning every entity.
  const connSubs = new Map();

  // Coalescing buffers for paced subscribers: Map<bufferKey, {conn, scope, field, events:Array, timer:Timeout|null}>
  // key = `${conn.id}|${scope}|${field}` — scope = `${entity}:${id}`, field = ephemeral field name.
  // SEPARATE from SubSpec (DECISIONLOG #69 F2: folding a draining timer into the registry value
  // re-creates a two-lifetime smell).
  const paceBuffers = new Map();

  // P6e-2: delivery-layer prev-shadow for `.updated` delta computation
  // (DECISIONLOG #71 F1). Per-scope (`${entity}:${id}`), NOT per-conn — committed
  // state shared across subs. Seeded on created/updated, evicted on remove +
  // clear. NOT purged on disconnect (other subs may share the scope).
  const prevState = new Map();

  function prevGet(scope) { return prevState.get(scope) ?? {}; }
  function prevSeed(scope, row) {
    prevState.set(scope, row);
    if (prevState.size > PREV_STATE_MAX) {
      const oldest = prevState.keys().next().value;
      prevState.delete(oldest);
    }
  }
  function prevEvict(scope) { prevState.delete(scope); }

  function subscriptionCount(conn) {
    return connSubs.get(conn)?.size ?? 0;
  }

  function hasSubscription(conn, entity, id) {
    return connSubs.get(conn)?.has(`${entity}:${id}`) ?? false;
  }

  function addSubscription(entity, id, conn, fields = null, pace = null) {
    if (!byEntity.has(entity)) byEntity.set(entity, new Map());
    const byId = byEntity.get(entity);
    if (!byId.has(id)) byId.set(id, new Map());
    byId.get(id).set(conn, { fields, latch: true, pace });
    let mine = connSubs.get(conn);
    if (!mine) { mine = new Set(); connSubs.set(conn, mine); }
    mine.add(`${entity}:${id}`);
  }

  function removeSubscription(entity, id, conn) {
    const byId = byEntity.get(entity);
    if (byId) {
      const subs = byId.get(id);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) byId.delete(id);
        if (byId.size === 0) byEntity.delete(entity);
      }
    }
    const mine = connSubs.get(conn);
    if (mine) {
      mine.delete(`${entity}:${id}`);
      if (mine.size === 0) connSubs.delete(conn);
    }
  }

  function removeAll(conn) {
    const mine = connSubs.get(conn);
    if (!mine) return;
    for (const key of mine) {
      const sep = key.indexOf(':');
      const entity = key.slice(0, sep);
      const id = key.slice(sep + 1);
      const byId = byEntity.get(entity);
      if (!byId) continue;
      const subs = byId.get(id);
      if (!subs) continue;
      subs.delete(conn);
      if (subs.size === 0) byId.delete(id);
      if (byId.size === 0) byEntity.delete(entity);
    }
    connSubs.delete(conn);

    // Purge all pacing buffers for this connection (conn.id is part of buffer key).
    for (const [bufKey, entry] of paceBuffers) {
      if (entry.conn === conn) {
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
        paceBuffers.delete(bufKey);
      }
    }
  }

  // Flush one paced buffer: re-auth, coalesce, send ONE envelope, then clear.
  // Called from setTimeout. Async with internal error handling (never rejects the
  // timer callback's returned promise).
  async function flushPacedBuffer(key) {
    const entry = paceBuffers.get(key);
    if (!entry) return;
    const { conn, scope, events, entityRecord, authzRow } = entry;
    // Clear FIRST — re-entrant safety.
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    paceBuffers.delete(key);
    if (events.length === 0) return;
    if (conn.closed) return;

    // Re-auth (fail-closed): mayRow owns the hasOwnCanGrant skip + the
    // try/catch fail-closed; a thrown check or !allowed drops the buffer.
    if (!(await mayRow(entityRecord, 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb))) return;

    // Coalesce using the ephemeral kind's logic.
    const kind = PACE_STRATEGIES.ephemeral;
    const coalescer = entry.by ? kind.coalescers[entry.by] : null;
    const coalesced = coalescer ? events.reduce(coalescer) : events[events.length - 1];
    const span = kind.reduceSpan(events);
    const [entityName, idStr] = scope.split(':');
    conn.send({
      type: 'event', entity: entityName, id: idStr,
      seq: span.seq, seqSpan: span.seqSpan, event: coalesced,
    });
  }

  // Fan-out: forward a committed kernel event to every authorized subscriber of
  // (entity, id). `entity` is the compiled entity RECORD — mayVerb needs it to
  // run the grant's `.can` body. For 'created'/'updated', the row is re-read +
  // HYDRATED here (a raw SELECT row lacks the assembled struct namespace that
  // `.can` bodies read, e.g. `entity.linkShare.tier`); hydration via findById
  // also re-reads the post-commit materialized state. For 'removed', the row is
  // gone (the consumer passes `undefined`) — re-authorization is SKIPPED and the
  // remove event forwards to every current subscriber (it IS the revocation
  // signal). `committedEvent` is the kernel's event — its `seq` is the per-scope
  // monotonic seq from `_Cursor`, and `data` is the mutation payload.
  async function emit(entityRecord, id, row, committedEvent) {
    const name = entityRecord?.name;
    if (!name) return;                       // unknown entity -> can't authorize -> fail closed
    let committed = committedEvent;
    if (committed.handle?.brand !== 'event-handle') {
      try {
        committed = { ...committedEvent };
        Object.defineProperty(committed, 'handle', { value: parseEventType(committedEvent.type), enumerable: false });
        Object.freeze(committed);
      } catch { return; }
    }
    const handle = committed.handle;
    if (handle.entity !== name) return;
    const byId = byEntity.get(name);
    if (!byId) return;
    const subs = byId.get(String(id));
    if (!subs) return;

    const removed = row === undefined;       // removed -> row gone post-commit
    // Hydrate so .can bodies reading entity.<struct>.* resolve. Falls back to
    // the raw row when hydration is unavailable (unchanged behavior for simple
    // entities whose .can body reads only `is.*`).
    let authzRow = row;
    if (!removed && entityRecord.findById) {
      try { authzRow = entityRecord.findById(String(id), null) ?? row; } catch { authzRow = row; }
    }

    // Determine if this is an ephemeral field event that requires opt-in.
    let ephemeralField = null;
    if (!removed && handle.kind === EventKind.fieldSet) {
      const fd = entityRecord.fields?.[handle.field];
      if (fd?.kind === 'ephemeral') {
        ephemeralField = handle.field;
      }
    }

    // P6e-2: compute per-field delta for `.updated` events (DECISIONLOG #71 F1).
    // Delta is per-(scope, event) — same for all subs, computed once. Computed from
    // the hydrated authzRow (committed state) vs the prior committed shadow.
    const scope = `${name}:${String(id)}`;
    let delta = undefined;
    if (removed) {
      prevEvict(scope);
    } else if (handle.kind === EventKind.updated) {
      const prev = prevGet(scope);
      const changed = Object.keys(committed.data ?? {}).filter((k) => k !== 'id');
      delta = computeDelta(entityRecord, prev, authzRow, changed);
      prevSeed(scope, authzRow);
    } else if (handle.kind === EventKind.created) {
      prevSeed(scope, authzRow);
    } else if (handle.kind === EventKind.native) {
      // P6e-2 B2: store/ordered native events are delta-native — their event.data
      // IS the structural delta. Normalize under the same `delta` map key.
      delta = { [handle.field]: committed.data };
    }

    for (const [conn, subSpec] of subs) {
      if (conn.closed) {
        subs.delete(conn);
        continue;
      }
      if (!removed && !(await mayRow(entityRecord, 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb))) {
        // mayRow owns the hasOwnCanGrant skip + try/catch fail-closed. Removed
        // events skip re-auth intentionally: the remove IS the revocation signal,
        // forwarded to every current subscriber before the row is gone.
        continue;
      }
      // Interest filter for ephemeral events: deliver ONLY if the subscriber's
      // SubSpec.fields includes the ephemeral field. Pass-through events
      // (created/updated/removed/collection) and removed events are delivered
      // to ALL subscribers.
      if (ephemeralField !== null) {
        const interest = subSpec?.fields;
        if (!interest || interest[ephemeralField] !== true) continue;
      }

      // Determine effective pace for this subscriber + field.
      // Only ephemeral field events may be paced; pass-through/removed events
      // and subscribers without pace always use window=0.
      let pace = { window: 0, by: null };
      if (ephemeralField !== null && subSpec?.pace !== null && subSpec?.pace !== undefined) {
        pace = subSpec.pace;
      }

      // ONE paced emit path: window=0 = pass-through (flush-on-receive, inline);
      // window>0 = enqueue + timer (coalesced on flush).
      if (pace.window === 0) {
        const envelope = {
          type: 'event', entity: name, id, seq: committed.seq,
          seqSpan: [committed.seq, committed.seq],
          event: committed,
        };
        if (delta !== undefined) envelope.delta = delta;
        conn.send(envelope);
      } else {
        // Paced: enqueue into per-(conn, scope, field) buffer.
        const bufKey = `${conn.id}|${scope}|${ephemeralField}`;
        let entry = paceBuffers.get(bufKey);
        if (!entry) {
          entry = {
            conn,
            scope,
            field: ephemeralField,
            events: [],
            timer: null,
            by: pace.by,
            entityRecord,
            authzRow,
          };
          paceBuffers.set(bufKey, entry);
        }
        entry.events.push(committed);
        // Refresh authzRow with latest re-read so flush-time re-auth is current.
        entry.authzRow = authzRow;
        if (entry.timer === null) {
          entry.timer = setTimeout(() => flushPacedBuffer(bufKey), pace.window);
        }
      }
    }
  }

  function close() {
    byEntity.clear();
    connSubs.clear();
    for (const [, entry] of paceBuffers) {
      if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
    }
    paceBuffers.clear();
    prevState.clear();
  }

  return {
    addSubscription,
    removeSubscription,
    removeAll,
    subscriptionCount,
    hasSubscription,
    emit,
    close,
  };
}
