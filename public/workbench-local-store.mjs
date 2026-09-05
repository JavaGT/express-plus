// createLocalStore — wraps createLiveStore with a local event log (IndexedDB)
// plus BroadcastChannel relay for cross-tab event sharing, and a durable
// Outbox for client mutations (#183).
//
// Architecture:
//   WS event → channel.subscribe callback → normalizeEnvelope → log.append
//   → BroadcastChannel.postMessage('log-update') → forward to LiveList
//
// Other tabs (followers) listen on the BroadcastChannel, read new entries
// from the shared log, and feed them into LiveList via the same onEnvelope
// callback path.
//
// Mutations (create/update/remove) go through the Outbox: dispatch applies the
// visible placeholder immediately, the outbox durably holds the exact request
// (same actionId on every resend — the server dedupes per (scope, actionId)),
// and completion waits for authoritative per-scope seq evidence: the committed
// event landing in the local log, or the commit-seq header of the resend.
// Outbox rows are tagged rows of the SAME local log — no second store.

import { openLocalLog, OUTBOX_LOG } from './workbench-local-log.mjs';
import { createLiveStore, LiveChannel, decodeResult } from './workbench-client.mjs';

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

// --- OutboxEntry ---

const OUTBOX_DEFAULTS = Object.freeze({
  retryBaseMs: 1000,
  retryMaxMs: 10000,
  sendTimeoutMs: 10000,
});

/**
 * One durable client mutation waiting for its authoritative commit.
 *
 * The class is the entry's identity + transition rules; the durable row is
 * `toRow()` (a plain clone of the same fields, tagged `log: OUTBOX_LOG`).
 * Retry resends carry the SAME actionId — the server dedupes per
 * (scope, actionId), so a resend can never mint a second mutation.
 *
 * Statuses: 'queued' → 'sending' → 'committed' | 'rejected'.
 *   committed — authoritative seq evidence arrived (log delta or commit-seq
 *               response header); the row is then removed from the queue.
 *   rejected  — the server answered No (grant revoked, validation changed,
 *               missing row, uninterpretable 4xx); fail-closed: the row stays
 *               durably visible until dismissed, the placeholder rolls back.
 */
export class OutboxEntry {
  constructor(init) {
    this.id = init.id ?? null;               // durable row id (assigned on append)
    this.actionId = init.actionId;
    this.opId = init.opId ?? null;           // dispatch correlation (client-local)
    this.entity = init.entity;
    this.rowId = init.rowId ?? null;         // null for creates until committed
    this.kind = init.kind;                   // 'create' | 'update' | 'remove'
    this.payload = init.payload ?? null;
    this.body = init.body ?? null;           // exact request bytes; retries resend these
    this.targetScope = init.targetScope ?? null;
    this.status = init.status ?? 'queued';
    this.attempts = init.attempts ?? 0;
    this.committedSeq = init.committedSeq ?? null;
    this.resultRow = init.resultRow ?? null;
    this.failure = init.failure ?? null;
    this.createdAt = init.createdAt ?? Date.now();
    this.updatedAt = init.updatedAt ?? this.createdAt;

    // Runtime-only resolution channels (never persisted): first settlement of
    // the dispatching call, and the terminal outcome. `promises()` opens them.
    this._first = null;
    this._firstSettle = null;
    this._terminal = null;
    this._terminalSettle = null;
  }

  get pending() { return this.status === 'queued' || this.status === 'sending'; }
  get terminal() { return this.status === 'committed' || this.status === 'rejected'; }

