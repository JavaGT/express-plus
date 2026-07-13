// createLocalStore — wraps createLiveStore with a local event log (IndexedDB)
// plus BroadcastChannel relay for cross-tab event sharing.
//
// Architecture:
//   WS event → channel.subscribe callback → normalizeEnvelope → log.append
//   → BroadcastChannel.postMessage('log-update') → forward to LiveList
//
// Other tabs (followers) listen on the BroadcastChannel, read new entries
// from the shared log, and feed them into LiveList via the same onEnvelope
// callback path.

import { openLocalLog } from './workbench-local-log.mjs';
import { createLiveStore, LiveChannel } from './workbench-client.mjs';

// --- normalizeEnvelope ---

/**
 * Convert a live WS envelope into a structured log entry.
 *
 * Derives `kind` from the event.type suffix:
 *   .created → 'create', .removed → 'remove', .updated or unknown → 'update'
 *
 * @param {object} envelope — { type:'event', entity, id, seq, seqSpan, event:{type, data, actionId}, delta }
 * @param {string} entity — entity name passed from the subscribe scope
 * @returns {object} log entry shape
 */
export function normalizeEnvelope(envelope, entity) {
  const eventType = envelope.event?.type ?? '';
  let kind = 'update';
  if (eventType.endsWith('.created')) kind = 'create';
  else if (eventType.endsWith('.removed')) kind = 'remove';

  return {
    opId: envelope.event?.actionId ?? null,
    seq: envelope.seq,
    scope: `${entity}:${envelope.id}`,
    entity,
    rowId: envelope.id,
    kind,
    type: eventType,
    payload: envelope.event?.data ?? null,
    preimage: null,
    actionId: envelope.event?.actionId ?? null,
    status: 'committed',
    source: 'remote',
    timestamp: Date.now(),
  };
}

// --- createLocalRelay ---

/**
 * Create a relay that wraps a LiveChannel by intercepting WS events,
 * writing them to a local IndexedDB log, and broadcasting via BroadcastChannel
 * so other tabs sharing the same log can pick them up.
 *
 * Returns an object matching the LiveChannel contract:
 *   subscribe(entity, id, options, onEnvelope) → { currentSeq }
 *   unsubscribe(entity, id)
 *   close()
 *
 * @param {{ name: string, channel: object }} config
 * @returns {Promise<{ subscribe, unsubscribe, close }>}
 */
