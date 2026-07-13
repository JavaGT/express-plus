// LiveChannel — WebSocket transport layer for workbench live sync.
//
// Slice A of the client SDK. ONE WebSocket per channel, multiplexed across
// entity/id subscriptions. Auto-reconnects with exponential backoff. Zero
// external dependencies — uses Node's global WebSocket (Node 22+).
//
// Protocol (matches src/live.mjs verbatim):
//   client → server: {type:'subscribe', entity, id, fields?, pace?} / {type:'subscribe', scope, interest?} / {type:'unsubscribe', entity, id} / {type:'unsubscribe', scope}
//   server → client: {type:'subscribed', scope, entity, id, currentSeq}
//                    {type:'unsubscribed', scope, entity, id}
//                    {type:'event', entity, id, seq, seqSpan, event, delta?}
//                    {type:'error', message}

// --- BEGIN GENERATED from src/replay-decision.mjs (keep in sync; zero-import) ---
function normalizeSeqSpan(seqOrSpan) {
  if (Array.isArray(seqOrSpan) && seqOrSpan.length >= 2) {
    const lo = Number(seqOrSpan[0]);
    const hi = Number(seqOrSpan[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('seqSpan must be finite numbers');
    }
    return [lo, hi];
  }
  const seq = Number(seqOrSpan);
  if (!Number.isFinite(seq)) {
    throw new Error('seq must be a finite number');
  }
  return [seq, seq];
}

function decideReplay(cursor, seqOrSpan) {
  const [lo, hi] = normalizeSeqSpan(seqOrSpan);
  const expected = (Number(cursor) || 0) + 1;
  if (hi < expected) return { kind: 'duplicate' };
  if (lo > expected) return { kind: 'gap' };
  return { kind: 'next', cursor: hi };
}
// --- END GENERATED from src/replay-decision.mjs ---

function normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent) {
  if (typeof optionsOrOnEvent === 'function' || optionsOrOnEvent === undefined || optionsOrOnEvent === null) {
    return { options: {}, onEvent: optionsOrOnEvent };
  }
  return { options: optionsOrOnEvent, onEvent: maybeOnEvent };
}

function subscribeEnvelope(entity, id, { fields, pace } = {}) {
  const envelope = { type: 'subscribe', entity, id };
  if (fields !== undefined) envelope.fields = fields;
  if (pace !== undefined) envelope.pace = pace;
  return envelope;
}

class ClientClosedError extends Error {
  constructor(message = 'Live channel is closed') {
    super(message);
    this.name = 'ClientClosedError';
  }
}

