// A live WebSocket connection — socket I/O, frame parsing/sending,
// message routing, and the connection lifecycle.
//
// Subscribe-time admission is delegated to live-admission.mjs; subscription
// registration delegates to the injected fanout handle. The transport wiring
// (WebSocket upgrade, CSWSH check, principalOf) stays in live.mjs.

import { FrameSender, FrameParser } from './websocket.mjs';
import { authorizeSubscription, normalizeSubscribeMsg } from './live-admission.mjs';

export class LiveConnection {
  #socket;
  #sender;
  #parser;
  #id;
  #closed = false;
  #principal;
  #fanout;
  #resolveEntity;
  #mayVerb;
  #db;
  #currentSeq;
  #onClose;

  constructor(socket, id, { fanout, resolveEntity, mayVerb, db, currentSeq, onClose } = {}) {
    this.#socket = socket;
    this.#sender = new FrameSender();
    this.#parser = new FrameParser();
    this.#id = id;
    this.#principal = null;
    this.#fanout = fanout;
    this.#resolveEntity = resolveEntity;
    this.#mayVerb = mayVerb;
    this.#db = db;
    this.#currentSeq = currentSeq;
    this.#onClose = onClose;

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

  error(message) {
    this.send({ type: 'error', message });
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
          this.error('invalid JSON');
        }
      }
      if (msg.opcode === -1) {
        this.error(msg.error);
      }
    }

    const pongs = this.#parser.drainPongs();
    for (const payload of pongs) {
      try { this.#socket.write(this.#sender.pong(payload)); } catch { this.#close(); }
    }
  }

  #handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'subscribe':
        this.#authorizeAndSubscribe(msg).catch(() => this.error('forbidden'));
        break;
      case 'unsubscribe':
        this.#handleUnsubscribe(msg);
        break;
      default:
        this.error(`unknown message type: ${msg.type}`);
    }
  }

  #handleUnsubscribe(msg) {
    const normalized = normalizeSubscribeMsg(msg);
    if (normalized) {
      this.#fanout.removeSubscription(normalized.scope, this);
      const response = { type: 'unsubscribed', scope: normalized.scope };
      if (normalized.interest.entity) response.entity = normalized.interest.entity;
      if (normalized.interest.id !== undefined) response.id = normalized.interest.id;
      this.send(response);
    }
  }

  async #authorizeAndSubscribe(msg) {
    const result = await authorizeSubscription(msg, this, {
      resolveEntity: this.#resolveEntity,
      mayVerb: this.#mayVerb,
      db: this.#db,
      fanout: this.#fanout,
    });
    if (!result.admitted) {
      this.error(result.reason);
      return;
    }
    this.#fanout.addSubscription(result.scope, this, result.fields, result.pace, result.interest);
    const response = {
      type: 'subscribed',
      scope: result.scope,
      currentSeq: this.#currentSeq(result.scope),
    };
    if (result.entityName) response.entity = result.entityName;
    if (result.id !== undefined) response.id = result.id;
    this.send(response);
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanup();
    try { this.#socket.destroy(); } catch { /* ignore */ }
  }

  #cleanup() {
    this.#fanout.removeAll(this);
    this.#onClose?.();
  }
}
