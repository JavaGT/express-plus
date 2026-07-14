import { mayRow } from './row-grant.mjs';
import {
  admitSystemMutation,
  clearRemovedScheduleReceipts,
  rearmChangedScheduleReceipts,
} from './schedule.mjs';
import { createServer, durableMutationVariant } from './pipeline.mjs';
import { buildEffectsRegistry, validateEffects, executeEffectsForEvent } from './effect-compiler.mjs';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.mjs';
import { admitInvitationCreation, isInvitationCreationAuthority } from './auth/invitation.mjs';
import { createProjectedAsyncConsumer } from './projected-async.mjs';
import { buildDurableEffectsRegistry, createDurableEffectsConsumer } from './durable-effects.mjs';
import { createBlobLifecycle } from './blob-lifecycle.mjs';

// Framework auth entities are always-available effect targets (an app's effect
// may target Inbox without mounting it — auth entities are never request-facing
// routes). They must be present in the validation set so the admission handshake
// can resolve them + their `admitsEffects`.
const FRAMEWORK_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];

function collectAppEntities(app) {
  const handlers = {};
  const projections = [];
  const entities = new Map(app.entities ?? []);
  for (const entity of entities.values()) {
    Object.assign(handlers, entity.crudHandlers);
    projections.push(entity.projection);
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
  async function admitsExistingRow({ entityName, verb, principal, event }) {
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
  }

  return {
    async beforeProjection({ entityName, verb, principal, event, payload, db: hookDb, now }) {
      if (
        entityName === Invitation.name
        && verb === 'create'
        && isInvitationCreationAuthority(principal)
      ) {
        return admitInvitationCreation({
          Invitation: app.entities?.get(Invitation.name),
          event,
          principal,
        });
      }
      if (principal?.type === 'system' && principal.attributes?.source) {
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
      }
      if (principal?.type === 'system' && principal.attributes?.effect && verb !== 'create') {
        const granted = await admitsExistingRow({ entityName, verb, principal, event });
        if (granted && verb === 'update') {
          rearmChangedScheduleReceipts({
            entity: app.entities?.get(entityName),
            event,
            principal,
            db: hookDb ?? app.db,
          });
        }
        return granted;
      }
      if (verb === 'update') {
        rearmChangedScheduleReceipts({
          entity: app.entities?.get(entityName),
          event,
          principal,
          db: hookDb ?? app.db,
        });
      }
      return true;
    },
    async afterProjection({ entityName, verb, principal, event, db: hookDb }) {
      if (
        entityName === Invitation.name
        && verb === 'create'
        && isInvitationCreationAuthority(principal)
      ) return true;
      if (verb === 'remove') {
        clearRemovedScheduleReceipts({
          entity: app.entities?.get(entityName),
          rowId: event?.data?.id,
          db: hookDb ?? app.db,
        });
      }
      if (verb !== 'create') return true;
      return admitsExistingRow({ entityName, verb, principal, event });
    },
  };
}

// Post-commit consumers are contributed by the module that owns each seam.
// Kernel only assembles engaged seams — it does not implement fanout/latch,
// and it does not branch on kind: recovery mechanics live inside each
// consumer's own module (blob-lifecycle.mjs, projected-async.mjs,
// durable-effects.mjs, email-seam.mjs), never here. The `kind` tag below is
// documentation-as-data — it makes the recovery contracts a consumer can have
// visible at the one place they're assembled, instead of leaving a reader to
// infer it per-module:
//
//   - 'durable-projection-consumer' — advances a per-scope _ConsumerCursor
//     atomically with its work; a boot-time reconcile sweep (wired in
//     application-runtime.mjs) replays any scope whose _Log outran its
//     cursor. blob.finalize, projected.async, effect.durable, email all share
//     this MECHANISM — but not the same idempotency property: blob.finalize's
//     underlying work (a filesystem rename) is provably safe to replay
//     (blob-store.mjs), so its replay is exactly-once in effect even though
//     the mechanism is at-least-once. email's underlying work (an external
//     transport call) is NOT provably idempotent — a replay after a crash
//     between a successful send and its cursor write can duplicate the send.
//     This is documented, honest, at-least-once (email-seam.mjs), not
//     exactly-once — the taxonomy names the recovery MECHANISM, not a promise
//     that every consumer's side effect is safe to repeat.
//   - 'live-delivery-consumer' — re-authorizes at delivery time; the CLIENT
//     (not a server-side cursor) owns the reconnect/replay decision. Folding
//     this into the cursor contract above would be a second recovery model
//     for the same problem (AGENTS.md's no-second-path rule) — it stays
//     separate on purpose. app.live.createConsumer.
//   - 'best-effort-external-consumer' — no cursor, no reconcile sweep at all:
//     a crash between COMMIT and this consumer running silently drops the
//     work with no replay. Honestly at-least-once is a claim this kind
//     CANNOT make; it is unknown-handoff. No shipped consumer is this kind
//     today (email moved to 'durable-projection-consumer' once it gained a
//     cursor) — kept in the closed set for a future seam that genuinely has
//     no recovery path, so classifying one honestly doesn't require growing
//     the enum under pressure.
//
// A fourth kind named by the Wave 5/6 design council but not represented in
// this array — 'clock-driven maintenance starter' (the blob and log-retention
// reapers) — is registered on app.clock directly (application-runtime.mjs),
// not as a post-commit consumer: it runs on a timer, not per committed batch.
export const POST_COMMIT_CONSUMER_KINDS = Object.freeze([
  'durable-projection-consumer',
  'live-delivery-consumer',
  'best-effort-external-consumer',
]);

function engagedPostCommitConsumerDescriptors(app, entities, { blobFinalizeConsumer, durableEffectsRegistry }) {
  return [
    { name: 'blob.finalize', kind: 'durable-projection-consumer', consumer: blobFinalizeConsumer },
    { name: 'live', kind: 'live-delivery-consumer', consumer: app.live?.createConsumer?.(app) },
    { name: 'projected.async', kind: 'durable-projection-consumer', consumer: createProjectedAsyncConsumer({ entities }) },
    { name: 'effect.durable', kind: 'durable-projection-consumer', consumer: createDurableEffectsConsumer({ durableEffectsRegistry, jobs: app.jobs }) },
    { name: 'email', kind: 'durable-projection-consumer', consumer: app._emailConsumer },
  ].filter((d) => Boolean(d.consumer));
}

export function buildKernel(app) {
  const { handlers, projections, entities } = collectAppEntities(app);
  const sessionEntity = entities.get(Session.name);
  if (sessionEntity && app._sessionSchedule) {
    Object.defineProperty(sessionEntity, 'schedule', {
      value: app._sessionSchedule,
      enumerable: true,
      configurable: true,
    });
  }
  for (const fe of FRAMEWORK_ENTITIES) {
    if (fe && !entities.has(fe.name)) {
      const bound = app.entity(fe);
      // Session timing is app configuration, so override only the declarative
      // schedule while retaining the app-bound query and mutation closures.
      const entity = bound;
      entities.set(entity.name, entity);
      Object.assign(handlers, entity.crudHandlers);
      projections.push(entity.projection);
    }
  }
  app.entities = entities;

  const effectsRegistry = buildEffects(entities);
  const durableEffectsRegistry = buildDurableEffectsRegistry([...entities.values()]);
  const { blobAdapter, blobFinalizeConsumer, blobColumns, reconcileBlobFinalize } = createBlobLifecycle({
    blobs: app.blobs,
    entities,
  });
  app.blobColumns = blobColumns;
  app.durableEffectsRegistry = durableEffectsRegistry;
  app.reconcileBlobFinalize = reconcileBlobFinalize;
  // emailSeam(...).install(app) (called by the app author before .listen(),
  // per email-seam.mjs's contract) stashes its reconcile sweep on app._... —
  // pick it up here alongside the other reconcile sweeps kernel already owns.
  // No-op default when the email seam was never installed.
  app.reconcileEmailDelivery = app._reconcileEmailDelivery ?? (async () => ({ delivered: 0 }));

  const postCommitConsumerDescriptors = engagedPostCommitConsumerDescriptors(app, entities, {
    blobFinalizeConsumer,
    durableEffectsRegistry,
  });
  app.postCommitConsumerDescriptors = postCommitConsumerDescriptors;

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
      postCommitConsumers: postCommitConsumerDescriptors.map((d) => d.consumer),
    }),
  });
}