  toRow() {
    const row = {
      log: OUTBOX_LOG,
      actionId: this.actionId,
      opId: this.opId,
      entity: this.entity,
      rowId: this.rowId,
      kind: this.kind,
      payload: this.payload,
      body: this.body,
      targetScope: this.targetScope,
      status: this.status,
      attempts: this.attempts,
      committedSeq: this.committedSeq,
      resultRow: this.resultRow,
      failure: this.failure,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    // The row id is assigned by the store's auto-increment key on append;
    // an explicit null is an invalid key.
    if (this.id != null) row.id = this.id;
    return row;
  }

  static fromRow(row) { return new OutboxEntry(row); }

  promises() {
    if (!this._first) {
      this._first = new Promise((resolve, reject) => {
        this._firstSettle = { resolve, reject };
      });
    }
    if (!this._terminal) {
      this._terminal = new Promise((resolve) => {
        this._terminalSettle = resolve;
      });
    }
    return { settlement: this._first, completion: this._terminal };
  }

  resolveFirst(outcome) {
    const settle = this._firstSettle;
    if (!settle) return;
    this._firstSettle = null;
    settle.resolve(outcome);
  }

  rejectFirst(error) {
    const settle = this._firstSettle;
    if (!settle) return;
    this._firstSettle = null;
    settle.reject(error);
  }

  resolveTerminal(outcome) {
    const settle = this._terminalSettle;
    if (!settle) return;
    this._terminalSettle = null;
    settle(outcome);
  }

  /** Store closing / entry removed before any outcome — stop waiting. */
  abandon() {
    this.resolveFirst({ status: 'queued', actionId: this.actionId });
    this.resolveTerminal({ status: 'abandoned' });
  }

  markSending(now = Date.now()) {
    if (this.status !== 'queued') return false;
    this.status = 'sending';
    this.attempts += 1;
    this.updatedAt = now;
    return true;
  }

  /** A started attempt ended without committing — retryable. */
  markQueued(now = Date.now()) {
    if (this.terminal || this.status === 'queued') return false;
    this.status = 'queued';
    this.updatedAt = now;
    return true;
  }

  markCommitted({ seq = null, row = null } = {}, now = Date.now()) {
    if (this.terminal) return false;
    this.status = 'committed';
    this.committedSeq = Number.isFinite(seq) ? seq : null;
    this.resultRow = row ?? null;
    this.failure = null;
    this.updatedAt = now;
    return true;
  }

  markRejected(failure, now = Date.now()) {
    if (this.terminal) return false;
    this.status = 'rejected';
    this.failure = failure ?? null;
    this.updatedAt = now;
    return true;
  }
}

// --- createOutbox ---

/**
 * The durable client-mutation queue over the existing local log.
 *
 * Any tab may enqueue; only the leader sends (flusher) and only the leader
 * completes entries from log deltas. Every transition is written to the
 * shared rows and broadcast, so all tabs observe queued entries and settle
 * their placeholders from the same evidence. Terminal outcomes resolve
 * through the entry's runtime channels: the dispatching call's settlement,
 * and the terminal continuation that confirms or rolls back the placeholder.
 */
function createOutbox({ log, broadcast, options = {} }) {
  const cfg = { ...OUTBOX_DEFAULTS, ...options };
  const entries = new Map();      // row id → OutboxEntry (mirror of durable rows)
  const observers = new Set();
  const chains = new Map();       // chain key → in-flight chain promise
  let transport = null;
  let leader = false;
  let stopped = false;
  let retryFailures = 0;
  let retryUntil = 0;
  let retryTimer = null;

  function snapshot() {
    return [...entries.values()]
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .map((entry) => entry.toRow());
  }

  function notify() {
    const rows = snapshot();
    for (const cb of observers) {
      try { cb(rows); } catch { /* observers are outside our trust boundary */ }
    }
  }

  function notifyAndBroadcast(row) {
    notify();
    try { broadcast.postMessage({ type: 'outbox-update', row }); } catch { /* channel closed */ }
  }

  /** Fire the entry's runtime channels for its current durable state. */
  function resolve(entry) {
    if (entry.status === 'committed') {
      const outcome = { status: 'committed', seq: entry.committedSeq, row: entry.resultRow };
      entry.resolveFirst(outcome);
      entry.resolveTerminal(outcome);
    } else if (entry.status === 'rejected') {
      const outcome = { status: 'rejected', failure: entry.failure };
      entry.resolveFirst(outcome);
      entry.resolveTerminal(outcome);
    } else if (entry.status === 'queued' && entry.attempts > 0) {
      // A started attempt settled without committing — transport-grade
      // failure; the same actionId retries with backoff.
      entry.resolveFirst({ status: 'queued', actionId: entry.actionId });
    }
  }

  /** Leader-side transition: mutate, resolve channels, persist + broadcast. */
  function transition(entry, fn) {
    if (!fn(entry)) return false;
    resolve(entry);
    void persistTransition(entry);
    return true;
  }

  async function persistTransition(entry) {
    if (entry.id == null || !entries.has(entry.id)) return;
    try {
      if (entry.status === 'committed') {
        // The committed outcome must reach every tab before the row goes
        // away — the committed event in the log is the durable record; a
        // retained queue row would only become unbounded growth.
        await log.outboxPut(entry.toRow());
        notifyAndBroadcast(entry.toRow());
        await log.outboxDelete(entry.id);
        entries.delete(entry.id);
        notify();
        try { broadcast.postMessage({ type: 'outbox-remove', id: entry.id }); } catch { /* channel closed */ }
      } else {
        await log.outboxPut(entry.toRow());
        notifyAndBroadcast(entry.toRow());
      }
    } catch {
      // Persistence is best-effort; the mirror still resolves locally.
    }
  }

  // --- enqueue / observe / dismiss ---

  async function enqueue(entry) {
    try {
      const appended = await log.outboxAppend(entry.toRow());
      entry.id = appended.id;
    } catch (error) {
      // The mutation never became durable — dispatch must fail closed, not
      // pretend the entry is queued.
      entry.rejectFirst(error ?? new Error('outbox append failed'));
      entry.resolveTerminal({ status: 'abandoned' });
      return;
    }
    entries.set(entry.id, entry);
    notifyAndBroadcast(entry.toRow());
    kick();
  }

  function observe(cb) {
    observers.add(cb);
    cb(snapshot());
    return () => observers.delete(cb);
  }

  /** Remove a durably rejected entry after the failure was acknowledged. */
  async function dismiss(entryId) {
    const entry = entries.get(entryId);
    if (!entry || entry.status !== 'rejected') return false;
    entries.delete(entryId);
    notify();
    try { broadcast.postMessage({ type: 'outbox-remove', id: entryId }); } catch { /* channel closed */ }
    try { await log.outboxDelete(entryId); } catch { /* best-effort */ }
    return true;
  }

  // --- cross-tab observation (signals carry the row: no re-read race) ---

  function applyRemoteRow(row) {
    if (!row || row.log !== OUTBOX_LOG || typeof row.id !== 'number') return;
    let entry = entries.get(row.id);
    if (!entry) {
      entry = OutboxEntry.fromRow(row);
      entries.set(row.id, entry);
    } else {
      // Refresh durable fields in place — the instance carries this tab's
      // pending resolution channels.
      Object.assign(entry, row);
    }
    resolve(entry);
    notify();
    // A remote enqueue (or retry state) may be flushable here.
    if (leader && entry.status === 'queued') kick();
  }

  function applyRemoteRemove(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.abandon(); // no-op once the terminal outcome already resolved
    notify();
  }

  // --- leader lifecycle ---

  function setLeader(value) {
    leader = value;
    if (!value || stopped) return;
    void (async () => {
      await reload();
      kick();
    })();
  }

  async function reload() {
    let rows = [];
    try { rows = await log.outboxEntries(0); } catch { rows = []; }
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const existing = entries.get(row.id);
      if (existing) Object.assign(existing, row);
      else entries.set(row.id, OutboxEntry.fromRow(row));
      resolve(entries.get(row.id));
    }
    for (const id of [...entries.keys()]) {
      if (!seen.has(id)) {
        const removed = entries.get(id);
        entries.delete(id);
        removed.abandon();
      }
    }
    // Crash-orphan 'sending' rows (a previous session died mid-send) go back
    // to queued — resending the same actionId is safe: the server dedupes
    // per (scope, actionId) before field logic.
    for (const entry of entries.values()) {
      if (entry.status === 'sending') transition(entry, (e) => e.markQueued());
    }
    notify();
  }

