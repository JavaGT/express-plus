// Application runtime ownership. This is the one boot path for both headless
// and HTTP applications: declaration/schema finalization, Kernel assembly,
// recovery, maintenance, clocks, and graceful shutdown registration.

import { randomUUID } from 'node:crypto';

import { buildKernel } from './kernel.ts';
import { installGracefulShutdown } from './lifecycle.ts';
import {
  pruneInactiveScheduleReceipts,
  startClockTriggers,
} from './schedule-runtime.ts';
import { reconcileProjectedRecovery } from './projected-async.ts';
import { reconcileDurableEffects } from './durable-effects.ts';
import { startSimulation } from './simulate.ts';
import { retentionPrune } from './committed-log.ts';
import { getLog, withLog } from './log.ts';
import type { FrameworkLog } from './log.ts';
import { EMPTY_BLOB_CENSUS, type BlobCensus } from './blob-census.ts';
import { blobRetentionDefaults, validateBlobRetentionPolicies, type BlobRetentionPolicies } from './blob-retention.ts';
import type { BlobReapOptions } from './blob-store.ts';
import { installBatchHttpDispatcher, installHistoryHttpDispatcher } from './application-action-http.ts';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.ts';
import { rawRow } from './entity/query.ts';
import type { FieldDescriptor, LiveEntityRecord } from './live-fanout.ts';

const BLOB_REAP_INTERVAL_MS = 10 * 60_000;

// S6/A5 #5 low-disk guard default: refuse new uploads below 256 MiB of free
// disk so a full disk can never compromise SQLite/WAL durability mid-commit.
// Configurable via the maintenance options; 0 disables the guard.
export const DEFAULT_LOW_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

export interface RuntimeMaintenance {
  blobReapIntervalMs: number;
  blobReapTtlMs: number;
  logRetentionDays: number;
  logRetentionIntervalMs: number;
  /** Named blob retention policies (S6/A5) — the single TTL source; no scattered literals. */
  blobRetention: Readonly<BlobRetentionPolicies>;
  /** Low-disk upload guard (S6/A5 #5): refuse new uploads below this many free bytes (0 disables). */
  blobLowDiskHeadroomBytes: number;
}

interface RuntimeDatabase {
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
}

interface KernelHistory {
  cursor: (args: unknown) => Promise<unknown>;
  undo: (args: unknown) => unknown;
  redo: (args: unknown) => unknown;
}

interface RuntimeKernel {
  dispatch: (args: unknown) => unknown;
  dispatchBatch: (request: unknown) => unknown;
  history?: KernelHistory;
}

interface RuntimeClock {
  add(spec: { name: string; intervalMs: number; fn: () => void }): unknown;
  stop?(): unknown;
  _schedule(): void;
}

interface RuntimeApp {
  _runtimeShutdownInstalled?: boolean;
  _transportReady: Promise<unknown>;
  _shutdownStarted?: boolean;
  _startFailed?: boolean;
  _startPromise?: Promise<RuntimeApp>;
  _startupMode?: 'http' | 'headless';
  _transportAttached?: boolean;
  _maintenance: RuntimeMaintenance;
  log: FrameworkLog;
  writeQueue: { run<T>(operation: () => T): Promise<T> };
  kernel: RuntimeKernel;
  history?: unknown;
  dispatch: (args: unknown) => unknown;
  batch: (actions: unknown, options?: { principal?: unknown; clientId?: unknown; scope?: unknown }) => Promise<unknown>;
  entities: ReadonlyMap<string, LiveEntityRecord>;
  db?: RuntimeDatabase | null;
  prepareSchema(): Promise<unknown>;
  resolveRoutes(): Promise<unknown>;
  clock: RuntimeClock;
  jobs?: { stop?(): unknown; startReaper?(): unknown };
  blobs?: { reap(options: BlobReapOptions): unknown };
  blobCensus?: BlobCensus;
  pendingBlobLifecycle?: { reap(): unknown; reconcile(): unknown };
  /** S1/A6 recycle seam (S6/A5): the reaper routes replaced/dangling generations through it before removing live bytes. */
  blobRecycleSeam?: { bin(deletion: { generations: readonly string[] }): Promise<unknown> } | null;
  reconcileBlobFinalize?(db: unknown): unknown;
  reconcileEmailDelivery?(db: unknown): unknown;
  reconcileOperationalConsumers?(): unknown;
  durableEffectsRegistry?: unknown;
  httpServer?: { address(): { port?: number } | null };
  simulation?: unknown;
  sweepBlobs?: () => Promise<unknown>;
  sweepPendingBlobs?: () => Promise<unknown>;
  sweepLog?: () => Promise<unknown>;
  ready?: Promise<unknown>;
  onShutdown(name: string, hook: () => void | Promise<void>, options?: { timeoutMs?: number }): void;
  _shutdownFromStartFailure?(): Promise<unknown>;
}

