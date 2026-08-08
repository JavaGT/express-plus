import { mayRow, mayFieldOp } from './row-grant.mjs';
import { CASCADE_PREAUTHORIZED } from './entity/removal-cascade.mjs';
import {
  admitSystemMutation,
  clearRemovedScheduleReceipts,
  rearmChangedScheduleReceipts,
} from './schedule-runtime.mjs';
import { createServer, durableMutationVariant } from './pipeline.mjs';
import { buildEffectsRegistry, validateEffects, executeEffectsForEvent } from './effect-compiler.mjs';
import { User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor } from './auth/entities.mjs';
import {
  admitInvitationAcceptance,
  admitInvitationCreation,
  isInvitationCreationAuthority,
} from './auth/invitation.mjs';
import { createProjectedAsyncConsumer } from './projected-async.mjs';
import { buildDurableEffectsRegistry, createDurableEffectsConsumer } from './durable-effects.mjs';
import { createBlobLifecycle } from './blob-lifecycle.mjs';
import { createOperationalConsumers } from './operational-consumer.mjs';
import { createWordEvidenceConsumers } from './word-evidence.mjs';
import { createPendingBlobLifecycle } from './pending-blob.mjs';
import { readSeq } from './committed-log.mjs';
import { CRUD_CURSOR_POLICY, assertV9AnnotatedTextOffsetEditPayload, ANNOTATED_TEXT_COMPENSATION } from './entity/crud.mjs';
import { EventKind } from './event-handle.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';
import { bindAuthorizedRows, isAuthorizedRows } from './action-authorization.mjs';
import { write } from './grant.mjs';
import { replayPrivateFactProjections } from './post-commit-effects.mjs';
import { txn } from './driver.mjs';
import { installRemovalCascades } from './entity/removal-cascade.mjs';
import { rawRow } from './entity/query.mjs';
import { readDeletedRowAnchor } from './deleted-row-anchor.mjs';

// Framework auth entities are always-available effect targets (an app's effect
// may target Inbox without mounting it — auth entities are never request-facing
// routes). They must be present in the validation set so the admission handshake
// can resolve them + their `admitsEffects`.
const FRAMEWORK_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];

