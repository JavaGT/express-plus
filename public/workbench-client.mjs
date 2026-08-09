// LiveChannel — WebSocket transport layer for workbench live sync.
//
// Slice A of the client SDK. ONE WebSocket per channel, multiplexed across
// entity/id subscriptions. Auto-reconnects with exponential backoff. Zero
// external dependencies — uses Node's global WebSocket (Node 22+).
//
// Protocol (matches src/live-delivery.mjs verbatim):
//   client → server: {type:'subscribe', requestId, entity, id, fields?, pace?} / {type:'subscribe', requestId, scope, interest?} / {type:'unsubscribe', entity, id} / {type:'unsubscribe', scope}
//   server → client: {type:'subscribed', requestId, scope, entity, id, currentSeq}
//                    {type:'unsubscribed', scope, entity, id}
//                    {type:'event', entity, id, seq, seqSpan, event, delta?}
//                    {type:'resync', entity, id, seq, reason}
//                    {type:'error', requestId?, failure}

import { applyTextOp, createTextState, materializeText, restoreTextCheckpoint } from './workbench-annotated-text.mjs';
import { deleteText, insertText } from './workbench-text-edit.mjs';
import { createAnnotatedTextSnapshotSessionBinding, revokeAnnotatedTextSnapshotSessionBinding } from './workbench-annotated-text-snapshot-internal.mjs';
import { materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument, projectRangesOverText } from './workbench-annotated-text-snapshot.mjs';
import { applyTextOperation, materializeText as materializeFamilyText, restoreTextFamily, textFamilyCheckpoint } from './workbench-annotated-text-continuous.mjs';
import { annotatedTextAction } from './workbench-annotated-text-action.mjs';
export { bindAnnotatedTextEditor } from './workbench-annotated-text-editor.mjs';
export { materializeAnnotatedTextSnapshot };

// --- BEGIN GENERATED from src/replay-decision.ts (keep in sync; zero-import) ---
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
// --- END GENERATED from src/replay-decision.ts ---

