// Application-integrated live delivery. This is intentionally not a server
// export: the app supplies its own entity registry and authorization engine,
// while callers provide only transport policy and declared aggregate snapshots.



import { createOwnedLiveDelivery } from './live-delivery-public.mjs';
import { createLiveDeliveryHttpHandler } from './live-delivery-http.mjs';
import { createLiveDeliveryWebSocket } from './live-delivery-websocket.mjs';
import { mayVerb } from './row-grant.mjs';

import { validatePrincipalSnapshotDeclarations } from './principal-snapshot-delivery.mjs';
import { collapseForAdmission,                } from './principal.mjs';































export function attachApplicationLiveDelivery(app                    , {
  principalOf,
  path = '/live-delivery',
  maxSubscriptions = 100,
  snapshots,
  principalSnapshots,
  maxCatchupEvents,
  authorization,
}                                )                     {
  if (app._startPromise || app._startupMode || app._transportAttached) {
    throw new Error('live delivery must be attached before application startup');
  }
  if (app._applicationLiveDelivery) throw new Error('live delivery is already attached');
  if (!app.db) throw new Error('live delivery requires an application database');
  validatePrincipalSnapshotDeclarations(principalSnapshots         , app.schema         );

  // Two-valued admission collapse (S5/A1), applied at the application delivery
  // seam — the ONE boundary a revoked/expired/disabled principal could reach a
  // transport as a real non-active status. Both skins resolve the caller here:
  // HTTP bootstrap/catchup/SSE and the WebSocket upgrade. A non-'active'
  // principal enters delivery as the canonical `anonymous`, so re-authorization
  // (mayVerb / the grant) and subscription presence never see a real non-active
  // status — a revoked caller is admitted exactly as an unauthenticated one
  // (no status oracle). The REAL status stays on the pre-collapse principal for
  // statusOf() — the audit reader.
  const principalOfAdmitted = async (request                 ) => collapseForAdmission(await principalOf(request));
  const owned = createOwnedLiveDelivery({
    db: app.db                ,
    entities: (name        , declaration          ) => declaration === undefined ? app.entities.get(name) : app.entity(declaration),
    mayVerb: (entity                  , verb        , row                                            , principal           ) => mayVerb(entity         , verb, row, principal),
    // The app's injected authorization adapter (S5/A2) owns subscription
    // admission + re-authorization on this seam too; without one the framework
    // mayVerb engine runs, unchanged.
    authorization,
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
    principalOf: principalOfAdmitted,
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
    path,
    wake: owned.delivery.wake,
    // The committed-event core behind the public delivery protocol. Exposed so
    // the app can register S5/A5 onRevocation listeners (e.g. the S4/A2 search
    // staleness bridge) against the SAME core the SSE/WebSocket skins present.
    core: owned.core,
    close: owned.close,
    mountWebSocket: (httpServer                                                   ) => {
      if (!wsTransport) {
        wsTransport = createLiveDeliveryWebSocket(httpServer, {
          path: `${path}/events`,
          core: owned.core,
          principalOf: principalOfAdmitted,
          resolveEntity: (name        ) => app.entities.get(name),
          mayVerb: (entity                  , verb        , row                                            , principal           ) => mayVerb(entity         , verb, row, principal),
          authorization,
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
