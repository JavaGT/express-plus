// Closed registered-action composition capability for `region.edit`
// (scope#992 W2 / Finding 4). A composed annotated-text action declares ONE
// annotated entity/field handle via `annotatedTextOperation(Entity, Entity.field)`.
// That handle is inert until `commitEvents` enters `coordinatedTxn` and calls the
// compiled field policy's `admitAndPlan(dbInTxn, descriptor, principal)`.
//
// The returned region descriptor is inert data. No public builder and no
// handler read can mark it admitted. Only the transaction-bound admission here,
// which re-reads the canonial family, affected closure, owning row/scope, and
// field grant, is the validation evidence. This closes the native-edit versus
// correction-apply race: whichever enters the coordinator first commits, and the
// second either validates against that current state or fails stale.

import { createHash } from 'node:crypto';
import { ValidationError } from './field-strategy.mjs';
import { authorizeFieldOp } from './strategy/index.mjs';
import { write } from './grant.mjs';
import { rawRow } from './entity/query.mjs';
import { resolveAnnotatedTextOwningScope, getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';
import { restoreTextFamilySerialized } from './annotated-text-continuous.mjs';
import { loadAnnotationImages } from './annotated-text-storage.mjs';
import { planRegionEdit,                 } from './annotated-text-region-plan.mjs';
import { constructV16RegionEvent } from './annotated-text-operated-event.mjs';

import { parseRegionEditDescriptor } from './annotated-text-region-descriptor.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  namedTransitionIds,
  regionImageFromStored,

} from './annotated-text-region-reducer.mjs';
import { materializeText, projectEndpointToOffset, textFamilyBasis } from './annotated-text-continuous.mjs';
import { sha256Utf8, regionStaleError } from './annotated-text-region-limits.mjs';










































































/**
 * Declare a closed annotated-text composition capability bound to one
 * entity/field handle. `Entity` carries the compiled `fields`; `field` is the
 * annotatedText field handle. Returns an inert handle used in a registered
 * action's `operations` declaration.
 */
export function annotatedTextOperation                                                          (
  Entity   ,
  field                       ,
)                               {
  const entityName = Entity?.name;
  const fieldName = field?.fieldName;
  const descriptor = Entity?.fields?.[fieldName];
  if (typeof entityName !== 'string' || entityName.length === 0 || typeof fieldName !== 'string' || fieldName.length === 0) {
    throw new Error('annotatedTextOperation requires an entity and an annotatedText field handle');
  }
  if (!descriptor || descriptor.kind !== 'annotatedText') {
    throw new Error(`annotatedTextOperation: '${entityName}.${fieldName}' is not an annotatedText field`);
  }
  const region = ((rawDescriptor         ) => parseRegionEditDescriptor(rawDescriptor))                                ;
  Object.defineProperty(region, 'build', {
    value: (db          , input                               ) => buildRegionEditDescriptor({
      handle: { entity: entityName, field: fieldName },
      entities: new Map([[entityName, Entity]]),
      db,
      input,
    }),
  });
  return Object.freeze({
    __brand: 'annotatedTextOperation',
    entity: entityName,
    field: fieldName,
    region: Object.freeze(region),
  });
}

function compiledDeclarationFor(handle                              , entities                          )                                                                      {
  const entity = entities.get(handle.entity);
  const descriptor = entity?.fields?.[handle.field];
  if (!entity || !descriptor || descriptor.kind !== 'annotatedText') {
    throw new Error(`annotatedTextOperation declaration '${handle.entity}.${handle.field}' is not a registered annotatedText field`);
  }
  const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!compiledMeta) throw new Error(`annotatedTextOperation declaration '${handle.entity}.${handle.field}' is not compiled`);
  return { descriptor, compiledMeta, fields: entity.fields };
}

function loadPlanContext(dbInTxn          , prefix        , documentId        , entity        , field        , compiledMeta     , descriptor     ) {
  const state = dbInTxn.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(documentId);
  if (!state) {
    throw new ValidationError(`${entity}.${field}.operation document does not exist`);
  }
  const family = restoreTextFamilySerialized(state.family_checkpoint);
  const annotations = loadAnnotationImages(dbInTxn, {
    prefix,
    documentId,
    declarations: compiledMeta.annotationHandles
      ? Object.values(compiledMeta.annotationHandles).map((meta     ) => ({ annotationName: meta.annotationName, fields: descriptor.annotations?.find((a     ) => a.annotationName === meta.annotationName)?.fields ?? {} }))
      : [],
  });
  // Declarations carry placeholder + authorization-policy source so the v16
  // fingerprint covers the full ratified declaration contract (Finding 4).
  const regionDeclarations = Object.values(compiledMeta.annotationHandles ?? {}).map((meta     ) => {
    const annConfig      = descriptor.annotations?.find((a     ) => a.annotationName === meta.annotationName);
    const isProtecting = typeof (annConfig?.protects ?? null) === 'string';
    const access = compiledMeta.protectingFamilies?.[meta.annotationName]?.access;
    return {
      annotationName: meta.annotationName,
      fields: annConfig?.fields ?? {},
      empty: annConfig?.empty ?? 'delete',
      cardinality: meta.cardinality ?? 'many',
      kind: 'annotation',
      protects: typeof annConfig?.protects === 'string' ? annConfig.protects : null,
      placeholder: typeof compiledMeta.protectingFamilies?.[meta.annotationName]?.placeholder === 'string'
        ? compiledMeta.protectingFamilies[meta.annotationName].placeholder
        : null,
      accessPolicySource: isProtecting
        ? (typeof access === 'function' ? Function.prototype.toString.call(access) : null)
        : null,
    };
  });
  const storedAsRegion = annotations.map((image) => ({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    prerequisites: image.prerequisites,
  }));
  const declarationByName = new Map(regionDeclarations.map((entry     ) => [entry.annotationName, entry]));
  const images = storedAsRegion.map((image) => regionImageFromStored(image, declarationByName.get(image.family)));
  return { state, family, annotations: storedAsRegion, images, regionDeclarations, structureVersion: state.structure_version };
}

