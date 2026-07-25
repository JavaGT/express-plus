// Live Delivery — singular public seam for the Deliver loop (SPEC §8).
//
// One factory: createLiveDelivery(httpServer, opts) →
//   { emit, count, close, createConsumer, wake }
//
// Owns: WS upgrade, connection lifecycle, fan-out, subscribe admission (via
// LiveConnection), per-commit authz row latch (createConsumer), and the
// committed-event delivery core (live-delivery-core). Kernel only registers the
// consumer this seam contributes when app.live is engaged.
//
// The committed post-commit consumer (createConsumer) only wakes core; the core
// re-reads the _Log, re-authorises, projects, and delivers to WebSocket
// subscribers. The ephemeral fan-out remains distinct for non-_Log events and
// pacing; there is one committed authority (core).
//
// wake(scope) is exposed for callers (e.g. serve.mjs job-event bridge) that
// need to trigger core delivery without going through the post-commit consumer.
//
// Internals (live-fanout, live-connection, live-admission, websocket) stay
// private implementation of this seam — callers do not import them for wiring.

import { upgradeWebSocket } from './websocket.mjs';
import { isSameOriginRequest } from './middleware.mjs';
import { createLiveFanout } from './live-fanout.mjs';
import { createLiveDeliveryCore } from './live-delivery-core.mjs';
import { createLiveEnvelopeBuilder } from './live-delivery-envelope.mjs';
import { LiveConnection } from './live-connection.mjs';
import { createAnnotatedTextCaretLive } from './annotated-text-caret-live.mjs';
import { readSeq } from './cursor.mjs';

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
 * @param {Function} [options.ready] — resolves when protocol admission is safe
 * @param {object|null} [options.log] — application-owned structured logger
 * @returns {{ emit: Function, count: Function, close: Function, createConsumer: Function, wake: Function }}
 */
export function createLiveDelivery(httpServer, {
  path = '/events',
  mayVerb = null,
  principalOf = () => ({ type: 'anonymous', id: null }),
  db = null,
  resolveEntity = null,
  ready = () => Promise.resolve(),
  log = null,
} = {}) {
  const fanout = createLiveFanout({ mayVerb });
  const carets = createAnnotatedTextCaretLive({ db, resolveEntity, mayVerb, fanout });
  const connections = new Set();
  const pendingUpgrades = new Set();
  let closed = false;

  const currentSeq = (scope) => readSeq(db, scope);

  // Shared envelope builder — one delta projector for the whole delivery seam.
  const envelopeBuilder = createLiveEnvelopeBuilder();

  // Committed-event delivery core — the single authority for committed events.
  // The projectRecipient uses the shared envelope builder for delta/reducer
  // parity with the fan-out path.
  const core = createLiveDeliveryCore({
    db,
    entities: resolveEntity ? (name) => resolveEntity(name) : new Map(),
    mayVerb,
    projectRecipient: (ctx) => envelopeBuilder.buildEnvelope(ctx),
    log,
  });

  function count() {
    return connections.size;
  }

  function close() {
    closed = true;
    core.close();
    envelopeBuilder.clear();
    for (const socket of pendingUpgrades) socket.destroy();
    pendingUpgrades.clear();
    for (const conn of connections) {
      try { conn.close?.(); } catch { /* ignore */ }
    }
    connections.clear();
    fanout.close();
  }

  function wake(scope) {
    core.wake(scope);
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

    if (closed) {
      socket.destroy();
      return;
    }

    // HTTP requests and WebSocket subscriptions share one application-start
    // barrier. Keep the raw socket outside the connection registry until the
    // schema, Kernel, recovery, and admission engine are ready. A failed start
    // fails closed; shutdown destroys sockets waiting at this barrier.
    pendingUpgrades.add(socket);
    Promise.resolve()
      .then(() => ready())
      .then(() => {
        pendingUpgrades.delete(socket);
        if (closed || socket.destroyed) {
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
          core,
          resolveEntity,
          mayVerb,
          db,
          currentSeq,
          log,
          carets,
          onClose: () => connections.delete(conn),
        });
        conn.setPrincipal(principalOf(req));
        connections.add(conn);
      })
      .catch(() => {
        pendingUpgrades.delete(socket);
        socket.destroy();
      });
  });

  /**
   * Post-commit consumer for the durable pipeline. Only wakes the core — the
   * core re-reads _Log, re-authorises, projects, and delivers. No longer emits
   * directly through the fan-out (the fan-out is for non-_Log events only).
   */
  function createConsumer() {
    const woken = new Set();
    return async (events) => {
      woken.clear();
      for (const ev of events) {
        if (!ev.scope) continue;
        if (woken.has(ev.scope)) continue;
        woken.add(ev.scope);
        core.wake(ev.scope);
      }
    };
  }

  return {
    emit: fanout.emit.bind(fanout),
    count,
    close,
    createConsumer,
    wake,
  };
}

/** @deprecated Use createLiveDelivery — same function (singular seam). */
export const createLiveServer = createLiveDelivery;