function collectAppEntities(app     ) {
  const handlers                      = {};
  const projections        = [];
  const cursorPolicy = new Map();
  const entities                   = new Map(app.entities ?? []);
  for (const entity of entities.values()) {
    Object.assign(handlers, entity.crudHandlers);
    projections.push(...(entity.projections ?? [entity.projection]));
    // Generated handler policy is explicit metadata, never inferred from names.
    for (const [actionType, policy] of Object.entries(entity.crudHandlers?.[CRUD_CURSOR_POLICY] ?? {})) {
      cursorPolicy.set(actionType, policy);
    }
  }
  for (const declaration of app.actions ?? []) {
    if (!declaration || typeof declaration.type !== 'string' || declaration.type.length === 0) {
      throw new Error('registered action requires a non-empty type');
    }
    if (typeof declaration.authorize !== 'function') {
      throw new Error(`registered action '${declaration.type}' requires an authorize function`);
    }
    if (typeof declaration.handler !== 'function') {
      throw new Error(`registered action '${declaration.type}' requires a handler function`);
    }
    if (declaration.erasure !== undefined && declaration.erasure !== true
      && (!declaration.erasure || typeof declaration.erasure !== 'object'
        || Object.keys(declaration.erasure).some((key) => !['prepare', 'tables', 'readTables'].includes(key))
        || !Array.isArray(declaration.erasure.tables)
        || declaration.erasure.tables.some((table     ) => typeof table !== 'string' || table.length === 0)
        || (declaration.erasure.readTables !== undefined
          && (!Array.isArray(declaration.erasure.readTables)
            || declaration.erasure.readTables.some((table     ) => typeof table !== 'string' || table.length === 0)))
        || typeof declaration.erasure.prepare !== 'function')) {
      throw new Error(`registered action '${declaration.type}' has an invalid erasure preparation`);
    }
    if (declaration.erasure && declaration.history?.cursor !== 'excluded') {
      throw new Error(`erasure action '${declaration.type}' must exclude its history cursor`);
    }
    if (handlers[declaration.type]) throw new Error(`action '${declaration.type}' is already registered`);
    const handler = async (context     ) => {
      const lifecycle = app.pendingBlobLifecycle;
      const deletion = lifecycle?.fields.find((field     ) => field.purgeActionName === declaration.type);
      if (deletion && context.payload?.[deletion.field] !== undefined) {
        const blobRef = context.payload[deletion.field];
        const blobId = typeof blobRef === 'string' ? blobRef : blobRef?.blobId;
        await lifecycle.requestDeletion({
          blobId, actionName: declaration.type, actionId: context.actionId,
          scopeId: context.scope, resourceId: context.payload?.[deletion.resourceField],
        });
      }
      let handlerContext      = context;
      const claimedFields = [];
      if (lifecycle) {
        for (const field of lifecycle.fields) {
          if (field.actionName !== declaration.type) continue;
          const committedEventId = `${context.scope}:${readSeq(context.db, context.scope) + 1}`;
          const claimedBlob = await lifecycle.validateClaim({
            claim: context.payload[field.field], field: field.field, actionName: declaration.type,
            actionId: context.actionId, authenticatedPrincipal: context.principal,
            scopeId: context.scope, resourceId: context.payload[field.resourceField], committedEventId,
          });
          const { blobId } = claimedBlob;
          claimedFields.push({ field, blobId });
          handlerContext = {
            ...handlerContext,
            payload: { ...handlerContext.payload, [field.field]: blobId },
            claimedBlobs: Object.freeze({ ...(handlerContext.claimedBlobs ?? {}), [field.field]: claimedBlob }),
          };
        }
      }
      const result = await declaration.handler(handlerContext);
      const commit = Array.isArray(result) ? { events: result } : result;
      if (!commit || !Array.isArray(commit.events)) throw new Error(`registered action '${declaration.type}' must return an event array`);
      if (handlerContext.claimedBlobs) {
        const claimedBlobValues = Object.values(handlerContext.claimedBlobs);
        const forbiddenEventMetadata = claimedBlobValues.flatMap((blob     ) => [blob.sha256, blob.md5, blob.byteLength, blob.mediaType]).filter((value) => value !== null);
        const forbiddenPrivateMetadata = claimedBlobValues.flatMap((blob     ) => [blob.resourceId, blob.sha256, blob.md5, blob.byteLength, blob.mediaType]).filter((value) => value !== null);
        const attestationKeys = new Set(['resourceId', 'sha256', 'md5', 'byteLength', 'mediaType']);
        const containsAttestationMetadata = (value     , forbidden       , seen = new Set         ())          => {
          if (typeof value !== 'object' || value === null) return forbidden.some((candidate) => Object.is(candidate, value));
          if (seen.has(value)) return false;
          seen.add(value);
          if (Array.isArray(value)) return value.some((item) => containsAttestationMetadata(item, forbidden, seen));
          const keys = Object.keys(value);
          if (keys.includes('claimedBlobs') || keys.includes('resourceId') || keys.filter((key) => attestationKeys.has(key)).length > 1) return true;
          return Object.values(value).some((item) => containsAttestationMetadata(item, forbidden, seen));
        };
        if (containsAttestationMetadata(commit.events, forbiddenEventMetadata)
          || containsAttestationMetadata({ directive: commit.directive, privateFact: commit.privateFact, effects: commit.effects }, forbiddenPrivateMetadata)) {
          throw new Error(`declared blob action '${declaration.type}' cannot serialize claimed blob metadata`);
        }
      }
      if (!lifecycle) return Array.isArray(result) ? result : {
        events: commit.events,
        ...(commit.directive === undefined ? {} : { directive: commit.directive }),
        ...(commit.privateFact === undefined ? {} : { privateFact: commit.privateFact }),
        ...(commit.effects === undefined ? {} : { effects: commit.effects }),
      };
      for (const { field, blobId } of claimedFields) {
        const owningEvents = commit.events.filter((event     ) => event?.scope === context.scope && event.data && Object.prototype.hasOwnProperty.call(event.data, field.field));
        if (owningEvents.length !== 1) throw new Error(`declared blob action '${declaration.type}' must emit exactly one owning event field '${field.field}' in its dispatch scope`);
        if (owningEvents[0].data[field.field] !== blobId) throw new Error(`declared blob action '${declaration.type}' must emit its canonical blob id in field '${field.field}'`);
        for (const [metadataName, path] of Object.entries(field.canonicalEventMetadata ?? {})                        ) {
          let target = owningEvents[0].data;
          for (const part of path.slice(0, -1)) {
            if (!Object.prototype.hasOwnProperty.call(target, part) || typeof target[part] !== 'object' || target[part] === null || Array.isArray(target[part])) {
              throw new Error(`declared blob action '${declaration.type}' canonical metadata path '${path.join('.')}' must already have an object parent`);
            }
            target = target[part];
          }
          const leaf = path.at(-1);
          if (Object.prototype.hasOwnProperty.call(target, leaf)) {
            throw new Error(`declared blob action '${declaration.type}' handler cannot set canonical metadata path '${path.join('.')}'`);
          }
          target[leaf] = handlerContext.claimedBlobs[field.field][metadataName];
        }
      }
      return {
        events: commit.events,
        ...(claimedFields.length === 0 ? {} : { canonicalPayload: handlerContext.payload, claimedBlobs: handlerContext.claimedBlobs }),
        ...(commit.directive === undefined ? {} : { directive: commit.directive }),
        ...(commit.privateFact === undefined ? {} : { privateFact: commit.privateFact }),
        ...(commit.effects === undefined ? {} : { effects: commit.effects }),
      };
    };
    Object.defineProperty(handler, 'inTransaction', { value: true });
    Object.defineProperty(handler, 'batchForbidden', {
      value: (app._blobLifecycleOptions?.fields ?? []).some((field     ) => field.actionName === declaration.type),
    });
    Object.defineProperty(handler, 'erasureCapable', { value: Boolean(declaration.erasure) });
    Object.defineProperty(handler, 'erasurePrepare', {
      value: declaration.erasure === true ? undefined : declaration.erasure?.prepare,
    });
    Object.defineProperty(handler, 'erasurePreparationTables', {
      value: declaration.erasure && declaration.erasure !== true
        ? Object.freeze([...declaration.erasure.tables]) : Object.freeze([]),
    });
    Object.defineProperty(handler, 'erasurePreparationReadTables', {
      value: declaration.erasure && declaration.erasure !== true
        ? Object.freeze([...(declaration.erasure.readTables ?? [])]) : Object.freeze([]),
    });
    Object.defineProperty(handler, 'privateFactProjection', {
      value: declaration.projections?.some((projection     ) => projection?.privateFact === true) ?? false,
    });
    handlers[declaration.type] = handler;
    for (const projection of declaration.projections ?? []) {
      if (!Array.isArray(projection?.eventTypes) || typeof projection.apply !== 'function') {
        throw new Error(`registered action '${declaration.type}' has an invalid projection`);
      }
      if (projection.privateFact !== undefined && projection.privateFact !== true) {
        throw new Error(`registered action '${declaration.type}' projection privateFact must be true when present`);
      }
      // Retain the declaring action identity internally. Event names are not a
      // private-fact authority: two actions may emit the same event type, but a
      // projection may observe only its own action's private canonical fact.
      projections.push(Object.freeze({ ...projection, actionType: declaration.type }));
    }
    // Registered action cursor policy from declaration metadata
    // Closed keys: only 'cursor' is valid on the history object
    const historyMeta = declaration.history;
    if (historyMeta !== undefined) {
      if (typeof historyMeta !== 'object' || historyMeta === null) {
        throw new Error(`registered action '${declaration.type}' history must be an object`);
      }
      const unknownKeys = Object.keys(historyMeta).filter((k) => k !== 'cursor');
      if (unknownKeys.length > 0) {
        throw new Error(`registered action '${declaration.type}' history has unknown keys '${unknownKeys.join(', ')}'`);
      }
      const policy = historyMeta.cursor;
      if (policy !== undefined) {
        if (policy !== 'eligible' && policy !== 'excluded') {
          throw new Error(`registered action '${declaration.type}' has invalid history.cursor '${policy}'`);
        }
        cursorPolicy.set(declaration.type, policy);
      }
    }
  }
  return { handlers, projections, entities, cursorPolicy };
}

