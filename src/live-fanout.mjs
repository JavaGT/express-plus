// Live fan-out core — scope-keyed subscription registry, delivery-time
// re-authorization, pace buffers, and event delivery.
//
// W5 slice 2: registry is keyed by scope string (e.g. "Entity:id" for
// per-entity, "project:p1" for coarse). The old entity→id→conn map
// is retired — per-entity is a degenerate scope, not a separate path.

import { anonymous } from './principal.mjs';
import { mayRow } from './row-grant.mjs';
import { PACE_STRATEGIES } from './field-pace.mjs';
import { createDeltaProjector } from './field-delta.mjs';
import { EventKind, parseEventType } from './event-handle.mjs';

export function createLiveFanout({ mayVerb = null } = {}) {
  const byScope = new Map();   // Map<scope, Map<conn, SubSpec>>
  const connSubs = new Map();  // Map<conn, Set<scope>>
  const paceBuffers = new Map();

  const deltaProjector = createDeltaProjector();

  function subscriptionCount(conn) {
    return connSubs.get(conn)?.size ?? 0;
  }

  // hasSubscription(conn, scopeOrEntity, id?) — two-arg form checks by scope
  // string; three-arg form derives scope from `${entity}:${id}` for backward
  // compatibility with callers that don't yet have a scope string.
  function hasSubscription(conn, scopeOrEntity, id) {
    if (arguments.length >= 3) {
      return connSubs.get(conn)?.has(`${scopeOrEntity}:${id}`) ?? false;
    }
    return connSubs.get(conn)?.has(scopeOrEntity) ?? false;
  }

  function addSubscription(a, b, c, d, e) {
    if (arguments.length >= 3 && typeof a === 'string' && (!a.includes(':') || (typeof b === 'string' && typeof c === 'object' && c !== null && c.id !== undefined))) {
      // Legacy: addSubscription(entity, id, conn, fields?, pace?)
      // Heuristic: first arg is entity (no ':'), OR there are >=4 args with
      // the third being a conn (object with .id) — use legacy path.
      // But actually, conn is always an object so this is unreliable. Use:
      // first arg has no ':' → legacy. First arg has ':' → scope-keyed.
    }
    if (typeof a === 'string' && a.includes(':')) {
      return addSubscriptionScope(a, b, c, d, e);
    }
    return addSubscriptionLegacy(a, b, c, d, e);
  }

  function addSubscriptionScope(scope, conn, fields = null, pace = null, interest = {}) {
    if (!byScope.has(scope)) byScope.set(scope, new Map());
    byScope.get(scope).set(conn, { fields, latch: true, pace, interest });
    let mine = connSubs.get(conn);
    if (!mine) { mine = new Set(); connSubs.set(conn, mine); }
    mine.add(scope);
  }

  function addSubscriptionLegacy(entity, id, conn, fields = null, pace = null) {
    const scope = `${entity}:${id}`;
    addSubscriptionScope(scope, conn, fields, pace, { entity, id });
  }

  function removeSubscription(a, b, c) {
    if (typeof a === 'string' && a.includes(':')) {
      return removeSubscriptionScope(a, b);
    }
    return removeSubscriptionLegacy(a, b, c);
  }

  function removeSubscriptionScope(scope, conn) {
    const subs = byScope.get(scope);
    if (subs) {
      subs.delete(conn);
      if (subs.size === 0) byScope.delete(scope);
    }
    const mine = connSubs.get(conn);
    if (mine) {
      mine.delete(scope);
      if (mine.size === 0) connSubs.delete(conn);
    }
  }

  function removeSubscriptionLegacy(entity, id, conn) {
    removeSubscriptionScope(`${entity}:${id}`, conn);
  }

  function removeAll(conn) {
    const mine = connSubs.get(conn);
    if (!mine) return;
    for (const scope of mine) {
      const subs = byScope.get(scope);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) byScope.delete(scope);
      }
    }
    connSubs.delete(conn);

    for (const [bufKey, entry] of paceBuffers) {
      if (entry.conn === conn) {
        if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
        paceBuffers.delete(bufKey);
      }
    }
  }

  async function flushPacedBuffer(key) {
    const entry = paceBuffers.get(key);
    if (!entry) return;
    const { conn, scope, events, entityRecord, authzRow } = entry;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    paceBuffers.delete(key);
    if (events.length === 0) return;
    if (conn.closed) return;

    if (!(await mayRow(entityRecord, 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb))) return;

    const kind = PACE_STRATEGIES.ephemeral;
    const coalescer = entry.by ? kind.coalescers[entry.by] : null;
    const coalesced = coalescer ? events.reduce(coalescer) : events[events.length - 1];
    const span = kind.reduceSpan(events);
    const colon = scope.indexOf(':');
    const entityName = colon > 0 ? scope.slice(0, colon) : scope;
    const idStr = colon > 0 ? scope.slice(colon + 1) : scope;
    conn.send({
      type: 'event', entity: entityName, id: idStr,
      seq: span.seq, seqSpan: span.seqSpan, event: coalesced,
    });
  }

  // Fan-out: forward a committed kernel event to authorized subscribers
  // of the event's scope. One registry, one fan-out path.
  async function emit(entityRecord, id, row, committedEvent, { hydrated = false } = {}) {
    const name = entityRecord?.name;
    if (!name) return;
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

    const eventScope = committedEvent.scope ?? `${name}:${String(id)}`;
    const removed = row === undefined;

    let authzRow = row;
    if (!removed && !hydrated && entityRecord.findById) {
      try { authzRow = entityRecord.findById(String(id), null) ?? row; } catch { authzRow = row; }
    }

    let ephemeralField = null;
    if (!removed && handle.kind === EventKind.fieldSet) {
      const fd = entityRecord.fields?.[handle.field];
      if (fd?.kind === 'ephemeral') {
        ephemeralField = handle.field;
      }
    }

    const delta = deltaProjector.project(entityRecord, id, authzRow, committed);

    const scopeSubs = byScope.get(eventScope);
    if (!scopeSubs) return;

    for (const [conn, subSpec] of scopeSubs) {
      if (conn.closed) {
        scopeSubs.delete(conn);
        continue;
      }
      if (!removed && !(await mayRow(entityRecord, 'subscribe', authzRow, conn.principal ?? anonymous, mayVerb))) {
        continue;
      }
      if (ephemeralField !== null) {
        const fields = subSpec?.fields;
        if (!fields || fields[ephemeralField] !== true) continue;
      }

      let pace = { window: 0, by: null };
      if (ephemeralField !== null && subSpec?.pace !== null && subSpec?.pace !== undefined) {
        pace = subSpec.pace;
      }

      if (pace.window === 0) {
        const envelope = {
          type: 'event', entity: name, id, seq: committed.seq,
          seqSpan: [committed.seq, committed.seq],
          event: committed,
        };
        if (delta !== undefined) envelope.delta = delta;
        conn.send(envelope);
      } else {
        const bufKey = `${conn.id}|${eventScope}|${ephemeralField}`;
        let entry = paceBuffers.get(bufKey);
        if (!entry) {
          entry = {
            conn,
            scope: eventScope,
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
        entry.authzRow = authzRow;
        if (entry.timer === null) {
          entry.timer = setTimeout(() => flushPacedBuffer(bufKey), pace.window);
        }
      }
    }
  }

  function close() {
    byScope.clear();
    connSubs.clear();
    for (const [, entry] of paceBuffers) {
      if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
    }
    paceBuffers.clear();
    deltaProjector.clear();
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
