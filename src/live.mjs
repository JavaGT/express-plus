// Live-sync — WebSocket upgrade handler, connection lifecycle, currentSeq,
// and composition root (SPEC §8).
//
// createLiveServer wires the live subsystem: it constructs a LiveFanout
// (subscription registry + fan-out delivery + pace buffers), creates
// LiveConnection instances on WebSocket upgrade, and exposes { emit, count,
// close }. Re-authorization runs through the SAME mayVerb engine the REST
// dispatch uses — no second auth path.
//
// The framework owns the /events path; an app never mounts it.

import { upgradeWebSocket } from './websocket.mjs';
import { isSameOriginRequest } from './middleware.mjs';
import { createLiveFanout } from './live-fanout.mjs';
import { LiveConnection } from './live-connection.mjs';
import { readSeq } from './cursor.mjs';

// Create a live server on the given HTTP server, upgrading connections on
// `path` (default '/events'). `mayVerb` is the re-authorization engine —
// the same function the REST dispatch uses: mayVerb(entity, verb, row, principal).
// `principalOf` derives a WS connection's principal (default: anonymous).
// `resolveEntity(name)` maps an entity NAME to its compiled record — needed so
// subscribe-time can run bindReadScope + mayVerb (the same engine fan-out uses).
export function createLiveServer(httpServer, {
  path = '/events',
  mayVerb = null,
  principalOf = () => ({ type: 'anonymous', id: null }),
  db = null,
  resolveEntity = null,
} = {}) {
  const fanout = createLiveFanout({ mayVerb });
  const connections = new Set();

  const currentSeq = (scope) => readSeq(db, scope);

  // Count of active connections (for tests).
  function count() {
    return connections.size;
  }

  function close() {
    for (const conn of connections) {
      try { conn.close?.(); } catch { /* ignore */ }
    }
    connections.clear();
    fanout.close();
  }

  // Attach the upgrade handler.
  httpServer.on('upgrade', (req, socket, head) => {
    // Only upgrade on the configured path.
    const url = req.url ? new URL(req.url, 'http://localhost') : { pathname: '' };
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    // Cross-Site WebSocket Hijacking (CSWSH) defense — the SAME same-origin
    // verdict the REST CSRF guard uses (middleware.mjs). A browser ALWAYS
    // attaches Origin to a cross-origin WS handshake, so a foreign Origin here
    // is an attacker page connecting on the victim's cookies; reject it. An
    // absent Origin is a non-browser client (no CSWSH vector) → allowed.
    if (!isSameOriginRequest(req)) {
      socket.destroy();
      return;
    }

    const result = upgradeWebSocket(req, socket);
    if (!result) {
      socket.destroy();
      return;
    }

    const id = `ws:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const conn = new LiveConnection(socket, id, {
      fanout,
      resolveEntity,
      mayVerb,
      db,
      currentSeq,
      onClose: () => connections.delete(conn),
    });
    conn.setPrincipal(principalOf(req));
    connections.add(conn);
  });

  return { emit: fanout.emit, count, close };
}