  function close() {
    stopped = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    for (const entry of entries.values()) entry.abandon();
    entries.clear();
    chains.clear();
    observers.clear();
  }

  // --- flusher (leader only) ---

  function useTransport(config) {
    transport = {
      baseUrl: config.baseUrl,
      path: config.path,
      fetch: config.fetch ?? globalThis.fetch,
    };
    kick();
  }

  function chainKeyOf(entry) {
    // Creates have no target scope yet — each is its own chain. Updates and
    // removes serialize per target scope so per-scope ordering holds.
    return entry.targetScope ?? `new\0${entry.actionId}`;
  }

  function _seqFromHeader(res) {
    const value = res?.headers?.get?.('x-workbench-seq') ?? null;
    if (value == null || value === '') return null;
    const seq = Number(value);
    return Number.isFinite(seq) ? seq : null;
  }

  /**
   * Dedupe correctness rests on actionIds being unguessable and unique — a
   * weak or reused actionId could dedupe a DIFFERENT mutation in the same
   * scope. Same standard as the text replica identity (randomReplicaActor).
   */
  function mintActionId() {
    if (!globalThis.crypto?.getRandomValues) {
      throw new Error('secure random action identity is unavailable');
    }
    return globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID()
      : [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
  }

  function pendingInOrder() {
    return [...entries.values()]
      .filter((entry) => entry.status === 'queued')
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  function nextQueuedForChain(key) {
    let best = null;
    for (const entry of entries.values()) {
      if (entry.status !== 'queued') continue;
      if (chainKeyOf(entry) !== key) continue;
      if (!best || (entry.id ?? 0) < (best.id ?? 0)) best = entry;
    }
    return best;
  }

  function kick() {
    if (!leader || stopped) return;
    // Backoff gate: never (re)start a chain while a retry is pending — the
    // retry timer re-kicks when the delay elapses. Without this, a chain's
    // completion kick would synchronously recreate itself and spin.
    if (Date.now() < retryUntil) return;
    for (const entry of pendingInOrder()) {
      const key = chainKeyOf(entry);
      if (chains.has(key)) continue;
      chains.set(key, runChain(key));
    }
  }

  function noteFailure() {
    retryFailures += 1;
    const delay = Math.min(cfg.retryBaseMs * 2 ** (retryFailures - 1), cfg.retryMaxMs);
    retryUntil = Date.now() + delay;
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        kick();
      }, delay);
      retryTimer.unref?.();
    }
  }

  function noteSuccess() {
    retryFailures = 0;
    retryUntil = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    kick();
  }

  /** Force a retry pass now (public kick; also clears backoff). */
  function flush() {
    retryFailures = 0;
    retryUntil = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    kick();
  }

  async function runChain(key) {
    try {
      while (leader && !stopped) {
        const entry = nextQueuedForChain(key);
        if (!entry) return;
        if (Date.now() < retryUntil) return;
        await attemptSend(entry);
        if (!entry.terminal) {
          noteFailure();
          return;
        }
        noteSuccess();
      }
    } finally {
      chains.delete(key);
      kick();
    }
  }

  async function attemptSend(entry) {
    transition(entry, (e) => e.markSending());
    if (!transport) return;
    const { url, init } = buildRequest(entry);
    try {
      const res = await sendWithTimeout(url, init);
      const decoded = await decodeResult(res);
      const echo = res?.headers?.get?.('x-workbench-action-id') ?? null;
      if (decoded.ok) {
        // The response must be for THIS actionId; a foreign echo is
        // transport-grade noise — queue and resend (the server dedupes).
        if (echo && echo !== entry.actionId) {
          transition(entry, (e) => e.markQueued());
          return;
        }
        transition(entry, (e) => e.markCommitted({
          seq: _seqFromHeader(res),
          row: res.status === 204 ? null : (decoded.value ?? null),
        }));
        return;
      }
      if (decoded.httpStatus < 500) {
        // 4xx is a server No — grant revoked offline, validation changed,
        // missing row. Fail closed: reject, roll the placeholder back, keep
        // the entry durably visible. A 4xx with no interpretable failure body
        // is still a No, never an infinite resend.
        const failure = decoded.failure
          ?? { category: 'internal', message: decoded.error ?? `http ${decoded.httpStatus}` };
        transition(entry, (e) => e.markRejected(failure));
        return;
      }
      transition(entry, (e) => e.markQueued()); // 5xx — retryable
    } catch {
      transition(entry, (e) => e.markQueued()); // transport error / timeout
    }
  }

  function buildRequest(entry) {
    const url = entry.kind === 'create'
      ? `${transport.baseUrl}${transport.path}`
      : `${transport.baseUrl}${transport.path}/${entry.rowId}`;
    const method = entry.kind === 'create' ? 'POST' : entry.kind === 'update' ? 'PATCH' : 'DELETE';
    const init = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-workbench-action-id': entry.actionId,
      },
    };
    if (entry.body != null) init.body = entry.body;
    return { url, init };
  }

  async function sendWithTimeout(url, init) {
    if (!cfg.sendTimeoutMs) return transport.fetch(url, init);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`outbox send timed out after ${cfg.sendTimeoutMs}ms`)),
      cfg.sendTimeoutMs,
    );
    timer.unref?.();
    try {
      return await transport.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Authoritative per-scope seq delta completion: the committed event for a
   * pending entry landed in the local log. Called by the relay when it
   * appends a live event; row data is not needed — the seq IS the evidence
   * (the ingest fold resolves the placeholder's content).
   */
  function noteCommittedEvent(scope, actionId, seq) {
    if (!leader || stopped || actionId == null) return;
    for (const entry of entries.values()) {
      if (!entry.pending) continue;
      if (entry.targetScope !== scope || entry.actionId !== actionId) continue;
      transition(entry, (e) => e.markCommitted({ seq: Number.isFinite(seq) ? seq : null, row: null }));
    }
  }

  /**
   * Durable send of a new mutation: mint one actionId, persist the exact
   * request, and return the resolution channels. Retries reuse the entry's
   * actionId — never a fresh one.
   */
  function send(request) {
    if (!transport) throw new Error('outbox transport is not configured');
    if (request.kind === 'update' || request.kind === 'remove') {
      if (request.id == null) throw new Error(`${request.kind} requires a row id`);
    }
    const entry = new OutboxEntry({
      actionId: mintActionId(),
      opId: request.opId ?? null,
      entity: request.entity,
      rowId: request.kind === 'create' ? null : request.id,
      kind: request.kind,
      payload: request.payload ?? null,
      body: request.body ?? null,
      targetScope: request.kind === 'create' ? null : `${request.entity}:${request.id}`,
      status: 'queued',
    });
    const { settlement, completion } = entry.promises();
    void enqueue(entry);
    return { settlement, completion, actionId: entry.actionId };
  }

  return {
    send,
    snapshot,
    observe,
    flush,
    dismiss,
    setLeader,
    useTransport,
    noteCommittedEvent,
    applyRemoteRow,
    applyRemoteRemove,
    close,
  };
}

// --- createLocalRelay ---

/**
 * Create a relay that wraps a LiveChannel by intercepting WS events,
 * writing them to a local IndexedDB log, and broadcasting via BroadcastChannel
 * so other tabs sharing the same log can pick them up. The relay also owns
 * the Outbox: leader election decides which tab resends durable mutations.
 *
 * Returns an object matching the LiveChannel contract:
 *   subscribe(entity, id, options, onEnvelope) → { currentSeq }
 *   unsubscribe(entity, id)
 *   close()
 * plus `outbox` (the durable mutation queue) and `ready()`.
 *
 * @param {{ name: string, channel: object, locks?: object, outbox?: object }} config
 * @returns {Promise<{ subscribe, unsubscribe, close, ready, outbox }>}
 */
export async function createLocalRelay({ name, channel, locks, outbox: outboxOptions = {} }) {
  const log = await openLocalLog(name);
  const LOCK_NAME = `workbench:live:${name}`;
  const broadcast = new BroadcastChannel(`workbench:live:${name}`);
  const outbox = createOutbox({ log, broadcast, options: outboxOptions });
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
        outbox.setLeader(true);
        void reconcileUpstream();
        // Hold the lock until close(), then allow the next tab to take over.
        return new Promise((release) => { releaseLeadership = release; });
      }).catch(() => {
        clearTimeout(lockFallback);
        lockFallback = null;
        resolve();
      });
    });
  } else {
    outbox.setLeader(true);
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
      // The appended event is authoritative per-scope seq evidence — it may
      // complete a pending outbox entry for this scope.
      outbox.noteCommittedEvent(scope, entry.actionId, entry.seq);
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
  // Outbox signals carry the changed row (or removal) directly — applying
  // them must not re-read the store, or a fast commit+delete sequence could
  // race the re-read and lose the terminal outcome.
  broadcast.onmessage = async (message) => {
    if (closed) return;
    const data = message?.data;
    if (data?.type === 'outbox-update') {
      outbox.applyRemoteRow(data.row);
      return;
    }
    if (data?.type === 'outbox-remove') {
      outbox.applyRemoteRemove(data.id);
      return;
    }
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
    outbox.close();
    try { log.close(); } catch { /* ignore */ }
  }

  return { subscribe, unsubscribe, close, ready, outbox };
}