class LiveSyncSession {
  // `baseUrl` is e.g. 'http://127.0.0.1:5432'. Derives ws:// URL by swapping
  // scheme and appending '/events'. If already ws:// or wss://, uses as-is.
  constructor(baseUrl, options = {}) {
    let wsUrl;
    if (baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://')) {
      wsUrl = baseUrl.replace(/\/$/, '') + '/events';
    } else {
      wsUrl = baseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:')
        .replace(/\/$/, '') + '/events';
    }
    this._wsUrl = wsUrl;
    this._socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));

    // Desired subscriptions are the source of truth. Wire messages are derived
    // from this registry for each socket generation; there is deliberately no
    // raw-message outbox to become stale or contradictory while offline.
    this._subs = new Map();
    // Pending subscribe promises: key → { resolve, reject }
    this._pendingSubs = new Map();
    // Pending unsubscribe: key → { resolve, timeout }
    this._pendingUnsubs = new Map();

    this._socket = null;
    this._state = 'idle';
    this._generation = 0;
    this._connecting = null;
    this._closed = false;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._maxBackoff = options.maxBackoff ?? 5000;
    this._backoffBase = options.backoffBase ?? 200;
    this._watchdog = null;
    this._connCallbacks = new Set();
  }

  // Subscribe to an (entity, id). Opens the WebSocket lazily on first call.
  // Returns a handle `{ currentSeq }` from the server's `subscribed` ack.
  // Rejects with `new Error(message)` if the server sends an `error` envelope
  // before the `subscribed` ack.
  subscribe(entity, id, optionsOrOnEvent, maybeOnEvent) {
    const { options, onEvent } = normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent);
    const key = `${entity}:${String(id)}`;
    if (this._closed) throw new ClientClosedError();
    if (this._subs.has(key)) {
      throw new Error(`already subscribed to ${entity}:${id}`);
    }
    if (this._pendingUnsubs.has(key)) {
      throw new Error(`unsubscribe is still pending for ${entity}:${id}`);
    }

    const ready = new Promise((resolve, reject) => {
      this._subs.set(key, {
        onEvent,
        onCheckpoint: options.onCheckpoint,
        fields: options.fields,
        pace: options.pace,
        envelope: subscribeEnvelope(entity, id, options),
        sentGeneration: 0,
      });
      this._pendingSubs.set(key, { resolve, reject });
    });
    this._openSocket().then(() => {
      this._sendSubscription(key);
    }).catch((err) => {
      const pending = this._pendingSubs.get(key);
      if (pending) {
        this._pendingSubs.delete(key);
        this._subs.delete(key);
        pending.reject(err);
      }
    });
    return ready;
  }

  // Subscribe to a scope string. The scope is the ordered stream key (e.g. "Entity:id"
  // for per-entity, "project:<id>" for room/project streams). interest narrows delivery
  // to a specific entity + id within the scope. Opens the WebSocket lazily on first call.
  subscribeScope(scope, optionsOrOnEvent, maybeOnEvent) {
    const { options, onEvent } = normalizeSubscribeArgs(optionsOrOnEvent, maybeOnEvent);
    const key = scope;
    if (this._closed) throw new ClientClosedError();
    if (this._subs.has(key)) {
      throw new Error(`already subscribed to scope ${scope}`);
    }
    if (this._pendingUnsubs.has(key)) {
      throw new Error(`unsubscribe is still pending for scope ${scope}`);
    }

    const envelope = { type: 'subscribe', scope };
    if (options.interest) envelope.interest = options.interest;
    else if (options.fields !== undefined || options.pace !== undefined) {
      envelope.interest = {};
      if (options.fields !== undefined) envelope.interest.fields = options.fields;
      if (options.pace !== undefined) envelope.interest.pace = options.pace;
    }
    const ready = new Promise((resolve, reject) => {
      this._subs.set(key, {
        onEvent,
        onCheckpoint: options.onCheckpoint,
        fields: options.fields,
        pace: options.pace,
        scope,
        entity: options.interest?.entity,
        id: options.interest?.id,
        envelope,
        sentGeneration: 0,
      });
      this._pendingSubs.set(key, { resolve, reject });
    });
    this._openSocket().then(() => {
      this._sendSubscription(key);
    }).catch((err) => {
      const pending = this._pendingSubs.get(key);
      if (pending) {
        this._pendingSubs.delete(key);
        this._subs.delete(key);
        pending.reject(err);
      }
    });
    return ready;
  }

  // Unsubscribe from an (entity, id). Resolves after the `unsubscribed` ack
  // or a short timeout (2s) if the ack never arrives.
  async unsubscribe(entity, id) {
    const key = `${entity}:${String(id)}`;
    return this._unsubscribe(key, { type: 'unsubscribe', entity, id });
  }

  async _unsubscribe(key, envelope) {
    if (!this._subs.has(key)) return;
    this._subs.delete(key);
    const pendingSub = this._pendingSubs.get(key);
    if (pendingSub) {
      this._pendingSubs.delete(key);
      pendingSub.reject(new ClientClosedError('Live subscription was cancelled'));
    }
    if (!this._socket || this._socket.readyState !== 1) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingUnsubs.delete(key);
        resolve();
      }, 2000);
      if (typeof timeout.unref === 'function') timeout.unref();

      this._pendingUnsubs.set(key, { resolve, timeout });
      if (!this._send(envelope)) {
        clearTimeout(timeout);
        this._pendingUnsubs.delete(key);
        resolve();
      }
    });
  }

  // Unsubscribe from a scope string.
  async unsubscribeScope(scope) {
    return this._unsubscribe(scope, { type: 'unsubscribe', scope });
  }

  // Tear down: close socket, clear all subscriptions, cancel reconnect timer.
  // After close(), no further reconnects or deliveries happen.
  close() {
    if (this._closed) return;
    this._closed = true;
    this._state = 'closing';
    this._generation++;
    this._clearReconnect();
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
    if (this._socket) {
      try { this._socket.close(); } catch { /* ignore */ }
      this._socket = null;
    }
    this._subs.clear();
    for (const [, pending] of this._pendingSubs) {
      pending.reject(new ClientClosedError());
    }
    this._pendingSubs.clear();
    for (const [, p] of this._pendingUnsubs) {
      if (p.timeout) clearTimeout(p.timeout);
      p.resolve();
    }
    this._pendingUnsubs.clear();
    this._connecting = null;
    this._state = 'closed';
    this._emitConnectionStatus('disconnected');
    this._connCallbacks.clear();
  }

  // --- internal ---

  // Open a new WebSocket connection. Returns a promise that resolves when the
  // socket is open (readyState === 1), or rejects on error / timeout.
  // Uses polling on readyState because Node's global WebSocket does not reliably
  // emit the 'open' event across versions.
  _openSocket() {
    if (this._closed) return Promise.reject(new ClientClosedError());
    if (this._socket?.readyState === 1 && this._state === 'online') {
      return Promise.resolve();
    }
    if (this._connecting) return this._connecting;

    this._state = 'connecting';
    const generation = ++this._generation;
    const connecting = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this._socketFactory(this._wsUrl);
      } catch (err) {
        if (generation === this._generation) {
          this._socket = null;
          this._state = 'idle';
        }
        reject(err);
        return;
      }
      let settled = false;
      let pollTimer = null;
      let connectTimeout = null;

      const stopTimers = () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (connectTimeout) { clearTimeout(connectTimeout); connectTimeout = null; }
        if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
      };

      const resolveOpen = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        if (this._closed || generation !== this._generation) {
          try { ws.close(); } catch { /* ignore */ }
          reject(new ClientClosedError());
          return;
        }
        this._reconnectAttempt = 0;
        this._socket = ws;
        this._state = 'online';
        this._emitConnectionStatus('connected');
        this._reconcileDesired();
        // Watchdog: some servers (incl. this framework's hand-rolled WS) do
        // not complete the close handshake — they ack the close frame but
        // never destroy the socket, so the client's 'close' event never fires
        // and readyState sticks at 2 (CLOSING). Poll readyState and fire the
        // same drop path the 'close' listener would when the socket is no
        // longer OPEN. unref'd so it never pins the event loop on its own.
        this._watchdog = setInterval(() => {
          if (this._closed || generation !== this._generation || ws !== this._socket) {
            clearInterval(this._watchdog); this._watchdog = null;
            return;
          }
          if (ws.readyState !== 1) {
            clearInterval(this._watchdog); this._watchdog = null;
            this._retireSocket(ws, generation);
          }
        }, 100);
        if (typeof this._watchdog.unref === 'function') this._watchdog.unref();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        if (generation === this._generation) {
          this._socket = null;
          this._state = 'idle';
        }
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', resolveOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', () => {
        if (generation !== this._generation) return;
        if (!settled) {
          settled = true;
          stopTimers();
          reject(new Error('WebSocket connection closed before opening'));
        }
        this._retireSocket(ws, generation);
      });
      ws.addEventListener('message', (ev) => {
        if (this._closed || generation !== this._generation || ws !== this._socket) return;
        try {
          this._handleEnvelope(JSON.parse(ev.data));
        } catch { /* malformed frame — ignore */ }
      });

      // Poll readyState until OPEN (1) — fallback when 'open' doesn't fire.
      pollTimer = setInterval(() => {
        if (settled) { clearInterval(pollTimer); pollTimer = null; return; }
        if (ws.readyState === 1) resolveOpen();
      }, 20);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();

      // Connection timeout — reject but leave the socket up (it may connect
      // eventually; if it does, the close handler will trigger reconnect).
      connectTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          stopTimers();
          if (generation === this._generation) {
            this._socket = null;
            this._state = 'idle';
          }
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('WebSocket connection timeout'));
        }
      }, 5000);
      if (typeof connectTimeout.unref === 'function') connectTimeout.unref();
    });
    this._connecting = connecting;
    connecting.finally(() => {
      if (this._connecting === connecting) this._connecting = null;
    }).catch(() => {});
    return connecting;
  }

  _retireSocket(ws, generation) {
    if (this._closed || generation !== this._generation) return;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._socket === ws) this._socket = null;
    this._generation++;
    for (const sub of this._subs.values()) sub.sentGeneration = 0;
    this._state = 'backoff';
    this._emitConnectionStatus('disconnected');
    try {
      if (ws.readyState < 2) ws.close();
    } catch { /* ignore */ }
    this._scheduleReconnect();
  }

  _subscriptionEnvelope(key, sub) {
    if (sub.envelope) return sub.envelope;
    const nullSep = key.indexOf('\0');
    if (nullSep > 0) {
      return subscribeEnvelope(key.slice(0, nullSep), key.slice(nullSep + 1), sub);
    }
    const colon = key.indexOf(':');
    if (colon > 0) {
      return subscribeEnvelope(key.slice(0, colon), key.slice(colon + 1), sub);
    }
    const envelope = { type: 'subscribe', scope: key };
    const interest = {};
    if (sub.entity !== undefined) interest.entity = sub.entity;
    if (sub.id !== undefined) interest.id = sub.id;
    if (sub.fields !== undefined) interest.fields = sub.fields;
    if (sub.pace !== undefined) interest.pace = sub.pace;
    if (Object.keys(interest).length > 0) envelope.interest = interest;
    return envelope;
  }

  _sendSubscription(key) {
    const sub = this._subs.get(key);
    if (!sub || sub.sentGeneration === this._generation) return;
    if (this._send(this._subscriptionEnvelope(key, sub))) {
      sub.sentGeneration = this._generation;
    }
  }

  _reconcileDesired() {
    for (const key of this._subs.keys()) this._sendSubscription(key);
  }

  // Route one server envelope to the right handler.
  _handleEnvelope(envelope) {
    const scopeKey = envelope.scope ?? (envelope.entity ? `${envelope.entity}:${String(envelope.id)}` : null);

    if (envelope.type === 'subscribed') {
      const sub = scopeKey ? this._subs.get(scopeKey) : null;
      if (sub && typeof sub.onCheckpoint === 'function') {
        try { sub.onCheckpoint({ currentSeq: envelope.currentSeq }); } catch { /* isolate consumer */ }
      }
      const pending = scopeKey ? this._pendingSubs.get(scopeKey) : null;
      if (pending) {
        this._pendingSubs.delete(scopeKey);
        pending.resolve({ currentSeq: envelope.currentSeq });
      }
    } else if (envelope.type === 'unsubscribed') {
      if (scopeKey) {
        const pending = this._pendingUnsubs.get(scopeKey);
        if (pending) {
          if (pending.timeout) clearTimeout(pending.timeout);
          this._pendingUnsubs.delete(scopeKey);
          pending.resolve();
        }
      }
    } else if (envelope.type === 'error') {
      for (const [key, pending] of this._pendingSubs) {
        this._pendingSubs.delete(key);
        pending.reject(new Error(envelope.message));
      }
    } else if (envelope.type === 'event') {
      const key = scopeKey ?? `${envelope.entity}:${String(envelope.id)}`;
      const sub = this._subs.get(key);
      if (sub && typeof sub.onEvent === 'function') {
        sub.onEvent(envelope);
      }
    }
  }

  // Send only on the current online generation. Desired subscriptions, rather
  // than raw messages, are replayed after a drop.
  _send(data) {
    const ws = this._socket;
    const generation = this._generation;
    if (!ws || ws.readyState !== 1 || this._state !== 'online') return false;
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch {
      this._retireSocket(ws, generation);
      return false;
    }
  }

  // Schedule a reconnection attempt with exponential backoff.
  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    this._emitConnectionStatus('reconnecting');
    const delay = Math.min(
      this._backoffBase * Math.pow(2, this._reconnectAttempt),
      this._maxBackoff,
    );
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closed) return;
      try {
        await this._openSocket();
        this._reconcileDesired();
      } catch {
        if (!this._closed) this._scheduleReconnect();
      }
    }, delay);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  // Cancel any pending reconnect timer.
  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempt = 0;
  }

  // Public connection-state emitter. Registers a callback that receives the
  // connection status ('connected' | 'disconnected' | 'reconnecting') on every
  // transition. Returns an unsubscribe function.
  onConnectionChange(cb) {
    this._connCallbacks.add(cb);
    return () => { this._connCallbacks.delete(cb); };
  }

  _emitConnectionStatus(status) {
    for (const cb of this._connCallbacks) {
      try { cb(status); } catch { /* swallow */ }
    }
  }
}