// Shared capped-exponential-backoff delay. Pure: timers and attempt counters
// stay at the call sites, which differ in reset/clear semantics.
function backoffDelay(attempt, base, max) {
  return Math.min(base * 2 ** attempt, max);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// createOpLifecycle — the one operation-record lifecycle both fold-echo
// engines (createLiveDeliverySession, createScopeLiveStore) reimplemented.
// The REST-overlay model (createLiveStore) keeps its own overlay bookkeeping.
// ---------------------------------------------------------------------------

function shouldReconcile(_operation, { confirmedCursor, echoCursor }) {
  return echoCursor != null && (confirmedCursor == null || echoCursor >= confirmedCursor);
}

function makeOperation({ actionId, ...extra }) {
  return {
    opId: actionId,
    actionId,
    status: 'pending',
    error: null,
    delivered: false,
    confirmedCursor: null,
    echoCursor: null,
    ...extra,
  };
}

function createOpLifecycle() {
  const operations = new Map();
  return {
    operations,
    makeOperation,
    shouldReconcile,
    count(status) {
      let count = 0;
      for (const operation of operations.values()) {
        if (operation.status === status) count += 1;
      }
      return count;
    },
  };
}

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
  updateCaret({ entity, id, field, offset }) {
    if (this._closed) throw new ClientClosedError();
    const arg = arguments[0];
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      throw new TypeError('updateCaret requires exactly type/entity/id/field/offset');
    }
    const argKeys = Object.keys(arg);
    if (argKeys.length !== 4 || argKeys.some((k) => !['entity','id','field','offset'].includes(k))) {
      throw new TypeError('updateCaret requires exactly type/entity/id/field/offset');
    }
    if (typeof entity !== 'string' || entity.length === 0 ||
        typeof id !== 'string' || id.length === 0 ||
        typeof field !== 'string' || field.length === 0) {
      throw new TypeError('updateCaret requires non-empty strings for entity, id, field');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('updateCaret requires a non-negative safe integer offset');
    }
    const msg = { type: 'caret.update', entity, id, field, offset };
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
        if (valueKeys.length !== 3 || valueKeys[0] !== 'kind' || valueKeys[1] !== 'offset' || valueKeys[2] !== 'presence') return;
        if (typeof value.presence !== 'string' || value.presence.length === 0 ||
            !Number.isSafeInteger(value.offset) || value.offset < 0) return;
      } else if (value.kind === 'edge') {
        if (valueKeys.length !== 3 || valueKeys[0] !== 'edge' || valueKeys[1] !== 'kind' || valueKeys[2] !== 'presence') return;
        if (typeof value.presence !== 'string' || value.presence.length === 0 ||
            value.edge !== 'start') return;
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
    const delay = backoffDelay(this._reconnectAttempt, this._backoffBase, this._maxBackoff);
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
    const delay = backoffDelay(this._resyncAttempt, this._resyncBackoffBase, this._maxResyncBackoff);
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

function normalizeFailure(value) {
  if (isWorkbenchFailure(value)) return value;
  const raw = value?.message ?? value?.error ?? value;
  const message = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && typeof raw.message === 'string'
      ? raw.message
      : String(raw);
  return clientFailure('internal', message);
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
      let body;
      try {
        body = JSON.stringify({ operation: payload.operation });
        requestAttempted = true;
        const res = await resolvedFetch(`${baseUrl}${path}/${payload.id}/${fieldName}/apply`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body,
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
  sendBatch,
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  recoveryWarningDelayMs = 5000,
  isFoldableEcho = () => false,
}) {
  if (typeof bootstrap !== 'function') throw new TypeError('bootstrap is required');
  if (typeof subscribe !== 'function') throw new TypeError('subscribe is required');
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  if (configuredFold !== undefined && typeof configuredFold !== 'function') throw new TypeError('fold must be a function');
  if (typeof sendAction !== 'function') throw new TypeError('sendAction is required');
  if (sendBatch !== undefined && typeof sendBatch !== 'function') throw new TypeError('sendBatch must be a function');

  let baseSnapshot = null;
  let visibleSnapshot = null;
  let cursor = 0;
  let status = 'bootstrapping';
  let closed = false;
  let initialized = false;
  let reconnecting = false;
  let reconnectRequested = false;
  let connectionGeneration = 0;
  let recoveryGeneration = 0;
  let snapshotGeneration = 0;
  let receiptGeneration = 0;
  let subscription = null;
  let actionCounter = 0;
  const snapshotOnly = configuredFold === undefined;
  const fold = configuredFold ?? ((snapshot) => snapshot);
  // How long a foldable operation waits for its SSE fold echo before falling
  // back to receipt-driven snapshot recovery. The echo lands just after the
  // sender receipt, so without this grace the receipt wins and every keystroke
  // forces a full document bootstrap. See recoverFoldableAfterGrace.
  const FOLD_ECHO_GRACE_MS = 200;
  let deliveryChain = Promise.resolve();
  // Snapshot recovery is one coalesced package-owned operation.  In
  // particular, an opaque resync must wait for every transmitted operation
  // whose outcome is still unknown; otherwise its replacement snapshot can
  // be projected over an action which may still commit.
  let snapshotRecoveryFloor = null;
  let snapshotRecoveryRequested = false;
  let snapshotRecoveryRunning = false;
  let snapshotRecoveryWaiters = [];
  const listeners = new Set();
  const { operations, makeOperation, shouldReconcile, count } = createOpLifecycle();
  const recoveryRetryWaiters = new Set();
  const admissionWaiters = [];
  let recoveryWarningTimer = null;
  let recoveryWarningActive = false;

  function finishRecoveryWarning() {
    if (recoveryWarningTimer !== null) {
      clearTimeout(recoveryWarningTimer);
      recoveryWarningTimer = null;
    }
    if (recoveryWarningActive) {
      recoveryWarningActive = false;
      try { onRecoveryDelayed?.(false); } catch { /* isolate consumers */ }
    }
  }

  function startRecoveryWarning() {
    if (recoveryWarningTimer !== null || recoveryWarningActive) return;
    recoveryWarningTimer = setTimeout(() => {
      recoveryWarningTimer = null;
      if (closed || status === 'revoked' || status === 'unavailable') return;
      recoveryWarningActive = true;
      try { onRecoveryDelayed?.(true); } catch { /* isolate consumers */ }
    }, recoveryWarningDelayMs);
  }

  function admit(operation) {
    if (closed || status === 'revoked' || status === 'unavailable') return Promise.resolve(false);
    if (initialized && status === 'live' && !reconnecting) return Promise.resolve(true);
    return new Promise((resolve) => {
      admissionWaiters.push({ operation, resolve });
    });
  }

  function settleAdmissions(available) {
    if (!available) {
      for (const waiter of admissionWaiters.splice(0)) waiter.resolve(false);
      return;
    }
    for (const waiter of admissionWaiters.splice(0)) waiter.resolve(true);
  }

  function terminalStatus() {
    return closed ? 'closed' : status === 'revoked' ? 'revoked' : 'unavailable';
  }

  function canTransmit(operation) {
    return initialized
      && !closed
      && status === 'live'
      && !reconnecting
      && operations.get(operation.actionId) === operation;
  }

  function waitForRecoveryRetry(attempt) {
    const delay = backoffDelay(attempt, 50, 1000);
    return new Promise((resolve) => {
      const waiter = { timeout: null, resolve };
      waiter.timeout = setTimeout(() => {
        recoveryRetryWaiters.delete(waiter);
        resolve(true);
      }, delay);
      recoveryRetryWaiters.add(waiter);
    });
  }

  function cancelRecoveryRetries() {
    for (const waiter of recoveryRetryWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(false);
    }
    recoveryRetryWaiters.clear();
  }

  function createSettlement(operation) {
    const waiters = new Set();
    operation.settlement = Object.freeze({
      opId: operation.opId,
      wait({ signal } = {}) {
        if (operation.settlementOutcome) return Promise.resolve(operation.settlementOutcome);
        if (signal?.aborted) return Promise.resolve({ opId: operation.opId, status: 'cancelled' });
        return new Promise((resolve) => {
          const waiter = { resolve, signal, cancel: null };
          const cancel = () => {
            waiters.delete(waiter);
            signal.removeEventListener('abort', cancel);
            resolve({ opId: operation.opId, status: 'cancelled' });
          };
          waiter.cancel = cancel;
          if (signal) signal.addEventListener('abort', cancel, { once: true });
          waiters.add(waiter);
        });
      },
    });
    operation.resolveSettlement = (outcome) => {
      if (operation.settlementOutcome) return;
      operation.settlementOutcome = Object.freeze({ opId: operation.opId, ...outcome });
      for (const waiter of waiters) {
        if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.cancel);
        waiter.resolve(operation.settlementOutcome);
      }
      waiters.clear();
    };
    return operation.settlement;
  }

  function settleOperation(operation, outcome) {
    operation.resolveSettlement?.(outcome);
  }

  function nextActionId() {
    if (createActionId) return createActionId();
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `delivery_op_${++actionCounter}`;
  }

  function freezeClone(value) {
    if (!value || typeof value !== 'object') return value;
    for (const child of Object.values(value)) freezeClone(child);
    return Object.freeze(value);
  }

  function publish() {
    if (closed || baseSnapshot === null) return;
    let projected = baseSnapshot;
    for (const operation of operations.values()) {
      if (operation.status === 'pending') {
        for (const action of operation.actions ?? [operation.action]) projected = optimistic(projected, action);
      }
      // Application callbacks may synchronously trigger terminal revocation.
      // Never publish a projection that was computed before that transition.
      if (closed || status === 'revoked' || baseSnapshot === null) return;
    }
    visibleSnapshot = projected;
    for (const listener of listeners) {
      try { listener(visibleSnapshot); } catch { /* isolate consumers */ }
    }
  }

  function hasUnknownTransmission() {
    if (!snapshotOnly) return false;
    for (const operation of operations.values()) {
      if (operation.transmitted && operation.outcome === 'unknown') return true;
    }
    return false;
  }

  function cancelSnapshotRecovery(error = new ClientClosedError('Live delivery is unavailable')) {
    snapshotRecoveryRequested = false;
    snapshotRecoveryFloor = null;
    for (const waiter of snapshotRecoveryWaiters.splice(0)) waiter.reject(error);
  }

  function requestSnapshotRecovery(floor, wait = !hasUnknownTransmission(), inline = false) {
    snapshotRecoveryRequested = true;
    if (floor != null) {
      snapshotRecoveryFloor = snapshotRecoveryFloor == null
        ? floor
        : Math.max(snapshotRecoveryFloor, floor);
    }
    const promise = wait
      ? new Promise((resolve, reject) => snapshotRecoveryWaiters.push({ resolve, reject }))
      : Promise.resolve();
    kickSnapshotRecovery(inline);
    return promise;
  }

  function kickSnapshotRecovery(inline = false) {
    if (!snapshotRecoveryRequested || snapshotRecoveryRunning || closed || status === 'revoked' || status === 'unavailable') return;
    if (hasUnknownTransmission()) return;
    snapshotRecoveryRunning = true;
    const floor = snapshotRecoveryFloor;
    snapshotRecoveryFloor = null;
    snapshotRecoveryRequested = false;
    const waiters = snapshotRecoveryWaiters.splice(0);
    const snapshotGenerationAtStart = snapshotGeneration;
    const run = async () => {
      try {
        await recover('snapshot', floor);
        if (floor != null && !closed && status !== 'revoked' && status !== 'unavailable'
          && snapshotGeneration === snapshotGenerationAtStart) {
          // A reconnect may supersede this request without installing its
          // result. Give the coalesced recovery one fresh attempt before
          // treating an uncovered receipt fence as a terminal failure.
          await recover('snapshot', floor);
          if (snapshotGeneration === snapshotGenerationAtStart) {
            throw new Error('replacement snapshot did not supersede the receipt');
          }
        }
        if (floor != null && !closed && status !== 'revoked' && status !== 'unavailable'
          && cursorAnchor(cursor) < floor) {
          await recover('snapshot', floor);
          if (cursorAnchor(cursor) < floor) {
            throw new Error('replacement snapshot does not cover the receipt fence');
          }
        }
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        if (!closed && status !== 'revoked') becomeUnavailable();
        for (const waiter of waiters) waiter.reject(error);
        throw error;
      } finally {
        snapshotRecoveryRunning = false;
        kickSnapshotRecovery();
      }
    };
    // A delivery callback runs on deliveryChain.  Run its recovery inline so
    // it cannot wait on the chain which is waiting on the callback.  Sender
    // receipts, by contrast, join the chain and serialize with later delivery.
    if (inline) {
      void run().catch(() => {});
    } else {
      const attempt = deliveryChain.catch(() => {}).then(run);
      deliveryChain = attempt.catch(() => {});
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
    // Fold envelopes name the predecessor cursor explicitly. A mismatch means
    // the payload cannot be applied against the client's accepted base.
    if (envelope.fold
      && Number.isSafeInteger(envelope.fold.baseCursor)
      && envelope.fold.baseCursor !== cursorAnchor(cursor)) {
      return { status: 'resync' };
    }

    let nextSnapshot;
    try {
      nextSnapshot = fold(baseSnapshot, envelope);
    } catch {
      // A failed fold must not advance the cursor or acknowledgement fence.
      return { status: 'resync' };
    }
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
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(actionId);
      }
    }
    publish();
    return { status: operation ? 'confirmed' : 'applied' };
  }

  function settleSnapshotConfirmations(receiptGenerationAtStart) {
    // Composite streams and non-foldable annotated-text ops intentionally do
    // not disclose a foldable echo. A positive sender receipt plus an
    // authorized replacement snapshot is the package-owned equivalent of a
    // direct-stream action echo. Fold-mode sessions still use this path when
    // recovery installs a snapshot (split/merge/redacted/gap).
    for (const [actionId, operation] of operations) {
      if (operation.delivered
        && operation.confirmedThrough != null
        && snapshotGeneration > operation.receiptSnapshotGeneration
        && receiptGenerationAtStart >= operation.receiptGeneration
        && cursorAnchor(cursor) >= operation.confirmedThrough) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(actionId);
      }
    }
  }

  function becomeUnavailable() {
    if (closed || status === 'revoked') return;
    cancelSnapshotRecovery();
    finishRecoveryWarning();
    status = 'unavailable';
    settleAdmissions(false);
    // An opaque aggregate can only be reconciled by its replacement snapshot.
    // Once that recovery fails, no optimistic projection is safe to retain.
    for (const operation of operations.values()) settleOperation(operation, { status: 'unavailable' });
    operations.clear();
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

  async function recover(mode, snapshotCursorFloor, retryAttempt = 0) {
    if (closed) return;
    onRecoveryStart?.();
    startRecoveryWarning();
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
      if (!(await waitForRecoveryRetry(retryAttempt)) || closed || status === 'revoked' || generation !== recoveryGeneration) return;
      return recover('snapshot', snapshotCursorFloor, retryAttempt + 1);
    }
    if (result.kind === 'snapshot') {
      assertCursor(result.cursor, 'snapshot cursor');
      const nextSnapshot = validateSnapshot(result.snapshot, result);
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
      finishRecoveryWarning();
      status = 'live';
      publish();
      if (initialized && !reconnecting) settleAdmissions(true);
      return;
    }
    if (result.kind === 'catchup' && mode === 'catchup') {
      if (!(await applyCatchup(result))) return recover('snapshot');
      if (closed || status === 'revoked' || generation !== recoveryGeneration) return;
      finishRecoveryWarning();
      status = 'live';
      publish();
      if (initialized && !reconnecting) settleAdmissions(true);
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
        const recovery = requestSnapshotRecovery(undefined, !hasUnknownTransmission(), true);
        if (!hasUnknownTransmission()) await recovery;
        continue;
      }
      const applied = applyEvent(envelope);
      if (applied.status === 'resync') {
        const recovery = requestSnapshotRecovery(undefined, !hasUnknownTransmission(), true);
        if (!hasUnknownTransmission()) await recovery;
        continue;
      }
      if (applied.status === 'gap') {
        try {
          await recover('catchup');
        } catch (error) {
          if (!closed && status !== 'revoked') becomeUnavailable();
          throw error;
        }
        if (closed || status === 'revoked' || generation !== connectionGeneration) return;
        const replayed = applyEvent(envelope);
        if (replayed.status === 'gap') {
          if (!closed && status !== 'revoked') becomeUnavailable();
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
    requestSnapshotRecovery(operation.confirmedThrough, false);
  }

  // A foldable operation's echo is emitted on the SSE immediately after its
  // action commits, but the sender receipt is answered first. Without a grace
  // window the receipt path always wins the race, forcing a full document
  // snapshot per keystroke and discarding the fold as a "duplicate". Give the
  // echo time to land; only then fall back to snapshot recovery (the delayed-SSE
  // path). A settled operation (fold echo applied) skips the fallback.
  function recoverFoldableAfterGrace(operation) {
    setTimeout(() => {
      if (operations.get(operation.actionId) !== operation) return;
      if (operation.echoCursor != null) return;
      if (operation.confirmedThrough == null) return;
      recoverReceiptSnapshot(operation);
    }, FOLD_ECHO_GRACE_MS);
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
        if (generation !== connectionGeneration) return;
        connectionGeneration += 1;
        if (reconnecting) reconnectRequested = true;
        else reconnect().catch(() => {});
      },
    });
    // Delivery can revoke access while transport establishment is pending.
    // Never retain a subscription that became unauthorized before its handle.
    if (closed || status === 'revoked' || generation !== connectionGeneration) {
      nextSubscription?.close?.();
      return false;
    }
    subscription = nextSubscription;
    return true;
  }

  let reconnectLoop = null;
  async function reconnect() {
    if (closed || status === 'revoked') return;
    if (reconnecting) {
      reconnectRequested = true;
      // A reconnect loop is already running. Await its completion (which
      // includes the extra iteration this request triggers) so the caller
      // observes the loop's final snapshot, not an intermediate one.
      return reconnectLoop;
    }
    // Some adapters report their own close synchronously. Mark reconnecting
    // before closing the old subscription so that callback cannot recurse.
    reconnecting = true;
    onRecoveryStart?.();
    reconnectLoop = (async () => {
      try {
        do {
          reconnectRequested = false;
          // Invalidate the old transport before recovery reauthorizes the stream.
          connectionGeneration += 1;
          subscription?.close?.();
          subscription = null;
          await recover('catchup');
          if (closed || status === 'revoked') break;
          status = 'recovering';
          if (!(await connect())) {
            reconnectRequested = true;
            continue;
          }
          status = 'live';
        } while (reconnectRequested && !closed && status !== 'revoked');
        if (!reconnectRequested && !closed && status === 'live') settleAdmissions(true);
      } catch (error) {
        if (!closed && status !== 'revoked') becomeUnavailable();
        throw error;
      } finally {
        reconnecting = false;
        reconnectLoop = null;
      }
    })();
    return reconnectLoop;
  }

  function revoke(_reason) {
    if (closed || status === 'revoked') return;
    status = 'revoked';
    cancelSnapshotRecovery();
    finishRecoveryWarning();
    settleAdmissions(false);
    cancelRecoveryRetries();
    baseSnapshot = null;
    visibleSnapshot = null;
    for (const operation of operations.values()) settleOperation(operation, { status: 'revoked' });
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
      if (!closed && status !== 'revoked') {
        if (await connect()) initialized = true;
      }
    } catch (error) {
      if (!closed && status !== 'revoked') becomeUnavailable();
      throw error;
    }
  }

  async function dispatch(type, payload) {
    const actionId = nextActionId();
    const action = freezeClone(structuredClone({ actionId, type, payload }));
    const operation = makeOperation({
      actionId,
      action,
      outcome: 'unknown',
      confirmedThrough: null,
      receiptGeneration: null,
      receiptSnapshotGeneration: null,
      foldableEcho: isFoldableEcho(action) === true,
    });
    const settlement = createSettlement(operation);
    if (!initialized || closed || status === 'unavailable' || status === 'revoked') {
      settleOperation(operation, { status: terminalStatus() });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    operations.set(actionId, operation);
    publish();
    if (!((status === 'live' && !reconnecting) || await admit(operation)) || !canTransmit(operation)) {
      settleOperation(operation, { status: terminalStatus() });
      operations.delete(actionId);
      publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    return submitAction(operation);
  }

  async function submitAction(operation) {
    try {
      operation.transmitted = true;
      const receipt = await sendAction(operation.action);
      if (status === 'revoked') {
        operation.outcome = 'rejected';
        settleOperation(operation, { status: 'revoked' });
        operations.delete(operation.actionId);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      if (receipt?.ok === false) {
        operation.outcome = 'rejected';
        kickSnapshotRecovery();
        // The matching committed envelope is authoritative when a request
        // failure races its delivery; never tell callers to retry that action.
        if (operation.echoCursor != null) {
          operations.delete(operation.actionId);
          publish();
          settleOperation(operation, { status: 'reconciled' });
          return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
        }
        const failure = receipt.failure ?? receipt.error ?? receipt;
        operations.delete(operation.actionId);
        operation.status = 'failed';
        operation.error = failure;
        settleOperation(operation, { status: 'failed', error: failure });
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure };
      }
      const confirmedThrough = receipt?.confirmedThrough;
      if (snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0 || receipt?.actionId !== operation.actionId)) {
        throw new Error('snapshot-only action receipt must confirm its actionId through a nonnegative cursor');
      }
      operation.outcome = 'positive';
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++receiptGeneration;
      operation.receiptSnapshotGeneration = snapshotGeneration;
      settleSnapshotConfirmations(receiptGeneration);
      // Prefer fold echo settlement. Snapshot recovery covers (a) snapshot-only
      // composites and (b) fold-mode actions whose receipt names a fence but
      // whose fold echo has not arrived (non-foldable ops, delayed SSE).
      // Ordinary fold sessions without a confirmation fence keep echo-only settle.
      if (operation.echoCursor == null
        && (snapshotOnly || Number.isSafeInteger(operation.confirmedThrough))) {
        if (operation.foldableEcho) recoverFoldableAfterGrace(operation);
        else recoverReceiptSnapshot(operation);
      }
      if (shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement, value: receipt?.value };
    } catch (error) {
      if (status === 'revoked') {
        settleOperation(operation, { status: 'revoked' });
        operations.delete(operation.actionId);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      // A delivery echo proves the action reached the committed recipient
      // stream even when its request promise fails after that point.
      if (operation.echoCursor != null) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
        publish();
        return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
      }
      operation.deliveryError = error;
      return { ok: false, status: 'outcome-unknown', opId: operation.actionId, settlement: operation.settlement, deliveryError: { message: String(error?.message ?? error) } };
    }
  }

  async function submitBatch(operation) {
    try {
      operation.transmitted = true;
      const receipt = await sendBatch(operation.batch);
      if (status === 'revoked') {
        operation.outcome = 'rejected';
        settleOperation(operation, { status: 'revoked' });
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      if (receipt?.ok === false) {
        operation.outcome = 'rejected';
        kickSnapshotRecovery();
        if (operation.echoCursor != null) {
          settleOperation(operation, { status: 'reconciled' });
          operations.delete(operation.actionId);
          publish();
          return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
        }
        operations.delete(operation.actionId);
        operation.status = 'failed';
        operation.error = receipt.failure ?? receipt.error ?? receipt;
        settleOperation(operation, { status: 'failed', error: operation.error });
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: operation.error };
      }
      if (!receipt || receipt.ok !== true || receipt.actionId !== operation.actionId) {
        throw new Error('batch dispatch returned an invalid receipt');
      }
      const confirmedThrough = receipt.confirmedThrough;
      if (snapshotOnly && (!Number.isSafeInteger(confirmedThrough) || confirmedThrough < 0)) {
        throw new Error('snapshot-only batch receipt must confirm through a nonnegative cursor');
      }
      operation.outcome = 'positive';
      operation.delivered = true;
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      if (Number.isSafeInteger(confirmedCursor) && confirmedCursor >= 0) operation.confirmedCursor = confirmedCursor;
      if (Number.isSafeInteger(confirmedThrough) && confirmedThrough >= 0) operation.confirmedThrough = confirmedThrough;
      operation.receiptGeneration = ++receiptGeneration;
      operation.receiptSnapshotGeneration = snapshotGeneration;
      settleSnapshotConfirmations(receiptGeneration);
      if (operation.echoCursor == null
        && (snapshotOnly || Number.isSafeInteger(operation.confirmedThrough))) {
        if (operation.foldableEcho) recoverFoldableAfterGrace(operation);
        else recoverReceiptSnapshot(operation);
      }
      if (shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement, value: receipt?.value };
    } catch (error) {
      if (status === 'revoked') {
        settleOperation(operation, { status: 'revoked' });
        operations.delete(operation.actionId);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: operation.actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery access was revoked') };
      }
      if (operation.echoCursor != null) {
        settleOperation(operation, { status: 'reconciled' });
        operations.delete(operation.actionId);
        publish();
        return { ok: true, status: 'committed', opId: operation.actionId, settlement: operation.settlement };
      }
      // A transport exception cannot prove rollback. Retain the one package-owned
      // envelope and optimistic placeholder so retry can resend its action ID.
      operation.deliveryError = error;
      return { ok: false, status: 'outcome-unknown', opId: operation.actionId, settlement: operation.settlement, deliveryError: { message: String(error?.message ?? error) } };
    }
  }

  async function batch(actions) {
    const actionId = nextActionId();
    const rejectedOperation = { opId: actionId };
    const rejectedSettlement = createSettlement(rejectedOperation);
    if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => !action
      || typeof action.type !== 'string'
      || Object.keys(action).length !== 2
      || !isJsonValue(action.payload))) {
      settleOperation(rejectedOperation, { status: 'failed', error: new TypeError('batch requires a non-empty action array') });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: new TypeError('batch requires a non-empty action array') };
    }
    if (typeof sendBatch !== 'function') {
      const failure = new TypeError('sendBatch is required');
      settleOperation(rejectedOperation, { status: 'failed', error: failure });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure };
    }
    if (!initialized || closed || status === 'unavailable' || status === 'revoked') {
      settleOperation(rejectedOperation, { status: terminalStatus() });
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: rejectedSettlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    const retainedActions = freezeClone(structuredClone(actions));
    const batchEnvelope = Object.freeze({ actionId, actions: retainedActions });
    const operation = makeOperation({
      actionId,
      batch: batchEnvelope,
      actions: retainedActions,
      outcome: 'unknown',
      confirmedThrough: null,
      receiptGeneration: null,
      receiptSnapshotGeneration: null,
      foldableEcho: isFoldableEcho(retainedActions[0]) === true,
    });
    createSettlement(operation);
    operations.set(actionId, operation);
    publish();
    if (!((status === 'live' && !reconnecting) || await admit(operation)) || !canTransmit(operation)) {
      settleOperation(operation, { status: terminalStatus() });
      operations.delete(actionId);
      publish();
      return { ok: false, status: 'failed-rolled-back', opId: actionId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    return submitBatch(operation);
  }

  async function retry(opId) {
    const operation = operations.get(opId);
    if (!operation?.deliveryError || (!operation.batch && !operation.action)) {
      const rejectedOperation = { opId };
      const settlement = createSettlement(rejectedOperation);
      const failure = new TypeError('operation is not awaiting transport retry');
      settleOperation(rejectedOperation, { status: 'failed', error: failure });
      return { ok: false, status: 'failed-rolled-back', opId, settlement, failure };
    }
    if (!((status === 'live' && !reconnecting) || await admit(operation)) || !canTransmit(operation)) {
      settleOperation(operation, { status: terminalStatus() });
      operations.delete(opId);
      publish();
      return { ok: false, status: 'failed-rolled-back', opId, settlement: operation.settlement, failure: new ClientClosedError('Live delivery is unavailable') };
    }
    operation.deliveryError = null;
    return operation.batch ? submitBatch(operation) : submitAction(operation);
  }

  const ready = start();
  ready.catch(() => {});

  return {
    get snapshot() { return visibleSnapshot; },
    get cursor() { return cursor; },
    get status() { return status; },
    get ready() { return ready; },
    dispatch,
    batch,
    retry,
    reconnect,
    operations() {
      return [...operations.values()].map((operation) => Object.freeze({
        opId: operation.opId,
        actionId: operation.actionId,
        status: operation.status,
        error: operation.error,
      }));
    },
    pendingCount() { return count('pending'); },
    subscribe(listener) {
      listeners.add(listener);
      if (visibleSnapshot !== null || status === 'revoked') listener(visibleSnapshot);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      cancelSnapshotRecovery();
      finishRecoveryWarning();
      settleAdmissions(false);
      cancelRecoveryRetries();
      subscription?.close?.();
      subscription = null;
      for (const operation of operations.values()) settleOperation(operation, { status: 'closed' });
      operations.clear();
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
  serializeAction,
  sendBatch,
  actionUrl,
  historySession,
  fetchImpl = globalThis.fetch,
  eventSourceFactory = (url, options) => new EventSource(url, options),
  createActionId,
  onRecoveryStart,
  onRecoveryDelayed,
  requestIdentity = null,
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
  const batchActionEndpoint = new URL('/workbench/actions/batch', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();
  const historyEndpoint = new URL('/workbench/history', new URL(baseUrl, globalThis.location?.href ?? 'http://workbench.local')).toString();

  async function bootstrap({ after, mode }) {
    const url = new URL(endpoint, globalThis.location?.href ?? 'http://workbench.local');
    if (!requestIdentity) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries(requestIdentity ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('mode', mode);
    if (mode === 'catchup') url.searchParams.set('after', typeof after === 'object' ? JSON.stringify(after) : String(after));
    let response;
    try {
      response = await fetchImpl(url.toString(), { credentials: 'include' });
    } catch {
      return { kind: 'retry' };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'revoked' };
    if (response.status >= 500) return { kind: 'retry' };
    if (!response.ok) throw new Error(`live delivery bootstrap failed with HTTP ${response.status}: ${await response.text()}`);
    const result = await response.json();
    if (!result || typeof result !== 'object' || !['snapshot', 'catchup', 'retry', 'revoked'].includes(result.kind)) {
      throw new Error('live delivery bootstrap returned an invalid response');
    }
    return result;
  }

  function subscribe({ after, deliver, closed }) {
    const url = new URL(eventsEndpoint, globalThis.location?.href ?? 'http://workbench.local');
    if (!requestIdentity) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries(requestIdentity ?? {})) url.searchParams.set(key, value);
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
      ? { actionId: action.actionId, command: historyCommand, ...historyPayload,
          ...(requestIdentity ? { document: requestIdentity } : { scope }) }
      : null;
    const response = await fetchImpl(historyRequest ? historyEndpoint : actionEndpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(historyRequest ?? { ...action, ...(requestIdentity ? { document: requestIdentity } : { scope }), clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch {
      if (!response.ok) return { ok: false, failure: new Error(`action dispatch failed with HTTP ${response.status}`) };
      throw new Error(`action dispatch failed with HTTP ${response.status}`);
    }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true) throw new Error('action dispatch returned an invalid receipt');
    return receipt;
  }

  async function sendHttpBatch(batch) {
    const response = await fetchImpl(batchActionEndpoint, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...batch, ...(requestIdentity ? { document: requestIdentity } : { scope }), clientId: historySession }),
    });
    let receipt;
    try { receipt = await response.json(); } catch {
      if (!response.ok) return { ok: false, failure: new Error(`batch dispatch failed with HTTP ${response.status}`) };
      throw new Error(`batch dispatch failed with HTTP ${response.status}`);
    }
    if (!response.ok) return receipt?.ok === false ? receipt : { ok: false, failure: receipt };
    if (!receipt || receipt.ok !== true || receipt.actionId !== batch.actionId) throw new Error('batch dispatch returned an invalid receipt');
    return receipt;
  }

  let actionTail = Promise.resolve();
  const transportAction = (action) => action.type.startsWith('$history.')
    ? sendHttpAction(action)
    : (sendAction ?? sendHttpAction)(action);
  const session = createLiveDeliverySession({
    bootstrap,
    subscribe,
    validateSnapshot,
    fold,
    optimistic,
    sendAction: (action) => {
      if (!serializeAction?.(action)) return transportAction(action);
      const pending = actionTail.then(() => transportAction(action));
      actionTail = pending.catch(() => {});
      return pending;
    },
    sendBatch: sendBatch ?? sendHttpBatch,
    createActionId,
    onRecoveryStart,
    onRecoveryDelayed,
    isFoldableEcho: (action) => serializeAction?.(action) === true,
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

/**
 * Snapshot-only client for a principal-anchored projection. The package owns
 * its cursor, reconnect, and opaque-resync replacement; hosts receive no event
 * reducer, mutation, optimistic-state, or cursor configuration seam.
 */
export function createPrincipalSnapshotHttpSession({
  baseUrl,
  declaration,
  principal,
  validateSnapshot,
  fetchImpl,
  eventSourceFactory,
}) {
  if (typeof declaration !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(declaration)) {
    throw new TypeError('principal snapshot declaration is invalid');
  }
  if (!principal || !['user', 'link', 'system', 'apiKey'].includes(principal.type)
    || typeof principal.id !== 'string' || principal.id.length === 0) {
    throw new TypeError('principal snapshot principal is invalid');
  }
  if (typeof validateSnapshot !== 'function') throw new TypeError('validateSnapshot is required');
  const scope = `PrincipalSnapshot:${declaration}/${principal.type}/${encodeURIComponent(principal.id)}`;
  const session = createLiveDeliveryHttpSession({
    baseUrl,
    scope,
    validateSnapshot,
    fetchImpl,
    eventSourceFactory,
    historySession: 'principal-snapshot',
    sendAction: async () => { throw new Error('principal snapshot sessions do not dispatch actions'); },
  });
  return Object.freeze({
    get snapshot() { return session.snapshot; },
    get status() { return session.status; },
    get ready() { return session.ready; },
    subscribe(listener) { return session.subscribe(listener); },
    reconnect() { return session.reconnect(); },
    close() { session.close(); },
  });
}

/**
 * A document-bound annotated-text session. The document context owns scope,
 * action grammar, and private authoring bindings; callers only name positions.
 */
export function createAnnotatedTextHttpSession({ baseUrl, context, historySession, fetchImpl, eventSourceFactory, createActionId, onRecoveryDelayed, onFoldApplied, carets }) {
  if (!context || typeof context !== 'object' || typeof context.documentId !== 'string' || context.documentId.length === 0) {
    throw new TypeError('annotated text context requires a documentId');
  }
  const { entity, field, documentId } = context;
  if (typeof entity?.name !== 'string' || typeof field?.fieldName !== 'string' || entity.fields?.[field.fieldName]?.kind !== 'annotatedText') {
    throw new TypeError('annotated text context requires declared entity and field handles');
  }
  const scope = `annotated-text:${documentId}`;
  const randomToken = () => {
    if (!globalThis.crypto?.getRandomValues) throw new Error('secure random authoring tokens are unavailable');
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  };
  const authoringClientStorageKey = `workbench:annotated-text-authoring-client:${JSON.stringify([
    baseUrl.replace(/\/+$/, ''), entity.name, field.fieldName, documentId,
  ])}`;
  let authoringClient;
  try {
    const stored = globalThis.sessionStorage?.getItem(authoringClientStorageKey);
    authoringClient = typeof stored === 'string' && /^[A-Za-z0-9_-]{43}$/.test(stored) ? stored : randomToken();
    if (stored !== authoringClient) {
      try { globalThis.sessionStorage?.setItem(authoringClientStorageKey, authoringClient); } catch {}
    }
  } catch {
    authoringClient = randomToken();
  }
  const deferredAuthoringAcknowledgements = new Map();
  let authoringMutationTail = null;
  let sessionClosed = false;
  let wakeAuthoringMutation = null;
  let translatedActions = 0;
  // Annotated-text family checkpoint is session-private. Snapshots replace it;
  // fold envelopes advance it. It is not a text.crdt reducer seed.
  let familyCheckpoint = null;
  const snapshotBinding = createAnnotatedTextSnapshotSessionBinding();
  const requestIdentity = { entity: entity.name, field: field.fieldName, documentId, authoringClient };
  if (typeof context.viewAs === 'string' && context.viewAs.length > 0) requestIdentity.viewAs = context.viewAs;

  // Optional recipient-projected carets: ephemeral presence ONLY. When the host
  // supplies a `carets` option the session owns ONE caret LiveChannel — the
  // document subscription carries caret interest, validated `annotated-text-caret`
  // frames feed registered listeners, and publish/clear are volatile (never
  // queued, never durable, never optimistic text). Without the option the
  // session exposes no caret surface and never constructs a channel.
  const caretsOption = carets ?? null;
  const caretListeners = new Set();
  let caretChannel = null;
  if (caretsOption != null) {
    if (typeof caretsOption !== 'object' || Array.isArray(caretsOption)
      || typeof caretsOption.wsBaseUrl !== 'string' || caretsOption.wsBaseUrl.length === 0) {
      throw new TypeError('annotated text carets option requires a wsBaseUrl');
    }
    if (caretsOption.socketFactory !== undefined && typeof caretsOption.socketFactory !== 'function') {
      throw new TypeError('annotated text carets socketFactory must be a function');
    }
    try {
      caretChannel = new LiveChannel(caretsOption.wsBaseUrl, {
        ...(typeof caretsOption.socketFactory === 'function' ? { socketFactory: caretsOption.socketFactory } : {}),
      });
      // Eager subscribe so presence is ready when the editor first focuses.
      // A host without WebSocket support rejects the subscription; degrade to a
      // no-op channel instead of failing session construction.
      caretChannel.subscribe(entity.name, documentId, {
        carets: [field.fieldName],
        onCaret: (frame) => {
          for (const listener of caretListeners) {
            try { listener(frame); } catch { /* isolate consumers */ }
          }
        },
      }).catch(() => {});
    } catch {
      caretChannel = null;
    }
  }

  function installAuthoringFromFold(foldAuthoring, fence) {
    if (!foldAuthoring || foldAuthoring.acknowledgementFence !== fence) {
      throw new Error('annotated text fold authoring fence mismatch');
    }
    const positionFrames = foldAuthoring.positionFrames;
    if (!Array.isArray(positionFrames) || positionFrames.length === 0
      || !positionFrames[0] || typeof positionFrames[0].positionToken !== 'string') {
      throw new Error('annotated text fold position frame is invalid');
    }
    snapshotBinding.authoring = Object.freeze({
      stream: foldAuthoring.stream,
      lease: foldAuthoring.lease,
      snapshot: foldAuthoring.snapshot,
      acknowledgementFence: fence,
      // A fold refreshes the one document-scoped position token; the binding is
      // rebuilt fresh so stale block-era group/split state never survives.
      documentPositionToken: positionFrames[0].positionToken,
      groupTokens: new Map(),
      splitResolutions: Object.freeze([]),
    });
  }

  /**
   * Consume the server-authoritative emptied-annotation disposition a v4 fold
   * ships. The fold is the ONE reconciliation path: the client never infers
   * delete-vs-orphan itself. A `deleted` disposition drops the annotation; an
   * `orphaned` disposition keeps its durable identity with the server's saved
   * quote (fields and owner come from the annotation the recipient already
   * disclosed). A disposition naming an annotation the recipient never had, a
   * family mismatch, or a collapsed range without a matching disposition fail
   * closed so the session recovers with an authorized snapshot instead of
   * diverging.
   */
  function applyAnnotatedTextFoldDispositions(currentDocument, ranges, dispositions) {
    if (!Array.isArray(dispositions)) throw new Error('annotated text fold dispositions are invalid');
    const annotationById = new Map(currentDocument.annotations.map((annotation) => [annotation.id, annotation]));
    const dispositionById = new Map();
    for (const disposition of dispositions) {
      if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)
        || typeof disposition.annotationId !== 'string'
        || (disposition.kind !== 'deleted' && disposition.kind !== 'orphaned')
        || typeof disposition.family !== 'string'
        || (disposition.kind === 'orphaned' && typeof disposition.savedQuote !== 'string')) {
        throw new Error('annotated text fold disposition is invalid');
      }
      const annotation = annotationById.get(disposition.annotationId);
      if (!annotation) throw new Error('annotated text fold disposition names an unknown annotation');
      if (annotation.family !== disposition.family) throw new Error('annotated text fold disposition family disagrees');
      if (dispositionById.has(disposition.annotationId)) throw new Error('annotated text fold disposition is duplicated');
      dispositionById.set(disposition.annotationId, disposition);
    }
    const retainedRanges = [];
    const orphans = [...(currentDocument.orphans ?? [])];
    for (const range of ranges) {
      const disposition = dispositionById.get(range.annotationId);
      if (disposition) {
        // The server is authoritative: the annotation is gone from the active
        // ranges regardless of the local projection's width approximation.
        if (disposition.kind === 'orphaned') {
          const annotation = annotationById.get(range.annotationId);
          orphans.push(deepFreeze({
            id: annotation.id,
            family: annotation.family,
            fields: { ...annotation.fields },
            savedQuote: disposition.savedQuote,
            ...(annotation.owner ? { owner: annotation.owner } : {}),
          }));
        }
        continue;
      }
      // A range the server emptied always carries a disposition. A collapsed
      // range without one is a projection divergence; recover with a snapshot.
      if (range.start >= range.end) throw new Error('annotated text fold collapsed a range without a disposition');
      retainedRanges.push(range);
    }
    const retainedAnnotations = currentDocument.annotations.filter((annotation) => !dispositionById.has(annotation.id));
    // The server's snapshot canonicalizes orphans by `ORDER BY a.id` (see
    // annotated-text-snapshot.mjs). A fold must reproduce that EXACT order so
    // a folded document is byte-for-byte the fresh authorized snapshot: new
    // orphans are appended in range order above, so sort the combined list
    // canonically before installing it. Fields are preserved by the stable id
    // sort.
    const canonicalOrphans = [...orphans].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return Object.freeze({
      ...currentDocument,
      ranges: Object.freeze(retainedRanges),
      annotations: Object.freeze(retainedAnnotations),
      orphans: Object.freeze(canonicalOrphans),
    });
  }

  function foldAnnotatedTextDocument(currentDocument, envelope) {
    const startedAt = onFoldApplied ? performance.now() : 0;
    const fold = envelope?.fold;
    if (!fold || fold.kind !== 'annotatedText' || fold.version !== 4 || fold.field !== field.fieldName) {
      throw new Error('annotated text fold envelope is missing or unsupported');
    }
    const fence = envelope.seq ?? envelope.seqSpan?.[1];
    if (fold.fence !== fence || fold.authoring?.acknowledgementFence !== fence) {
      throw new Error('annotated text fold fence mismatch');
    }
    if (fold.text?.reducer !== 'workbench.text' || !Array.isArray(fold.text.operations) || fold.text.operations.length === 0) {
      throw new Error('annotated text fold text operations are invalid');
    }
    if (!fold.projection || typeof fold.projection.text !== 'string') {
      throw new Error('annotated text fold projection is invalid');
    }
    if (!Array.isArray(fold.dispositions)) {
      throw new Error('annotated text fold dispositions are invalid');
    }
    // The family seed comes from the snapshot's authoring envelope (fully
    // unredacted recipients). A fold against no seeded checkpoint cannot verify
    // the transition; fail closed so the session recovers with a fresh snapshot.
    if (!familyCheckpoint) {
      throw new Error('annotated text fold requires a family checkpoint seeded by the snapshot');
    }
    let family = restoreTextFamily(familyCheckpoint);
    // A fold ships text operations only; the annotation ranges must track the
    // same transition. Project the authoritative snapshot ranges through the
    // fold's COMBINED text change (a replace is one delete+insert pair whose
    // combined effect empties a covered range without re-opening it), then let
    // the fold's server-carried dispositions decide each emptied annotation's
    // delete-vs-orphan fate (the client never infers the policy itself).
    const beforeText = materializeFamilyText(family);
    for (const operation of fold.text.operations) {
      family = applyTextOperation(family, operation);
    }
    const afterText = materializeFamilyText(family);
    const foldedRanges = beforeText === afterText
      ? currentDocument.ranges
      : projectRangesOverText(currentDocument.ranges, beforeText, afterText);
    if (materializeFamilyText(family) !== fold.projection.text) {
      throw new Error('annotated text fold projection disagrees with family');
    }
    // A causally-reducible fold must leave NO pending operations behind: a
    // syntactically valid op whose dependency is absent would materialize the
    // same text now and then silently drain into the document on a later fold,
    // desynchronizing the session. The element count is required and exact.
    if (!Number.isSafeInteger(fold.familyElementCount)
      || Object.keys(family.checkpoint.elements).length !== fold.familyElementCount) {
      throw new Error('annotated text fold family element count disagrees');
    }
    if (Object.keys(family.checkpoint.pending).length !== 0 || family.checkpoint.rebootstrapRequired) {
      throw new Error('annotated text fold left pending operations behind; snapshot recovery required');
    }
    familyCheckpoint = textFamilyCheckpoint(family);
    installAuthoringFromFold(fold.authoring, fence);
    if (onFoldApplied) onFoldApplied(fold, performance.now() - startedAt);
    const foldedDocument = applyAnnotatedTextFoldDispositions(currentDocument, foldedRanges, fold.dispositions);
    return Object.freeze({ ...foldedDocument, text: fold.projection.text });
  }

  const session = createLiveDeliveryHttpSession({
    baseUrl,
    scope,
    historySession,
    fetchImpl,
    eventSourceFactory,
    createActionId,
    requestIdentity,
    onRecoveryStart: () => {
      familyCheckpoint = null;
      revokeAnnotatedTextSnapshotSessionBinding(snapshotBinding);
    },
    onRecoveryDelayed,
    fold: foldAnnotatedTextDocument,
    optimistic(document, action) {
      // Blockless: the document is ONE text and the action carries absolute
      // offsets; the text-splice projection needs no block mapping.
      return projectPendingAnnotatedTextDocument(document, action, null);
    },
    serializeAction(action) {
      return action.payload?.edit?.kind === 'text.insert'
        || action.payload?.edit?.kind === 'text.delete'
        || action.payload?.edit?.kind === 'text.replace';
    },
    validateSnapshot(snapshot, delivery) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('annotated text delivery snapshot must be an object');
      const authoring = delivery?.authoring;
      if (!authoring || authoring.acknowledgementFence !== delivery.cursor) throw new Error('annotated text delivery authoring envelope is invalid');
      const documentPositionToken = authoring.positionFrames?.[0]?.positionToken;
      if (!documentPositionToken || typeof documentPositionToken !== 'string') throw new Error('annotated text delivery authoring position token is invalid');
      snapshotBinding.authoring = Object.freeze({
        stream: authoring.stream,
        lease: authoring.lease,
        snapshot: authoring.snapshot,
        acknowledgementFence: authoring.acknowledgementFence,
        documentPositionToken,
        groupTokens: new Map(),
        splitResolutions: Object.freeze([]),
      });
      // For fully-unredacted recipients the authoring envelope carries the
      // canonical family checkpoint; seed the fold reducer from it so
      // subsequent folds apply against the client's own copy instead of
      // re-shipping the whole family per keystroke.
      familyCheckpoint = authoring.family ?? null;
      const result = materializeAnnotatedTextSnapshot({ ...snapshot[field?.fieldName], authoring }, field, snapshotBinding);
      return result;
    },
  });
  function acknowledgeAuthoring(authoring) {
    void Promise.resolve().then(() => fetchImpl(`${baseUrl.replace(/\/$/, '')}/authoring/ack`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, entity: entity.name, field: field.fieldName, documentId,
        stream: authoring.stream, lease: authoring.lease, snapshot: authoring.snapshot,
        ...(context.viewAs ? { viewAs: context.viewAs } : {}) }),
    })).catch(() => {});
  }
  function flushAuthoringAcknowledgements() {
    if (translatedActions !== 0) return;
    for (const authoring of deferredAuthoringAcknowledgements.values()) acknowledgeAuthoring(authoring);
    deferredAuthoringAcknowledgements.clear();
  }
  session.subscribe((document) => {
    if (document === null) revokeAnnotatedTextSnapshotSessionBinding(snapshotBinding);
    if (document && snapshotBinding.authoring) {
      const authoring = snapshotBinding.authoring;
      if (translatedActions === 0) acknowledgeAuthoring(authoring);
      else deferredAuthoringAcknowledgements.set(authoring.snapshot, authoring);
    }
  });
  function capturedBlocks(command) {
    // Blockless: the whole document is ONE text. Capture the CURRENT
    // (optimistic) text so the submit check can detect a foreign change that
    // appeared after capture.
    void command;
    return new Map([['document', session.snapshot?.text ?? '']]);
  }
  function sameCapturedBlocks(blocks) {
    return blocks.get('document') === session.snapshot?.text;
  }
  function localAuthoringConflict() {
    return { ok: false, failure: new Error('annotated text changed before queued operation could be submitted') };
  }
  function queueAuthoringMutation(command, send) {
    const blocks = capturedBlocks(command);
    const predecessor = authoringMutationTail;
    let release;
    authoringMutationTail = new Promise((resolve) => { release = resolve; });
    return (async () => {
      try {
        if (predecessor) await predecessor;
        if (sessionClosed) throw new ClientClosedError('Annotated text document is unavailable');
        // Tokens are snapshot-fenced capabilities. Never translate against a
        // revoked binding or an optimistic/foreign basis that has since moved.
        if (session.status !== 'live' || !session.snapshot || !snapshotBinding.authoring) {
          await new Promise((resolve) => {
            wakeAuthoringMutation = resolve;
            const unsubscribe = session.subscribe(() => {
              if (sessionClosed || ['revoked', 'unavailable'].includes(session.status)
                || (session.status === 'live' && session.snapshot && snapshotBinding.authoring)) {
                unsubscribe();
                wakeAuthoringMutation = null;
                resolve();
              }
            });
          });
        }
        if (sessionClosed) throw new ClientClosedError('Annotated text document is unavailable');
        if (['revoked', 'unavailable'].includes(session.status)) return localAuthoringConflict();
        // Fail closed on any foreign change after capture: the queued offset is
        // absolute against the captured view, and a naive length-delta rebase
        // moves it to the wrong place when the foreign edit sits after the
        // target. The position basis would be stale server-side anyway; surface
        // the conflict instead of guessing.
        if (!sameCapturedBlocks(blocks)) return localAuthoringConflict();
        const result = await send(command);
        if (result?.ok && result.settlement?.wait) await result.settlement.wait();
        return result;
      } finally {
        release();
      }
    })();
  }
  async function dispatchNow(command) {
    if (!session.snapshot || !snapshotBinding.authoring) throw new ClientClosedError('Annotated text document is unavailable');
    const tokenAt = (value) => {
      if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new TypeError('annotated text position is invalid');
      if (value.affinity !== 'left' && value.affinity !== 'right') throw new TypeError('annotated text position requires an affinity');
      return { positionToken: snapshotBinding.authoring.documentPositionToken, offset: value.offset, affinity: value.affinity };
    };
    const translated = { ...command, id: documentId, authoring: { version: 1, stream: snapshotBinding.authoring.stream, lease: snapshotBinding.authoring.lease, mutationId: command.mutationId ?? randomToken() } };
    if (command.at) translated.at = tokenAt(command.at);
    if (command.from) translated.from = tokenAt(command.from);
    if (command.to) translated.to = tokenAt(command.to);
    const action = annotatedTextAction(entity, field, translated);
    translatedActions += 1;
    try {
      return await session.dispatch(action.type, action.payload);
    } finally {
      translatedActions -= 1;
      flushAuthoringAcknowledgements();
    }
  }
  const annotatedSurface = {
    get document() { return annotatedDocumentView(session.snapshot); },
    get history() { return session.history; },
    get status() { return session.status; },
    get ready() { return session.ready; },
    insert({ mutationId, at, text }) {
      const command = { kind: 'text.insert', mutationId, at, text };
      return queueAuthoringMutation(command, (current) => dispatchNow(current));
    },
    delete({ mutationId, from, to }) {
      const command = { kind: 'text.delete', mutationId, from, to };
      return queueAuthoringMutation(command, (current) => dispatchNow(current));
    },
    replace(input) {
      if (!input || typeof input !== 'object') return { ok: false, failure: new TypeError('annotated text replace requires from, to, and text') };
      // An insert (empty selection) must NOT be sent as text.replace: the
      // server rejects a replace with an empty delete range. Route it to
      // text.insert so editor keystrokes and IME inserts submit correctly.
      const isInsert = input?.from?.offset === input?.to?.offset && input?.text;
      const command = isInsert
        ? { kind: 'text.insert', mutationId: input?.mutationId, at: input.from, text: input.text }
        : {
            kind: input?.text ? 'text.replace' : 'text.delete',
            mutationId: input?.mutationId,
            from: input?.from,
            to: input?.to,
            ...(input?.text ? { text: input.text } : {}),
          };
      return queueAuthoringMutation(command, (current) => dispatchNow(current));
    },
    applyAnnotation({ mutationId, annotation, from, to }) {
      const command = { kind: 'annotation.apply', mutationId, annotation, from, to };
      return queueAuthoringMutation(command, (current) => dispatchNow(current));
    },
    removeAnnotation({ mutationId, annotationId }) {
      const command = { kind: 'annotation.remove', mutationId, annotationId };
      return queueAuthoringMutation(command, (current) => dispatchNow(current));
    },
    reconnect: () => session.reconnect(),
    // Subscribe delivers the same document view the session.document getter
    // exposes. The underlying delivery publishes the raw blockless recipient
    // snapshot; the view passes it through as-is.
    subscribe: (listener) => session.subscribe((snapshot) => listener(snapshot === null ? null : annotatedDocumentView(snapshot))),
    close: () => {
      sessionClosed = true;
      wakeAuthoringMutation?.();
      wakeAuthoringMutation = null;
      revokeAnnotatedTextSnapshotSessionBinding(snapshotBinding);
      if (caretChannel) {
        // Best-effort retraction before the channel closes; a server with no
        // presence yet still accepts the clear, so no error is expected.
        try { caretChannel.clearCaret({ entity: entity.name, id: documentId, field: field.fieldName }); } catch { /* best effort */ }
        try { caretChannel.close(); } catch { /* best effort */ }
        caretChannel = null;
      }
      caretListeners.clear();
      session.close();
    },
  };
  if (caretsOption != null) {
    annotatedSurface.publishCaret = function publishCaret({ offset } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new TypeError('annotated text caret offset must be a non-negative safe integer');
      }
      if (!caretChannel) return false;
      return caretChannel.updateCaret({ entity: entity.name, id: documentId, field: field.fieldName, offset });
    };
    annotatedSurface.clearCaret = function clearCaret() {
      if (!caretChannel) return false;
      return caretChannel.clearCaret({ entity: entity.name, id: documentId, field: field.fieldName });
    };
    annotatedSurface.onCaret = function onCaret(listener) {
      if (typeof listener !== 'function') throw new TypeError('annotated text caret listener must be a function');
      caretListeners.add(listener);
      return () => caretListeners.delete(listener);
    };
  }
  return Object.freeze(annotatedSurface);
}