function installRuntimeShutdown(app: RuntimeApp): void {
  if (app._runtimeShutdownInstalled) return;
  installGracefulShutdown(app as never);
  app._runtimeShutdownInstalled = true;
  app.onShutdown('job queue', () => void app.jobs?.stop?.(), { timeoutMs: 1000 });
  app.onShutdown('clock', () => void app.clock?.stop?.(), { timeoutMs: 1000 });
}

function wireMutationSurface(app: RuntimeApp): (args: unknown) => unknown {
  const dispatch = (args: unknown) =>
    withLog(app.log, () => app.writeQueue.run(() => app.kernel.dispatch(bindAnnotatedTextScope(app, args as never))));
  app.dispatch = dispatch;
  const kernelHistory = app.kernel.history as KernelHistory | undefined;
  app.history = kernelHistory && Object.freeze({
    cursor: kernelHistory.cursor,
    undo: (args: unknown) => withLog(app.log, () => app.writeQueue.run(() => kernelHistory.undo(args))),
    redo: (args: unknown) => withLog(app.log, () => app.writeQueue.run(() => kernelHistory.redo(args))),
  });
  // The HTTP skin receives a private queued dispatcher, not a cursor capability.
  // Reading and moving happen under one package write-queue turn.
  if (kernelHistory) {
    installHistoryHttpDispatcher(app as never, ((command: string, args: Record<string, unknown>) => withLog(app.log, () => app.writeQueue.run(async () => {
      const cursor = await kernelHistory.cursor(args);
      return (kernelHistory as unknown as Record<string, (args: unknown) => unknown>)[command]({ ...args, revision: (cursor as { revision?: unknown }).revision });
    }))) as never);
  }
  const dispatchBatch = (request: unknown) => withLog(app.log, () => app.writeQueue.run(() => app.kernel.dispatchBatch(request)));
  installBatchHttpDispatcher(app as never, dispatchBatch as never);
  app.batch = async (actionsOrFactory: unknown, { principal, clientId, scope }: { principal?: unknown; clientId?: unknown; scope?: unknown } = {}) =>
    withLog(app.log, () => app.writeQueue.run(() => {
      const actions = typeof actionsOrFactory === 'function'
        ? actionsOrFactory()
        : actionsOrFactory;
      if (actions && typeof (actions as { then?: unknown }).then === 'function') {
        throw new TypeError('app.batch action factory must return a synchronous action array');
      }
      if (!Array.isArray(actions)) {
        throw new TypeError('app.batch requires an action array or synchronous action-array factory');
      }
      return app.kernel.dispatchBatch({ actionId: randomUUID(), actions, principal, clientId, scope });
    }));
  return dispatch;
}


function bindAnnotatedTextScope(app: RuntimeApp, args: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
  if (!args?.type || !args?.payload || typeof args.payload !== 'object') return args;
  const type = args.type as string;
  const entity = [...app.entities.values()].find((candidate) => type.startsWith(`${candidate.name}.`));
  const annotatedFields = entity && Object.entries(entity.fields as Record<string, FieldDescriptor>).filter(([, field]) => field.kind === 'annotatedText');
  if (!annotatedFields?.length || !entity) return args;
  const operationType = annotatedFields.find(([name]) => type === `${entity.name}.${name}.operation`)
    ?? annotatedFields[0];
  const descriptor = operationType[1];
  if (type !== `${entity.name}.create` && type !== `${entity.name}.update` && type !== `${entity.name}.remove`
    && type !== `${entity.name}.annotatedText.retire` && type !== `${entity.name}.${operationType[0]}.operation`) return args;
  const id = (args.payload as Record<string, unknown>).id;
  if (typeof id !== 'string' || !id) return args;
  const row = type === `${entity.name}.create`
    ? args.payload
    : rawRow(app.db, entity.name, id);
  if (!row) return args;
  return { ...args, scope: resolveAnnotatedTextOwningScope(descriptor, entity.fields as Record<string, any>, row as Record<string, any>).key };
}

