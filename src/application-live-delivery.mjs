// Application-integrated live delivery. This is intentionally not a server
// export: the app supplies its own entity registry and authorization engine,
// while callers provide only transport policy and declared aggregate snapshots.

                                                 

import { createOwnedLiveDelivery } from './live-delivery-public.mjs';
import { createLiveDeliveryHttpHandler } from './live-delivery-http.mjs';
import { createLiveDeliveryWebSocket } from './live-delivery-websocket.mjs';
import { mayVerb } from './row-grant.mjs';
import { validatePrincipalSnapshotDeclarations } from './principal-snapshot-delivery.mjs';
                                                
                                             
                                                                       

                                                 
                                                                            
                
                            
                                 
                                          
                            
 

                              
                          
                        
                               
                                     
                                  
                           
                   
                                          
                                                     
                    
                              
                                                     
                                                                                             
    
                                                                                                     
 

export function attachApplicationLiveDelivery(app                    , {
  principalOf,
  path = '/live-delivery',
  maxSubscriptions = 100,
  snapshots,
  principalSnapshots,
  maxCatchupEvents,
}                                )                     {
  if (app._startPromise || app._startupMode || app._transportAttached) {
    throw new Error('live delivery must be attached before application startup');
  }
  if (app._applicationLiveDelivery) throw new Error('live delivery is already attached');
  if (!app.db) throw new Error('live delivery requires an application database');
  validatePrincipalSnapshotDeclarations(principalSnapshots         , app.schema         );

  const owned = createOwnedLiveDelivery({
    db: app.db                ,
    entities: (name        , declaration          ) => declaration === undefined ? app.entities.get(name) : app.entity(declaration),
    mayVerb: (entity                  , verb        , row                                            , principal           ) => mayVerb(entity         , verb, row, principal),
    snapshots,
    principalSnapshots,
    schema: app.schema,
    log: app.log,
    maxCatchupEvents,
    // Ordinary lifecycle envelopes omit actionId (public receipt privacy).
    // Annotated-text fold envelopes attach actionId themselves for own-echo.
    includeActionId: false,
  });
  const handler = createLiveDeliveryHttpHandler({
    delivery: owned.delivery,
    principalOf,
    path,
    maxSubscriptions,
    log: app.log,
  });

  // The WebSocket transport is mounted at listen() time, when the httpServer
  // exists. It is a pure upgrade skin over the SAME owned core — one committed
  // authority, SSE and WebSocket skins both present it. SSE rides the request
  // chain at `path` (+ `/bootstrap`, `/events`); the WebSocket upgrade mounts
  // at `<path>/events`, so a browser WebSocket and an EventSource coexist on
  // the same URL without a second delivery machine.
  let wsTransport                                                        = null;

  app._applicationLiveDelivery = Object.freeze({
    consumer: owned.consumer,
    handler,
    wake: owned.delivery.wake,
    close: owned.close,
    mountWebSocket: (httpServer                                                   ) => {
      if (!wsTransport) {
        wsTransport = createLiveDeliveryWebSocket(httpServer, {
          path: `${path}/events`,
          core: owned.core,
          principalOf,
          resolveEntity: (name        ) => app.entities.get(name),
          mayVerb: (entity                  , verb        , row                                            , principal           ) => mayVerb(entity         , verb, row, principal),
          db: app.db                ,
          ready: () => Promise.resolve(app.ready),
          log: app.log,
        });
      }
      return wsTransport;
    },
  });
  for (const declaration of principalSnapshots ?? []) app._principalSnapshotRuntime._registerDeclaration(declaration);
  if (principalSnapshots?.length) app._principalSnapshotRuntime._setWakeHook((declaration, principal) => {
    owned.delivery.wake(`PrincipalSnapshot:${declaration.name}/${principal.type}/${encodeURIComponent(principal.id ?? '')}`);
  });
  app.onShutdown('live delivery', async () => {
    // Release WebSocket connections first (they retract caret presence and end
    // their sockets), then the committed authority revokes remaining SSE subs.
    await wsTransport?.close();
    await owned.close();
  }, { timeoutMs: 1000 });
  return app;
}
