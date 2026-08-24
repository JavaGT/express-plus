// Pure field-owned planner for v10 region.edit (scope#992 W1).
// Reads live family + complete affected closure, verifies basis/digests/IDs,
// captures delete-contribution provenance through the existing codec, then
// builds one complete bounded witness via the shared postimage reducer and
// proves it with assertCompleteRegionWitness BEFORE any commit. No DB writes.

import { canonicalTextOp } from './annotated-text.mjs';

import {
  applyTextOperation,
  insertAnchorForOffset,
  materializeText,
  projectEndpointToOffset,
  textOperationForOffsetEdit,

} from './annotated-text-continuous.mjs';
import {
  captureDeleteContribution,



} from './annotated-text-delete-history.mjs';
import { parseRegionEditDescriptor,                           } from './annotated-text-region-descriptor.mjs';
import {
  sha256Utf8,
} from './annotated-text-region-limits.mjs';
import { regionStaleError } from './annotated-text-region-limits.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  namedTransitionIds,
  reduceRegionPostimage,
  regionDeclarationFingerprint,
  assertCompleteRegionWitness,
  regionImageFromStored,



} from './annotated-text-region-reducer.mjs';



















function sameFrontier(left         , right         )          {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actorIds(actor        )                                               {
  const base = actor.slice(0, 30);
  return { deleteActor: `${base}d0`, insertActor: `${base}e0` };
}

function applyRegionText({
  family,
  from,
  to,
  replacement,
  actor,
  lamport,
}






 )                                                                              {
  const { deleteActor, insertActor } = actorIds(actor);
  const covered = materializeText(family).slice(from, to);
  if (replacement === covered) {
    return { afterFamily: family, textOperations: Object.freeze({ kind: 'none' }) };
  }
  if (from === to && replacement.length > 0) {
    const operation = textOperationForOffsetEdit(family, {
      kind: 'text.insert',
      at: { offset: from, affinity: 'right' },
      text: replacement,
    }, insertActor, lamport);
    return { afterFamily: applyTextOperation(family, operation), textOperations: Object.freeze({ kind: 'insert', operation }) };
  }
  if (from < to && replacement.length === 0) {
    const operation = textOperationForOffsetEdit(family, {
      kind: 'text.delete',
      from: { offset: from },
      to: { offset: to },
    }, deleteActor, lamport);
    return { afterFamily: applyTextOperation(family, operation), textOperations: Object.freeze({ kind: 'delete', operation }) };
  }
  const deleteOperation = textOperationForOffsetEdit(family, {
    kind: 'text.delete',
    from: { offset: from },
    to: { offset: to },
  }, deleteActor, lamport);
  const intermediate = applyTextOperation(family, deleteOperation);
  const anchor = from === 0 || materializeText(intermediate).length === 0
    ? ['root']
    : insertAnchorForOffset(intermediate, from);
  const insertOperation = canonicalTextOp(['workbench.text', 1, [insertActor, 1], lamport + 1, intermediate.checkpoint.frontier, ['insert', anchor, replacement]]);
  return {
    afterFamily: applyTextOperation(intermediate, insertOperation),
    textOperations: Object.freeze({ kind: 'replace', operations: Object.freeze([deleteOperation, insertOperation])                                }),
  };
}

export function planRegionEdit({
  descriptor: rawDescriptor,
  family,
  structureVersion,
  annotations,
  declarations,
  actor,
  lamport,
}







 )             {
  const descriptor = parseRegionEditDescriptor(rawDescriptor);
  const text = materializeText(family);
  if (descriptor.id !== family.id) throw regionStaleError('region.edit document id does not match the live family');
  if (descriptor.basis.id !== family.id || !sameFrontier(descriptor.basis.frontier, family.checkpoint.frontier)) {
    throw regionStaleError('region.edit family basis is stale');
  }
  if (descriptor.to > text.length) throw regionStaleError('region.edit range is outside the live document');
  const covered = text.slice(descriptor.from, descriptor.to);
  if (sha256Utf8(covered) !== descriptor.coveredTextDigest) {
    throw regionStaleError('region.edit covered text digest is stale');
  }

  const declarationByName = new Map(declarations.map((entry) => [entry.annotationName, entry]));
  const images                          = annotations.map((image) => (
    regionImageFromStored(image, declarationByName.get(image.family))
  ));
  const closure = computeAffectedClosure({
    annotations: images,
    family,
    from: descriptor.from,
    to: descriptor.to,
    namedIds: namedTransitionIds(descriptor),
  });
  if (digestAffectedClosure(closure) !== descriptor.affectedClosureDigest) {
    throw regionStaleError('region.edit affected closure digest is stale');
  }
  const liveCoveredIds = collectCoveredIds(closure, family, descriptor.from, descriptor.to);
  if (JSON.stringify(liveCoveredIds) !== JSON.stringify(descriptor.expectedCoveredAnnotationIds)) {
    throw regionStaleError('region.edit expected covered annotation ids are stale');
  }

  const { afterFamily, textOperations } = applyRegionText({
    family,
    from: descriptor.from,
    to: descriptor.to,
    replacement: descriptor.replacement,
    actor,
    lamport,
  });
  const postimage = reduceRegionPostimage({
    beforeFamily: family,
    afterFamily,
    beforeAnnotations: closure,
    region: { from: descriptor.from, to: descriptor.to },
    transitions: descriptor.transitions,
    declarations,
    expectedBeforeDigest: descriptor.affectedClosureDigest,
  });
  // One completeness predicate for planning and replay: overflow rejects the
  // action here BEFORE the compound commit; a valid witness proceeds.
  assertCompleteRegionWitness({
    postimage,
    liveAnnotations: images,
    family,
    from: descriptor.from,
    to: descriptor.to,
    namedIds: namedTransitionIds(descriptor),
  });
  const declarationFingerprint = regionDeclarationFingerprint(declarations);

  let contribution                    = null;
  if (textOperations.kind !== 'none' && descriptor.from < descriptor.to) {
    contribution = captureDeleteContribution({
      documentId: descriptor.id,
      family,
      fromUtf16: descriptor.from,
      toUtf16: descriptor.to,
      annotations: annotations                           ,
      declarations: declarations                                ,
    });
  }

  const frontierChanged = !sameFrontier(family.checkpoint.frontier, afterFamily.checkpoint.frontier);
  return Object.freeze({
    descriptor,
    before: Object.freeze({ structuralRevision: structureVersion, frontier: family.checkpoint.frontier }),
    after: Object.freeze({
      structuralRevision: structureVersion + (postimage.emptied.length || frontierChanged ? 1 : 0),
      frontier: afterFamily.checkpoint.frontier,
    }),
    afterFamily,
    textOperations,
    postimage,
    contribution,
    declarationFingerprint,
  });
}

function collectCoveredIds(
  closure                                  ,
  family                      ,
  from        ,
  to        ,
)           {
  const ids           = [];
  for (const image of closure) {
    for (const membership of image.memberships) {
      const start = projectEndpointToOffset(family, membership.start);
      const end = projectEndpointToOffset(family, membership.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) {
        ids.push(image.id);
        break;
      }
    }
  }
  return ids.sort();
}
