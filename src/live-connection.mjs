// @ts-nocheck
// A live WebSocket connection — socket I/O, frame parsing/sending,
// message routing, and the connection lifecycle.
//
// Subscribe-time admission is delegated to live-admission.mjs; subscription
// registration delegates to the injected fanout handle. The transport wiring
// (WebSocket upgrade, CSWSH check, principalOf) stays in live.mjs.

import { FrameSender, FrameParser } from './websocket.mjs';
import { authorizeSubscription, parseSubscribeMsg } from './live-admission.mjs';
import { failure, isWorkbenchFailure, sanitizeUnexpectedFailure } from './outcome.mjs';

function requestIdOf(msg) {
  const value = msg?.requestId;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  return undefined;
}

export class LiveConnection {
  #socket;
  #sender;
  #parser;
  #id;
  #closed = false;
  #principal;
  #fanout;
  #core;
  #resolveEntity;
  #mayVerb;
  #db;
  #currentSeq;
  #onClose;
  #log;
  #carets;
  #coreAcs;

  constructor(socket, id, { fanout, core = null, resolveEntity, mayVerb, db, currentSeq, onClose, log = null, carets = null } = {}) {
    this.#socket = socket;
    this.#sender = new FrameSender();
    this.#parser = new FrameParser();
    this.#id = id;
    this.#principal = null;
    this.#fanout = fanout;
    this.#core = core;
    this.#resolveEntity = resolveEntity;
    this.#mayVerb = mayVerb;
    this.#db = db;
    this.#currentSeq = currentSeq;
    this.#onClose = onClose;
    this.#log = log;
    this.#carets = carets;
    this.#coreAcs = new Map();

    socket.on('data', (chunk) => {
      this.#parser.feed(chunk);
      this.#drain();
    });

    socket.on('error', () => this.#close());
    socket.on('end', () => this.#close());
    socket.on('close', () => this.#close());
  }

  get id() { return this.#id; }
  get closed() { return this.#closed; }
  get principal() { return this.#principal; }

  close() { this.#close(); }

  setPrincipal(p) {
    this.#principal = p;
  }

  send(data) {
    if (this.#closed) return;
    try {
      this.#socket.write(this.#sender.text(JSON.stringify(data)));
    } catch {
      this.#close();
    }
  }

  error(workbenchFailure, requestId) {
    const response = {
      type: 'error',
      failure: isWorkbenchFailure(workbenchFailure)
        ? workbenchFailure
        : sanitizeUnexpectedFailure(),
    };
    if (requestId !== undefined) response.requestId = requestId;
    this.send(response);
  }

  #drain() {
    const msgs = this.#parser.drainMessages();
    for (const msg of msgs) {
      if (msg.opcode === 0x8) {
        try { this.#socket.write(this.#sender.close(msg.closeCode ?? 1000, msg.closeReason)); } catch { /* ignore */ }
        this.#close();
        return;
      }
      if (msg.opcode === 0x1) {
        try {
          const parsed = JSON.parse(msg.payload.toString('utf-8'));
          this.#handleMessage(parsed);
        } catch {
          this.error(failure('invalid-input', 'Invalid JSON.'));
        }
      }
      if (msg.opcode === -1) {
        this.error(failure('invalid-input', String(msg.error || 'Invalid WebSocket frame.')));
      }
    }

    const pongs = this.#parser.drainPongs();
    for (const payload of pongs) {
      try { this.#socket.write(this.#sender.pong(payload)); } catch { this.#close(); }
    }
  }

  #handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.error(failure('invalid-input', 'Message must be an object.'));
      return;
    }
    switch (msg.type) {
      case 'subscribe':
        this.#authorizeAndSubscribe(msg).catch((err) => {
          const requestId = requestIdOf(msg);
          this.#log?.error('live', 'subscription admission failed', {
            err,
            connectionId: this.#id,
            ...(requestId === undefined ? {} : { requestId }),
          });
          this.error(sanitizeUnexpectedFailure(), requestId);
        });
        break;
      case 'unsubscribe':
        this.#handleUnsubscribe(msg);
        break;
      case 'caret.update':
        this.#carets?.update(this, msg).catch(() => this.error(failure('invalid-input', 'Invalid caret update.')));
        break;
      case 'caret.clear':
        this.#carets?.clear(this, msg).catch(() => this.error(failure('invalid-input', 'Invalid caret clear.')));
        break;
      default:
        this.error(
          failure('unknown-action', `Unknown message type: ${String(msg.type)}.`),
          requestIdOf(msg),
        );
    }
  }

  #handleUnsubscribe(msg) {
    const normalized = parseSubscribeMsg(msg);
    if (normalized) {
      this.#carets?.removeConnection(this, normalized.scope).catch(() => {});
      this.#fanout.removeSubscription(normalized.scope, this);
      const ac = this.#coreAcs.get(normalized.scope);
      if (ac) {
        ac.abort();
        this.#coreAcs.delete(normalized.scope);
      }
      const response = { type: 'unsubscribed', scope: normalized.scope };
      if (normalized.interest.entity) response.entity = normalized.interest.entity;
      if (normalized.interest.id !== undefined) response.id = normalized.interest.id;
      this.send(response);
    }
  }

  async #authorizeAndSubscribe(msg) {
    const requestId = requestIdOf(msg);
    const result = await authorizeSubscription(msg, this, {
      resolveEntity: this.#resolveEntity,
      mayVerb: this.#mayVerb,
      db: this.#db,
      fanout: this.#fanout,
    });
    if (!result.admitted) {
      this.error(result.failure, requestId);
      return;
    }

    const scope = result.scope;
    let activateCore = null;
    let coreAc = null;

    // Subscribe to the core for committed-event delivery BEFORE sending the
    // subscribed ack. If core subscription fails, we remove the fanout
    // registration and send only an error — no ack reaches the client.
    if (this.#core) {
      const previousAc = this.#coreAcs.get(scope);
      if (previousAc) previousAc.abort();
      const ac = new AbortController();
      coreAc = ac;
      this.#coreAcs.set(scope, ac);
      try {
        const coreSubscription = await this.#core.subscribe({
          principal: this.#principal,
          scope,
          after: this.#currentSeq(scope),
          signal: ac.signal,
          paused: true,
          deliver: async (batch) => {
            if (this.#closed) throw new Error('live connection closed');
            for (const envelope of batch) {
              if (this.#closed) throw new Error('live connection closed');
              this.send(envelope);
            }
          },
          revoke: () => {
            // A reauthorization failure after acknowledgement is terminal for
            // this recipient. Do not leave the transport appearing live.
            if (this.#coreAcs.get(scope) !== ac) return;
            this.#coreAcs.delete(scope);
            this.#fanout.removeSubscription(scope, this);
            ac.abort();
            this.error(failure('denied', 'Subscription revoked.'), requestId);
          },
        });
        activateCore = coreSubscription?.activate ?? null;
        if (ac.signal.aborted) return;
      } catch (err) {
        // A newer subscribe or unsubscribe owns this scope now. Its controller
        // and fan-out registration must not be clobbered by this stale attempt.
        if (this.#coreAcs.get(scope) !== ac) return;
        this.#coreAcs.delete(scope);
        this.#fanout.removeSubscription(scope, this);
        this.#log?.error?.('live', 'core subscription failed', { scope, err: String(err) });
        this.error(failure('denied', 'Subscription failed.'), requestId);
        return;
      }
      if (this.#coreAcs.get(scope) !== ac) return;
    }

    const response = {
      type: 'subscribed',
      scope,
      currentSeq: this.#currentSeq(scope),
    };
    if (requestId !== undefined) response.requestId = requestId;
    if (result.entityName) response.entity = result.entityName;
    if (result.id !== undefined) response.id = result.id;
    this.send(response);

    if (activateCore) {
      try {
        await activateCore();
      } catch (err) {
        if (this.#coreAcs.get(scope) === coreAc) {
          this.#coreAcs.delete(scope);
        }
        this.#log?.error?.('live', 'core activation failed', { scope, err: String(err) });
        this.error(failure('denied', 'Subscription failed.'), requestId);
        return;
      }
    }
    if (this.#coreAcs.get(scope) === undefined) return;
    this.#fanout.addSubscription(scope, this, result.fields, result.pace, { ...result.interest, carets: result.carets });
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    try { this.#socket.destroy(); } catch { /* ignore */ }
  }

  #cleanup() {
    for (const ac of this.#coreAcs.values()) {
      ac.abort();
    }
    this.#coreAcs.clear();
    this.#fanout.removeAll(this);
    this.#carets?.removeConnection(this).catch(() => {});
    this.#onClose?.();
  }
}
