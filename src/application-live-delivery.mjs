// Application-integrated live delivery. This is intentionally not a server
// export: the app supplies its own entity registry and authorization engine,
// while callers provide only transport policy and declared aggregate snapshots.

                                                 

import { createOwnedLiveDelivery } from './live-delivery-public.mjs';
import { createLiveDeliveryHttpHandler } from './live-delivery-http.mjs';
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

  app._applicationLiveDelivery = Object.freeze({
    consumer: owned.consumer,
    handler,
    path,
    wake: owned.delivery.wake,
    close: owned.close,
  });
  for (const declaration of principalSnapshots ?? []) app._principalSnapshotRuntime._registerDeclaration(declaration);
  if (principalSnapshots?.length) app._principalSnapshotRuntime._setWakeHook((declaration, principal) => {
    owned.delivery.wake(`PrincipalSnapshot:${declaration.name}/${principal.type}/${encodeURIComponent(principal.id ?? '')}`);
  });
  app.onShutdown('live delivery', () => owned.close(), { timeoutMs: 1000 });
  return app;
}