function annotatedDocumentView(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  return Object.freeze({
    kind: snapshot.kind,
    version: snapshot.version,
    text: snapshot.text,
    ranges: snapshot.ranges,
    annotations: snapshot.annotations,
    ...(snapshot.orphans !== undefined ? { orphans: snapshot.orphans } : {}),
    ...(snapshot.measurements !== undefined ? { measurements: snapshot.measurements } : {}),
    // The materializer projects the wire envelope's capabilityHints into its
    // public `capabilities` array; the approved session contract exposes them
    // as `capabilityHints` and never leaks the materialized key. Restricted
    // documents keep the full shape with an empty hint collection.
    ...(snapshot.restricted
      ? { capabilityHints: [] }
      : { capabilityHints: Array.isArray(snapshot.capabilities) ? snapshot.capabilities : (Array.isArray(snapshot.capabilityHints) ? snapshot.capabilityHints : []) }),
    ...(snapshot.restricted ? { restricted: true } : {}),
    ...(snapshot.redactions?.length ? { redactions: snapshot.redactions } : {}),
  });
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
  const { operations, makeOperation, shouldReconcile, count } = createOpLifecycle();

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
      // A committed echo for this actionId proves the action committed, so it
      // reconciles the operation even when it was retained as an
      // outcome-unknown placeholder (delivered is false) after a transport throw.
      const reconcile = ownOperation.delivered || ownOperation.status === 'failed';
      if (reconcile && shouldReconcile(ownOperation, { confirmedCursor: ownOperation.confirmedCursor, echoCursor: cursor })) {
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
    const delay = backoffDelay(resyncAttempt, resyncBackoffBase, maxResyncBackoff);
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
    const operation = makeOperation({ actionId, action });
    operations.set(actionId, operation);
    publish();
    try {
      const receipt = await sendAction(action);
      if (receipt?.ok === false) {
        operation.status = 'failed';
        operation.error = normalizeFailure(receipt.failure ?? receipt.error ?? receipt);
        publish();
        return { ok: false, status: 'failed-rolled-back', opId: actionId, failure: operation.error };
      }
      const confirmedCursor = receipt?.cursor ?? receipt?.seq;
      operation.delivered = true;
      if (Number.isFinite(confirmedCursor)) operation.confirmedCursor = confirmedCursor;
      if (shouldReconcile(operation, { confirmedCursor: operation.confirmedCursor, echoCursor: operation.echoCursor })) {
        operations.delete(actionId);
      }
      publish();
      return { ok: true, status: 'committed', opId: actionId, value: receipt?.value };
    } catch (error) {
      operation.status = 'failed';
      operation.error = clientFailure('internal', String(error?.message ?? error));
      publish();
      return { ok: false, status: 'outcome-unknown', opId: actionId, failure: operation.error };
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
    pendingCount() { return count('pending'); },
    failedCount() { return count('failed'); },
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
// createAuthClient — register/login/logout against the framework's `/auth` battery.
// ---------------------------------------------------------------------------
//
// Thin fetch wrappers over `/auth/register`, `/auth/login`, and `/auth/logout` with
// `credentials: 'include'` so the browser sends and stores the fail-closed
// `sid` cookie the server sets on registration or login. The token lives in the cookie, never
// client JS (HttpOnly), so the client never holds a credential it can leak.
// Independent of the live-store machinery — a page may auth before subscribing.
// `login` returns the parsed JSON body (`{ user: { id, username } }`); both
// throw on a non-2xx response with the server's error message.

export function createAuthClient({ baseUrl, fetchImpl } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch;

  async function authenticate(intent, username, password) {
    const res = await fetchFn(`${baseUrl}/auth/${intent}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const decoded = await decodeResult(res);
    if (!decoded.ok) throw new Error(decoded.failure?.message ?? decoded.error);
    return decoded.value;
  }

  function register(username, password) {
    return authenticate('register', username, password);
  }

  function login(username, password) {
    return authenticate('login', username, password);
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

  return { register, login, logout };
}
