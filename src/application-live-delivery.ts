// Application-integrated live delivery. This is intentionally not a server
// export: the app supplies its own entity registry and authorization engine,
// while callers provide only transport policy and declared aggregate snapshots.

import type { IncomingMessage } from 'node:http';

import { createOwnedLiveDelivery } from './live-delivery-public.ts';
import { createLiveDeliveryHttpHandler } from './live-delivery-http.ts';
import { mayVerb } from './row-grant.ts';
import { validatePrincipalSnapshotDeclarations } from './principal-snapshot-delivery.ts';
import type { Principal } from './principal.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveDatabase, LiveEntityRecord } from './live-fanout.ts';

export interface ApplicationLiveDeliveryOptions {
  principalOf: (request: IncomingMessage) => Principal | Promise<Principal>;
  path?: string;
  maxSubscriptions?: number;
  snapshots?: readonly unknown[];
  principalSnapshots?: readonly unknown[];
  maxCatchupEvents?: number;
}

interface ApplicationLiveApp {
  _startPromise?: unknown;
  _startupMode?: string;
  _transportAttached?: boolean;
  _applicationLiveDelivery?: unknown;
  db?: LiveDatabase | null;
  schema?: unknown;
  entities: Map<string, LiveEntityRecord>;
  entity: (declaration: unknown) => LiveEntityRecord;
  log: FrameworkLog;
  _principalSnapshotRuntime: {
    _registerDeclaration(declaration: unknown): void;
    _setWakeHook(hook: (declaration: { name?: string }, principal: Principal) => void): void;
  };
  onShutdown(name: string, hook: () => void | Promise<void>, options?: { timeoutMs?: number }): void;
}

export function attachApplicationLiveDelivery(app: ApplicationLiveApp, {
  principalOf,
  path = '/live-delivery',
  maxSubscriptions = 100,
  snapshots,
  principalSnapshots,
  maxCatchupEvents,
}: ApplicationLiveDeliveryOptions): ApplicationLiveApp {
  if (app._startPromise || app._startupMode || app._transportAttached) {
    throw new Error('live delivery must be attached before application startup');
  }
  if (app._applicationLiveDelivery) throw new Error('live delivery is already attached');
  if (!app.db) throw new Error('live delivery requires an application database');
  validatePrincipalSnapshotDeclarations(principalSnapshots as never, app.schema as never);

  const owned = createOwnedLiveDelivery({
    db: app.db as LiveDatabase,
    entities: (name: string, declaration?: unknown) => declaration === undefined ? app.entities.get(name) : app.entity(declaration),
    mayVerb: (entity: LiveEntityRecord, verb: string, row: Record<string, unknown> | null | undefined, principal: Principal) => mayVerb(entity as never, verb, row, principal),
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
