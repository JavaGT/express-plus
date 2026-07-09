// Live Delivery — singular public seam for the Deliver loop (SPEC §8).
//
// One factory: createLiveDelivery(httpServer, opts) →
//   { emit, count, close, createConsumer }
//
// Owns: WS upgrade, connection lifecycle, fan-out, subscribe admission (via
// LiveConnection), per-commit authz row latch (createConsumer). Kernel only
// registers the consumer this seam contributes when app.live is engaged.
//
// Internals (live-fanout, live-connection, live-admission, websocket) stay
// private implementation of this seam — callers do not import them for wiring.

import { upgradeWebSocket } from './websocket.mjs';
import { isSameOriginRequest } from './middleware.mjs';
import { createLiveFanout } from './live-fanout.mjs';
import { LiveConnection } from './live-connection.mjs';
import { readSeq } from './cursor.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';

/**
 * Create the Live Delivery subsystem and attach it to an HTTP server.
 *
 * @param {import('node:http').Server} httpServer
 * @param {object} [options]
 * @param {string} [options.path='/events']
 * @param {Function|null} [options.mayVerb] — same engine REST uses
 * @param {Function} [options.principalOf] — same principal resolver HTTP uses
 * @param {object|null} [options.db]
 * @param {Function|null} [options.resolveEntity] — name → entity record
 * @returns {{ emit: Function, count: Function, close: Function, createConsumer: Function }}
 */
export function createLiveDelivery(httpServer, {
  path = '/events',
  mayVerb = null,
  principalOf = () => ({ type: 'anonymous', id: null }),
  db = null,
  resolveEntity = null,
} = {}) {
  const fanout = createLiveFanout({ mayVerb });
  const connections = new Set();

  const currentSeq = (scope) => readSeq(db, scope);

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

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ? new URL(req.url, 'http://localhost') : { pathname: '' };
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }

    // CSWSH defense — same same-origin verdict as REST CSRF (middleware.mjs).
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

  /**
   * Post-commit consumer for the durable pipeline. Latches the hydrated authz
   * row per Scope handle within a commit batch, then emits through this
   * delivery's fan-out. A removed row is `undefined` and stays so for the batch.
   */
  function createConsumer(app) {
    return async (events, { db: txnDb }) => {
      const rowLatch = new Map();
      for (const ev of events) {
        const handle = tryParseScopeKey(ev.scope);
        if (!handle) continue;
        const { entity: entityName, id, key: scope } = handle;
        const entity = app.entities?.get(entityName);
        let row = rowLatch.get(scope);
        if (row === undefined && !rowLatch.has(scope)) {
          try {
            const raw = txnDb.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(id);
            row = raw ? entity?.hydrate?.(raw, null) ?? raw : undefined;
          } catch {
            row = undefined;
          }
          rowLatch.set(scope, row);
        }
        fanout.emit(entity, id, row, ev, {
          hydrated: row !== undefined && typeof entity?.hydrate === 'function',
        });
      }
    };
  }

  return {
    emit: fanout.emit.bind(fanout),
    count,
    close,
    createConsumer,
  };
}

/** @deprecated Use createLiveDelivery — same function (singular seam). */
export const createLiveServer = createLiveDelivery;
