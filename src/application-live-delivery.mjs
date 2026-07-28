// Application-integrated live delivery. This is intentionally not a server
// export: the app supplies its own entity registry and authorization engine,
// while callers provide only transport policy and declared aggregate snapshots.

import { createOwnedLiveDelivery } from './live-delivery-public.mjs';
import { createLiveDeliveryHttpHandler } from './live-delivery-http.mjs';
import { mayVerb } from './row-grant.mjs';

export function attachApplicationLiveDelivery(app, {
  principalOf,
  path = '/live-delivery',
  maxSubscriptions = 100,
  snapshots,
  maxCatchupEvents,
} = {}) {
  if (app._startPromise || app._startupMode || app._transportAttached) {
    throw new Error('live delivery must be attached before application startup');
  }
  if (app._applicationLiveDelivery) throw new Error('live delivery is already attached');
  if (!app.db) throw new Error('live delivery requires an application database');

  const owned = createOwnedLiveDelivery({
    db: app.db,
    entities: (name) => app.entities.get(name),
    mayVerb: (entity, verb, row, principal) => mayVerb(entity, verb, row, principal),
    snapshots,
    log: app.log,
    maxCatchupEvents,
    includeActionId: false,
  });
  const handler = createLiveDeliveryHttpHandler({
    delivery: owned.delivery,
    principalOf,
    path,
    maxSubscriptions,
  });

  app._applicationLiveDelivery = Object.freeze({
    consumer: owned.consumer,
    handler,
    wake: owned.delivery.wake,
    close: owned.close,
  });
  app.onShutdown('live delivery', () => owned.close(), { timeoutMs: 1000 });
  return app;
}
