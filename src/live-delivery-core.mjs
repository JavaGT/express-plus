// LIVE DELIVERY CORE — package-private transport-neutral committed event delivery core.
//
// One subscription = one async stream of committed events, re-authorised per batch.
// The core reads committed events via _Log/readSince, projects them through the
// injected projector, and delivers them to the subscriber's async deliver callback.
// The subscriber's in-memory cursor advances only after successful delivery.
// wake(scope) is a payloadless hint to re-check for new events.
//
// Each subscription owns an opaque record and cursor. Multiple subscriptions on the
// same scope are independent — they cannot share or replace each other's cursor.
// Per-subscription dirty/generation loop ensures that a wake arriving during an
// active read/delivery triggers a second canonical reread before quiescence.
//
// After close() or removeSub, the active flag prevents any further delivery —
// closed subscriptions cannot project, deliver, or advance their cursor.
//
// Cursor safety: the cursor is advanced only after a successful delivery callback.
// If delivery rejects, the subscription is removed, the cursor is NOT advanced,
// and a resubscribe starting from the same after cursor will re-deliver the event.
// If the WebSocket closes during delivery, the same invariant applies — the
// subscriber's deliver callback should reject (or the subscription is removed by
// the owning LiveConnection's abort signal), so the cursor never advances for an
// undelivered event.
//
// Empty projection: when projectRecipient returns an empty array for all events
// in a batch, the cursor IS advanced (the events were successfully processed, just
// nothing needed to be sent to the client). This is correct for filter-only
// projectors that suppress certain event types — the consumer has acknowledged
// them and should not re-deliver on reconnect.

import { readSince } from './committed-log.mjs';
import { EventKind, parseEventType } from './event-handle.mjs';
import { mayRow } from './row-grant.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

let nextSubId = 1;

function generateSubId() {
  return nextSubId++;
}

