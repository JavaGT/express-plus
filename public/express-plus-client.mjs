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
