// LiveChannel — WebSocket transport layer for express+ live sync.
//
// Slice A of the client SDK. ONE WebSocket per channel, multiplexed across
// entity/id subscriptions. Auto-reconnects with exponential backoff. Zero
// external dependencies — uses Node's global WebSocket (Node 22+).
//
// Protocol (matches src/live.mjs verbatim):
//   client → server: {type:'subscribe', entity, id} / {type:'unsubscribe', entity, id}
//   server → client: {type:'subscribed', entity, id, currentSeq}
//                    {type:'unsubscribed', entity, id}
//                    {type:'event', entity, id, seq, seqSpan, event, delta?}
//                    {type:'error', message}

export class LiveChannel {
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

    // Subscription registry: `${entity}\0${id}` → { onEvent }
    this._subs = new Map();
    // Pending subscribe promises: key → { resolve, reject }
    this._pendingSubs = new Map();
    // Pending unsubscribe: key → { resolve, timeout }
    this._pendingUnsubs = new Map();

    this._socket = null;
    this._closed = false;
    this._outbox = [];
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._maxBackoff = options.maxBackoff ?? 5000;
    this._backoffBase = options.backoffBase ?? 200;
    this._watchdog = null;
  }

  // Subscribe to an (entity, id). Opens the WebSocket lazily on first call.
  // Returns a handle `{ currentSeq }` from the server's `subscribed` ack.
  // Rejects with `new Error(message)` if the server sends an `error` envelope
  // before the `subscribed` ack.
  async subscribe(entity, id, onEvent) {
    const key = `${entity}\0${String(id)}`;
    if (this._subs.has(key)) {
      throw new Error(`already subscribed to ${entity}:${id}`);
    }

    // Open socket lazily on first subscribe.
    if (!this._socket || this._socket.readyState > 1) {
      await this._openSocket();
    }

    return new Promise((resolve, reject) => {
      this._subs.set(key, { onEvent });
      this._pendingSubs.set(key, { resolve, reject });
      this._send({ type: 'subscribe', entity, id });
    });
  }

  // Unsubscribe from an (entity, id). Resolves after the `unsubscribed` ack
  // or a short timeout (2s) if the ack never arrives.
  async unsubscribe(entity, id) {
    const key = `${entity}\0${String(id)}`;
    if (!this._subs.has(key)) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._subs.delete(key);
        this._pendingUnsubs.delete(key);
        resolve();
      }, 2000);
      if (typeof timeout.unref === 'function') timeout.unref();

      this._pendingUnsubs.set(key, { resolve, timeout });
      this._send({ type: 'unsubscribe', entity, id });
    });
  }

  // Tear down: close socket, clear all subscriptions, cancel reconnect timer.
  // After close(), no further reconnects or deliveries happen.
  close() {
    this._closed = true;
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
    this._pendingSubs.clear();
    for (const [, p] of this._pendingUnsubs) {
      if (p.timeout) clearTimeout(p.timeout);
    }
    this._pendingUnsubs.clear();
    this._outbox = [];
  }

  // --- internal ---

  // Open a new WebSocket connection. Returns a promise that resolves when the
  // socket is open (readyState === 1), or rejects on error / timeout.
  // Uses polling on readyState because Node's global WebSocket does not reliably
  // emit the 'open' event across versions.
  _openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl);
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
        // Race guard: if close() ran while this socket was opening, tear it
        // down and resolve WITHOUT installing it (a leaked open socket would
        // keep the event loop alive + steal the _socket slot).
        if (this._closed) {
          try { ws.close(); } catch { /* ignore */ }
          resolve();
          return;
        }
        this._reconnectAttempt = 0;
        this._socket = ws;
        this._flushOutbox();
        // Watchdog: some servers (incl. this framework's hand-rolled WS) do
        // not complete the close handshake — they ack the close frame but
        // never destroy the socket, so the client's 'close' event never fires
        // and readyState sticks at 2 (CLOSING). Poll readyState and fire the
        // same drop path the 'close' listener would when the socket is no
        // longer OPEN. unref'd so it never pins the event loop on its own.
        this._watchdog = setInterval(() => {
          if (this._closed || ws !== this._socket) {
            clearInterval(this._watchdog); this._watchdog = null;
            return;
          }
          if (ws.readyState !== 1) {
            clearInterval(this._watchdog); this._watchdog = null;
            this._socket = null;
            this._scheduleReconnect();
          }
        }, 100);
        if (typeof this._watchdog.unref === 'function') this._watchdog.unref();
        resolve();
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        stopTimers();
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', resolveOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', () => {
        if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
        // Clear socket reference immediately so the test can detect the old
        // socket was replaced. The reconnect timer assigns a new socket when
        // the new connection opens.
        if (this._socket === ws) this._socket = null;
        if (!this._closed) this._scheduleReconnect();
      });
      ws.addEventListener('message', (ev) => {
        if (this._closed) return;
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
          reject(new Error('WebSocket connection timeout'));
        }
      }, 5000);
      if (typeof connectTimeout.unref === 'function') connectTimeout.unref();
    });
  }

  // Route one server envelope to the right handler.
  _handleEnvelope(envelope) {
    if (envelope.type === 'subscribed') {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      const pending = this._pendingSubs.get(key);
      if (pending) {
        this._pendingSubs.delete(key);
        pending.resolve({ currentSeq: envelope.currentSeq });
      }
    } else if (envelope.type === 'unsubscribed') {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      this._subs.delete(key);
      const pending = this._pendingUnsubs.get(key);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this._pendingUnsubs.delete(key);
        pending.resolve();
      }
    } else if (envelope.type === 'error') {
      // Error envelopes carry no entity/id. Reject ALL pending subscribes so
      // no caller is left hanging.
      for (const [key, pending] of this._pendingSubs) {
        this._pendingSubs.delete(key);
        pending.reject(new Error(envelope.message));
      }
    } else if (envelope.type === 'event') {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      const sub = this._subs.get(key);
      if (sub && typeof sub.onEvent === 'function') {
        sub.onEvent(envelope);
      }
    }
  }

  // Buffer-safe send: queues into outbox if socket is not yet open.
  _send(data) {
    const msg = JSON.stringify(data);
    if (this._socket && this._socket.readyState === 1) {
      try { this._socket.send(msg); } catch { /* will retry via outbox */ }
    } else {
      this._outbox.push(msg);
    }
  }

  // Flush the buffered outbox into the socket.
  _flushOutbox() {
    const queue = this._outbox;
    this._outbox = [];
    for (const msg of queue) {
      try {
        if (this._socket && this._socket.readyState === 1) {
          this._socket.send(msg);
        } else {
          this._outbox.push(msg);
        }
      } catch { /* skip */ }
    }
  }

  // Schedule a reconnection attempt with exponential backoff.
  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
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
        // Re-subscribe every active subscription (the server lost state on
        // socket close).
        for (const [key] of this._subs) {
          const sep = key.indexOf('\0');
          const entity = key.slice(0, sep);
          const id = key.slice(sep + 1);
          this._send({ type: 'subscribe', entity, id });
        }
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
}

