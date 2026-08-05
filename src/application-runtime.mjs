// Application runtime ownership. This is the one boot path for both headless
// and HTTP applications: declaration/schema finalization, Kernel assembly,
// recovery, maintenance, clocks, and graceful shutdown registration.

import { randomUUID } from 'node:crypto';

import { buildKernel } from './kernel.mjs';
import { installGracefulShutdown } from './lifecycle.mjs';
import {
  pruneInactiveScheduleReceipts,
  startClockTriggers,
} from './schedule-runtime.mjs';
import { reconcileProjectedRecovery } from './projected-async.mjs';
import { reconcileDurableEffects } from './durable-effects.mjs';
import { startSimulation } from './simulate.mjs';
import { retentionPrune } from './committed-log.mjs';
import { getLog, withLog } from './log.mjs';
import { installBatchHttpDispatcher, installHistoryHttpDispatcher } from './application-action-http.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';

const BLOB_REAP_INTERVAL_MS = 10 * 60_000;
const BLOB_REAP_TTL_MS = 60 * 60_000;

function installRuntimeShutdown(app) {
  if (app._runtimeShutdownInstalled) return;
  installGracefulShutdown(app);
  app._runtimeShutdownInstalled = true;
  app.onShutdown('job queue', () => app.jobs?.stop?.(), { timeoutMs: 1000 });
  app.onShutdown('clock', () => app.clock?.stop?.(), { timeoutMs: 1000 });
}

function wireMutationSurface(app) {
  const dispatch = (args) =>
    withLog(app.log, () => app.writeQueue.run(() => app.kernel.dispatch(bindAnnotatedTextScope(app, args))));
  app.dispatch = dispatch;
  app.history = app.kernel.history && Object.freeze({
    cursor: app.kernel.history.cursor,
    undo: (args) => withLog(app.log, () => app.writeQueue.run(() => app.kernel.history.undo(args))),
    redo: (args) => withLog(app.log, () => app.writeQueue.run(() => app.kernel.history.redo(args))),
  });
  // The HTTP skin receives a private queued dispatcher, not a cursor capability.
  // Reading and moving happen under one package write-queue turn.
  if (app.kernel.history) {
    installHistoryHttpDispatcher(app, (command, args) => withLog(app.log, () => app.writeQueue.run(async () => {
      const cursor = await app.kernel.history.cursor(args);
      return app.kernel.history[command]({ ...args, revision: cursor.revision });
    })));
  }
  const dispatchBatch = (request) => withLog(app.log, () => app.writeQueue.run(() => app.kernel.dispatchBatch(request)));
  installBatchHttpDispatcher(app, dispatchBatch);
  app.batch = async (actionsOrFactory, { principal, clientId, scope } = {}) =>
    withLog(app.log, () => app.writeQueue.run(() => {
      const actions = typeof actionsOrFactory === 'function'
        ? actionsOrFactory()
        : actionsOrFactory;
      if (actions && typeof actions.then === 'function') {
        throw new TypeError('app.batch action factory must return a synchronous action array');
      }
      if (!Array.isArray(actions)) {
        throw new TypeError('app.batch requires an action array or synchronous action-array factory');
      }
      return app.kernel.dispatchBatch({ actionId: randomUUID(), actions, principal, clientId, scope });
    }));
  return dispatch;
}


function bindAnnotatedTextScope(app, args) {
  if (!args?.type || !args?.payload || typeof args.payload !== 'object') return args;
  const entity = [...app.entities.values()].find((candidate) => args.type.startsWith(`${candidate.name}.`));
  const annotatedFields = entity && Object.entries(entity.fields).filter(([, field]) => field.kind === 'annotatedText');
  if (!annotatedFields?.length) return args;
  const operationType = annotatedFields.find(([name]) => args.type === `${entity.name}.${name}.operation`)
    ?? annotatedFields[0];
  const descriptor = operationType[1];
  if (args.type !== `${entity.name}.create` && args.type !== `${entity.name}.update` && args.type !== `${entity.name}.remove`
    && args.type !== `${entity.name}.annotatedText.retire` && args.type !== `${entity.name}.${operationType[0]}.operation`) return args;
  const id = args.payload.id;
  if (typeof id !== 'string' || !id) return args;
  const row = args.type === `${entity.name}.create`
    ? args.payload
    : app.db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(id);
  if (!row) return args;
  return { ...args, scope: resolveAnnotatedTextOwningScope(descriptor, entity.fields, row).key };
}