// Public façade. The state machine stays private so transport lifecycle details
// do not become package API, while existing LiveChannel consumers retain the
// small subscribe/unsubscribe/close surface.
export class LiveChannel extends LiveSyncSession {}

// LiveList — tracks ONE document's live state: a single (entity, id) row,
// including its sub-collection fields. Bootstraps from a REST snapshot, then
// folds live events through ONE reducer path (_ingest → _applyEvent),
// maintaining a sequence cursor. Re-renders on every state change via
// registered onRender callbacks.
//
// Zero external deps — uses injected fetch and channel (no real server needed
// for tests).
export class LiveList {
  constructor({
    entity,
    id,
    channel,
    fetchImpl,
    snapshotUrl,
    eventsSinceUrl,
    fields,
    pace,
    maxBufferedEvents = 1000,
    resyncBackoffBase = 200,
    maxResyncBackoff = 5000,
  }) {
    this._entity = entity;
    this._id = id;
    this._channel = channel;
    this._fetchImpl = fetchImpl ?? globalThis.fetch;
    this._snapshotUrl = snapshotUrl;
    this._eventsSinceUrl = eventsSinceUrl;
    this._fields = fields;
    this._pace = pace;

    this._state = null;
    this._cursor = 0;
    this._ready = false;
    this._closed = false;
    this._epoch = 0;
    this._abortController = new AbortController();
    this._subscribeCalled = false;
    this._resyncing = false;
    this._queue = [];               // Buffered live envelopes (before ready / during resync)
    this._maxBufferedEvents = maxBufferedEvents;
    this._bufferOverflow = false;
    this._resyncBackoffBase = resyncBackoffBase;
    this._maxResyncBackoff = maxResyncBackoff;
    this._resyncAttempt = 0;
    this._resyncRetryTimer = null;
    this._renderCallbacks = new Set();
    this._ordered = {};             // { [field]: [{id, key, item}] } — internal ordered tracking
    this._removed = false;

    // Promise that resolves when bootstrap completes — accessible via .ready
    this._readyResolve = null;
    this._readyReject = null;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // Consumers may await either subscribe() or .ready. Keep an ignored branch
    // so rejecting readiness during teardown never becomes an unhandled promise.
    this._readyPromise.catch(() => {});
  }