// LiveList — tracks ONE document's live state: a single (entity, id) row,
// including its sub-collection fields. Bootstraps from a REST snapshot, then
// folds live events through ONE reducer path (_ingest → _applyEvent),
// maintaining a sequence cursor. Re-renders on every state change via
// registered onRender callbacks.
//
// Zero external deps — uses injected fetch and channel (no real server needed
// for tests).
export class LiveList {
  constructor({ entity, id, channel, fetchImpl, snapshotUrl, eventsSinceUrl }) {
    this._entity = entity;
    this._id = id;
    this._channel = channel;
    this._fetchImpl = fetchImpl ?? globalThis.fetch;
    this._snapshotUrl = snapshotUrl;
    this._eventsSinceUrl = eventsSinceUrl;

    this._state = null;
    this._cursor = 0;
    this._ready = false;
    this._closed = false;
    this._subscribeCalled = false;
    this._resyncing = false;
    this._queue = [];               // Buffered live envelopes (before ready / during resync)
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

    try {
      // 1. GET snapshot → initial state + cursor
      const snapRes = await this._fetchImpl(this._snapshotUrl(this._entity, this._id));
      const { snapshot, seq } = await this._decode(snapRes);
      this._state = snapshot;
      this._cursor = seq;
      this._removed = false;

      // 2. Subscribe to live channel.
      //    During the subscribe await, any live envelopes arrive via _onLiveEnvelope,
      //    which queues them because _ready is still false.
      const ack = await this._channel.subscribe(this._entity, this._id, (envelope) => {
        this._onLiveEnvelope(envelope);
      });

      // 3. If the server has progressed past our snapshot cursor, there is a
      //    race-gap — resync via events-since BEFORE releasing the queue.
      if (ack.currentSeq > this._cursor) {
        await this._resync();
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
    try { await this._channel.unsubscribe(this._entity, this._id); } catch { /* ignore */ }
    this._renderCallbacks.clear();
    this._queue = [];
  }

  // --- Internal ---

  /** Minimal fetch response decoder. */
  _decode(res) {
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  /**
   * Called by the channel for every live envelope. Queues if not yet ready
   * or currently resyncing; otherwise ingests directly.
   */
  _onLiveEnvelope(envelope) {
    if (this._closed) return;
    if (!this._ready || this._resyncing) {
      this._queue.push(envelope);
      return;
    }
    this._ingest(this._normalizeLive(envelope));
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
    const exp = this._cursor + 1;

    if (seqSpan[1] < exp) {
      // Duplicate — already applied
      return;
    }
    if (seqSpan[0] > exp) {
      // Gap — missing events. Queue this envelope then trigger a resync;
      // after the resync fills the gap, the queue drain will re-process it
      // through _ingest when the cursor is caught up.
      this._queue.push({ seq: normalized.seq, seqSpan, event, delta });
      this._resync().catch(() => {});
      return;
    }
    // Within range — apply the event
    this._applyEvent(event, delta);
    this._cursor = seqSpan[1];
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
  async _resync() {
    if (this._resyncing) return; // prevent re-entrancy
    this._resyncing = true;

    try {
      const res = await this._fetchImpl(this._eventsSinceUrl(this._entity, this._id, this._cursor));
      const body = await this._decode(res);

      if (body.resync === 'stale') {
        // Forced re-bootstrap: fresh snapshot replaces state entirely.
        const snapRes = await this._fetchImpl(this._snapshotUrl(this._entity, this._id));
        const { snapshot, seq } = await this._decode(snapRes);
        this._state = snapshot;
        this._cursor = seq;
        this._removed = false;
        this._ordered = {};
      } else if (body.events) {
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
      // Resync fetch failed — continue with current state.
    }

    this._resyncing = false;

    // Drain any envelopes that arrived during the resync.
    const queue = this._queue;
    this._queue = [];
    for (const envelope of queue) {
      this._ingest(this._normalizeLive(envelope));
    }

    this._render();
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
        // Assign scalar fields from event.data (exclude 'id' — it's an identity field).
        if (event.data) {
          for (const key of Object.keys(event.data)) {
            if (key !== 'id') {
              this._state[key] = event.data[key];
            }
          }
        }
        // Apply per-kind delta for sub-collection changes.
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
 * action, close, overlayFor, pendingCreates, onRender.
 */
export function createLiveStore({ baseUrl, name, path, channel, fetchImpl }) {
  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;

  let _opIdCounter = 0;
  const _listCache = new Map();     // id → LiveList
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
    const state = list.state;

    for (const [opId, entry] of _overlay) {
      if (entry.id !== id || entry.status !== 'confirmed') continue;
      if (entry.kind === 'update' && state !== null) {
        _overlay.delete(opId);
      } else if (entry.kind === 'remove' && state === null) {
        _overlay.delete(opId);
      } else if (entry.kind === 'create' && state !== null) {
        _overlay.delete(opId);
      }
    }
  }

  function _storeRender() {
    for (const cb of _renderCallbacks) {
      try { cb(); } catch { /* swallow */ }
    }
  }

  // --- Subscribe ---

  function _subscribeLiveList(id) {
    if (_closed) throw new Error('store is closed');
    if (_listCache.has(id)) return _listCache.get(id);

    const list = new LiveList({
      entity: name,
      id,
      channel: resolvedChannel,
      fetchImpl: resolvedFetch,
      snapshotUrl: _snapshotUrl,
      eventsSinceUrl: _eventsSinceUrl,
    });

    _listCache.set(id, list);

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

    // dispatch NEVER throws — a closed store returns a failed Result like any
    // other failure (contract: the returned Promise resolves to committed or
    // failed-rolled-back, never rejects).
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
    const entry = { opId, id: id ?? null, kind, optimistic, status: 'pending', row: null };
    _overlay.set(opId, entry);
    _storeRender();

    // Fire REST
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
      _storeRender();

      return {
        ok: true,
        status: 'committed',
        opId,
        id: realId,
        row: kind === 'remove' ? undefined : returnedRow,
      };
    } catch (err) {
      // Network / exception error — roll back
      _overlay.delete(opId);
      _storeRender();
      return { ok: false, status: 'failed-rolled-back', opId, error: err.message ?? String(err) };
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
    _closed = true;
    resolvedChannel.close();
    for (const unsub of _listUnsubs.values()) {
      unsub();
    }
    _listCache.clear();
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
    pendingCreates,
    onRender(cb) {
      _renderCallbacks.add(cb);
      return () => _renderCallbacks.delete(cb);
    },
  };

  return store;
}