function engageMaintenance(app, log) {
  const options = app._maintenance;
  if (app.blobs) {
    app.sweepBlobs = () => app.writeQueue.run(() =>
      app.blobs.reap({ ttl: options.blobReapTtlMs, blobColumns: app.blobColumns ?? [] })
    );
    app.clock.add({
      name: 'blob-reaper',
      intervalMs: options.blobReapIntervalMs,
      fn: () => void app.sweepBlobs().catch((err) => log.warn('system', 'blob reap failed', { err })),
    });
  }
  if (app.pendingBlobLifecycle) {
    app.sweepPendingBlobs = () => app.writeQueue.run(() => app.pendingBlobLifecycle.reap());
    app.clock.add({
      name: 'pending-blob-reaper',
      intervalMs: options.blobReapIntervalMs,
      fn: () => void app.sweepPendingBlobs().catch((err) => log.warn('system', 'pending blob reap failed', { err })),
    });
  }
  if (options.logRetentionDays > 0) {
    app.sweepLog = () => app.writeQueue.run(() => {
      const cutoff = new Date(Date.now() - options.logRetentionDays * 86_400_000).toISOString();
      retentionPrune(app.db, cutoff);
      app.db.prepare('DELETE FROM _ProjectedCursor WHERE lastSeq = 0').run();
    });
    app.clock.add({
      name: 'log-reaper',
      intervalMs: options.logRetentionIntervalMs,
      fn: () => void app.sweepLog().catch((err) => log.warn('system', 'log retention sweep failed', { err })),
    });
  }
}

async function bootApplication(app) {
  const log = app.log ?? getLog();
  // When HTTP was selected, fail the same boot promise on bind errors before
  // acquiring the durable/background owners.
  await app._transportReady;
  if (app._shutdownStarted) return app;
  await app.resolveRoutes();
  if (app._shutdownStarted) return app;
  if (app.db && typeof app.db.exec === 'function') await app.prepareSchema();
  if (app._shutdownStarted) return app;

  app.kernel = buildKernel(app);
  const dispatch = wireMutationSurface(app);

  if (app.db) {
    if (typeof app.db.exec === 'function') {
      pruneInactiveScheduleReceipts({ db: app.db, entities: app.entities });
    }
    startClockTriggers({ db: app.db, entities: app.entities, dispatch, clock: app.clock });
    app.simulation = startSimulation({
      db: app.db,
      entities: app.entities,
      dispatch,
      clock: app.clock,
    });
  }

  try {
    await app.writeQueue.run(() => reconcileProjectedRecovery(app.db, app.entities));
  } catch (err) {
    log.warn('system', 'projected recovery sweep failed', { err });
  }
  if (app._shutdownStarted) return app;
  if (app.db && app.reconcileBlobFinalize) {
    try {
      await app.writeQueue.run(() => app.reconcileBlobFinalize(app.db));
    } catch (err) {
      log.warn('system', 'blob finalize recovery sweep failed', { err });
    }
  }
  if (app.pendingBlobLifecycle) {
    try {
      await app.writeQueue.run(() => app.pendingBlobLifecycle.reconcile());
    } catch (err) {
      log.warn('system', 'pending blob lifecycle recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  if (app.db && app.reconcileEmailDelivery) {
    try {
      await app.writeQueue.run(() => app.reconcileEmailDelivery(app.db));
    } catch (err) {
      log.warn('system', 'email delivery recovery sweep failed', { err });
    }
  }
  if (app.db && app.reconcileOperationalConsumers) {
    try {
      await app.writeQueue.run(() => app.reconcileOperationalConsumers());
    } catch (err) {
      log.warn('system', 'operational consumer recovery sweep failed', { err });
    }
  }
  if (app._shutdownStarted) return app;
  if (app.jobs && app.durableEffectsRegistry) {
    try {
      await app.writeQueue.run(() =>
        reconcileDurableEffects(app.db, {
          durableEffectsRegistry: app.durableEffectsRegistry,
          jobs: app.jobs,
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

export function startApplication(app) {
  if (app._startFailed && app._startPromise) return app._startPromise;
  if (app._shutdownStarted) {
    return Promise.reject(new Error('application has been shut down and cannot be started again'));
  }
  if (app._startPromise) return app._startPromise;

  app._startupMode = app._transportAttached ? 'http' : 'headless';
  installRuntimeShutdown(app);
  app._startPromise = withLog(app.log, () => bootApplication(app)).catch(async (err) => {
    app._startFailed = true;
    if (!app._shutdownStarted) await app._shutdownFromStartFailure();
    throw err;
  });
  app.ready = app._startPromise;
  return app._startPromise;
}

export const maintenanceDefaults = Object.freeze({
  blobReapIntervalMs: BLOB_REAP_INTERVAL_MS,
  blobReapTtlMs: BLOB_REAP_TTL_MS,
  logRetentionDays: 0,
  logRetentionIntervalMs: BLOB_REAP_INTERVAL_MS,
});

export function validateMaintenanceOptions(options) {
  for (const name of ['blobReapIntervalMs', 'logRetentionIntervalMs']) {
    const value = options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a finite number greater than zero`);
    }
  }
  for (const name of ['blobReapTtlMs', 'logRetentionDays']) {
    const value = options[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a finite non-negative number`);
    }
  }
  return Object.freeze({ ...options });
}
