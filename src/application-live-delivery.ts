// Application-integrated live delivery. This is intentionally not a server
// export: the app supplies its own entity registry and authorization engine,
// while callers provide only transport policy and declared aggregate snapshots.

import type { IncomingMessage } from 'node:http';

import { createOwnedLiveDelivery } from './live-delivery-public.ts';
import { createLiveDeliveryHttpHandler } from './live-delivery-http.ts';
import { createLiveDeliveryWebSocket } from './live-delivery-websocket.ts';
import { mayVerb } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import { validatePrincipalSnapshotDeclarations } from './principal-snapshot-delivery.ts';
import { collapseForAdmission, type Principal } from './principal.ts';
import type { FrameworkLog } from './log.ts';
import type { LiveDatabase, LiveEntityRecord } from './live-fanout.ts';

export interface ApplicationLiveDeliveryOptions {
  principalOf: (request: IncomingMessage) => Principal | Promise<Principal>;
  path?: string;
  maxSubscriptions?: number;
  snapshots?: readonly unknown[];
  principalSnapshots?: readonly unknown[];
  maxCatchupEvents?: number;
  authorization?: AuthorizationAdapter;
}

interface ApplicationLiveApp {
  _startPromise?: unknown;
  _startupMode?: string;
  _transportAttached?: boolean;
  _applicationLiveDelivery?: unknown;
  ready?: Promise<unknown> | null;
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
  authorization,
}: ApplicationLiveDeliveryOptions): ApplicationLiveApp {
  if (app._startPromise || app._startupMode || app._transportAttached) {
    throw new Error('live delivery must be attached before application startup');
  }
  if (app._applicationLiveDelivery) throw new Error('live delivery is already attached');
  if (!app.db) throw new Error('live delivery requires an application database');
  validatePrincipalSnapshotDeclarations(principalSnapshots as never, app.schema as never);

  // Two-valued admission collapse (S5/A1), applied at the application delivery
  // seam — the ONE boundary a revoked/expired/disabled principal could reach a
  // transport as a real non-active status. Both skins resolve the caller here:
  // HTTP bootstrap/catchup/SSE and the WebSocket upgrade. A non-'active'
  // principal enters delivery as the canonical `anonymous`, so re-authorization
  // (mayVerb / the grant) and subscription presence never see a real non-active
  // status — a revoked caller is admitted exactly as an unauthenticated one
  // (no status oracle). The REAL status stays on the pre-collapse principal for
  // statusOf() — the audit reader.
  const principalOfAdmitted = async (request: IncomingMessage) => collapseForAdmission(await principalOf(request));
  const owned = createOwnedLiveDelivery({
    db: app.db as LiveDatabase,
    entities: (name: string, declaration?: unknown) => declaration === undefined ? app.entities.get(name) : app.entity(declaration),
    mayVerb: (entity: LiveEntityRecord, verb: string, row: Record<string, unknown> | null | undefined, principal: Principal) => mayVerb(entity as never, verb, row, principal),
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
  let wsTransport: ReturnType<typeof createLiveDeliveryWebSocket> | null = null;

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
    mountWebSocket: (httpServer: Parameters<typeof createLiveDeliveryWebSocket>[0]) => {
      if (!wsTransport) {
        wsTransport = createLiveDeliveryWebSocket(httpServer, {
          path: `${path}/events`,
          core: owned.core,
          principalOf: principalOfAdmitted,
          resolveEntity: (name: string) => app.entities.get(name),
          mayVerb: (entity: LiveEntityRecord, verb: string, row: Record<string, unknown> | null | undefined, principal: Principal) => mayVerb(entity as never, verb, row, principal),
          authorization,
          db: app.db as LiveDatabase,
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
