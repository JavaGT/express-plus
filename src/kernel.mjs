import { randomUUID } from 'node:crypto';
import { mayRow } from './row-grant.mjs';
import { admitSystemMutation, startClockTriggers } from './schedule.mjs';
import { createServer, durableMutationVariant } from './pipeline.mjs';
import { buildEffectsRegistry, validateEffects, executeEffectsForEvent } from './effect-compiler.mjs';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth-entities.mjs';
import { createWriteQueue } from './write-queue.mjs';
import { createProjectedAsyncConsumer } from './projected-async.mjs';
import { buildDurableEffectsRegistry, createDurableEffectsConsumer } from './durable-effects.mjs';
import { createBlobLifecycle } from './blob-lifecycle.mjs';
import { reconcileProjectedRecovery } from './projected-async.mjs';
import { reconcileDurableEffects } from './durable-effects.mjs';
import { getLog } from './log.mjs';
import { createLivePostCommitConsumer } from './live-delivery.mjs';

// Framework auth entities are always-available effect targets (an app's effect
// may target Inbox without mounting it — auth entities are never request-facing
// routes). They must be present in the validation set so the admission handshake
// can resolve them + their `admitsEffects`.
const FRAMEWORK_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];

function collectAppEntities(app) {
  const handlers = {};
  const projections = [];
  const entities = new Map();
  for (const route of app.routes) {
    const entity = route.entity;
    if (entity && !entities.has(entity.name)) {
      entities.set(entity.name, entity);
      Object.assign(handlers, entity.crudHandlers);
      projections.push(entity.projection);
    }
  }
  return { handlers, projections, entities };
}

function buildEffects(entities) {
  const effectsRegistry = buildEffectsRegistry([...entities.values()]);
  if (effectsRegistry.size > 0) {
    const forValidation = [...entities.values()];
    for (const fe of FRAMEWORK_ENTITIES) {
      if (fe && !entities.has(fe.name)) forValidation.push(fe);
    }
    validateEffects(forValidation);
  }
  return effectsRegistry;
}

function buildDurableAdmission(app) {
  return {
    async beforeProjection({ entityName, verb, principal, event, payload, db: hookDb, now }) {
      if (principal?.type !== 'system' || !principal.attributes?.source) return true;
      const entity = app.entities?.get(entityName);
      if (!entity) return false;
      return admitSystemMutation({
        entity,
        verb,
        rowId: event?.data?.id,
        payload,
        principal,
        db: hookDb ?? app.db,
        now: now ?? Date.now(),
      });
    },
    async afterProjection({ entityName, verb, principal, event }) {
      if (event?._effectPrincipal) return true;
      if (verb !== 'create') return true;
      const entity = app.entities?.get(entityName);
      if (!entity) return false;
      const id = event?.data?.id;
      if (id == null) return false;
      let row = null;
      try {
        row = entity.findById(String(id), principal);
      } catch {
        row = null;
      }
      if (!row) return false;
      return mayRow(entity, verb, row, principal);
    },
  };
}

// Post-commit consumers are contributed by the module that owns each seam.
// Kernel only assembles engaged seams — it does not implement fanout/latch.
function engagedPostCommitConsumers(app, entities, { blobFinalizeConsumer, durableEffectsRegistry }) {
  return [
    blobFinalizeConsumer,
    createLivePostCommitConsumer(app),
    createProjectedAsyncConsumer({ entities }),
    createDurableEffectsConsumer({ durableEffectsRegistry, jobs: app.jobs }),
    app._emailConsumer,
  ].filter(Boolean);
}

