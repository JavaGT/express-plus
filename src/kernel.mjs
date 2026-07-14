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
// Kernel only assembles engaged seams — it does not implement fanout/latch.
// Live: app.live.createConsumer (singular Live Delivery seam) when engaged.
function engagedPostCommitConsumers(app, entities, { blobFinalizeConsumer, durableEffectsRegistry }) {
  return [
    blobFinalizeConsumer,
    app.live?.createConsumer?.(app),
    createProjectedAsyncConsumer({ entities }),
    createDurableEffectsConsumer({ durableEffectsRegistry, jobs: app.jobs }),
    app._emailConsumer,
  ].filter(Boolean);
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