function engageMaintenance(app: RuntimeApp, log: FrameworkLog): void {
  const options = app._maintenance;
  if (app.blobs) {
    app.sweepBlobs = () => app.writeQueue.run(() =>
      app.blobs!.reap({
        ttl: options.blobReapTtlMs,
        census: app.blobCensus ?? EMPTY_BLOB_CENSUS,
        // The named 'replaced-generation' policy (S6/A5): replaced generations
        // are reclaimed only once this retention window has elapsed.
        replacedRetentionMs: options.blobRetention.replacedGenerationRetentionMs,
        // Route replaced/dangling generations through the S1/A6 recycling bin
        // (S6/A5 #4) when the app owns a recycle seam.
        ...(app.blobRecycleSeam ? { recycle: app.blobRecycleSeam } : {}),
      })
    );
    app.clock.add({
      name: 'blob-reaper',
      intervalMs: options.blobReapIntervalMs,
      fn: () => void app.sweepBlobs!().catch((err) => log.warn('system', 'blob reap failed', { err })),
    });
  }
  if (app.pendingBlobLifecycle) {
    app.sweepPendingBlobs = () => app.writeQueue.run(() => app.pendingBlobLifecycle!.reap());
    app.clock.add({
      name: 'pending-blob-reaper',
      intervalMs: options.blobReapIntervalMs,
      fn: () => void app.sweepPendingBlobs!().catch((err) => log.warn('system', 'pending blob reap failed', { err })),
    });
  }
  if (options.logRetentionDays > 0) {
    app.sweepLog = () => app.writeQueue.run(async () => {
      const cutoff = new Date(Date.now() - options.logRetentionDays * 86_400_000).toISOString();
      await retentionPrune(app.db as never, cutoff);
      (app.db as RuntimeDatabase).prepare('DELETE FROM _ProjectedCursor WHERE lastSeq = 0').run();
    });
    app.clock.add({
      name: 'log-reaper',
      intervalMs: options.logRetentionIntervalMs,
      fn: () => void app.sweepLog!().catch((err) => log.warn('system', 'log retention sweep failed', { err })),
    });
  }
}