  // --- Public API ---

  /** Current document state (plain object), or null if removed. */
  get state() { return this._state; }

  /** Current sequence cursor. */
  get cursor() { return this._cursor; }

  /** Promise that resolves when bootstrap completes (same as subscribe()). */
  get ready() { return this._readyPromise; }

  /**
   * Bootstrap: snapshot → subscribe → (resync if gap) → drain queue → render.
   * Resolves only after the full bootstrap sequence completes. Throws if called twice.
   */
  async subscribe() {
    if (this._subscribeCalled) throw new Error('subscribe already called');
    this._subscribeCalled = true;
    const epoch = this._epoch;

    try {
      // 1. GET snapshot → initial state + cursor
      const snapRes = await this._fetchImpl(
        this._snapshotUrl(this._entity, this._id),
        { signal: this._abortController.signal },
      );
      const { snapshot, seq } = await this._decode(snapRes);
      this._assertActive(epoch);
      this._state = snapshot;
      this._cursor = seq;
      this._removed = false;

      // 2. Subscribe to live channel.
      //    During the subscribe await, any live envelopes arrive via _onLiveEnvelope,
      //    which queues them because _ready is still false.
      const ack = await this._channel.subscribe(this._entity, this._id, {
        fields: this._fields,
        pace: this._pace,
        onCheckpoint: ({ currentSeq }) => this._onCheckpoint(currentSeq),
      }, (envelope) => {
        this._onLiveEnvelope(envelope);
      });
      this._assertActive(epoch);

      // 3. If the server has progressed past our snapshot cursor, there is a
      //    race-gap — resync via events-since BEFORE releasing the queue.
      if (this._bufferOverflow) {
        await this._resync(true);
        this._assertActive(epoch);
      } else if (ack.currentSeq > this._cursor) {
        await this._resync();
        this._assertActive(epoch);
      }

      // 4. Drain the queue (envelopes that arrived during subscribe + resync).
      this._ready = true;
      const queue = this._queue;
      this._queue = [];
      for (const envelope of queue) {
        this._ingest(this._normalizeLive(envelope));
      }

      // 5. Render initial state, then resolve.
      this._render();
      this._readyResolve();
    } catch (err) {
      this._readyReject(err);
      throw err;
    }
  }

  /**
   * Register a render callback. Called with the current state on every state
   * change. Returns an unsubscribe function.
   */
  onRender(cb) {
    this._renderCallbacks.add(cb);
    return () => this._renderCallbacks.delete(cb);
  }