function coveredAnnotationIds(
  closure                                  ,
  family                                                ,
  from        ,
  to        ,
)           {
  const ids           = [];
  for (const image of closure) {
    if (image.memberships.some((membership) => {
      const start = projectEndpointToOffset(family, membership.start);
      const end = projectEndpointToOffset(family, membership.end);
      return Math.min(end, to) - Math.max(start, from) > 0;
    })) ids.push(image.id);
  }
  return ids.sort();
}

function buildRegionEditDescriptor({
  handle,
  entities,
  db,
  input,
}




 )                       {
  const { descriptor, compiledMeta } = compiledDeclarationFor(handle                                , entities);
  const prefix = `${handle.entity}_${handle.field}`;
  const context = loadPlanContext(db, prefix, input.id, handle.entity, handle.field, compiledMeta, descriptor);
  const text = materializeText(context.family);
  if (input.expectedText !== undefined && input.expectedText !== text) {
    throw regionStaleError('region.edit reviewed wording no longer matches the live document');
  }
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to)
    || input.from < 0 || input.to < input.from || input.to > text.length) {
    throw regionStaleError('region.edit range is outside the live document');
  }
  const provisional = parseRegionEditDescriptor({
    version: 10,
    kind: 'region.edit',
    id: input.id,
    basis: textFamilyBasis(context.family),
    from: input.from,
    to: input.to,
    coveredTextDigest: '0'.repeat(64),
    affectedClosureDigest: '0'.repeat(64),
    expectedCoveredAnnotationIds: [],
    replacement: input.replacement,
    transitions: input.transitions,
  });
  const closure = computeAffectedClosure({
    annotations: context.images,
    family: context.family,
    from: input.from,
    to: input.to,
    namedIds: namedTransitionIds(provisional),
  });
  return parseRegionEditDescriptor({
    ...provisional,
    coveredTextDigest: sha256Utf8(text.slice(input.from, input.to)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredAnnotationIds(closure, context.family, input.from, input.to),
  });
}

/**
 * Compile a declared `annotatedTextOperation` handle into a transaction-bound
 * field policy at application assembly. Rejects a handle bound to an unknown
 * entity/field and binds the admission to the app's DB identity.
 */
export function compileRegionFieldPolicy(
  handle                              ,
  entities                          ,
  appDb         ,
)                            {
  const { descriptor, compiledMeta, fields } = compiledDeclarationFor(handle, entities);
  const prefix = `${handle.entity}_${handle.field}`;
  const fieldGrantCheck = write;

  return Object.freeze({
    entity: handle.entity,
    field: handle.field,
    handle,
    async admitAndPlan(
      dbInTxn          ,
      rawDescriptor         ,
      principalInput                                ,
      owners                                      ,
    ) {
      if (dbInTxn !== (appDb           )) {
        throw new Error('annotatedTextOperation policy bound to a foreign DB handle');
      }
      const principal = principalInput ?? { type: undefined, id: undefined };
      const regionDescriptor = parseRegionEditDescriptor(rawDescriptor);
      const documentId = regionDescriptor.id;
      const row = rawRow(dbInTxn       , handle.entity, documentId);
      if (!row) {
        throw new ValidationError(`${handle.entity}.${handle.field}.operation document does not exist`);
      }
      const documentScope = resolveAnnotatedTextOwningScope(descriptor, fields, row).key;
      if (owners.scope !== documentScope) {
        throw new ValidationError(`${handle.entity}.${handle.field}.operation requires document scope '${documentScope}'`);
      }
      // Mandatory in-transaction annotated field admission; the outer action
      // authorization never substitutes for field authorization.
      await authorizeFieldOp({ name: handle.entity, fields }       , handle.field, fieldGrantCheck                     , row, principal);
       const { family, annotations, regionDeclarations, structureVersion } = loadPlanContext(dbInTxn, prefix, documentId, handle.entity, handle.field, compiledMeta, descriptor);
      const actor = createHash('sha256')
        .update(`${handle.entity}\u0000${handle.field}\u0000${documentId}\u0000${principal?.id ?? ''}\u0000${owners.scope}`)
        .digest('hex').slice(0, 32);
      let maxLamport = 0;
      for (const element of Object.values(family.checkpoint.elements)) {
        if ((element                        ).lamport && (element                       ).lamport > maxLamport) maxLamport = (element                       ).lamport;
      }
      const plan = planRegionEdit({
        descriptor: regionDescriptor,
        family,
        structureVersion,
        annotations: annotations                                                                                            ,
        declarations: regionDeclarations,
        actor,
        lamport: maxLamport + 1,
      });
      // New region traffic emits ONLY v16 (W1b cutover). The returned nonce
      // capability is the single-use admission proof for committed-log's
      // append after the pipeline's deep copy strips the brand. The nonce is
      // bound to owning scope, entity, field, document, canonical bytes, and
      // the action id — so two distinct identical actions are both admitted,
      // while replay/reuse of one action's capability fails.
      const { event: envelope, capability } = constructV16RegionEvent(plan, {
        owningScope: documentScope,
        entity: handle.entity,
        field: handle.field,
        documentId,
        actionId: owners.actionId ?? '',
      });
      return Object.freeze({
        plan,
        envelope: envelope                                                ,
        v16Capability: capability,
        contribution: plan.contribution,
        entity: handle.entity,
        field: handle.field,
        documentId,
        owningScope: documentScope,
      });
    },
  });
}