function buildEffects(entities                  ) {
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

function buildDurableAdmission(app     ) {
  const registeredEventTypes = new Set(
    (app.actions ?? []).flatMap((action     ) =>
      (action.projections ?? []).flatMap((projection     ) => projection.eventTypes ?? [])),
  );
  function admissionRowId(event     ) {
    // Native field events are scoped to their parent row as `owner`; lifecycle
    // events use their entity row `id` (and may independently declare an owner
    // field). The parsed handle is the authoritative discriminator.
    return event?.handle?.kind === EventKind.native
      ? event.data?.owner ?? event.data?.id
      : event?.data?.id;
  }
  async function admitsExistingRow({ entityName, verb, principal, event }     ) {
    const entity = app.entities?.get(entityName);
    if (!entity) return false;
    const id = admissionRowId(event);
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
  async function admitsAnnotatedProject({ entityName, verb, principal, event }     ) {
    const entity = app.entities?.get(entityName);
    const descriptor = entity && Object.values(entity.fields).find((field     ) => field.kind === 'annotatedText');
    if (!descriptor) return true;
    const project = tryParseScopeKey(event?.scope);
    const projectEntity = project && app.entities?.get(project.entity);
    // Declarations may target an externally-owned project table. When that
    // declaration is registered, it is the package authorization boundary.
    if (!projectEntity) return true;
    let row = null;
    try { row = projectEntity.findById(project.id, principal); } catch { row = null; }
    return !!row && mayRow(projectEntity, verb, row, principal);
  }

  return {
    async beforeProjection({ entityName, verb, principal, event, payload, db: hookDb, now }     ) {
      if (registeredEventTypes.has(event?.type)) return true;
      if (event?.[CASCADE_PREAUTHORIZED]) return true;
      if (admitInvitationAcceptance({ event, principal })) return true;
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
          rowId: admissionRowId(event),
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
      if (verb === 'update' || verb === 'remove') {
        const granted = await admitsExistingRow({ entityName, verb, principal, event })
          && await admitsAnnotatedProject({ entityName, verb, principal, event });
        if (granted) {
          rearmChangedScheduleReceipts({
            entity: app.entities?.get(entityName),
            event,
            principal,
            db: hookDb ?? app.db,
          });
        }
        return granted;
      }
      return admitsAnnotatedProject({ entityName, verb, principal, event });
    },
    async afterProjection({ entityName, verb, principal, event, db: hookDb }     ) {
      if (registeredEventTypes.has(event?.type)) return true;
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
      if (verb !== 'create') return admitsAnnotatedProject({ entityName, verb, principal, event });
      return (await admitsExistingRow({ entityName, verb, principal, event }))
        && await admitsAnnotatedProject({ entityName, verb, principal, event });
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

function engagedPostCommitConsumerDescriptors(app     , entities     , { blobFinalizeConsumer, pendingBlobConsumer, durableEffectsRegistry, operationalConsumer }     ) {
  return [
    { name: 'blob.finalize', kind: 'durable-projection-consumer', consumer: blobFinalizeConsumer },
    { name: 'pending-blob.finalize', kind: 'durable-projection-consumer', consumer: pendingBlobConsumer },
    { name: 'live', kind: 'live-delivery-consumer', consumer: app._applicationLiveDelivery?.consumer ?? app.live?.createConsumer?.(app) },
    { name: 'projected.async', kind: 'durable-projection-consumer', consumer: createProjectedAsyncConsumer({ entities }) },
    { name: 'effect.durable', kind: 'durable-projection-consumer', consumer: createDurableEffectsConsumer({ durableEffectsRegistry, jobs: app.jobs }) },
    { name: 'email', kind: 'durable-projection-consumer', consumer: app._emailConsumer },
    { name: 'operational', kind: 'durable-projection-consumer', consumer: operationalConsumer },
  ].filter((d) => Boolean(d.consumer));
}

export function buildKernel(app     ) {
  const { handlers, projections, entities, cursorPolicy } = collectAppEntities(app);
  const generatedHistoryActions                      = {};
  for (const entity of entities.values()) {
    if (entity.historyActionRule) generatedHistoryActions[`${entity.name}.update`] = entity.historyActionRule;
    if (entity.createHistoryActionRule) generatedHistoryActions[`${entity.name}.create`] = entity.createHistoryActionRule;
  }
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
  installRemovalCascades(entities);
  app.entities = entities;

  const effectsRegistry = buildEffects(entities);
  const durableEffectsRegistry = buildDurableEffectsRegistry([...entities.values()]);
  const { blobAdapter, blobFinalizeConsumer, blobColumns, reconcileBlobFinalize } = createBlobLifecycle({
    blobs: app.blobs,
    entities,
  });
  app.blobColumns = blobColumns;
  if (app._blobLifecycleOptions) app.pendingBlobLifecycle = createPendingBlobLifecycle(app, app._blobLifecycleOptions);
  app.durableEffectsRegistry = durableEffectsRegistry;
  app.reconcileBlobFinalize = reconcileBlobFinalize;
  // emailSeam(...).install(app) (called by the app author before .listen(),
  // per email-seam.mjs's contract) stashes its reconcile sweep on app._... —
  // pick it up here alongside the other reconcile sweeps kernel already owns.
  // No-op default when the email seam was never installed.
  app.reconcileEmailDelivery = app._reconcileEmailDelivery ?? (async () => ({ delivered: 0 }));
  const wordEvidenceConsumers = createWordEvidenceConsumers({ db: app.db, entities });
  const operational = createOperationalConsumers([...app.operationalConsumers, ...wordEvidenceConsumers]       , {
    writeQueue: app.writeQueue,
    onShutdown: app.onShutdown,
  }       );
  operational.engage(app.db);
  app.reconcileOperationalConsumers = () => operational.reconcile(app.db);

  const postCommitConsumerDescriptors = engagedPostCommitConsumerDescriptors(app, entities, {
    blobFinalizeConsumer,
    pendingBlobConsumer: app.pendingBlobLifecycle?.consumer,
    durableEffectsRegistry,
    operationalConsumer: operational.declared.length ? operational.consumer : null,
  });
  app.postCommitConsumerDescriptors = postCommitConsumerDescriptors;
  const privateFactProjections = projections.filter((projection) => projection.privateFact === true && projection.replay !== false);
  app.replayPrivateFactProjections = () => app.writeQueue.run(
    () => txn(app.db, () => replayPrivateFactProjections(app.db, privateFactProjections)),
  );

  const registeredActions = new Map             ((app.actions ?? []).map((action     ) => [action.type, action]));
  const annotatedEntities = new Set(
    [...entities.values()]
      .filter((entity     ) => Object.values(entity.fields).some((field     ) => field.kind === 'annotatedText'))
      .map((entity     ) => entity.name),
  );
  const annotatedActionTypes = new Set(
    [...entities.values()].flatMap((entity     ) => Object.entries(entity.fields)
      .filter(([, field]) => (field       ).kind === 'annotatedText')
      .map(([field]) => `${entity.name}.${field}.operation`)),
  );
  const annotatedActionDetails = new Map();
  for (const entity of entities.values()) for (const [fieldName, field] of Object.entries(entity.fields)) {
    if ((field       ).kind !== 'annotatedText') continue;
    annotatedActionDetails.set(`${entity.name}.${fieldName}.operation`, { entity, fieldName, field });
    annotatedActionDetails.set(`${entity.name}.${fieldName}.compensate`, { entity, fieldName, field, compensation: true });
  }
   const isAnnotatedHistoryAction = ({ type, payload }     ) => {
    const detail = annotatedActionDetails.get(type);
    if (!detail || detail.compensation) return false;
     try { const command = assertV9AnnotatedTextOffsetEditPayload(detail.entity.name, detail.fieldName, payload); return command.edit.kind === 'text.insert' && command.edit.text.length > 0; } catch { return false; }
  };
    const isContribution = (fact     , documentId     ) => fact?.version === 2 && fact.kind === 'annotated-text.contribution'
      && fact.documentId === documentId && fact.contribution?.kind === 'text.insert'
      && (!Object.hasOwn(fact.contribution, 'blockId') || (typeof fact.contribution.blockId === 'string' && fact.contribution.blockId.length > 0))
      && Array.isArray(fact.contribution.opId)
      && typeof fact.contribution.text === 'string' && Number.isSafeInteger(fact.contribution.scalarCount);
    const isAnnotatedHistoryFact = ({ type, payload, fact }     ) => {
      const detail = annotatedActionDetails.get(type);
      return Boolean(detail && isAnnotatedHistoryAction({ type, payload }) && isContribution(fact, payload.id));
    };
  // Annotated text history is a package-owned compensation action. It is not a
  // public action and is admitted only through the trusted history capability.
  for (const type of annotatedActionTypes) {
    generatedHistoryActions[type] = {
      inverse: ({ origin, target, targetFact }     ) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'undo' } }, input: { kind: ANNOTATED_TEXT_COMPENSATION, targetFact } }),
      redo: ({ origin, target, targetFact }     ) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'redo' } }, input: { kind: ANNOTATED_TEXT_COMPENSATION, targetFact } }),
    };
  }

  // Generated CRUD is authorized by row admission. Registered actions own an
  // explicit authorization function which runs at both durable auth gates.
  return createServer({
    handlers,
    authorize: async (context) => {
      const annotated = annotatedActionDetails.get(context.type);
      if (annotated) {
        const id = context.payload?.id;
        if (typeof id !== 'string' || id.length === 0) return false;
        const row = rawRow(app.db, annotated.entity.name, id);
        return Boolean(row && await mayFieldOp(annotated.entity, annotated.fieldName, write, annotated.entity.deserializeRow({ ...row }), context.principal));
      }
      const declaration = registeredActions.get(context.type);
      if (!declaration) {
        const [entityName, verb] = String(context.type).split('.');
        const entity = (verb === 'update' || verb === 'create') ? app.entities?.get(entityName) : null;
        if (!entity || (verb === 'update' && !entity.conditionalHistory) || (verb === 'create' && !entity.conditionalCreateHistory)) return true;
        const id = context.payload?.id;
        if (typeof id !== 'string' || id.length === 0) return false;
        const stored = rawRow(app.db, entity.name, id)
          ?? (verb === 'create' ? readDeletedRowAnchor(app.db, entity.name, id) : null);
        // Initial creates have no row (or deletion anchor) to authorize yet;
        // normal lifecycle admission remains their authority. A history move
        // always has either the live row or its deletion anchor to check.
        if (!stored) return verb === 'create';
        const row = entity.deserializeRow({ ...stored });
        return mayRow(entity, verb === 'create' ? 'remove' : 'update', row, context.principal);
      }
      const authorize = isAuthorizedRows(declaration.authorize)
        ? bindAuthorizedRows(declaration.authorize, app)
        : declaration.authorize;
      return authorize({ ...context, db: app.db });
    },
    db: app.db,
    history: app._history,
    historyActions: generatedHistoryActions,
    cursorPolicy,
     annotatedHistory: Object.freeze({ entities: annotatedEntities, actionTypes: annotatedActionTypes, moveActionTypes: new Set([...annotatedActionDetails].filter(([, detail]) => detail).map(([type]) => type)), isEligibleAction: isAnnotatedHistoryAction, isCanonicalFact: isAnnotatedHistoryFact }),
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      admission: buildDurableAdmission(app),
      blobAdapter: blobAdapter       ,
      effectsRegistry: effectsRegistry.size > 0 ? effectsRegistry : null,
      executeEffectsForEvent,
      postCommitConsumers: postCommitConsumerDescriptors.map((d) => d.consumer),
    }),
  });
}
