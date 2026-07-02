import { resolveStrategy } from './field-strategy.mjs';
import { mayVerb, hasOwnCanGrant } from './row-grant.mjs';
import { admitSystemMutation } from './schedule.mjs';
import { executeFrameworkDDL } from './ddl.mjs';
import { createServer, durableMutationVariant } from './pipeline.mjs';
import { buildEffectsRegistry, validateEffects } from './effect-compiler.mjs';
import { User, Session, Inbox } from './auth-entities.mjs';
import { getActiveDb, setActiveDb } from './db.mjs';
import { createWriteQueue } from './write-queue.mjs';

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

function buildBlobWiring(app, entities) {
  if (!app.blobs) return { blobAdapter: undefined, blobFinalizeConsumer: null };

  const blobFields = new Map();
  const blobColumns = [];
  for (const [name, ent] of entities) {
    const fields = [];
    for (const [fname, descriptor] of Object.entries(ent.fields ?? {})) {
      if (descriptor && descriptor.blob === true) fields.push(fname);
    }
    if (fields.length > 0) {
      blobFields.set(name, fields);
      for (const fName of fields) blobColumns.push({ table: name, column: fName });
    }
  }
  app.blobColumns = blobColumns;
  if (blobFields.size === 0) return { blobAdapter: undefined, blobFinalizeConsumer: null };

  const resolveBlobIds = (ev) => {
    const entityName = ev.handle?.brand === 'event-handle'
      ? ev.handle.entity
      : (() => { const dot = ev.type.indexOf('.'); return dot >= 0 ? ev.type.slice(0, dot) : ''; })();
    const fields = blobFields.get(entityName) ?? [];
    const ids = [];
    for (const fName of fields) {
      const value = ev.data?.[fName];
      if (value) ids.push(value);
    }
    return ids;
  };

  const blobAdapter = {
    async adoptInTxn(txnDb, events) {
      const blobIds = new Set();
      for (const ev of events) for (const id of resolveBlobIds(ev)) blobIds.add(id);
      for (const id of blobIds) app.blobs.adopt(txnDb, id);
    },
  };

  const blobFinalizeConsumer = async (events) => {
    const ids = new Set();
    for (const ev of events) for (const id of resolveBlobIds(ev)) ids.add(id);
    for (const id of ids) {
      try { app.blobs.finalize(id); } catch { /* reaper reconciles */ }
    }
  };

  return { blobAdapter, blobFinalizeConsumer };
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

function resolveTriggerTypes(desc, entityName) {
  if (!desc.from) return [`${entityName}.created`, `${entityName}.updated`];
  if (typeof desc.from === 'string') {
    const from = desc.from;
    return from.includes('.') ? [from] : [`${entityName}.${from}`];
  }
  return desc.from.map((f) => f.includes('.') ? f : `${entityName}.${f}`);
}

function buildProjectedAsyncConsumer(app) {
  return async (events, { db }) => {
    for (const ev of events) {
      const colon = ev.scope?.indexOf(':');
      if (colon < 0) continue;
      const entityName = ev.scope.slice(0, colon);
      const rowId = ev.scope.slice(colon + 1);
      const entityRecord = app.entities?.get(entityName);
      if (!entityRecord || !entityRecord.projectedAsyncFields?.length) continue;
      const triggered = [];
      for (const [fieldName, desc] of entityRecord.projectedAsyncFields) {
        const triggerTypes = resolveTriggerTypes(desc, entityName);
        if (triggerTypes.includes(ev.type)) triggered.push({ fieldName, compute: desc.compute });
      }
      if (triggered.length === 0) continue;
      const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = :id`).get({ id: rowId });
      if (!row) continue;
      const filteredRow = {};
      if (row.id !== undefined) filteredRow.id = row.id;
      for (const [k, v] of Object.entries(row)) {
        if (Object.prototype.hasOwnProperty.call(entityRecord.fields, k)) {
          const desc = entityRecord.fields[k];
          if (desc?.kind === 'value' || desc?.kind === 'projected') {
            try { filteredRow[k] = resolveStrategy(desc.kind).deserialize?.(v, desc) ?? v; } catch { filteredRow[k] = v; }
          } else {
            filteredRow[k] = v;
          }
        }
      }
      for (const { fieldName, compute } of triggered) {
        const prevDb = getActiveDb();
        setActiveDb(db);
        try {
          const result = await compute(filteredRow);
          const serialized = resolveStrategy('projected').serialize(result);
          db.prepare(`UPDATE ${entityName} SET ${fieldName} = :val WHERE id = :id`).run({
            val: serialized, id: rowId,
          });
          const cursorRow = db.prepare(
            'SELECT lastSeq FROM _ProjectedCursor WHERE entity = :e AND field = :f',
          ).get({ e: entityName, f: fieldName });
          const next = (cursorRow?.lastSeq ?? 0) + 1;
          db.prepare(
            'INSERT OR REPLACE INTO _ProjectedCursor (entity, field, lastSeq) VALUES (:e, :f, :s)',
          ).run({ e: entityName, f: fieldName, s: next });
        } catch {
          // compute failure leaves the projected column unchanged; cursor NOT advanced
        } finally {
          setActiveDb(prevDb);
        }
      }
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
      if (!hasOwnCanGrant(entity)) return true;
      const id = event?.data?.id;
      if (id == null) return false;
      let row = null;
      try {
        row = entity.findById(String(id), principal);
      } catch {
        row = null;
      }
      if (!row) return false;
      return mayVerb(entity, verb, row, principal);
    },
  };
}

export function buildKernel(app) {
  const { handlers, projections, entities } = collectAppEntities(app);
  app.entities = entities;
  if (app.db && typeof app.db.exec === 'function') executeFrameworkDDL(app.db);

  const effectsRegistry = buildEffects(entities);
  const { blobAdapter, blobFinalizeConsumer } = buildBlobWiring(app, entities);
  const postCommitConsumers = [
    blobFinalizeConsumer,
    buildLiveFanoutConsumer(app),
    buildProjectedAsyncConsumer(app),
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
