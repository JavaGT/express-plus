// Live Delivery WebSocket transport — a thin upgrade seam for the Deliver loop.
//
// Transport-neutral: it accepts an INJECTED committed-event subscription
// authority (a live-delivery-core-shaped `core`) plus the same admission
// dependencies the HTTP skin uses (resolveEntity / mayVerb / db). The seam owns
// only socket I/O, connection lifecycle, the ephemeral fan-out, and caret
// presence — never the committed authority itself, which the caller
// (createWebSocketLiveDelivery or an application-integrated delivery) owns and closes.
//
// One authority rule: SSE (live-delivery-http) and WebSocket both present the
// SAME injected core, so a subscribed client receives committed events through
// exactly one re-read / re-authorise / project / deliver path regardless of
// transport. Mounting this seam is the only way an application-integrated
// delivery gets a WebSocket upgrade; without an 'upgrade' listener a WS
// handshake request is handled as an ordinary GET and 400s against the SSE
// handler ('invalid live delivery request').

                                                         
                                          

import { upgradeWebSocket } from './websocket.mjs';
import { isSameOriginRequest } from './middleware.mjs';
import { createLiveFanout } from './live-fanout.mjs';
                                                                                    
                                                                
import { LiveConnection } from './live-connection.mjs';
import { createAnnotatedTextCaretLive } from './annotated-text-caret-live.mjs';
import { readSeq } from './cursor.mjs';
import { anonymous,                } from './principal.mjs';
                                             
                                                     

                                               
                
                                 
                                                                         
                                                                                 
                           
                           
                                 
                            
 

                                        
                  
                         
 

export function createLiveDeliveryWebSocket(httpServer        , {
  path = '/events',
  core = null,
  principalOf = (() => anonymous)                   ,
  resolveEntity = null,
  mayVerb = null,
  db = null,
  ready = () => Promise.resolve(),
  log = null,
}                               = {})                        {
  const fanout                   = createLiveFanout({ mayVerb });
  const carets = createAnnotatedTextCaretLive({ db: db         , resolveEntity: resolveEntity         , mayVerb: mayVerb         , fanout });
  const connections = new Set                ();
  const pendingUpgrades = new Set        ();
  let closed = false;
  let closePromise                       = null;

  const currentSeq = (scope        ) => readSeq(db, scope);

  async function close()                {
    if (closePromise) return closePromise;
    closePromise = closeImpl();
    return closePromise;
  }

  async function closeImpl()                {
    closed = true;
    for (const socket of pendingUpgrades) socket.destroy();
    pendingUpgrades.clear();
    await Promise.all([...connections].map((conn) => conn.close?.().catch(() => {})));
    connections.clear();
    fanout.close();
  }

  httpServer.on('upgrade', (req, socket, _head) => {
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
      .then(async () => {
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

        // principalOf may be asynchronous (a session lookup). Resolve it BEFORE
        // wiring the connection so admission never observes a pending promise
        // standing in for a principal. The browser cannot send frames before the
        // 101 handshake, and any bytes buffered before the connection is wired
        // are flushed to the 'data' listener once it attaches.
        const principal = await principalOf(req);
        if (closed || socket.destroyed) {
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
        conn.setPrincipal(principal);
        connections.add(conn);
      })
      .catch(() => {
        pendingUpgrades.delete(socket);
        socket.destroy();
      });
  });

  return { count: () => connections.size, close };
}