  /** Tear down: unsubscribe from channel, clear callbacks, stop folding. Idempotent. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._epoch++;
    this._abortController.abort();
    if (this._resyncRetryTimer) {
      clearTimeout(this._resyncRetryTimer);
      this._resyncRetryTimer = null;
    }
    this._renderCallbacks.clear();
    this._queue = [];
    if (!this._ready) this._readyReject(new ClientClosedError('Live list closed before it became ready'));
    try { await this._channel.unsubscribe(this._entity, this._id); } catch { /* ignore */ }
  }

  // --- Internal ---

  /** Minimal fetch response decoder. */
  _decode(res) {
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  _assertActive(epoch) {
    if (this._closed || epoch !== this._epoch) {
      throw new ClientClosedError('Live list is closed');
    }
  }

  _onCheckpoint(currentSeq) {
    if (this._closed || !this._ready || currentSeq <= this._cursor) return;
    this._resync().catch(() => {});
  }

  /**
   * Called by the channel for every live envelope. Queues if not yet ready
   * or currently resyncing; otherwise ingests directly.
   */
  _onLiveEnvelope(envelope) {
    if (this._closed) return;
    if (!this._ready || this._resyncing) {
      this._bufferEnvelope(envelope);
      return;
    }
    this._ingest(this._normalizeLive(envelope));
  }

  _bufferEnvelope(envelope) {
    if (this._queue.length >= this._maxBufferedEvents) {
      this._queue = [];
      this._bufferOverflow = true;
      return;
    }
    if (!this._bufferOverflow) this._queue.push(envelope);
  }

  /** Normalize a live WS envelope to internal shape {seq, seqSpan, event, delta}. */
  _normalizeLive(envelope) {
    return {
      seq: envelope.seq,
      seqSpan: envelope.seqSpan,
      event: envelope.event,
      delta: envelope.delta,
    };
  }

  /**
   * THE ONE fold path. Both live envelopes and events-since rows converge here
   * (after normalization). Span-aware cursor logic:
   *
   *   expected = cursor + 1
   *
   *   seqSpan[1] < expected → duplicate (skip)
   *   seqSpan[0] > expected → gap (trigger resync, return without applying)
   *   else                  → apply, advance cursor to seqSpan[1], render
   */
  _ingest(normalized) {
    if (this._closed) return;
    const { seqSpan, event, delta } = normalized;
    const decision = decideReplay(this._cursor, seqSpan);

    if (decision.kind === 'duplicate') {
      return;
    }
    if (decision.kind === 'gap') {
      // Gap — missing events. Queue this envelope then trigger a resync;
      // after the resync fills the gap, the queue drain will re-process it
      // through _ingest when the cursor is caught up.
      this._bufferEnvelope({ seq: normalized.seq, seqSpan, event, delta });
      this._resync().catch(() => {});
      return;
    }
    // next — apply and advance cursor to span hi (shared Replay decision)
    this._applyEvent(event, delta);
    this._cursor = decision.cursor;
    this._render();
  }

  /**
   * Resync: fetch events-since from the server to fill a gap or stale state.
   * Handles two response shapes:
   *   {resync:'stale', reason}  → forced re-bootstrap from fresh snapshot
   *   {events:[...]}           → fold each row in order (bypass span dup/gap logic)
   *
   * During resync, any arriving live envelopes are queued; they are drained and
   * ingested after the resync completes.
   */
  async _resync(forceSnapshot = false) {
    if (this._resyncing) return; // prevent re-entrancy
    this._resyncing = true;
    const epoch = this._epoch;
    let failed = false;

    try {
      let body = null;
      if (!forceSnapshot) {
        const res = await this._fetchImpl(
          this._eventsSinceUrl(this._entity, this._id, this._cursor),
          { signal: this._abortController.signal },
        );
        body = await this._decode(res);
        this._assertActive(epoch);
      }

      if (forceSnapshot || this._bufferOverflow || body?.resync === 'stale') {
        // Forced re-bootstrap: fresh snapshot replaces state entirely.
        const snapRes = await this._fetchImpl(
          this._snapshotUrl(this._entity, this._id),
          { signal: this._abortController.signal },
        );
        const { snapshot, seq } = await this._decode(snapRes);
        this._assertActive(epoch);
        this._state = snapshot;
        this._cursor = seq;
        this._removed = false;
        this._ordered = {};
        this._bufferOverflow = false;
        this._queue = [];
      } else if (body?.events) {
        // Fold events-since rows in order. Events-since is authoritative
        // ordered fill — apply seq>cursor rows directly without span checks.
        for (const row of body.events) {
          if (row.seq > this._cursor) {
            const normalized = {
              seq: row.seq,
              seqSpan: [row.seq, row.seq],
              event: { type: row.type, data: row.data, actionId: row.actionId },
              delta: undefined,
            };
            this._applyEvent(normalized.event, normalized.delta);
            this._cursor = row.seq;
          }
        }
      }
    } catch {
      failed = true;
    }

    this._resyncing = false;
    if (this._closed || epoch !== this._epoch) return;
    if (failed) {
      this._scheduleResync();
      return;
    }
    this._resyncAttempt = 0;

    // Drain any envelopes that arrived during the resync.
    const queue = this._queue;
    this._queue = [];
    for (const envelope of queue) {
      this._ingest(this._normalizeLive(envelope));
    }

    this._render();
  }

  _scheduleResync() {
    if (this._closed || this._resyncRetryTimer) return;
    const delay = Math.min(
      this._resyncBackoffBase * Math.pow(2, this._resyncAttempt),
      this._maxResyncBackoff,
    );
    this._resyncAttempt++;
    this._resyncRetryTimer = setTimeout(() => {
      this._resyncRetryTimer = null;
      if (!this._closed) this._resync(this._bufferOverflow).catch(() => {});
    }, delay);
    if (typeof this._resyncRetryTimer.unref === 'function') this._resyncRetryTimer.unref();
  }

  /**
   * Kind-aware reducer. Parse event.type by splitting on '.':
   *   2-part = entity.verb  (CRUD: created / updated / removed)
   *   3-part = entity.field.op  (field-specific: ordered, map, log ops)
   */
  _applyEvent(event, delta) {
    if (!event || !event.type) return;
    const parts = event.type.split('.');
    if (parts.length < 2) return;

    if (parts.length === 2) {
      this._applyCrud(parts[1], event, delta);
    } else if (parts.length === 3) {
      this._applyFieldOp(parts[1], parts[2], event);
    }
  }

  /** CRUD operations (2-part types: ticket.created / .updated / .removed). */
  _applyCrud(verb, event, delta) {
    switch (verb) {
      case 'created':
        this._state = { ...event.data };
        this._removed = false;
        this._ordered = {};
        break;

      case 'updated': {
        if (this._state == null) {
          this._state = {};
          this._removed = false;
        }
        // Value-XOR-delta: the server sends BOTH the whole new value (event.data)
        // and a per-field delta for diff-eligible/native kinds. A field present
        // in `delta` is applied ONLY via the delta below — assigning its whole
        // value here too would double-apply (e.g. a crdt insert on top of the
        // already-whole string). So skip any field the delta owns; event.data
        // remains authoritative for scalar fields the delta does NOT carry
        // (preserving the createClient app-reducer whole-value contract).
        // Exclude 'id' — it's an identity field.
        if (event.data) {
          for (const key of Object.keys(event.data)) {
            if (key === 'id') continue;
            if (delta && Object.prototype.hasOwnProperty.call(delta, key)) continue;
            this._state[key] = event.data[key];
          }
        }
        // Apply per-kind delta for the fields the delta owns.
        if (delta) {
          this._applyDelta(delta);
        }
        break;
      }

      case 'removed':
        this._state = null;
        this._removed = true;
        break;
    }
  }

  /**
   * Apply per-kind delta objects: value, state, crdt, struct, or map.
   * delta is { [field]: deltaObj, ... }.
   */
  _applyDelta(delta) {
    for (const [field, d] of Object.entries(delta)) {
      if (d == null) continue;
      try {
        if ('set' in d) {
          // Value delta: {set: v}
          this._state[field] = d.set;
        } else if ('from' in d && 'to' in d) {
          // State delta: {from, to}
          this._state[field] = d.to;
        } else if ('delete' in d || 'insert' in d) {
          // CRDT delta: {delete?:{at,length}, insert?:{at,text}}
          // DELETE FIRST, THEN INSERT — both offsets are relative to the
          // post-delete string at the same `at`.
          let s = this._state[field] ?? '';
          if (d.delete) {
            s = s.slice(0, d.delete.at) + s.slice(d.delete.at + d.delete.length);
          }
          if (d.insert) {
            s = s.slice(0, d.insert.at) + d.insert.text + s.slice(d.insert.at);
          }
          this._state[field] = s;
        } else if ('cells' in d) {
          // Struct delta: {cells: {[name]: {set: v}}}
          this._state[field] = { ...(this._state[field] ?? {}) };
          for (const [name, cell] of Object.entries(d.cells)) {
            this._state[field][name] = cell.set;
          }
        } else if ('added' in d || 'removed' in d || 'changed' in d) {
          // Map delta (native storeMapDiff): {added:[], removed:[], changed:[]}
          const m = { ...(this._state[field] ?? {}) };
          if (d.added) {
            for (const entry of d.added) {
              m[entry.member] = entry.role;
            }
          }
          if (d.changed) {
            for (const entry of d.changed) {
              m[entry.member] = entry.role;
            }
          }
          if (d.removed) {
            for (const member of d.removed) {
              delete m[member];
            }
          }
          this._state[field] = m;
        }
      } catch {
        // Malformed delta for this field — skip.
      }
    }
  }

  /**
   * Field-specific operations (3-part types: ticket.field.op).
   * Dispatches by operation name AND data shape:
   *   inserted/moved/reordered  → ordered
   *   appended                  → log
   *   added/changed             → map
   *   removed                   → map if data.member, ordered if data.id
   */
  _applyFieldOp(field, op, event) {
    const data = event.data;
    if (!data) return;

    switch (op) {
      case 'inserted':
      case 'moved':
      case 'reordered':
        this._applyOrderedOp(field, op, data);
        break;

      case 'appended':
        // Log append — push the full data as an entry.
        this._state[field] = [...(this._state[field] ?? []), data];
        break;

      case 'added':
      case 'changed': {
        // Map add/change — {member, role}
        const m = { ...(this._state[field] ?? {}) };
        m[data.member] = data.role;
        this._state[field] = m;
        break;
      }

      case 'removed': {
        // Disambiguate: 3-part .removed could be map or ordered.
        // data.member → map remove; data.id → ordered remove.
        if ('member' in data) {
          const m = { ...(this._state[field] ?? {}) };
          delete m[data.member];
          this._state[field] = m;
        } else if ('id' in data) {
          this._applyOrderedOp(field, 'removed', data);
        }
        break;
      }
    }
  }

  /**
   * Ordered sub-collection operations. Maintains internal _ordered[field] as
   * an array of {id, key, item}. After every op, sorts by key (lexicographic
   * String compare) and exposes state[field] as the sorted item values array.
   */
  _applyOrderedOp(field, op, data) {
    // Seed lazily — start from empty if this is the first ordered op.
    if (!this._ordered[field]) {
      this._ordered[field] = [];
    }
    const entries = this._ordered[field];

    switch (op) {
      case 'inserted':
        entries.push({ id: data.id, key: data.key, item: data.value });
        break;

      case 'moved':
        for (const entry of entries) {
          if (entry.id === data.id) {
            entry.key = data.key;
            break;
          }
        }
        break;

      case 'reordered': {
        const keyMap = new Map();
        if (data.entries) {
          for (const e of data.entries) {
            keyMap.set(e.id, e.key);
          }
        }
        for (const entry of entries) {
          if (keyMap.has(entry.id)) {
            entry.key = keyMap.get(entry.id);
          }
        }
        break;
      }

      case 'removed':
        this._ordered[field] = entries.filter(e => e.id !== data.id);
        break;
    }

    // Sort by key ascending. The server's ordered side-table stores `key` as a
    // REAL (numeric) column (ddl.mjs:108 `key REAL NOT NULL`) and orders rows via
    // SQLite `ORDER BY key` (entity.mjs:581) — a NUMERIC sort. The fractional key
    // is produced by numeric midpoint math (entity.mjs:588 keyBetween: (low+high)/2,
    // low+1, high-1, 0). So the client MUST sort numerically to match the server;
    // a string/locale compare would mis-order (e.g. 2 before 10) and diverge.
    this._ordered[field].sort((a, b) => a.key - b.key);

    // Expose as the sorted array of item values.
    this._state[field] = this._ordered[field].map(e => e.item);
  }

  /** Call every registered onRender callback with the current state. */
  _render() {
    for (const cb of this._renderCallbacks) {
      try { cb(this.state); } catch { /* swallow render errors */ }
    }
  }
}