export async function createLocalRelay({ name, channel, locks }) {
  const log = await openLocalLog(name);
  const LOCK_NAME = `workbench:live:${name}`;
  const broadcast = new BroadcastChannel(`workbench:live:${name}`);
  const subs = new Map(); // key → { onEnvelope, entity, id }
  const upstream = new Map(); // key → { promise, active }
  const cursors = new Map(); // scope → lastSeq delivered
  let closed = false;
  let generation = 0;
  let isLeader = !locks; // no locks → always leader
  let _ready = Promise.resolve(); // settles when leader/follower is decided
  let lockFallback = null;
  let releaseLeadership = null;

  if (locks) {
    _ready = new Promise((resolve) => {
      // Don't hang forever — settle as follower after a short window.
      lockFallback = setTimeout(() => resolve(), 50);
      lockFallback.unref?.();
      locks.request(LOCK_NAME, () => {
        clearTimeout(lockFallback);
        lockFallback = null;
        if (closed) { resolve(); return Promise.resolve(); }
        isLeader = true;
        resolve();
        void reconcileUpstream();
        // Hold the lock until close(), then allow the next tab to take over.
        return new Promise((release) => { releaseLeadership = release; });
      }).catch(() => {
        clearTimeout(lockFallback);
        lockFallback = null;
        resolve();
      });
    });
  }

  function ready() {
    return _ready;
  }

  async function ensureCursor(scope) {
    if (!cursors.has(scope)) {
      cursors.set(scope, await log.head(scope));
    }
    return cursors.get(scope);
  }

  function isActive(key, expectedGeneration, onEnvelope) {
    return !closed
      && generation === expectedGeneration
      && subs.get(key)?.onEnvelope === onEnvelope;
  }

  function deliver(onEnvelope, envelope) {
    try {
      onEnvelope(envelope);
    } catch {
      // Consumer code is outside the relay's trust boundary. One callback
      // cannot reject asynchronous delivery or block later log entries.
    }
  }

  async function forwardUpstream(key, sub, envelope) {
    if (!isActive(key, sub.generation, sub.onEnvelope)) return;
    const scope = `${sub.entity}:${sub.id}`;
    try {
      const entry = await log.append(normalizeEnvelope(envelope, sub.entity));
      if (!isActive(key, sub.generation, sub.onEnvelope)) return;
      cursors.set(scope, entry.seq);
      broadcast.postMessage({ type: 'log-update' });
    } catch {
      // Local persistence is best-effort; the live event is still useful.
    }
    if (!isActive(key, sub.generation, sub.onEnvelope)) return;
    deliver(sub.onEnvelope, envelope);
  }

  function ensureUpstream(key, sub) {
    const existing = upstream.get(key);
    if (existing) return existing.promise;

    const record = { promise: null, active: false };
    record.promise = channel.subscribe(
      sub.entity,
      sub.id,
      sub.options,
      (envelope) => { void forwardUpstream(key, sub, envelope); },
    ).then(async (ack) => {
      if (!isLeader || !isActive(key, sub.generation, sub.onEnvelope)) {
        try { await channel.unsubscribe(sub.entity, sub.id); } catch { /* ignore */ }
        throw new Error('relay is closed or subscription was cancelled');
      }
      record.active = true;
      return ack;
    }).catch((error) => {
      if (upstream.get(key) === record) upstream.delete(key);
      throw error;
    });
    upstream.set(key, record);
    return record.promise;
  }

  async function reconcileUpstream() {
    if (closed || !isLeader) return;
    await Promise.allSettled(
      [...subs.entries()].map(([key, sub]) => ensureUpstream(key, sub)),
    );
  }

  // Broadcast listener: when another tab signals new entries, read from
  // the shared log and deliver to all registered onEnvelope callbacks.
  broadcast.onmessage = async () => {
    if (closed) return;
    subscriptions:
    for (const [key, sub] of subs) {
      const expectedGeneration = generation;
      const scope = `${sub.entity}:${sub.id}`;
      const cursor = cursors.get(scope) ?? 0;
      try {
        const entries = await log.entriesSince(scope, cursor);
        if (!isActive(key, expectedGeneration, sub.onEnvelope)) continue;
        for (const entry of entries) {
          if (!isActive(key, expectedGeneration, sub.onEnvelope)) continue subscriptions;
          cursors.set(scope, entry.seq);
          deliver(sub.onEnvelope, {
            type: 'event',
            entity: sub.entity,
            id: sub.id,
            seq: entry.seq,
            seqSpan: [entry.seq, entry.seq],
            event: {
              type: entry.type,
              data: entry.payload,
              actionId: entry.actionId,
            },
            delta: undefined,
          });
        }
      } catch {
        // Log read failed for this scope — skip.
      }
    }
  };

  async function subscribe(entity, id, optionsOrOnEvent, maybeOnEvent) {
    if (closed) throw new Error('relay is closed');

    const options = typeof optionsOrOnEvent === 'function' ? {} : (optionsOrOnEvent ?? {});
    const onEnvelope = typeof optionsOrOnEvent === 'function' ? optionsOrOnEvent : maybeOnEvent;

    if (!onEnvelope) throw new Error('onEnvelope callback is required');

    const key = `${entity}\0${String(id)}`;
    const scope = `${entity}:${id}`;
    const expectedGeneration = generation;
    const sub = { onEnvelope, entity, id, options, generation: expectedGeneration };
    subs.set(key, sub);

    await ensureCursor(scope);
    await _ready;
    if (!isActive(key, expectedGeneration, onEnvelope)) {
      throw new Error('relay is closed or subscription was cancelled');
    }

    if (isLeader) {
      return ensureUpstream(key, sub);
    }

    // Follower: no real channel subscription. Return ack with log head
    // so LiveList can detect a gap vs its snapshot cursor.
    const currentSeq = await log.head(scope);
    if (!isActive(key, expectedGeneration, onEnvelope)) {
      throw new Error('relay is closed or subscription was cancelled');
    }
    return { currentSeq };
  }

  async function unsubscribe(entity, id) {
    const key = `${entity}\0${String(id)}`;
    subs.delete(key);
    const record = upstream.get(key);
    upstream.delete(key);
    if (record) {
      try { await record.promise; } catch { return; }
      try { await channel.unsubscribe(entity, id); } catch { /* ignore */ }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    generation += 1;
    if (lockFallback) {
      clearTimeout(lockFallback);
      lockFallback = null;
    }
    subs.clear();
    upstream.clear();
    cursors.clear();
    try { broadcast.close(); } catch { /* ignore */ }
    if (isLeader) {
      try { channel.close(); } catch { /* ignore */ }
    }
    isLeader = false;
    releaseLeadership?.();
    releaseLeadership = null;
    try { log.close(); } catch { /* ignore */ }
  }

  return { subscribe, unsubscribe, close, ready };
}

// --- createLocalStore ---

/**
 * Create a live store with local-log persistence.
 *
 * Identical API to createLiveStore, but WS events are written to an IndexedDB
 * event log and broadcast to other tabs via BroadcastChannel. Dispatch (create,
 * update, remove) goes through REST unchanged.
 *
 * @param {object} config
 * @param {string} config.baseUrl  — server origin (e.g. 'http://127.0.0.1:5432')
 * @param {string} config.name     — entity name (e.g. 'Todo')
 * @param {string} config.path     — CRUD mount path (e.g. '/todos')
 * @param {{ name: string }} config.local — local DB name and config
 * @param {object} [config.channel] — LiveChannel instance (optional)
 * @param {function} [config.fetchImpl] — fetch function (optional)
 * @returns {Promise<object>} store object (same shape as createLiveStore return)
 */
export async function createLocalStore({ baseUrl, name, path, local, channel, fetchImpl, locks }) {
  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;

  const relay = await createLocalRelay({ name: local.name, channel: resolvedChannel, locks });

  const store = createLiveStore({
    baseUrl,
    name,
    path,
    channel: relay,
    fetchImpl: resolvedFetch,
  });

  const _history = new Map(); // opId → { kind, id, preimage, payload }

  // Wrap dispatch to capture preimage before the operation runs.
  const originalDispatch = store.dispatch;
  store.dispatch = async (type, payload) => {
    let kind, id;
    if (type === `${name}.create`) {
      kind = 'create';
    } else if (type === `${name}.update`) {
      kind = 'update';
      id = payload.id;
    } else if (type === `${name}.remove`) {
      kind = 'remove';
      id = payload.id;
    } else {
      return originalDispatch(type, payload);
    }

    const preimage = id != null ? store.overlayFor(id) : null;

    const result = await originalDispatch(type, payload);

    if (result.ok && result.opId) {
      _history.set(result.opId, { kind, id: result.id ?? id, preimage, payload });
    }

    return result;
  };

  // Re-point sugar methods through the wrapped dispatch so every path
  // (dispatch, create, update, remove) captures a preimage.
  store.create = (payload) => store.dispatch(`${name}.create`, payload);
  store.update = (id, payload) => store.dispatch(`${name}.update`, { id, ...payload });
  store.remove = (id) => store.dispatch(`${name}.remove`, { id });

  store.undo = async (opId) => {
    const entry = _history.get(opId);
    if (!entry) {
      return { ok: false, status: 'failed-rolled-back', opId, error: 'no history for undo: ' + opId };
    }
    _history.delete(opId);

    if (entry.kind === 'create') {
      return store.remove(entry.id);
    }
    if (entry.kind === 'update') {
      return store.update(entry.id, entry.preimage);
    }
    if (entry.kind === 'remove') {
      return store.create(entry.preimage);
    }

    return { ok: false, status: 'failed-rolled-back', opId, error: 'unknown undo kind: ' + entry.kind };
  };

  // Override close to also tear down the relay (log + broadcast).
  const originalClose = store.close;
  store.close = () => {
    _history.clear();
    originalClose();
  };

  return store;
}
