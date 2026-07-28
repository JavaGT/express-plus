// LiveChannel — WebSocket transport layer for workbench live sync.
//
// Slice A of the client SDK. ONE WebSocket per channel, multiplexed across
// entity/id subscriptions. Auto-reconnects with exponential backoff. Zero
// external dependencies — uses Node's global WebSocket (Node 22+).
//
// Protocol (matches src/live.mjs verbatim):
//   client → server: {type:'subscribe', requestId, entity, id, fields?, pace?} / {type:'subscribe', requestId, scope, interest?} / {type:'unsubscribe', entity, id} / {type:'unsubscribe', scope}
//   server → client: {type:'subscribed', requestId, scope, entity, id, currentSeq}
//                    {type:'unsubscribed', scope, entity, id}
//                    {type:'event', entity, id, seq, seqSpan, event, delta?}
//                    {type:'resync', entity, id, seq, reason}
//                    {type:'error', requestId?, failure}

import { applyTextOp, createTextState, materializeText, restoreTextCheckpoint } from './workbench-annotated-text.mjs';
import { deleteText, insertText } from './workbench-text-edit.mjs';
import { materializeAnnotatedTextSnapshot } from './workbench-annotated-text-snapshot.mjs';
export { materializeAnnotatedTextSnapshot };

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

function subscribeEnvelope(entity, id, { fields, pace, carets } = {}) {
  const envelope = { type: 'subscribe', entity, id };
  if (fields !== undefined) envelope.fields = fields;
  if (pace !== undefined) envelope.pace = pace;
  if (carets !== undefined) envelope.carets = carets;
  return envelope;
}

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class ClientClosedError extends Error {
  constructor(message = 'Live channel is closed') {
    super(message);
    this.name = 'ClientClosedError';
  }
}