// --- createLocalStore ---

/**
 * Create a live store with local-log persistence and a durable Outbox.
 *
 * Identical API to createLiveStore, but WS events are written to an IndexedDB
 * event log and broadcast to other tabs via BroadcastChannel, and CRUD
 * dispatch (create, update, remove) goes through the durable outbox: the
 * optimistic overlay is the visible placeholder, completion waits for
 * authoritative per-scope seq evidence, and offline entries resends with the
 * same actionId (server-side dedupe) until the server commits or rejects.
 *
 * @param {object} config
 * @param {string} config.baseUrl  — server origin (e.g. 'http://127.0.0.1:5432')
 * @param {string} config.name     — entity name (e.g. 'Todo')
 * @param {string} config.path     — CRUD mount path (e.g. '/todos')
 * @param {{ name: string, outbox?: object }} config.local — local DB name and outbox tuning
 * @param {object} [config.channel] — LiveChannel instance (optional)
 * @param {function} [config.fetchImpl] — fetch function (optional)
 * @param {object} [config.locks] — Web Locks polyfill for leader election
 * @returns {Promise<object>} store object (same shape as createLiveStore return,
 *   plus `outbox()`, `onOutbox(cb)`, `flushOutbox()`, `dismissOutbox(id)`)
 */
export async function createLocalStore({ baseUrl, name, path, local, channel, fetchImpl, locks }) {
  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;

  const relay = await createLocalRelay({
    name: local.name,
    channel: resolvedChannel,
    locks,
    outbox: { ...OUTBOX_DEFAULTS, ...(local?.outbox ?? {}) },
  });
  relay.outbox.useTransport({ baseUrl, path, fetch: resolvedFetch });

  const store = createLiveStore({
    baseUrl,
    name,
    path,
    channel: relay,
    fetchImpl: resolvedFetch,
    sendMutation: (request) => relay.outbox.send(request),
  });

  const _history = new Map(); // opId → { kind, id, preimage, payload }
  const _pendingHistory = new Map(); // actionId → { kind, id, preimage, payload, opId }

  // Entries settled later (offline queue) become undoable once committed,
  // from the durable entry's own data.
  const offOutboxHistory = relay.outbox.observe((rows) => {
    for (const row of rows) {
      if (row.status !== 'committed' && row.status !== 'rejected') continue;
      const pending = _pendingHistory.get(row.actionId);
      if (!pending) continue;
      _pendingHistory.delete(row.actionId);
      if (row.status === 'committed') {
        _history.set(pending.opId, {
          kind: pending.kind,
          id: row.resultRow?.id ?? pending.id,
          preimage: pending.preimage,
          payload: pending.payload,
        });
      }
    }
  });

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
    } else if (result.status === 'queued' && result.actionId) {
      _pendingHistory.set(result.actionId, {
        kind,
        id: result.id ?? id,
        preimage,
        payload,
        opId: result.opId,
      });
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
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: { category: 'conflict', message: 'no history for undo: ' + opId },
      };
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

    return {
      ok: false,
      status: 'failed-rolled-back',
      opId,
      failure: { category: 'internal', message: 'unknown undo kind: ' + entry.kind },
    };
  };

  // --- Outbox surface ---

  store.outbox = () => relay.outbox.snapshot();
  store.onOutbox = (cb) => relay.outbox.observe(cb);
  store.flushOutbox = () => relay.outbox.flush();
  store.dismissOutbox = (entryId) => relay.outbox.dismiss(entryId);

  // Override close to also tear down the relay (log + broadcast + outbox).
  const originalClose = store.close;
  store.close = () => {
    _history.clear();
    _pendingHistory.clear();
    offOutboxHistory();
    originalClose();
  };

  return store;
}