// ---------------------------------------------------------------------------
// createLiveStore — client SDK store: LiveList cache + optimistic dispatch + overlays.
// ---------------------------------------------------------------------------

/**
 * Shared HTTP response decoder.
 *  - 204 (remove): returns `{ ok: true }`
 *  - non-ok:       returns `{ ok: false, error: 'http ' + res.status }`
 *  - ok with body: returns the parsed JSON body as-is
 */
export async function decodeResult(res) {
  if (res.status === 204) return { ok: true };
  if (!res.ok) return { ok: false, error: 'http ' + res.status };
  return res.json();
}

/**
 * Create a live store for one entity type.
 *
 * Options:
 *   baseUrl     – server origin (e.g. 'http://127.0.0.1:5432')
 *   name        – entity name (e.g. 'Doc')
 *   path        – CRUD mount path (e.g. '/docs')
 *   channel     – LiveChannel instance (optional, defaults to new LiveChannel(baseUrl))
 *   fetchImpl   – fetch function (optional, defaults to globalThis.fetch)
 *
 * Returns a store object with: subscribe, dispatch, create, update, remove,
 * action, close, overlayFor, overlayStatusFor, pendingCreates, onRender.
 */
export function createLiveStore({ baseUrl, name, path, channel, fetchImpl }) {
  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;

  let _opIdCounter = 0;
  const _listCache = new Map();     // id → LiveList
  const _listOptions = new Map();   // id → serialized subscribe options
  const _overlay = new Map();       // opId → overlay entry
  const _renderCallbacks = new Set();
  const _listUnsubs = new Map();    // id → LiveList.onRender unsub
  const _actionRoutes = new Map();  // actionType → { method, path }
  let _closed = false;

  function _nextOpId() {
    return 'op_' + (++_opIdCounter);
  }

  function _snapshotUrl(entity, id) {
    return `${baseUrl}/snapshot/${entity}/${id}`;
  }

  function _eventsSinceUrl(entity, id, cursor) {
    return `${baseUrl}/events-since/${entity}/${id}?cursor=${cursor}`;
  }

  // --- Overlay helpers ---

  function _clearConfirmedOverlays(id) {
    const list = _listCache.get(id);
    if (!list) return;

    for (const [opId, entry] of _overlay) {
      if (entry.id !== id || entry.status !== 'confirmed') continue;
      if (entry.confirmedSeq != null && list.cursor >= entry.confirmedSeq) {
        _overlay.delete(opId);
      }
    }
  }

  function _responseHeader(res, name) {
    return res?.headers?.get?.(name) ?? null;
  }

  function _confirmedSeq(res) {
    const value = _responseHeader(res, 'x-workbench-seq');
    if (value == null || value === '') return null;
    const seq = Number(value);
    return Number.isFinite(seq) ? seq : null;
  }

  function _storeRender() {
    for (const cb of _renderCallbacks) {
      try { cb(); } catch { /* swallow */ }
    }
  }

  // --- Subscribe ---

  function _subscribeLiveList(id, options = {}) {
    if (_closed) throw new Error('store is closed');
    if (_listCache.has(id)) {
      const prev = _listOptions.get(id);
      const cur = JSON.stringify({ fields: options.fields ?? null, pace: options.pace ?? null });
      if (prev !== cur) {
        throw new Error(`conflicting subscribe options for ${id}: already subscribed with different interest`);
      }
      return _listCache.get(id);
    }

    const list = new LiveList({
      entity: name,
      id,
      channel: resolvedChannel,
      fetchImpl: resolvedFetch,
      snapshotUrl: _snapshotUrl,
      eventsSinceUrl: _eventsSinceUrl,
      fields: options.fields,
      pace: options.pace,
    });

    _listCache.set(id, list);
    _listOptions.set(id, JSON.stringify({ fields: options.fields ?? null, pace: options.pace ?? null }));

    // Subscribe to LiveList onRender for overlay clearing + store render propagation
    const unsub = list.onRender(() => {
      _clearConfirmedOverlays(id);
      _storeRender();
    });
    _listUnsubs.set(id, unsub);

    // Boot strap (do not await — caller may await list.ready)
    list.subscribe().catch(() => {});

    return list;
  }

  // --- Overlay queries ---

  function overlayFor(id) {
    // Find the most recent (insertion-order) non-failed overlay for this id
    let entry = null;
    for (const e of _overlay.values()) {
      if (e.status === 'failed') continue;
      if (e.id === id) entry = e;
    }

    if (!entry) {
      const list = _listCache.get(id);
      return list ? list.state : null;
    }

    if (entry.kind === 'remove') return null;
    // Return authoritative row if confirmed, else optimistic guess
    return entry.row ?? entry.optimistic;
  }

  function overlayStatusFor(id) {
    let entry = null;
    for (const e of _overlay.values()) {
      if (e.status === 'failed') continue;
      if (e.id === id) entry = e;
    }
    if (!entry) return null;
    return { status: entry.status, kind: entry.kind, error: entry.error ?? null, opId: entry.opId };
  }

  function pendingCreates() {
    const result = [];
    for (const entry of _overlay.values()) {
      if (entry.kind === 'create' && entry.status === 'pending') {
        result.push(entry);
      }
    }
    return result;
  }

  // --- Dispatch (optimistic CRUD) ---

  async function dispatch(type, payload) {
    const opId = _nextOpId();

    // dispatch NEVER throws. Failures before transmission are known rollbacks;
    // a lost response after fetch starts has an unknown server outcome.
    if (_closed) {
      return { ok: false, status: 'failed-rolled-back', opId, error: 'store is closed' };
    }

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
      return { ok: false, status: 'failed-rolled-back', opId, error: 'unknown action type: ' + type };
    }

    // Capture preimage for rollback (the effective state before this op)
    const preimage = id ? overlayFor(id) : null;

    // Build optimistic overlay row
    let optimistic = null;
    if (kind === 'create') {
      optimistic = { ...payload };
    } else if (kind === 'update') {
      optimistic = { ...(preimage ?? {}), ...payload };
      delete optimistic.id;
      optimistic = { id, ...optimistic };
    }
    // remove: optimistic stays null

    // Create overlay entry (status: pending)
    const entry = { opId, id: id ?? null, kind, optimistic, status: 'pending', row: null, confirmedSeq: null };
    _overlay.set(opId, entry);
    _storeRender();

    // Fire REST. Keep requestAttempted separate from the optimistic state so a
    // local encoding failure cannot be mistaken for an uncertain server write.
    let requestAttempted = false;
    try {
      let method, url, body;
      if (kind === 'create') {
        method = 'POST';
        url = `${baseUrl}${path}`;
        body = JSON.stringify(payload);
      } else if (kind === 'update') {
        method = 'PATCH';
        url = `${baseUrl}${path}/${id}`;
        body = JSON.stringify(payload);
      } else {
        method = 'DELETE';
        url = `${baseUrl}${path}/${id}`;
        body = undefined;
      }

      const fetchOpts = { method, credentials: 'include' };
      if (body !== undefined) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = body;
      }

      requestAttempted = true;
      const res = await resolvedFetch(url, fetchOpts);
      const decoded = await decodeResult(res);

      if (decoded && decoded.ok === false) {
        // Failure — roll back
        _overlay.delete(opId);
        _storeRender();
        return { ok: false, status: 'failed-rolled-back', opId, error: decoded.error };
      }

      // Success
      const is204 = res.status === 204;
      const returnedRow = is204 ? undefined : decoded;
      let realId = id;

      if (kind === 'create') {
        realId = returnedRow && returnedRow.id;
      }

      // Update overlay entry
      entry.status = 'confirmed';
      entry.id = realId;
      entry.row = returnedRow ?? null;
      entry.confirmedSeq = _confirmedSeq(res);

      if (kind === 'create') {
        _overlay.delete(opId);
      }
      _storeRender();

      return {
        ok: true,
        status: 'committed',
        opId,
        id: realId,
        row: kind === 'remove' ? undefined : returnedRow,
      };
    } catch (err) {
      // Never leave uncertain optimistic data visible as if it were committed.
      _overlay.delete(opId);
      _storeRender();
      return {
        ok: false,
        status: requestAttempted ? 'outcome-unknown' : 'failed-rolled-back',
        opId,
        error: err.message ?? String(err),
      };
    }
  }

  // --- Action route registry ---

  function action(actionType, { method, path: actionPath }) {
    _actionRoutes.set(actionType, { method, path: actionPath });

    // Return a helper function the caller can invoke
    const fn = async (body) => {
      const route = _actionRoutes.get(actionType);
      if (!route) throw new Error(`unknown action: ${actionType}`);

      const opts = { method: route.method, credentials: 'include' };
      if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }

      try {
        const res = await resolvedFetch(`${baseUrl}${route.path}`, opts);
        return decodeResult(res);
      } catch (err) {
        return { ok: false, error: err.message ?? String(err) };
      }
    };

    // Also attach to the store object so store.<actionType>() works
    store[actionType] = fn;
    return fn;
  }

  // --- Close ---

  function close() {
    if (_closed) return;
    _closed = true;

    for (const unsub of _listUnsubs.values()) {
      unsub();
    }
    for (const list of _listCache.values()) {
      list.close().catch(() => {});
    }
    resolvedChannel.close();

    _listCache.clear();
    _listOptions.clear();
    _listUnsubs.clear();
    _overlay.clear();
    _renderCallbacks.clear();
  }

  // --- Store object ---

  const store = {
    subscribe: _subscribeLiveList,
    dispatch,
    create(payload) { return dispatch(`${name}.create`, payload); },
    update(id, payload) { return dispatch(`${name}.update`, { id, ...payload }); },
    remove(id) { return dispatch(`${name}.remove`, { id }); },
    action,
    close,
    overlayFor,
    overlayStatusFor,
    pendingCreates,
    onRender(cb) {
      _renderCallbacks.add(cb);
      return () => _renderCallbacks.delete(cb);
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// createAuthClient — login/logout against the framework's `/auth` battery.
// ---------------------------------------------------------------------------
//
// Thin fetch wrappers over `/auth/login` and `/auth/logout` with
// `credentials: 'include'` so the browser sends and stores the fail-closed
// `sid` cookie the server sets on login. The token lives in the cookie, never
// client JS (HttpOnly), so the client never holds a credential it can leak.
// Independent of the live-store machinery — a page may auth before subscribing.
// `login` returns the parsed JSON body (`{ user: { id, username } }`); both
// throw on a non-2xx response with the server's error message.

export function createAuthClient({ baseUrl, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;

  async function login(username, password) {
    const res = await fetchFn(`${baseUrl}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let message = `http ${res.status}`;
      try { const body = await res.json(); if (body?.error) message = body.error; } catch { /* keep status */ }
      throw new Error(message);
    }
    return res.json();
  }

  async function logout() {
    const res = await fetchFn(`${baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok && res.status !== 204) {
      let message = `http ${res.status}`;
      try { const body = await res.json(); if (body?.error) message = body.error; } catch { /* keep status */ }
      throw new Error(message);
    }
    // logout responds 204 with no body; return a plain ok marker for callers.
    return { ok: true };
  }

  return { login, logout };
}