export class WorkbenchFailureError extends Error {
  constructor(workbenchFailure) {
    if (!isWorkbenchFailure(workbenchFailure)) {
      throw new TypeError('WorkbenchFailureError requires a canonical WorkbenchFailure');
    }
    super(workbenchFailure.message);
    this.name = 'WorkbenchFailureError';
    this.failure = workbenchFailure;
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
    // In-flight subscribe wire requests: requestId → desired-subscription key.
    // A reconnect allocates a fresh request so an old denial cannot retire the
    // current generation's desired subscription.
    this._subRequests = new Map();
    this._nextRequestId = 1;
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
  // Rejects with WorkbenchFailureError when the server sends a canonical
  // `error` envelope before the `subscribed` ack; inspect its stable `.failure`.
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

    const carets = Array.isArray(options.carets) ? options.carets : undefined;
    const onCaret = typeof options.onCaret === 'function' ? options.onCaret : undefined;
    const ready = new Promise((resolve, reject) => {
      this._subs.set(key, {
        onEvent,
        onCaret,
        onCheckpoint: options.onCheckpoint,
        onResync: options.onResync,
        fields: options.fields,
        pace: options.pace,
        carets,
        envelope: subscribeEnvelope(entity, id, { ...options, carets }),
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

    const interest = { ...options.interest };
    if (options.fields !== undefined) interest.fields = options.fields;
    if (options.pace !== undefined) interest.pace = options.pace;
    const carets = Array.isArray(options.carets) ? options.carets : interest.carets;
    if (carets !== undefined) interest.carets = carets;
    const envelope = { type: 'subscribe', scope };
    if (Object.keys(interest).length > 0) envelope.interest = interest;
    const ready = new Promise((resolve, reject) => {
      this._subs.set(key, {
        onEvent,
        onCaret: typeof options.onCaret === 'function' ? options.onCaret : undefined,
        onCheckpoint: options.onCheckpoint,
        onResync: options.onResync,
        fields: options.fields,
        pace: options.pace,
        carets,
        scope,
        entity: interest.entity,
        id: interest.id,
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
    const requestId = this._subs.get(key)?.requestId;
    if (requestId !== undefined) this._subRequests.delete(requestId);
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
    this._subRequests.clear();
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

  // Send a volatile caret update. Returns false when offline (no queue/replay).
  updateCaret({ entity, id, field, blockId, offset }) {
    if (this._closed) throw new ClientClosedError();
    const arg = arguments[0];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      throw new TypeError('updateCaret requires exactly type/entity/id/field/blockId/offset');
    }
    const argKeys = Object.keys(arg);
    if (argKeys.length !== 5 || argKeys.some((k) => !['entity','id','field','blockId','offset'].includes(k))) {
      throw new TypeError('updateCaret requires exactly type/entity/id/field/blockId/offset');
    }
    if (typeof entity !== 'string' || entity.length === 0 ||
        typeof id !== 'string' || id.length === 0 ||
        typeof field !== 'string' || field.length === 0 ||
        typeof blockId !== 'string' || blockId.length === 0) {
      throw new TypeError('updateCaret requires non-empty strings for entity, id, field, blockId');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('updateCaret requires a non-negative safe integer offset');
    }
    const msg = { type: 'caret.update', entity, id, field, blockId, offset };
    return this._send(msg);
  }

  // Send a volatile caret clear. Returns false when offline (no queue/replay).
  clearCaret({ entity, id, field }) {
    if (this._closed) throw new ClientClosedError();
    const arg = arguments[0];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      throw new TypeError('clearCaret requires exactly type/entity/id/field');
    }
    const argKeys = Object.keys(arg);
    if (argKeys.length !== 3 || argKeys.some((k) => !['entity','id','field'].includes(k))) {
      throw new TypeError('clearCaret requires exactly type/entity/id/field');
    }
    if (typeof entity !== 'string' || entity.length === 0 ||
        typeof id !== 'string' || id.length === 0 ||
        typeof field !== 'string' || field.length === 0) {
      throw new TypeError('clearCaret requires non-empty strings for entity, id, field');
    }
    const msg = { type: 'caret.clear', entity, id, field };
    return this._send(msg);
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
    this._subRequests.clear();
    for (const sub of this._subs.values()) {
      sub.sentGeneration = 0;
      sub.requestId = undefined;
    }
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
    if (sub.carets !== undefined) interest.carets = sub.carets;
    if (Object.keys(interest).length > 0) envelope.interest = interest;
    return envelope;
  }

  _sendSubscription(key) {
    const sub = this._subs.get(key);
    if (!sub || sub.sentGeneration === this._generation) return;
    const requestId = this._nextRequestId++;
    const envelope = { ...this._subscriptionEnvelope(key, sub), requestId };
    if (this._send(envelope)) {
      if (sub.requestId !== undefined) this._subRequests.delete(sub.requestId);
      sub.requestId = requestId;
      this._subRequests.set(requestId, key);
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
      if (sub && envelope.requestId !== undefined && sub.requestId !== envelope.requestId) return;
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
      if (!isWorkbenchFailure(envelope.failure)) return;
      if (envelope.requestId !== undefined) {
        const key = this._subRequests.get(envelope.requestId);
        if (!key) return;
        this._subRequests.delete(envelope.requestId);
        const sub = this._subs.get(key);
        if (!sub || sub.requestId !== envelope.requestId) return;
        this._subs.delete(key);
        const pending = this._pendingSubs.get(key);
        if (pending) {
          this._pendingSubs.delete(key);
          pending.reject(new WorkbenchFailureError(envelope.failure));
        }
        return;
      }
      // A connection-level error cannot truthfully identify one pending
      // subscription, so it must not reject any of them as a known denial.
    } else if (envelope.type === 'event') {
      const key = scopeKey ?? `${envelope.entity}:${String(envelope.id)}`;
      const sub = this._subs.get(key);
      if (sub && typeof sub.onEvent === 'function') {
        sub.onEvent(envelope);
      }
    } else if (envelope.type === 'resync') {
      const key = scopeKey ?? `${envelope.entity}:${String(envelope.id)}`;
      const sub = this._subs.get(key);
      if (sub && typeof sub.onResync === 'function') {
        sub.onResync(envelope);
      }
    } else if (envelope.type === 'annotated-text-caret') {
      this._handleCaretFrame(envelope);
    }
  }

  // --- annotated-text-caret exact version 1 grammar ---

  // Route an inbound annotated-text-caret frame to matching subscriptions.
  // Drops malformed, unmatched, unsupported frames silently.
  _handleCaretFrame(envelope) {
    if (!isPlainJsonObject(envelope)) return;
    if (envelope.version !== 1 || envelope.type !== 'annotated-text-caret') return;
    if (typeof envelope.entity !== 'string' || envelope.entity.length === 0 ||
        typeof envelope.id !== 'string' || envelope.id.length === 0 ||
        typeof envelope.field !== 'string' || envelope.field.length === 0) return;
    const expectedTop = ['type', 'version', 'entity', 'id', 'field', 'change'];
    if (Object.keys(envelope).length !== expectedTop.length) return;
    const topKeys = Object.keys(envelope).sort();
    for (const k of topKeys) {
      if (!expectedTop.includes(k)) return;
    }
    if (!isPlainJsonObject(envelope.change)) return;
    if (envelope.change.op === 'remove') {
      const changeKeys = Object.keys(envelope.change).sort();
      if (changeKeys.length !== 2 || changeKeys[0] !== 'op' || changeKeys[1] !== 'presence') return;
      if (typeof envelope.change.presence !== 'string' || envelope.change.presence.length === 0) return;
    } else if (envelope.change.op === 'upsert') {
      const changeKeys = Object.keys(envelope.change).sort();
      if (changeKeys.length !== 2 || changeKeys[0] !== 'op' || changeKeys[1] !== 'value') return;
      const value = envelope.change.value;
      if (!isPlainJsonObject(value)) return;
      const valueKeys = Object.keys(value).sort();
      if (value.kind === 'caret') {
        if (valueKeys.length !== 4 || valueKeys[0] !== 'blockId' || valueKeys[1] !== 'kind' || valueKeys[2] !== 'offset' || valueKeys[3] !== 'presence') return;
        if (typeof value.blockId !== 'string' || value.blockId.length === 0 ||
            typeof value.presence !== 'string' || value.presence.length === 0 ||
            !Number.isSafeInteger(value.offset) || value.offset < 0) return;
      } else if (value.kind === 'edge') {
        if (valueKeys.length !== 4 || valueKeys[0] !== 'blockId' || valueKeys[1] !== 'edge' || valueKeys[2] !== 'kind' || valueKeys[3] !== 'presence') return;
        if (typeof value.blockId !== 'string' || value.blockId.length === 0 ||
            typeof value.presence !== 'string' || value.presence.length === 0 ||
            (value.edge !== 'start' && value.edge !== 'end')) return;
      } else {
        return;
      }
    } else {
      return;
    }

    const directKey = `${envelope.entity}:${String(envelope.id)}`;
    for (const [key, sub] of this._subs) {
      const directMatch = key === directKey;
      const scopedMatch = sub.scope !== undefined && sub.entity === envelope.entity && String(sub.id) === envelope.id;
      if (!directMatch && !scopedMatch) continue;
      if (typeof sub.onCaret !== 'function' || !sub.carets?.includes(envelope.field)) continue;
      try {
        sub.onCaret(envelope);
      } catch { /* isolate consumer errors */ }
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
    onTextReducer,
  }) {
    this._entity = entity;
    this._id = id;
    this._channel = channel;
    this._fetchImpl = fetchImpl ?? globalThis.fetch;
    this._snapshotUrl = snapshotUrl;
    this._eventsSinceUrl = eventsSinceUrl;
    this._fields = fields;
    this._pace = pace;
    this._onTextReducer = onTextReducer;

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
    this._snapshotRequiredSeq = 0;
    this._snapshotRecovery = false;
    this._forceSnapshotRequested = false;
    this._renderCallbacks = new Set();
    this._ordered = {};             // { [field]: [{id, key, item}] } — internal ordered tracking
    this._textStates = {};          // durable annotated-text reducer state by field
    this._textReducerReady = Promise.resolve();
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

  textState(field) { return this._textStates[field] ?? null; }

  get textReducerReady() { return this._textReducerReady; }

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
      const { snapshot, seq, reducers } = await this._decode(snapRes);
      this._assertActive(epoch);
      this._state = snapshot;
      await this._installTextReducers(reducers);
      this._cursor = seq;
      this._removed = false;

      // 2. Subscribe to live channel.
      //    During the subscribe await, any live envelopes arrive via _onLiveEnvelope,
      //    which queues them because _ready is still false.
      const ack = await this._channel.subscribe(this._entity, this._id, {
        fields: this._fields,
        pace: this._pace,
        onCheckpoint: ({ currentSeq }) => this._onCheckpoint(currentSeq),
        onResync: (control) => this._onLiveResync(control),
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
      await this._textReducerReady;
      this._assertActive(epoch);

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

  _onLiveResync(control) {
    if (this._closed
      || (control?.reason !== 'annotated-text-snapshot-required'
        && control?.reason !== 'recipient-snapshot-required')
      || control.entity !== this._entity
      || String(control.id) !== String(this._id)
      || !Number.isSafeInteger(control.seq)
      || control.seq < 0) return;
    this._snapshotRequiredSeq = Math.max(this._snapshotRequiredSeq, control.seq);
    this._forceSnapshotRequested = true;
    // A control can arrive while an ordinary replay is in flight. From that
    // point every queued live envelope contributes to the snapshot high-water.
    this._snapshotRecovery = true;
    this._resync(true).catch(() => {});
  }

  /**
   * Called by the channel for every live envelope. Queues if not yet ready
   * or currently resyncing; otherwise ingests directly.
   */
  _onLiveEnvelope(envelope) {
    if (this._closed) return;
    if (this._isAnnotatedOperation(envelope?.event)) {
      this._onLiveResync({
        entity: this._entity,
        id: this._id,
        seq: Array.isArray(envelope?.seqSpan) ? envelope.seqSpan[1] : envelope?.seq,
        reason: 'annotated-text-snapshot-required',
      });
      return;
    }
    if (!this._ready || this._resyncing) {
      this._bufferEnvelope(envelope);
      return;
    }
    this._ingest(this._normalizeLive(envelope));
  }

  _bufferEnvelope(envelope) {
    if (this._snapshotRecovery && !this._isEntityRemoval(envelope?.event)) {
      const seq = Array.isArray(envelope?.seqSpan) ? envelope.seqSpan[1] : envelope?.seq;
      if (Number.isSafeInteger(seq) && seq >= 0) {
        this._snapshotRequiredSeq = Math.max(this._snapshotRequiredSeq, seq);
      }
    }
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
      reducers: envelope.reducers,
    };
  }

  _isAnnotatedOperation(event) {
    if (typeof event?.type !== 'string') return false;
    const prefix = `${this._entity}.`;
    if (!event.type.startsWith(prefix) || !event.type.endsWith('.operated')) return false;
    const field = event.type.slice(prefix.length, -'.operated'.length);
    return this._state?.[field]?.kind === 'workbench.annotatedText.recipient';
  }

  _isEntityRemoval(event) {
    return event?.type === `${this._entity}.removed`;
  }

  _consumeTerminalRemoval() {
    const removal = this._queue.find((envelope) => this._isEntityRemoval(envelope?.event));
    if (!removal) return false;
    let span;
    try {
      span = normalizeSeqSpan(removal.seqSpan ?? removal.seq);
    } catch {
      return false;
    }
    if (span[1] < this._cursor) return false;
    this._state = null;
    this._cursor = span[1];
    this._removed = true;
    this._ordered = {};
    this._textStates = {};
    this._textReducerReady = Promise.resolve();
    this._bufferOverflow = false;
    this._snapshotRequiredSeq = 0;
    this._queue = [];
    return true;
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
    const { seqSpan, event, delta, reducers } = normalized;
    const decision = decideReplay(this._cursor, seqSpan);

    if (decision.kind === 'duplicate') {
      return;
    }
    if (decision.kind === 'gap') {
      // Gap — missing events. Queue this envelope then trigger a resync;
      // after the resync fills the gap, the queue drain will re-process it
      // through _ingest when the cursor is caught up.
      this._bufferEnvelope({ seq: normalized.seq, seqSpan, event, delta, reducers });
      this._resync().catch(() => {});
      return;
    }
    // next — apply and advance cursor to span hi (shared Replay decision)
    this._installTextReducers(reducers);
    this._applyEvent(event, delta);
    this._cursor = decision.cursor;
    this._render();
  }

  /**
   * Resync: fetch events-since from the server to fill a gap or stale state.
   * Handles two response shapes:
   *   {resync:'stale', reason}  → forced re-bootstrap from fresh snapshot
   *   {resync:'deleted', seq}   → terminal removal without a deleted snapshot
   *   {events:[...]}           → fold each row in order (bypass span dup/gap logic)
   *
   * During resync, any arriving live envelopes are queued; they are drained and
   * ingested after the resync completes.
   */
  async _resync(forceSnapshot = false) {
    if (this._resyncing) return; // prevent re-entrancy
    this._resyncing = true;
    const snapshotRequested = forceSnapshot || this._forceSnapshotRequested;
    this._forceSnapshotRequested = false;
    this._snapshotRecovery = snapshotRequested;
    const epoch = this._epoch;
    let failed = false;

    try {
      let body = null;
      if (!snapshotRequested) {
        const res = await this._fetchImpl(
          this._eventsSinceUrl(this._entity, this._id, this._cursor),
          { signal: this._abortController.signal },
        );
        body = await this._decode(res);
        this._assertActive(epoch);
      }

      if (body?.resync === 'deleted') {
        if (!Number.isFinite(body.seq) || body.seq < this._cursor) throw new Error('deleted resync has invalid cursor');
        this._state = null;
        this._cursor = body.seq;
        this._removed = true;
        this._ordered = {};
        this._textStates = {};
        this._textReducerReady = Promise.resolve();
        this._bufferOverflow = false;
        this._queue = [];
      } else if (snapshotRequested || this._bufferOverflow || body?.resync === 'stale') {
        // Forced re-bootstrap: fresh snapshot replaces state entirely.
        const snapRes = await this._fetchImpl(
          this._snapshotUrl(this._entity, this._id),
          { signal: this._abortController.signal },
        );
        const { snapshot, seq, reducers } = await this._decode(snapRes);
        this._assertActive(epoch);
        this._state = snapshot;
        await this._installTextReducers(reducers);
        this._cursor = seq;
        this._removed = false;
        this._ordered = {};
        this._bufferOverflow = false;
        if (this._cursor < this._snapshotRequiredSeq) {
          failed = true;
        } else if (this._consumeTerminalRemoval()) {
          // A removal may arrive after the snapshot's sequence. It has no
          // snapshot representation, so preserve its terminal live meaning.
        } else {
          this._snapshotRequiredSeq = 0;
          this._queue = [];
        }
      } else if (body?.events) {
        // Fold events-since rows in order. Events-since is authoritative
        // ordered fill — apply seq>cursor rows directly without span checks.
        // All-or-nothing (Wave 3.7 Contracts 2+3): validate the WHOLE batch —
        // contiguous from cursor+1 with no internal hole, every type known —
        // before applying any of it. A historical batch is server/network
        // data reaching the client outside the live span/dup-gap machinery;
        // a single bad row must not leave state and cursor split between
        // "partially applied" and "not applied" for the rest of the batch.
        const rows = body.events.filter((row) => row.seq > this._cursor);
        if (!this._isValidHistoricalBatch(rows)) {
          failed = true;
        } else {
          for (const row of rows) {
            const normalized = {
              seq: row.seq,
              seqSpan: [row.seq, row.seq],
              event: { type: row.type, data: row.data, actionId: row.actionId },
              delta: undefined,
              reducers: row.reducers,
            };
            await this._installTextReducers(normalized.reducers);
            this._applyEvent(normalized.event, normalized.delta);
            this._cursor = row.seq;
          }
        }
      }
    } catch {
      failed = !this._consumeTerminalRemoval();
    }

    this._resyncing = false;
    this._snapshotRecovery = false;
    if (this._closed || epoch !== this._epoch) return;
    if (failed) {
      this._forceSnapshotRequested = this._forceSnapshotRequested || snapshotRequested;
      this._scheduleResync();
      return;
    }
    if (this._forceSnapshotRequested) {
      await this._resync(true);
      return;
    }
    this._resyncAttempt = 0;

    // Drain any envelopes that arrived during the resync.
    const queue = this._queue;
    this._queue = [];
    for (const envelope of queue) {
      this._ingest(this._normalizeLive(envelope));
    }
    await this._textReducerReady;

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
   * All-or-nothing pre-check for an events-since batch (Wave 3.7 Contracts
   * 2+3): every row's seq must form a contiguous run starting at cursor+1
   * (no internal hole, no gap at the front), and every row's type must be one
   * _applyEvent actually knows how to fold. An empty batch is trivially valid.
   */
  _isValidHistoricalBatch(rows) {
    let expected = this._cursor + 1;
    for (const row of rows) {
      if (row.seq !== expected) return false;
      if (!this._isKnownEventType(row.type)) return false;
      expected += 1;
    }
    return true;
  }

  _isKnownEventType(type) {
    if (typeof type !== 'string' || type.length === 0) return false;
    const parts = type.split('.');
    if (parts.length === 2) return parts[1] === 'created' || parts[1] === 'updated' || parts[1] === 'removed';
    return parts.length === 3 && parts.every((part) => part.length > 0);
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

  /** Apply value, state, struct, or map deltas. Text CRDTs fold native ops. */
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
      case 'applied': {
        const operation = data.operation;
        if (!operation) return;
        const state = this._textStates[field] ?? createTextState();
        const next = applyTextOp(state, operation);
        this._textStates[field] = next;
        this._state[field] = materializeText(next);
        this._observeTextReducer({
          entity: this._entity, id: this._id, field,
          state: next, operation,
        }).catch(() => {});
        break;
      }
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

  _installTextReducers(reducers) {
    for (const reducer of reducers ?? []) {
      if (reducer?.entity !== this._entity || String(reducer.id) !== String(this._id)
        || reducer.reducer !== 'workbench.text' || reducer.version !== 1) continue;
      this._textStates[reducer.field] = restoreTextCheckpoint(reducer.checkpoint);
      this._observeTextReducer({
        entity: this._entity, id: this._id, field: reducer.field,
        epoch: JSON.stringify(reducer.checkpoint), state: this._textStates[reducer.field],
      });
    }
    return this._textReducerReady;
  }

  _observeTextReducer(observation) {
    if (!this._onTextReducer) return this._textReducerReady;
    // Persistence determines safe next counters, so observations must run in
    // delivery order and hold readiness until their durable transaction commits.
    this._textReducerReady = this._textReducerReady.then(() => this._onTextReducer(observation));
    return this._textReducerReady;
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
 * The HTTP status is authoritative. Bodies are values on success, even when an
 * entity happens to contain an `ok` field of its own.
 */
const FAILURE_CATEGORIES = new Set([
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'conflict',
  'internal',
]);

function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = (isArray ? value : Object.values(value))
    .every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isJsonRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && isJsonValue(value);
}

function isWorkbenchFailure(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && FAILURE_CATEGORIES.has(value.category)
    && typeof value.message === 'string'
    && value.message.length > 0
    && (value.details === undefined || isJsonRecord(value.details)),
  );
}

function clientFailure(category, message, details) {
  return { category, message, ...(details === undefined ? {} : { details }) };
}

export async function decodeResult(res) {
  if (res.status === 204) {
    return { ok: true, httpStatus: 204, value: undefined };
  }
  if (!res.ok) {
    let body;
    try {
      body = typeof res.json === 'function' ? await res.json() : null;
    } catch {
      body = null;
    }
    if (body?.ok === false && isWorkbenchFailure(body.failure)) {
      return { ok: false, httpStatus: res.status, failure: body.failure };
    }
    return { ok: false, httpStatus: res.status, error: 'http ' + res.status };
  }
  return { ok: true, httpStatus: res.status, value: await res.json() };
}

function replicaUnavailable() {
  return {
    reserve: async () => { throw new Error('durable replica storage is unavailable'); },
    reconcile: async () => { throw new Error('durable replica storage is unavailable'); },
  };
}

function randomReplicaActor() {
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure random replica identity is unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function replicaActionId(document, actor, counter) {
  // Server receipts are scoped to a row, while counters are scoped to a field.
  // Encode the document identity so first edits to sibling text fields cannot dedupe.
  return `text:${encodeURIComponent(document)}:${actor}:${counter}`;
}

// Browser default. A reservation atomically writes both its clock high-water
// and the exact request that owns that counter, so a retry cannot invent a
// causally different operation after an interrupted delivery.
export function createIndexedDbReplicaState({ indexedDB = globalThis.indexedDB, database = 'workbench-text-replicas' } = {}) {
  if (!indexedDB) return replicaUnavailable();
  let opened;
  const open = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('unable to open durable replica storage'));
    });
    return opened;
  };
  const transaction = async (mode, keys, change) => new Promise(async (resolve, reject) => {
    let tx;
    try { tx = (await open()).transaction('state', mode); } catch (error) { reject(error); return; }
    const store = tx.objectStore('state');
    const requests = (Array.isArray(keys) ? keys : [keys]).map((key) => store.get(key));
    for (const read of requests) read.onerror = () => reject(read.error);
    let remaining = requests.length;
    const results = [];
    for (const [index, read] of requests.entries()) read.onsuccess = () => {
      results[index] = read.result;
      if (--remaining !== 0) return;
      try { change(results, store); } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('durable replica transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('durable replica transaction aborted'));
  });
  return {
    async reserve(document, generate) {
      let record;
      await transaction('readwrite', [document, '@identity'], ([stored, identity], store) => {
        const actor = identity?.actor ?? randomReplicaActor();
        const state = stored ?? { actor, counter: 0, lamport: 0, frontier: [], epoch: null, outbox: [] };
        const counter = state.counter + 1;
        const lamport = Math.max(state.lamport, ...state.frontier.map(([, value]) => value), 0) + 1;
        // Generate before any durable mutation so known-invalid edits consume no counter.
        const operation = generate({ actor: state.actor, counter, lamport, frontier: state.frontier, epoch: state.epoch });
        record = { operation, actionId: replicaActionId(document, state.actor, counter), counter, replica: state.actor,
          body: JSON.stringify({ operation }), status: 'pending', failure: null };
        store.put({ actor }, '@identity');
        store.put({ ...state, counter, lamport, outbox: [...(state.outbox ?? []), record] }, document);
      });
      return { ...record };
    },
    async head(document) {
      let head = null;
      await transaction('readonly', document, ([state]) => { head = state?.outbox?.[0] ?? null; });
      return head;
    },
    async commit(document, counter) {
      await transaction('readwrite', document, ([state], store) => {
        if (!state?.outbox?.length || state.outbox[0].counter !== counter) throw new Error('text outbox head changed');
        store.put({ ...state, outbox: state.outbox.slice(1) }, document);
      });
    },
    async block(document, counter, failure) {
      await transaction('readwrite', document, ([state], store) => {
        if (!state?.outbox?.length || state.outbox[0].counter !== counter) throw new Error('text outbox head changed');
        const [head, ...tail] = state.outbox;
        store.put({ ...state, outbox: [{ ...head, status: 'blocked', failure }, ...tail] }, document);
      });
    },
    async reconcile(document, observation) {
      let outbox = [];
      await transaction('readwrite', [document, '@identity'], ([stored, identity], store) => {
        const actor = identity?.actor ?? randomReplicaActor();
        const state = stored ?? { actor, counter: 0, lamport: 0, frontier: [], epoch: null, outbox: [] };
        // A changed checkpoint is a conservative document epoch boundary.
        const epochChanged = observation.epoch !== undefined && state.epoch !== null && state.epoch !== observation.epoch;
        const frontier = epochChanged ? observation.frontier : mergeReplicaFrontiers(state.frontier, observation.frontier);
        const ownObservedCounter = frontier.find(([actor]) => actor === state.actor)?.[1] ?? 0;
        store.put({ actor }, '@identity');
        store.put({ ...state, counter: Math.max(state.counter, ownObservedCounter), frontier,
          epoch: observation.epoch === undefined ? state.epoch : observation.epoch,
          lamport: Math.max(state.lamport, observation.lamport ?? 0) }, document);
        outbox = [...(state.outbox ?? [])];
      });
      return outbox;
    },
  };
}

function mergeReplicaFrontiers(left, right) {
  const values = new Map(left);
  for (const [actor, counter] of right ?? []) values.set(actor, Math.max(values.get(actor) ?? 0, counter));
  return [...values].sort(([leftActor], [rightActor]) => leftActor.localeCompare(rightActor));
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
export function createLiveStore({ baseUrl, name, path, channel, fetchImpl, replicaState }) {
  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  const resolvedReplicaState = replicaState ?? createIndexedDbReplicaState();

  let _opIdCounter = 0;
  const _listCache = new Map();     // id → LiveList
  const _listOptions = new Map();   // id → serialized subscribe options
  const _overlay = new Map();       // opId → overlay entry
  const _renderCallbacks = new Set();
  const _listUnsubs = new Map();    // id → LiveList.onRender unsub
  const _actionRoutes = new Map();  // actionType → { method, path }
  const _textSendChains = new Map(); // document → serialized head delivery
  const _textAllocationChains = new Map(); // document → serialized durable reservation and draft update
  const _textDraftStates = new Map(); // document → checkpoint plus locally reserved operations
  let _closed = false;

  async function _reserveTextOperation(id, field, generate) {
    const document = `${name}\0${id}\0${field}`;
    const reservation = await resolvedReplicaState.reserve(document, generate);
    if (!reservation?.operation || !reservation.actionId || !Number.isSafeInteger(reservation.counter)) {
      throw new Error('durable replica state must persist text operation outbox records');
    }
    return { document, record: reservation };
  }

  function _serializeTextAllocation(document, work) {
    const previous = _textAllocationChains.get(document) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    _textAllocationChains.set(document, current);
    current.finally(() => {
      if (_textAllocationChains.get(document) === current) _textAllocationChains.delete(document);
    }).catch(() => {});
    return current;
  }

  function _textResult(status, record, extra = {}) {
    return { ok: status === 'committed', status, opId: record.actionId, actionId: record.actionId, ...extra };
  }

  async function _sendTextHead(document, id, field, expectedCounter) {
    const record = await resolvedReplicaState.head(document);
    if (!record) return { ok: false, status: 'failed-rolled-back', opId: null, failure: clientFailure('not-found', 'text outbox is empty') };
    if (record.status === 'blocked') return _textResult('blocked', record, { failure: record.failure });
    if (record.counter !== expectedCounter) return _textResult('queued', record, { waitingFor: record.actionId });
    try {
      const res = await resolvedFetch(`${baseUrl}${path}/${id}/${field}/apply`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-workbench-action-id': record.actionId },
        // `body` is persisted alongside the operation; retries send these exact bytes.
        body: record.body,
      });
      const decoded = await decodeResult(res);
      if (!decoded.ok) {
        if (decoded.failure) {
          await resolvedReplicaState.block(document, record.counter, decoded.failure);
          return _textResult('blocked', record, { failure: decoded.failure });
        }
        return _textResult('outcome-unknown', record, { deliveryError: { message: decoded.error } });
      }
      await resolvedReplicaState.commit(document, record.counter);
      return _textResult('committed', record, { row: decoded.value });
    } catch (error) {
      return _textResult('outcome-unknown', record, { deliveryError: { message: error?.message ?? String(error) } });
    }
  }

  function _serializeTextSend(document, send) {
    const prior = _textSendChains.get(document) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(send);
    _textSendChains.set(document, next);
    return next.finally(() => { if (_textSendChains.get(document) === next) _textSendChains.delete(document); });
  }

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
      onTextReducer: ({ entity, id: reducerId, field, epoch, state }) => {
        const document = `${entity}\0${reducerId}\0${field}`;
        const lamport = Math.max(0, ...Object.values(state.elements).map((element) => element.lamport));
        return _serializeTextAllocation(document, async () => {
          const outbox = await resolvedReplicaState.reconcile(document, { epoch, frontier: state.frontier, lamport });
          let draft = state;
          for (const record of outbox.sort((left, right) => left.counter - right.counter)) {
            draft = applyTextOp(draft, record.operation);
          }
          _textDraftStates.set(document, draft);
        });
      },
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
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('conflict', 'Store is closed.'),
      };
    }

    let kind, id;
    if (type.endsWith('.apply') && type.startsWith(`${name}.`)) {
      const fieldName = type.slice(name.length + 1, -'.apply'.length);
      if (!fieldName || typeof payload?.id !== 'string' || !Object.hasOwn(payload, 'operation')) {
        return { ok: false, status: 'failed-rolled-back', opId, failure: clientFailure('invalid-input', 'text operation requires { id, operation }') };
      }
      let requestAttempted = false;
      try {
        requestAttempted = true;
        const res = await resolvedFetch(`${baseUrl}${path}/${payload.id}/${fieldName}/apply`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: payload.operation }),
        });
        const decoded = await decodeResult(res);
        if (!decoded.ok) return decoded.failure
          ? { ok: false, status: 'failed-rolled-back', opId, failure: decoded.failure }
          : { ok: false, status: 'outcome-unknown', opId, deliveryError: { message: decoded.error } };
        return { ok: true, status: 'committed', opId, row: decoded.value };
      } catch (err) {
        return requestAttempted
          ? { ok: false, status: 'outcome-unknown', opId, deliveryError: { message: err.message ?? String(err) } }
          : { ok: false, status: 'failed-rolled-back', opId, failure: clientFailure('invalid-input', err.message ?? String(err)) };
      }
    } else if (type === `${name}.create`) {
      kind = 'create';
    } else if (type === `${name}.update`) {
      kind = 'update';
      id = payload.id;
    } else if (type === `${name}.remove`) {
      kind = 'remove';
      id = payload.id;
    } else {
      return {
        ok: false,
        status: 'failed-rolled-back',
        opId,
        failure: clientFailure('unknown-action', 'Unknown action type: ' + type),
      };
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

      if (!decoded.ok) {
        // Failure — roll back
        _overlay.delete(opId);
        _storeRender();
        if (decoded.failure) {
          return {
            ok: false,
            status: 'failed-rolled-back',
            opId,
            failure: decoded.failure,
          };
        }
        return {
          ok: false,
          status: 'outcome-unknown',
          opId,
          deliveryError: { message: decoded.error },
        };
      }

      // Success
      const is204 = res.status === 204;
      const returnedRow = is204 ? undefined : decoded.value;
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
      const message = err.message ?? String(err);
      return requestAttempted
        ? {
          ok: false,
          status: 'outcome-unknown',
          opId,
          deliveryError: { message },
        }
        : {
          ok: false,
          status: 'failed-rolled-back',
          opId,
          failure: clientFailure('invalid-input', message),
        };
    }
  }

  function text(id, field) {
    const generate = async (build) => {
      if (_closed) throw new Error('store is closed');
      const list = _listCache.get(id);
      if (!list) throw new Error('text field is not ready; subscribe and await list.ready first');
      await list.textReducerReady;
      const checkpoint = list.textState(field);
      if (!checkpoint) throw new Error('text field is not ready; subscribe and await list.ready first');
      const document = `${name}\0${id}\0${field}`;
      const { record } = await _serializeTextAllocation(document, async () => {
        const state = _textDraftStates.get(document) ?? checkpoint;
        const reservation = await _reserveTextOperation(id, field, (identity) => build({ state, ...identity }));
        // Preserve causal generation while an earlier durable operation awaits delivery.
        _textDraftStates.set(document, applyTextOp(state, reservation.record.operation));
        return reservation;
      });
      return _serializeTextSend(document, () => _sendTextHead(document, id, field, record.counter));
    };
    return {
      insert: ({ at, text: inserted }) => generate(({ state, ...identity }) => insertText(state, identity, at, inserted)),
      delete: ({ start, end }) => generate(({ state, ...identity }) => deleteText(state, identity, start, end)),
    };
  }

  async function retryText(id, field) {
    const document = `${name}\0${id}\0${field}`;
    return _serializeTextSend(document, async () => {
      const head = await resolvedReplicaState.head(document);
      if (!head) return { ok: false, status: 'failed-rolled-back', opId: null, failure: clientFailure('not-found', 'text outbox is empty') };
      if (head.status === 'blocked') return _textResult('blocked', head, { failure: head.failure });
      return _sendTextHead(document, id, field, head.counter);
    });
  }

  // --- Action route registry ---

  function action(actionType, { method, path: actionPath }) {
    _actionRoutes.set(actionType, { method, path: actionPath });

    // Return a helper function the caller can invoke
    const fn = async (body) => {
      const opId = _nextOpId();
      const route = _actionRoutes.get(actionType);
      if (!route) {
        return {
          ok: false,
          status: 'failed-rolled-back',
          opId,
          failure: clientFailure('unknown-action', `Unknown action: ${actionType}`),
        };
      }

      let requestAttempted = false;
      try {
        const opts = { method: route.method, credentials: 'include' };
        if (body !== undefined) {
          opts.headers = { 'Content-Type': 'application/json' };
          opts.body = JSON.stringify(body);
        }

        requestAttempted = true;
        const res = await resolvedFetch(`${baseUrl}${route.path}`, opts);
        const decoded = await decodeResult(res);
        if (decoded.ok) {
          return {
            ok: true,
            status: 'committed',
            opId,
            value: decoded.value,
          };
        }
        return decoded.failure
          ? {
            ok: false,
            status: 'failed-rolled-back',
            opId,
            failure: decoded.failure,
          }
          : {
            ok: false,
            status: 'outcome-unknown',
            opId,
            deliveryError: { message: decoded.error },
          };
      } catch (err) {
        const message = err.message ?? String(err);
        return requestAttempted
          ? {
            ok: false,
            status: 'outcome-unknown',
            opId,
            deliveryError: { message },
          }
          : {
            ok: false,
            status: 'failed-rolled-back',
            opId,
            failure: clientFailure('invalid-input', message),
          };
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
    apply(id, field, operation) { return dispatch(`${name}.${field}.apply`, { id, operation }); },
    text,
    retryText,
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
// createLiveDeliverySession — recipient-envelope delivery and recovery.
// ---------------------------------------------------------------------------

/**
 * Package-owned client ingest for a recipient-safe delivery stream. Transport
 * adapters provide atomic snapshots/catch-up and recipient envelopes only;
 * they never provide raw log rows or choose cursor recovery.
 */
export function createLiveDeliverySession({
  bootstrap,
  subscribe,
  validateSnapshot,
  fold: configuredFold,
  optimistic = (snapshot) => snapshot,
  sendAction,
  createActionId,
}) {
  if (typeof bootstrap !== 'function') throw new TypeError('bootstrap is required');
  if (typeof subscribe !== 'function') throw new TypeError('subscribe is required');
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  if (configuredFold !== undefined && typeof configuredFold !== 'function') throw new TypeError('fold must be a function');
  if (typeof sendAction !== 'function') throw new TypeError('sendAction is required');

  let baseSnapshot = null;
  let visibleSnapshot = null;
  let cursor = 0;
  let status = 'bootstrapping';
  let closed = false;
  let reconnecting = false;
  let connectionGeneration = 0;
  let recoveryGeneration = 0;
  let snapshotGeneration = 0;
  let receiptGeneration = 0;
  let subscription = null;
  let actionCounter = 0;
  const snapshotOnly = configuredFold === undefined;
  const fold = configuredFold ?? ((snapshot) => snapshot);
  let deliveryChain = Promise.resolve();
  const listeners = new Set();
  const operations = new Map();

  function nextActionId() {
    if (createActionId) return createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `delivery_op_${++actionCounter}`;
  }

  function publish() {
    if (closed || baseSnapshot === null) return;
    let projected = baseSnapshot;
    for (const operation of operations.values()) {
      if (operation.status === 'pending') projected = optimistic(projected, operation.action);
      // Application callbacks may synchronously trigger terminal revocation.
      // Never publish a projection that was computed before that transition.
      if (closed || status === 'revoked' || baseSnapshot === null) return;
    }
    visibleSnapshot = projected;
    for (const listener of listeners) {
      try { listener(visibleSnapshot); } catch { /* isolate consumers */ }
    }
  }

  function assertCursor(value, label) {
    if (Number.isSafeInteger(value) && value >= 0) return;
    if (value && typeof value === 'object'
      && Number.isSafeInteger(value.anchor) && value.anchor >= 0
      && Number.isSafeInteger(value.aggregate) && value.aggregate >= 0
      && Object.keys(value).length === 2) return;
    throw new Error(`${label} must be a nonnegative cursor`);
  }

  function cursorAnchor(value) {
    return typeof value === 'object' ? value.anchor : value;
  }

  function sameCursor(left, right) {
    return cursorAnchor(left) === cursorAnchor(right)
      && (typeof left === 'object') === (typeof right === 'object')
      && (typeof left !== 'object' || left.aggregate === right.aggregate);
  }

  function normalizeEvent(envelope) {
    if (!envelope || envelope.type !== 'event') throw new Error('delivery batch contains an invalid recipient envelope');
    const span = envelope.seqSpan ?? envelope.seq;
    const [lo, hi] = normalizeSeqSpan(span);
    assertCursor(lo, 'delivery sequence');
    assertCursor(hi, 'delivery sequence');
    if (lo > hi) throw new Error('delivery sequence span is inverted');
    return { envelope, seqSpan: [lo, hi] };
  }

  function applyEvent(envelope) {
    const { seqSpan } = normalizeEvent(envelope);
    // A declared aggregate has no event reducer. Treat an unexpected event as
    // an opaque recovery boundary rather than acknowledging stale state.
    if (snapshotOnly) return { status: 'resync' };
    const decision = decideReplay(cursor, seqSpan);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') return { status: 'gap' };

    const nextSnapshot = fold(baseSnapshot, envelope);
    // A fold callback may synchronously trigger terminal revocation through a
    // host lifecycle reaction. Do not restore state after that fail-closed turn.
    if (closed || status === 'revoked') return { status: 'revoked' };
    baseSnapshot = nextSnapshot;
    cursor = decision.cursor;
    const actionId = envelope.event?.actionId;
    const operation = actionId ? operations.get(actionId) : null;
    if (operation) {
      operation.echoCursor = cursor;
      if (operation.delivered
        && (operation.confirmedCursor == null || cursorAnchor(cursor) >= operation.confirmedCursor)) {
        operations.delete(actionId);
      }
    }
    publish();
    return { status: operation ? 'confirmed' : 'applied' };
  }

  function settleSnapshotConfirmations(receiptGenerationAtStart) {
    // Composite streams intentionally do not disclose event identity. A
    // positive sender receipt plus an authorized replacement snapshot is the
    // package-owned equivalent of a direct-stream action echo.
    if (!snapshotOnly) return;
    for (const [actionId, operation] of operations) {
      if (operation.delivered
        && operation.confirmedThrough != null
        && snapshotGeneration > operation.receiptSnapshotGeneration
        && receiptGenerationAtStart >= operation.receiptGeneration
        && cursorAnchor(cursor) >= operation.confirmedThrough) {
        operations.delete(actionId);
      }
    }
  }

  function becomeUnavailable() {
    if (closed || status === 'revoked') return;
    status = 'unavailable';
    // An opaque aggregate can only be reconciled by its replacement snapshot.
    // Once that recovery fails, no optimistic projection is safe to retain.
    if (snapshotOnly) operations.clear();
    publish();
  }

  async function applyCatchup(result) {
    if (!Array.isArray(result.envelopes)) throw new Error('catch-up is missing recipient envelopes');
    assertCursor(result.cursor, 'catch-up cursor');
    const initialCursor = cursor;
    for (const envelope of result.envelopes) {
      if (envelope?.type === 'resync') return false;
      const applied = applyEvent(envelope);
      if (applied.status === 'resync') return false;
      if (closed || status === 'revoked') return true;
      if (applied.status === 'gap') throw new Error('catch-up recipient envelopes are not contiguous');
    }
    if (result.envelopes.length === 0 && !sameCursor(result.cursor, initialCursor)) {
      throw new Error('empty catch-up cannot advance its cursor');
    }
    if (!sameCursor(cursor, result.cursor)) throw new Error('catch-up final cursor does not match its recipient envelopes');
    return true;
  }

  async function recover(mode, snapshotCursorFloor) {
    if (closed) return;
    const generation = ++recoveryGeneration;
    const receiptGenerationAtStart = receiptGeneration;
    const snapshotCursorAtStart = cursor;
    status = mode === 'snapshot' ? 'recovering' : 'catching-up';
    const result = await bootstrap({ after: mode === 'catchup' ? cursor : undefined, mode });
    // A transport can revoke access while an authorized recovery request is
    // pending. Its late result must never rematerialize project state.
    if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
    if (!result || typeof result !== 'object') throw new Error('bootstrap returned an invalid result');
    if (result.kind === 'revoked') {
      revoke(result.reason);
      return;
    }
    if (result.kind === 'retry') {
      return recover('snapshot', snapshotCursorFloor);
    }
    if (result.kind === 'snapshot') {
      assertCursor(result.cursor, 'snapshot cursor');
      const nextSnapshot = validateSnapshot(result.snapshot);
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      // A receipt confirmation must never install a replacement snapshot that
      // predates its committed fence, even when reconnect superseded its first
      // request while it was in flight.
      if (snapshotCursorFloor != null && cursorAnchor(result.cursor) < Math.max(snapshotCursorFloor, cursorAnchor(snapshotCursorAtStart))) return;
      baseSnapshot = nextSnapshot;
      cursor = result.cursor;
      snapshotGeneration += 1;
      settleSnapshotConfirmations(receiptGenerationAtStart);
      publish();
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      status = 'live';
      return;
    }
    if (result.kind === 'catchup' && mode === 'catchup') {
      if (!(await applyCatchup(result))) return recover('snapshot');
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      status = 'live';
      return;
    }
    throw new Error('bootstrap returned an unsupported result');
  }

  async function receive(envelopes, generation) {
    if (!Array.isArray(envelopes)) throw new Error('delivery callback requires an envelope array');
    for (const envelope of envelopes) {
      if (closed || status === 'revoked' || status === 'unavailable' || generation !== connectionGeneration) return;
      if (envelope?.type === 'resync') {
        // Recovery causes are intentionally opaque to applications.
        try {
          await recover('snapshot');
        } catch (error) {
          becomeUnavailable();
          throw error;
        }
        continue;
      }
      const applied = applyEvent(envelope);
      if (applied.status === 'resync') {
        try {
          await recover('snapshot');
        } catch (error) {
          becomeUnavailable();
          throw error;
        }
        continue;
      }
      if (applied.status === 'gap') {
        try {
          await recover('catchup');
        } catch (error) {
          if (!closed && status !== 'revoked') status = 'unavailable';
          throw error;
        }
        if (closed || status === 'revoked' || generation !== connectionGeneration) return;
        const replayed = applyEvent(envelope);
        if (replayed.status === 'gap') {
          if (!closed && status !== 'revoked') status = 'unavailable';
          throw new Error('delivery remains gapped after catch-up');
        }
      }
    }
  }

  function deliver(envelopes, generation) {
    // A later, transport-triggered recovery can proceed after a failed batch.
    const attempt = deliveryChain.catch(() => {}).then(() => receive(envelopes, generation));
    deliveryChain = attempt.catch(() => {});
    return attempt;
  }

  function recoverReceiptSnapshot(operation) {
    // Receipt recovery shares the delivery chain so an older replacement
    // snapshot cannot install after a later live delivery has advanced state.
    const attempt = deliveryChain.catch(() => {}).then(async () => {
      if (status === 'unavailable' || operations.get(operation.actionId) !== operation) return;
      try {
        await recover('snapshot', operation.confirmedThrough);
        if (!closed
          && status !== 'revoked'
          && operations.get(operation.actionId) === operation
          && (snapshotGeneration <= operation.receiptSnapshotGeneration || cursorAnchor(cursor) < operation.confirmedThrough)) {
          await recover('snapshot', operation.confirmedThrough);
        }
        if (!closed
          && status !== 'revoked'
          && operations.get(operation.actionId) === operation
          && (snapshotGeneration <= operation.receiptSnapshotGeneration || cursorAnchor(cursor) < operation.confirmedThrough)) {
          throw new Error('replacement snapshot does not cover snapshot-only action receipt');
        }
      } catch (error) {
        becomeUnavailable();
        throw error;
      }
    });
    deliveryChain = attempt.catch(() => {});
    // The sender receipt remains the dispatch result; recovery errors instead
    // make the session unavailable and remove its unsafe optimistic overlay.
    void attempt.catch(() => {});
  }

  async function connect() {
    const generation = ++connectionGeneration;
    const nextSubscription = await subscribe({
      after: cursor,
      deliver: (envelopes) => {
        if (closed || status === 'revoked' || generation !== connectionGeneration) return;
        return deliver(envelopes, generation);
      },
      revoke,
      closed: () => {
        if (generation === connectionGeneration) reconnect().catch(() => {});
      },
    });
    // Delivery can revoke access while transport establishment is pending.
    // Never retain a subscription that became unauthorized before its handle.
    if (closed || status === 'revoked' || generation !== connectionGeneration) {
      nextSubscription?.close?.();
      return;
    }
    subscription = nextSubscription;
  }

  async function reconnect() {
    if (closed || status === 'revoked' || reconnecting) return;
    // Some adapters report their own close synchronously. Mark reconnecting
    // before closing the old subscription so that callback cannot recurse.
    reconnecting = true;
    try {
      // Invalidate the old transport before recovery reauthorizes the stream.
      connectionGeneration += 1;
      subscription?.close?.();
      subscription = null;
      await recover('catchup');
      if (!closed && status !== 'revoked') await connect();
    } catch (error) {
      if (!closed && status !== 'revoked') status = 'unavailable';
      throw error;
    } finally {
      reconnecting = false;
    }
  }

  function revoke(_reason) {
    if (closed || status === 'revoked') return;
    status = 'revoked';
    baseSnapshot = null;
    visibleSnapshot = null;
    operations.clear();
    subscription?.close?.();
    subscription = null;
    for (const listener of listeners) {
      try { listener(null); } catch { /* isolate consumers */ }
    }
  }

  async function start() {
    try {
      await recover('snapshot');
      if (!closed && status !== 'revoked') await connect();
    } catch (error) {
      if (!closed && status !== 'revoked') status = 'unavailable';
      throw error;
    }
  }

  async function dispatch(type, payload) {
    const actionId = nextActionId();
    const action = { actionId, type, payload };
    const operation = {
      opId: actionId, actionId, action, status: 'pending', error: null,
      delivered: false, confirmedCursor: null, confirmedThrough: null, receiptGeneration: null, receiptSnapshotGeneration: null, echoCursor: null,
    };
    if (closed || status !== 'live') {
      return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    operations.set(actionId, operation);
    publish();
    if (closed || status !== 'live') {
      return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    try {
      const receipt = await sendAction(action);
      if (status === 'revoked') {
        return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      if (receipt?.ok === false) {
        // The matching committed envelope is authoritative when a request
        // failure races its delivery; never tell callers to retry that action.
        if (operation.echoCursor != null) {
          operations.delete(actionId);
          publish();
          return { ok: true, status: 'committed', opId: actionId };
        }
        throw receipt.failure ?? receipt.error ?? receipt;
      }
      const confirmedThrough = receipt?.confirmedThrough;
      if (snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0 || receipt?.actionId !== actionId)) {
        throw new Error('snapshot-only action receipt must confirm its actionId through a nonnegative cursor');
      }
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++receiptGeneration;
      operation.receiptSnapshotGeneration = snapshotGeneration;
      settleSnapshotConfirmations(receiptGeneration);
      // Composite streams hide event identity. Every positive receipt needs a
      // replacement snapshot after that receipt before its overlay can settle.
      if (snapshotOnly) recoverReceiptSnapshot(operation);
      if (operation.echoCursor != null
        && (operation.confirmedCursor == null || operation.echoCursor >= operation.confirmedCursor)) {
        operations.delete(actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: actionId, value: receipt?.value };
    } catch (error) {
      if (status === 'revoked') {
        return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      // A delivery echo proves the action reached the committed recipient
      // stream even when its request promise fails after that point.
      if (operation.echoCursor != null) {
        operations.delete(actionId);
        publish();
        return { ok: true, status: 'committed', opId: actionId };
      }
      if (operations.get(actionId) === operation) {
        operations.delete(actionId);
        operation.status = 'failed';
        operation.error = error;
        publish();
      }
      return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: error };
    }
  }

  const ready = start();
  ready.catch(() => {});

  return {
    get snapshot() { return visibleSnapshot; },
    get cursor() { return cursor; },
    get status() { return status; },
    get ready() { return ready; },
    dispatch,
    reconnect,
    operations() { return [...operations.values()]; },
    pendingCount() { return [...operations.values()].filter((operation) => operation.status === 'pending').length; },
    subscribe(listener) {
      listeners.add(listener);
      if (visibleSnapshot !== null || status === 'revoked') listener(visibleSnapshot);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      subscription?.close?.();
      subscription = null;
      listeners.clear();
    },
  };
}

/**
 * Connect the package-owned recovery session to its HTTP/SSE delivery skin.
 * Applications supply their recipient snapshot validator/fold and action
 * sender, never event replay, cursor, or transport recovery callbacks.
 */
export function createLiveDeliveryHttpSession({
  baseUrl,
  scope,
  validateSnapshot,
  fold,
  optimistic,
  sendAction,
  actionUrl,
  historySession,
  fetchImpl = globalThis.fetch,
  eventSourceFactory = (url, options) => new EventSource(url, options),
  createActionId,
}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl is required');
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (typeof eventSourceFactory !== 'function') throw new TypeError('eventSourceFactory is required');
  if (typeof historySession !== 'string' || historySession.length === 0) throw new TypeError('historySession is required');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/bootstrap`;
  const eventsEndpoint = `${baseUrl.replace(/\/$/, '')}/events`;
  // The action endpoint belongs to the configured Workbench origin, not the
  // browser document origin which may host a separate frontend application.
  const actionEndpoint = actionUrl ?? new URL('/workbench/actions', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();
  const historyEndpoint = new URL('/workbench/history', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();

  async function bootstrap({ after, mode }) {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://workbench.local');
    url.searchParams.set('scope', scope);
    url.searchParams.set('mode', mode);
    if (mode === 'catchup') url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
    const response = await fetchImpl(url.toString(), { credentials: 'include' });
    if (response.status === 401 || response.status === 403) return { kind: 'revoked' };
    if (!response.ok) throw new Error(`live delivery bootstrap failed with HTTP ${response.status}`);
    const result = await response.json();
    if (!result || typeof result !== 'object' || !['snapshot', 'catchup', 'revoked'].includes(result.kind)) {
      throw new Error('live delivery bootstrap returned an invalid response');
    }
    return result;
  }

  function subscribe({ after, deliver, closed }) {
    const url = new URL(eventsEndpoint, globalThis.location?.href ?? 'http://workbench.local');
    url.searchParams.set('scope', scope);
    url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
    const source = eventSourceFactory(url.toString(), { withCredentials: true });
    let open = true;
    source.onmessage = (message) => {
      if (!open) return;
      let envelopes;
      try { envelopes = JSON.parse(message.data); } catch { source.close(); closed(); return; }
      Promise.resolve(deliver(envelopes)).catch(() => { source.close(); closed(); });
    };
    source.onerror = () => {
      if (!open) return;
      open = false;
      source.close();
      closed();
    };
    return Promise.resolve({ close() { open = false; source.close(); } });
  }

  async function sendHttpAction(action) {
    const historyCommand = action.type === '$history.undo' ? 'undo'
      : action.type === '$history.redo' ? 'redo' : null;
    const historyPayload = action.payload;
    const historyRequest = historyCommand && historyPayload && typeof historyPayload === 'object'
      ? { actionId: action.actionId, command: historyCommand, ...historyPayload, scope }
      : null;
    const response = await fetchImpl(historyRequest ? historyEndpoint : actionEndpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(historyRequest ?? { ...action, scope, clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch { throw new Error(`action dispatch failed with HTTP ${response.status}`); }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true) throw new Error('action dispatch returned an invalid receipt');
    return receipt;
  }

  const session = createLiveDeliverySession({
    bootstrap,
    subscribe,
    validateSnapshot,
    fold,
    optimistic,
    sendAction: (action) => action.type.startsWith('$history.')
      ? sendHttpAction(action)
      : (sendAction ?? sendHttpAction)(action),
    createActionId,
  });
  // History commands use the same receipt/snapshot reconciliation path as an
  // application action. The server resolves this authenticated session's
  // current cursor within its write queue; raw revisions never leave it.
  Object.defineProperty(session, 'history', { value: Object.freeze({
    undo: () => session.dispatch('$history.undo', { session: historySession }),
    redo: () => session.dispatch('$history.redo', { session: historySession }),
  }) });
  return session;
}

// ---------------------------------------------------------------------------
// createScopeLiveStore — one validated composite snapshot + one scope cursor.
// ---------------------------------------------------------------------------

/**
 * Create a live store for an application-defined scope projection. The
 * framework owns bootstrap, replay, optimistic operation status, and transport;
 * the application supplies the snapshot validator and its one pure event fold.
 */
export function createScopeLiveStore({
  baseUrl,
  scope,
  validateSnapshot,
  fold,
  optimistic = (snapshot) => snapshot,
  sendAction,
  channel,
  fetchImpl,
  snapshotUrl,
  eventsSinceUrl,
  createActionId,
  resyncBackoffBase = 200,
  maxResyncBackoff = 5000,
}) {
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required');
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  if (typeof fold !== 'function') throw new TypeError('fold is required');
  if (typeof sendAction !== 'function') throw new TypeError('sendAction is required');

  const resolvedChannel = channel ?? new LiveChannel(baseUrl);
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  const snapshotEndpoint = snapshotUrl ?? `${baseUrl}/snapshot?scope=${encodeURIComponent(scope)}`;
  const replayEndpoint = (cursor) => eventsSinceUrl
    ? eventsSinceUrl(cursor)
    : `${baseUrl}/events-since?scope=${encodeURIComponent(scope)}&cursor=${cursor}`;

  let baseSnapshot = null;
  let visibleSnapshot = null;
  let cursor = 0;
  let ready = false;
  let closed = false;
  let actionCounter = 0;
  let resyncPromise = null;
  let resyncAttempt = 0;
  let resyncRetryTimer = null;
  const queued = [];
  const listeners = new Set();
  const operations = new Map();

  function nextActionId() {
    if (createActionId) return createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `scope_op_${++actionCounter}`;
  }

  function publish() {
    if (closed || baseSnapshot === null) return;
    let projected = baseSnapshot;
    for (const operation of operations.values()) {
      if (operation.status === 'pending') projected = optimistic(projected, operation.action);
    }
    visibleSnapshot = projected;
    for (const listener of listeners) {
      try { listener(visibleSnapshot); } catch { /* isolate consumers */ }
    }
  }

  async function decodeJson(response) {
    if (!response?.ok) throw new Error(`http ${response?.status ?? 'unknown'}`);
    return response.json();
  }

  async function loadSnapshot() {
    const response = await resolvedFetch(snapshotEndpoint, { credentials: 'include' });
    const body = await decodeJson(response);
    const nextSnapshot = validateSnapshot(body.snapshot);
    const nextCursor = body.cursors?.[scope] ?? body.seq;
    if (!Number.isFinite(nextCursor)) throw new Error(`snapshot is missing cursor for ${scope}`);
    baseSnapshot = nextSnapshot;
    cursor = nextCursor;
    publish();
  }

  function normalizeLive(envelope) {
    return {
      scope,
      seq: envelope.seq,
      seqSpan: envelope.seqSpan ?? [envelope.seq, envelope.seq],
      type: envelope.event?.type,
      data: envelope.event?.data,
      actionId: envelope.event?.actionId,
      delta: envelope.delta,
    };
  }

  function normalizeReplay(row) {
    return {
      scope,
      seq: row.seq,
      seqSpan: [row.seq, row.seq],
      type: row.type,
      data: row.data,
      actionId: row.actionId,
      committedAt: row.committedAt,
    };
  }

  // The only committed-event path. Live frames, own echoes, foreign events,
  // and historical replay all enter here after transport normalization.
  function ingest(event) {
    if (closed) return { status: 'closed' };
    const decision = decideReplay(cursor, event.seqSpan ?? event.seq);
    if (decision.kind === 'duplicate') return { status: 'duplicate' };
    if (decision.kind === 'gap') {
      queued.push(event);
      resync().catch(() => {});
      return { status: 'gap', expectedSeq: cursor + 1, receivedSeq: event.seqSpan?.[0] ?? event.seq };
    }

    baseSnapshot = fold(baseSnapshot, event);
    cursor = decision.cursor;
    const ownOperation = event.actionId ? operations.get(event.actionId) : null;
    if (ownOperation) {
      ownOperation.echoCursor = cursor;
      if (ownOperation.delivered && (ownOperation.confirmedCursor == null || cursor >= ownOperation.confirmedCursor)) {
        operations.delete(event.actionId);
      }
    }
    publish();
    return { status: ownOperation ? 'confirmed' : 'applied', cursor };
  }

  function queueOrIngest(event) {
    if (!ready || resyncPromise) queued.push(event);
    else ingest(event);
  }

  async function resync() {
    if (closed) return;
    if (resyncPromise) return resyncPromise;
    resyncPromise = (async () => {
      const response = await resolvedFetch(replayEndpoint(cursor), { credentials: 'include' });
      const body = await decodeJson(response);
      if (body.resync === 'stale') {
        await loadSnapshot();
      } else {
        const rows = (body.events ?? []).filter((row) => row.seq > cursor);
        let expected = cursor + 1;
        for (const row of rows) {
          if (row.scope !== undefined && row.scope !== scope) throw new Error('replay event belongs to another scope');
          if (row.seq !== expected) throw new Error('replay batch is not contiguous');
          expected += 1;
        }
        for (const row of rows) ingest(normalizeReplay(row));
      }
    })();
    let succeeded = false;
    try {
      await resyncPromise;
      succeeded = true;
      resyncAttempt = 0;
    } catch {
      scheduleResync();
    } finally {
      resyncPromise = null;
    }
    if (!succeeded) return;
    const held = queued.splice(0);
    for (const event of held) ingest(event);
  }

  function scheduleResync() {
    if (closed || resyncRetryTimer) return;
    const delay = Math.min(resyncBackoffBase * Math.pow(2, resyncAttempt), maxResyncBackoff);
    resyncAttempt += 1;
    resyncRetryTimer = setTimeout(() => {
      resyncRetryTimer = null;
      if (!closed) resync().catch(() => {});
    }, delay);
    if (typeof resyncRetryTimer.unref === 'function') resyncRetryTimer.unref();
  }

  function onLive(envelope) {
    if (closed || envelope?.type !== 'event') return;
    queueOrIngest(normalizeLive(envelope));
  }

  async function start() {
    await loadSnapshot();
    if (closed) throw new ClientClosedError('Scope live store is closed');
    const ack = await resolvedChannel.subscribeScope(scope, {
      onCheckpoint({ currentSeq }) {
        if (ready && currentSeq > cursor) resync().catch(() => {});
      },
    }, onLive);
    if (ack.currentSeq > cursor) await resync();
    ready = true;
    const held = queued.splice(0);
    for (const event of held) ingest(event);
    publish();
  }

  async function dispatch(type, payload) {
    const actionId = nextActionId();
    const action = { actionId, scope, type, payload };
    const operation = {
      opId: actionId,
      actionId,
      action,
      status: 'pending',
      error: null,
      delivered: false,
      confirmedCursor: null,
      echoCursor: null,
    };
    operations.set(actionId, operation);
    publish();
    try {
      const receipt = await sendAction(action);
      if (receipt?.ok === false) {
        operation.status = 'failed';
        operation.error = receipt.failure ?? receipt.error ?? receipt;
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: operation.error };
      }
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      operation.delivered = true;
      if (Number.isFinite(confirmedCursor)) operation.confirmedCursor = confirmedCursor;
      if (operation.echoCursor != null
        && (operation.confirmedCursor == null || operation.echoCursor >= operation.confirmedCursor)) {
        operations.delete(actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: actionId, value: receipt?.value };
    } catch (error) {
      operation.status = 'failed';
      operation.error = error;
      publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: error };
    }
  }

  const readyPromise = start();
  readyPromise.catch(() => {});

  return {
    get snapshot() { return visibleSnapshot; },
    get cursor() { return cursor; },
    get ready() { return readyPromise; },
    dispatch,
    operations() { return [...operations.values()]; },
    pendingCount() { return [...operations.values()].filter((operation) => operation.status === 'pending').length; },
    failedCount() { return [...operations.values()].filter((operation) => operation.status === 'failed').length; },
    discardFailed(opId) {
      if (operations.get(opId)?.status === 'failed') {
        operations.delete(opId);
        publish();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (visibleSnapshot !== null) listener(visibleSnapshot);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      if (resyncRetryTimer) clearTimeout(resyncRetryTimer);
      void resolvedChannel.unsubscribeScope(scope);
      resolvedChannel.close();
      listeners.clear();
      queued.length = 0;
    },
  };
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
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    return decoded.value;
  }

  async function logout() {
    const res = await fetchFn(`${baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    // logout responds 204 with no body; return a plain ok marker for callers.
    return { ok: true };
  }

  return { login, logout };
}
