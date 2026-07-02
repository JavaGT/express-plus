import { mayRow } from './row-grant.mjs';
import { admitSystemMutation } from './schedule.mjs';
import { createServer, durableMutationVariant } from './pipeline.mjs';
import { buildEffectsRegistry, validateEffects } from './effect-compiler.mjs';
import { User, Session, Inbox } from './auth-entities.mjs';
import { createWriteQueue } from './write-queue.mjs';
import { createProjectedAsyncConsumer } from './projected-async.mjs';
import { createBlobLifecycle } from './blob-lifecycle.mjs';

// Framework auth entities are always-available effect targets (an app's effect
// may target Inbox without mounting it — auth entities are never request-facing
// routes). They must be present in the validation set so the admission handshake
// can resolve them + their `admitsEffects`.
const FRAMEWORK_ENTITIES = [User, Session, Inbox];

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

function buildLiveFanoutConsumer(app) {
  if (!app.live) return null;
  return async (events, { db }) => {
    for (const ev of events) {
      const colon = ev.scope.indexOf(':');
      if (colon < 0) continue;
      const entityName = ev.scope.slice(0, colon);
      const id = ev.scope.slice(colon + 1);
      const entity = app.entities?.get(entityName);
      let row;
      try {
        row = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(id);
      } catch {
        row = undefined;
      }
      app.live.emit(entity, id, row, ev);
    }
  };
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

export function buildKernel(app) {
  const { handlers, projections, entities } = collectAppEntities(app);
  app.entities = entities;

  const effectsRegistry = buildEffects(entities);
  const { blobAdapter, blobFinalizeConsumer, blobColumns } = createBlobLifecycle({
    blobs: app.blobs,
    entities,
  });
  app.blobColumns = blobColumns;
  const postCommitConsumers = [
    blobFinalizeConsumer,
    buildLiveFanoutConsumer(app),
    createProjectedAsyncConsumer({ entities }),
  ].filter(Boolean);

  app.writeQueue = createWriteQueue();

  return createServer({
    handlers,
    authorize: () => true,
    db: app.db,
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      admission: buildDurableAdmission(app),
      blobAdapter,
      effectsRegistry: effectsRegistry.size > 0 ? effectsRegistry : null,
      postCommitConsumers,
    }),
  });
}
