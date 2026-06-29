// Live-sync — WebSocket subscription + fan-out with re-authorization (SPEC §8).
//
// A live server upgrades WebSocket connections on a configured path, wraps every
// connection with frame parsing/sending, tracks per-entity-row subscriptions, and
// fans out events to authorized subscribers. Re-authorization runs through the
// SAME mayVerb engine the REST dispatch uses — no second auth path.
//
// Message protocol (JSON over WebSocket text frames):
//
//   client → server:
//     { type: 'subscribe', entity, id }
//     { type: 'unsubscribe', entity, id }
//
//   server → client:
//     { type: 'event', entity, id, event }
//     { type: 'error', message }
//
// When an entity row changes (CRUD create/update/delete), the mutation path calls
// `live.emit(entity, id, eventPayload)`. The fan-out:
//   1. Finds every subscriber for (entity, id)
//   2. Re-authorizes each via mayVerb(entity, 'subscribe', row, principal)
//   3. Sends the event to every authorized subscriber
//
// Access to the subscriber's principal is governed by the same auth engine —
// the principal is set on the connection after the HTTP request-level auth
// (or via a connect-time token). The framework owns the /events path;
// an app never mounts it.

import { FrameSender, FrameParser, upgradeWebSocket } from './websocket.mjs';

// Create a live server on the given HTTP server, upgrading connections on
// `path` (default '/events'). `mayVerb` is the re-authorization engine —
// the same function the REST dispatch uses: mayVerb(entity, verb, row, principal).
// `principalOf` derives a WS connection's principal (default: anonymous).
export function createLiveServer(httpServer, {
  path = '/events',
  mayVerb = null,
  principalOf = () => ({ type: 'anonymous', id: null }),
} = {}) {
  // Subscription registry: Map<entity, Map<id, Set<connection>>>
  const byEntity = new Map();
  const connections = new Set();

  // A live connection wraps one upgraded WebSocket socket.
  class LiveConnection {
    #socket;
    #sender;
    #parser;
    #id;
    #closed = false;
    #principal;

    constructor(socket, id) {
      this.#socket = socket;
      this.#sender = new FrameSender();
      this.#parser = new FrameParser();
      this.#id = id;
      this.#principal = null;

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

    // Send a JSON message to the client over a WebSocket text frame.
    send(data) {
      if (this.#closed) return;
      try {
        this.#socket.write(this.#sender.text(JSON.stringify(data)));
      } catch {
        this.#close();
      }
    }

    // Send an error to the client (still a valid text frame).
    error(message) {
      this.send({ type: 'error', message });
    }

    #drain() {
      const msgs = this.#parser.drainMessages();
      for (const msg of msgs) {
        if (msg.opcode === 0x8) {
          // Client-initiated close — acknowledge it.
          this.#socket.write(this.#sender.close(msg.closeCode ?? 1000, msg.closeReason));
          this.#cleanup();
          return;
        }
        if (msg.opcode === 0x1) {
          // Text message — try to parse as JSON protocol.
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

      // Ping → pong (automatic keepalive)
      const pongs = this.#parser.drainPongs();
      for (const payload of pongs) {
        try { this.#socket.write(this.#sender.pong(payload)); } catch { this.#close(); }
      }
    }

    #handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'subscribe':
          if (typeof msg.entity === 'string' && msg.id !== undefined) {
            addSubscription(msg.entity, String(msg.id), this);
            this.send({ type: 'subscribed', entity: msg.entity, id: msg.id });
          } else {
            this.error('subscribe requires entity (string) and id');
          }
          break;
        case 'unsubscribe':
          if (typeof msg.entity === 'string' && msg.id !== undefined) {
            removeSubscription(msg.entity, String(msg.id), this);
            this.send({ type: 'unsubscribed', entity: msg.entity, id: msg.id });
          }
          break;
        default:
          this.error(`unknown message type: ${msg.type}`);
      }
    }

    #close() {
      if (this.#closed) return;
      this.#closed = true;
      this.#cleanup();
      try { this.#socket.destroy(); } catch { /* ignore */ }
    }

    #cleanup() {
      removeAll(this);
      connections.delete(this);
    }
  }

  // Subscription helpers
  function addSubscription(entity, id, conn) {
    if (!byEntity.has(entity)) byEntity.set(entity, new Map());
    const byId = byEntity.get(entity);
    if (!byId.has(id)) byId.set(id, new Set());
    byId.get(id).add(conn);
  }

  function removeSubscription(entity, id, conn) {
    const byId = byEntity.get(entity);
    if (!byId) return;
    const subs = byId.get(id);
    if (!subs) return;
    subs.delete(conn);
    if (subs.size === 0) byId.delete(id);
    if (byId.size === 0) byEntity.delete(entity);
  }

  function removeAll(conn) {
    for (const [entity, byId] of byEntity) {
      for (const [id, subs] of byId) {
        subs.delete(conn);
        if (subs.size === 0) byId.delete(id);
      }
      if (byId.size === 0) byEntity.delete(entity);
    }
  }

  // Fan-out: emit an event to every authorized subscriber of (entity, id).
  // `row` is the materialized row (needed for re-authorization via mayVerb).
  // `eventPayload` is what each subscriber receives as `event` in their JSON.
  function emit(entity, id, row, eventPayload) {
    const byId = byEntity.get(entity);
    if (!byId) return;
    const subs = byId.get(String(id));
    if (!subs) return;

    for (const conn of subs) {
      if (conn.closed) {
        subs.delete(conn);
        continue;
      }
      // Re-authorize: the same mayVerb engine the REST dispatch uses.
      // verb='subscribe' — the grant's .can body decides.
      if (mayVerb) {
        try {
          const allowed = mayVerb(entity, 'subscribe', row, conn.principal ?? { type: 'anonymous', id: null });
          if (!allowed) continue;
        } catch {
          continue; // fail closed: an auth error withholds the event
        }
      }
      conn.send({ type: 'event', entity, id, event: eventPayload });
    }
  }

  // Count of active connections (for tests).
  function count() {
    return connections.size;
  }

  function close() {
    for (const conn of connections) {
      try { conn.close?.(); } catch { /* ignore */ }
    }
    byEntity.clear();
    connections.clear();
  }

  // Attach the upgrade handler.
  httpServer.on('upgrade', (req, socket, head) => {
    // Only upgrade on the configured path.
    const url = req.url ? new URL(req.url, 'http://localhost') : { pathname: '' };
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    const result = upgradeWebSocket(req, socket);
    if (!result) {
      socket.destroy();
      return;
    }

    const id = `ws:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const conn = new LiveConnection(socket, id);
    conn.setPrincipal(principalOf(req));
    connections.add(conn);
  });

  return { emit, count, close };
}