export function buildKernel(app) {
  const { handlers, projections, entities } = collectAppEntities(app);
  for (const fe of FRAMEWORK_ENTITIES) {
    if (fe && !entities.has(fe.name)) {
      // A per-app Session copy (app._sessionEntity) carries this app's session-
      // duration schedule trigger; prefer it over the framework singleton when
      // the app installed one. Same shape (shallow spread, overridden delay),
      // so the reaper / admission / projection read the right expiry.
      const entity = fe === Session && app._sessionEntity ? app._sessionEntity : fe;
      entities.set(entity.name, entity);
      Object.assign(handlers, entity.crudHandlers);
      projections.push(entity.projection);
    }
  }
  app.entities = entities;

  const effectsRegistry = buildEffects(entities);
  const durableEffectsRegistry = buildDurableEffectsRegistry([...entities.values()]);
  const { blobAdapter, blobFinalizeConsumer, blobColumns } = createBlobLifecycle({
    blobs: app.blobs,
    entities,
  });
  app.blobColumns = blobColumns;
  app.durableEffectsRegistry = durableEffectsRegistry;

  app.writeQueue = createWriteQueue();

  // Kernel public seam: durable mutation server (handlers, admission, write
  // queue). authorize:()=>true is intentional — route gate + in-txn admission
  // own Grants (no second auth path at the outer hook).
  return createServer({
    handlers,
    authorize: () => true,
    db: app.db,
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      admission: buildDurableAdmission(app),
      blobAdapter,
      effectsRegistry: effectsRegistry.size > 0 ? effectsRegistry : null,
      executeEffectsForEvent,
      postCommitConsumers: engagedPostCommitConsumers(app, entities, {
        blobFinalizeConsumer,
        durableEffectsRegistry,
      }),
    }),
  });
}

// Boot orchestration — starts all subsystems after the kernel is built.
// Called from serve.mjs inside app.ready, after resolveRoutes + prepareSchema
// and after app.kernel = buildKernel(app).
export async function buildAndStart(app) {
  const log = getLog();
  const dispatchThroughWriteQueue = (args) => app.writeQueue.run(() => app.kernel.dispatch(args));
  // app.batch(actions, { principal }) — a server-side composed mutation
  // (SPEC §11, ADR #13). N actions run as ONE transaction = ONE composed
  // commit (one actionId, one `now`), all-or-nothing. This reuses the SAME
  // kernel path (authorize→handler→durable variant) wrapped once in the
  // writeQueue — not a second pipeline. Exposed for server code that needs
  // an atomic multi-entity write outside the per-route HTTP handlers.
  app.batch = (actions, { principal } = {}) =>
    app.writeQueue.run(() => app.kernel.dispatchBatch({ actionId: randomUUID(), actions, principal }));
  // Singular Schedule clock-dispatch: deadline + tick share one starter.
  // No-op when no triggers exist. Scheduled on the shared clock.
  startClockTriggers({
    db: app.db,
    entities: app.entities,
    dispatch: dispatchThroughWriteQueue,
    clock: app.clock,
  });
  // Projected.async boot catch-up. If the process died between committing an
  // event and the post-commit consumer applying its projection, the projected
  // field is stale and nothing reconciles it. One sweep at startup, under the
  // writeQueue mutex (same critical section dispatch uses), recomputes lagging
  // scopes from current row state and cleans cursors for removed rows. Run
  // after buildKernel (app.entities is set) and before serving traffic.
  try {
    await app.writeQueue.run(() => reconcileProjectedRecovery(app.db, app.entities));
  } catch (err) {
    log.warn('system', 'projected recovery sweep failed', { err });
  }
  // Durable-effects boot catch-up. Same crash gap as projected recovery: a
  // committed _Log row whose post-commit enqueue was lost (process died
  // between COMMIT and the durable consumer) would never be retried. One
  // sweep at startup, under the same writeQueue mutex, re-enqueues missed
  // jobs and advances the per-scope consumer cursor. No-op when no durable
  // effects are declared or the job-queue substrate is not engaged.
  if (app.jobs && app.durableEffectsRegistry) {
    try {
      await app.writeQueue.run(() =>
        reconcileDurableEffects(app.db, { durableEffectsRegistry: app.durableEffectsRegistry, jobs: app.jobs }),
      );
    } catch (err) {
      log.warn('system', 'durable effects recovery sweep failed', { err });
    }
  }
  // Start the unified clock — a single setTimeout loop that wakes only at the
  // nearest deadline. All framework reapers (schedule, tick, job-queue lease,
  // blob, log-retention, job-worker polls) register as watchers above; this
  // activates real timer scheduling. Called AFTER the sweeps finish so catch-up
  // doesn't race the first interval fire.
  app.clock._schedule();
  if (!app.httpServer.listening) {
    await new Promise((resolve) => app.httpServer.once('listening', resolve));
  }
  log.info('system', `server listening on port ${app.httpServer.address()?.port}`);
}
