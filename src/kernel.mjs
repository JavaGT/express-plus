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
    // Latch the hydrated authz row per scope within a commit batch: a batch may
    // carry several events for the same row (e.g. multiple side-table field
    // updates), and re-reading + re-hydrating via findById for each is wasted
    // work at 30–60Hz. The first event for a scope reads+hydrates; later events
    // in the same batch reuse it. A removed row is `undefined` and stays so.
    const rowLatch = new Map();
    for (const ev of events) {
      const colon = ev.scope.indexOf(':');
      if (colon < 0) continue;
      const entityName = ev.scope.slice(0, colon);
      const id = ev.scope.slice(colon + 1);
      const entity = app.entities?.get(entityName);
      const scope = ev.scope;
      let row = rowLatch.get(scope);
      if (row === undefined && !rowLatch.has(scope)) {
        try {
          const raw = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(id);
          row = raw ? entity?.hydrate?.(raw, null) ?? raw : undefined;
        } catch {
          row = undefined;
        }
        rowLatch.set(scope, row);
      }
      app.live.emit(entity, id, row, ev, { hydrated: row !== undefined && typeof entity?.hydrate === 'function' });
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