async function bootApplication(app: RuntimeApp): Promise<RuntimeApp> {
  const log = app.log ?? getLog();
  // When HTTP was selected, fail the same boot promise on bind errors before
  // acquiring the durable/background owners.
  await app._transportReady;
  if (app._shutdownStarted) return app;
  await app.resolveRoutes();
  if (app._shutdownStarted) return app;
  if (app.db && typeof app.db.exec === 'function') await app.prepareSchema();
  if (app._shutdownStarted) return app;

  app.kernel = buildKernel(app) as unknown as RuntimeKernel;
  const dispatch = wireMutationSurface(app);

  if (app.db) {
    if (typeof app.db.exec === 'function') {
      pruneInactiveScheduleReceipts({ db: app.db as never, entities: app.entities as never });
    }
    startClockTriggers({ db: app.db as never, entities: app.entities as never, dispatch, clock: app.clock as never });
    app.simulation = startSimulation({
      db: app.db as never,
      entities: app.entities,
      dispatch,
      clock: app.clock as never,
    });
  }

  try {
    await app.writeQueue.run(() => reconcileProjectedRecovery(app.db as never, app.entities as never));
  } catch (err) {
    log.warn('system', 'projected recovery sweep failed', { err });
  }
  if (app._shutdownStarted) return app;
  const reconcileBlobFinalize = app.reconcileBlobFinalize;
  if (app.db && reconcileBlobFinalize) {
    try {
      await app.writeQueue.run(() => reconcileBlobFinalize(app.db));
    } catch (err) {
      log.warn('system', 'blob finalize recovery sweep failed', { err });
    }
  }
  const pendingBlobLifecycle = app.pendingBlobLifecycle;
  if (pendingBlobLifecycle) {
    try {
      await app.writeQueue.run(() => pendingBlobLifecycle.reconcile());
    } catch (err) {
      log.warn('system', 'pending blob lifecycle recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  const reconcileEmailDelivery = app.reconcileEmailDelivery;
  if (app.db && reconcileEmailDelivery) {
    try {
      await app.writeQueue.run(() => reconcileEmailDelivery(app.db));
    } catch (err) {
      log.warn('system', 'email delivery recovery sweep failed', { err });
    }
  }
  const reconcileOperationalConsumers = app.reconcileOperationalConsumers;
  if (app.db && reconcileOperationalConsumers) {
    try {
      await app.writeQueue.run(() => reconcileOperationalConsumers());
    } catch (err) {
      log.warn('system', 'operational consumer recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  const durableEffectsRegistry = app.durableEffectsRegistry;
  if (app.jobs && durableEffectsRegistry) {
    try {
      await app.writeQueue.run(() =>
        reconcileDurableEffects(app.db as never, {
          durableEffectsRegistry: durableEffectsRegistry as never,
          jobs: app.jobs as never,
        }),
      );
    } catch (err) {
      log.warn('system', 'durable effects recovery sweep failed', { err });
    }
  }

  engageMaintenance(app, log);
  app.jobs?.startReaper?.();
  app.clock._schedule();
  log.info('system', app.httpServer
    ? `server listening on port ${app.httpServer.address()?.port}`
    : 'application started');
  return app;
}

export function startApplication(app: RuntimeApp): Promise<RuntimeApp> {
  if (app._startFailed && app._startPromise) return app._startPromise;
  if (app._shutdownStarted) {
    return Promise.reject(new Error('application has been shut down and cannot be started again'));
  }
  if (app._startPromise) return app._startPromise;

  app._startupMode = app._transportAttached ? 'http' : 'headless';
  installRuntimeShutdown(app);
  app._startPromise = (withLog(app.log, () => bootApplication(app)) as Promise<RuntimeApp>).catch(async (err) => {
    app._startFailed = true;
    if (!app._shutdownStarted) await app._shutdownFromStartFailure?.();
    throw err;
  }) as Promise<RuntimeApp>;
  app.ready = app._startPromise;
  return app._startPromise;
}

export const maintenanceDefaults: Readonly<RuntimeMaintenance> = Object.freeze({
  blobReapIntervalMs: BLOB_REAP_INTERVAL_MS,
  // The abandoned-upload TTL is a named policy (S6/A5) — the scalar remains for
  // back-compat, defaulting from the policy so no TTL literal lives here.
  blobReapTtlMs: blobRetentionDefaults.abandonedUploadTtlMs,
  logRetentionDays: 0,
  logRetentionIntervalMs: BLOB_REAP_INTERVAL_MS,
  blobRetention: blobRetentionDefaults,
  blobLowDiskHeadroomBytes: DEFAULT_LOW_DISK_HEADROOM_BYTES,
});

export function validateMaintenanceOptions(options: RuntimeMaintenance): Readonly<RuntimeMaintenance> {
  for (const name of ['blobReapIntervalMs', 'logRetentionIntervalMs'] as const) {
    const value = options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a finite number greater than zero`);
    }
  }
  for (const name of ['blobReapTtlMs', 'logRetentionDays'] as const) {
    const value = options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a finite non-negative number`);
    }
  }
  // The named retention policies (S6/A5) validate centrally in
  // blob-retention.ts; absent → the shared defaults.
  const blobRetention = validateBlobRetentionPolicies(options.blobRetention);
  const blobLowDiskHeadroomBytes = options.blobLowDiskHeadroomBytes ?? maintenanceDefaults.blobLowDiskHeadroomBytes;
  if (typeof blobLowDiskHeadroomBytes !== 'number' || !Number.isFinite(blobLowDiskHeadroomBytes) || blobLowDiskHeadroomBytes < 0) {
    throw new TypeError('blobLowDiskHeadroomBytes must be a finite non-negative number of bytes (0 disables the guard)');
  }
  return Object.freeze({
    blobReapIntervalMs: options.blobReapIntervalMs,
    blobReapTtlMs: options.blobReapTtlMs,
    logRetentionDays: options.logRetentionDays,
    logRetentionIntervalMs: options.logRetentionIntervalMs,
    blobRetention,
    blobLowDiskHeadroomBytes,
  });
}