export function createLiveDeliveryCore({ db, entities, mayVerb, projectRecipient, log = null }) {
  if (!db) throw new Error('live-delivery-core: db is required');
  if (!entities) throw new Error('live-delivery-core: entities is required');
  if (!mayVerb) throw new Error('live-delivery-core: mayVerb is required');
  if (typeof projectRecipient !== 'function') throw new Error('live-delivery-core: projectRecipient must be a function');

  const resolveEntity = typeof entities === 'function' ? entities : (name) => entities.get(name);
  const subs = new Map();
  const byScope = new Map();
  let closed = false;

  function entityRecord(name) {
    const record = resolveEntity(name);
    if (!record) throw new Error(`unknown entity '${name}'`);
    return record;
  }

  function reauthFor(entityRec, principal, handle) {
    try {
      const { sql: where, params: scopeParams } = entityRec.scopeFilter(principal);
      const raw = db.prepare(`SELECT * FROM ${entityRec.name} AS t0 WHERE ${where} AND t0.id = :id`).get({ ...scopeParams, id: handle.id });
      if (!raw) return null;
      // When hydrate is explicitly declared as a non-function (undefined/null),
      // fail closed — no raw row fallback. When hydrate is absent (compiled
      // entities without bind), use the raw row directly.
      if ('hydrate' in entityRec && typeof entityRec.hydrate !== 'function') return null;
      const row = typeof entityRec.hydrate === 'function' ? entityRec.hydrate(raw, principal) : raw;
      if (row === null || row === undefined) return null;
      return { row };
    } catch (err) {
      log?.error?.('live', 'reauthFor failed', { scope: handle.key, err: String(err) });
      return null;
    }
  }

  async function checkMayRow(entityRec, row, principal) {
    try {
      return await mayRow(entityRec, 'subscribe', row, principal, mayVerb);
    } catch {
      return false;
    }
  }

  function isTerminalRemoval(event, entityName) {
    try {
      const type = event.eventType ?? event.type;
      const handle = parseEventType(type);
      return handle.entity === entityName && handle.kind === EventKind.removed;
    } catch {
      return false;
    }
  }

  function removeSub(subId) {
    const sub = subs.get(subId);
    if (!sub) return;
    sub.active = false;
    subs.delete(subId);
    if (sub.signal && typeof sub.signal.removeEventListener === 'function') {
      try { sub.signal.removeEventListener('abort', sub._abortHandler); } catch { /* ignore */ }
    }
    const set = byScope.get(sub.scope);
    if (set) {
      set.delete(subId);
      if (set.size === 0) byScope.delete(sub.scope);
    }
  }

  async function catchUp(subId) {
    const sub = subs.get(subId);
    if (!sub || !sub.active) return;
    if (sub.paused) {
      sub.dirty = true;
      return;
    }
    sub.pending = true;
    try {
      while (true) {
        if (!sub.active) return;
        sub.dirty = false;
        const handle = tryParseScopeKey(sub.scope);
        if (!handle) { removeSub(subId); log?.error?.('live', 'invalid scope', { scope: sub.scope }); throw new Error(`invalid scope '${sub.scope}'`); }
        let events;
        try {
          events = readSince(db, sub.scope, sub.cursor);
        } catch (err) {
          log?.error?.('live', 'readSince failed', { scope: sub.scope, cursor: sub.cursor, err: String(err) });
          removeSub(subId);
          throw new Error(`readSince failed for scope '${sub.scope}'`);
        }
        const auth = reauthFor(sub.entityRec, sub.principal, handle);
        // A removal deletes its authorization subject, so it cannot be
        // re-authorized against a current row. Without that row, only terminal
        // removals for this entity may be projected; other committed rows in
        // the catch-up batch stay fail-closed. The terminal subscription is
        // then removed without acknowledging withheld events.
        const terminalRemoval = !auth;
        const deliverableEvents = auth
          ? events
          : events.filter((event) => isTerminalRemoval(event, sub.entityRec.name));
        if (!auth && deliverableEvents.length === 0) { removeSub(subId); log?.error?.('live', 'reauth denied', { scope: sub.scope }); throw new Error(`subscribe authorization denied for scope '${sub.scope}'`); }
        if (auth && !(await checkMayRow(sub.entityRec, auth.row, sub.principal))) { removeSub(subId); log?.error?.('live', 'mayRow denied', { scope: sub.scope }); throw new Error(`subscribe authorization denied for scope '${sub.scope}'`); }
        if (!sub.active) return;
        if (events.length === 0) {
          if (sub.dirty) continue;
          return;
        }
        const batch = [];
        for (const event of deliverableEvents) {
          if (!sub.active) return;
          const ctx = Object.freeze({
            entity: sub.entityRec,
            event: Object.freeze({ ...event }),
            principal: sub.principal,
            row: auth?.row,
            scope: sub.scope,
          });
          let projected;
          try {
            projected = projectRecipient(ctx);
          } catch (err) {
            log?.error?.('live', 'projectRecipient threw', { scope: sub.scope, seq: event.seq, err: String(err) });
            removeSub(subId);
            throw new Error(`projectRecipient threw for scope '${sub.scope}' seq ${event.seq}`);
          }
          if (!sub.active) return;
          if (!Array.isArray(projected)) {
            log?.error?.('live', 'projectRecipient must return an array', { scope: sub.scope, seq: event.seq });
            removeSub(subId);
            throw new Error(`projectRecipient must return an array for scope '${sub.scope}' seq ${event.seq}`);
          }
          batch.push(...projected);
        }
        if (!sub.active) return;
        // Cursor advances only after successful delivery. If the deliver callback
        // rejects (e.g. WebSocket closed), the subscription is removed, cursor
        // stays at the previous value, and a resubscribe re-delivers the event.
        if (batch.length > 0) {
          try {
            await sub.deliver(batch);
          } catch (err) {
            log?.error?.('live', 'delivery callback threw', { scope: sub.scope, err: String(err) });
            removeSub(subId);
            throw new Error(`delivery callback threw for scope '${sub.scope}'`);
          }
        }
        if (!sub.active) return;
        if (terminalRemoval) {
          // The authorization subject is gone. A terminal removal is the only
          // allowed output, and this subscription cannot acknowledge unrelated
          // earlier events that were withheld by the fail-closed filter.
          removeSub(subId);
          return;
        }
        // Advance cursor past the last event we processed (even if projection
        // returned empty — the events were acknowledged).
        sub.cursor = events[events.length - 1].seq;
        if (sub.dirty) continue;
        return;
      }
    } catch (err) {
      // If we're the outermost catchUp (not a re-entrant dirty wake), re-throw.
      // If this was a re-entrant call from the finally block, we need to make
      // sure the error is not silently swallowed — the subscriber will learn
      // about it via the promise from subscribe() or the removal.
      const sub = subs.get(subId);
      if (sub) {
        // The sub is still active but the loop aborted — remove it.
        removeSub(subId);
      }
      throw err;
    } finally {
      const sub = subs.get(subId);
      if (sub) {
        sub.pending = false;
        if (sub.active && sub.dirty) {
          catchUp(subId).catch(() => {
            // nested catchUp failure — subscription already removed
          });
        }
      }
    }
  }

  async function subscribe({ principal, scope, after = 0, signal, deliver, paused = false }) {
    if (closed) throw new Error('live-delivery-core is closed');
    if (signal?.aborted) return;
    const handle = tryParseScopeKey(scope);
    if (!handle) {
      log?.error?.('live', 'invalid scope', { scope });
      throw new Error(`invalid scope '${scope}'`);
    }
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
      throw new Error(`after must be a nonnegative safe integer, got ${after}`);
    }
    if (typeof deliver !== 'function') {
      throw new Error('deliver must be a function');
    }
    let entityRec;
    try {
      entityRec = entityRecord(handle.entity);
    } catch {
      log?.error?.('live', 'entity not found', { scope, entity: handle.entity });
      throw new Error(`entity '${handle.entity}' not found for scope '${scope}'`);
    }
    const auth = reauthFor(entityRec, principal, handle);
    if (!auth) {
      log?.error?.('live', 'subscribe denied', { scope });
      throw new Error(`subscribe authorization denied for scope '${scope}'`);
    }
    if (!(await checkMayRow(entityRec, auth.row, principal))) {
      log?.error?.('live', 'subscribe denied', { scope });
      throw new Error(`subscribe authorization denied for scope '${scope}'`);
    }
    const subId = generateSubId();
    const sub = { entityRec, principal, deliver, signal, cursor: after, pending: false, dirty: false, paused, scope, active: true };
    subs.set(subId, sub);
    let set = byScope.get(scope);
    if (!set) { set = new Set(); byScope.set(scope, set); }
    set.add(subId);
    if (signal) {
      const handler = () => { removeSub(subId); };
      sub._abortHandler = handler;
      signal.addEventListener('abort', handler, { once: true });
      if (signal.aborted) {
        removeSub(subId);
        throw new Error('subscription aborted');
      }
    }
    async function activate() {
      const current = subs.get(subId);
      if (!current || !current.active) return;
      if (!current.activation) {
        current.activation = (async () => {
          current.paused = false;
          try {
            await catchUp(subId);
          } catch (err) {
            removeSub(subId);
            throw err;
          }
        })();
      }
      return current.activation;
    }
    if (paused) return { activate };
    await activate();
  }

  async function wake(scope) {
    if (closed) return;
    const set = byScope.get(scope);
    if (!set) return;
    for (const subId of set) {
      const sub = subs.get(subId);
      if (!sub || !sub.active) continue;
      if (sub.paused) {
        sub.dirty = true;
        continue;
      }
      if (sub.pending) {
        sub.dirty = true;
      } else {
        catchUp(subId).catch(() => {});
      }
    }
  }

  function close() {
    closed = true;
    for (const sub of subs.values()) {
      sub.active = false;
      if (sub.signal && typeof sub.signal.removeEventListener === 'function') {
        try { sub.signal.removeEventListener('abort', sub._abortHandler); } catch { /* ignore */ }
      }
    }
    subs.clear();
    byScope.clear();
  }

  return { subscribe, wake, close };
}
