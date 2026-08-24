// Pure field-owned planner for v10 region.edit (scope#992 W1).
// Reads live family + complete affected closure, verifies basis/digests/IDs,
// captures delete-contribution provenance through the existing codec, then
// builds one v15 operated event via the shared postimage reducer. No DB writes.

import { canonicalTextOp } from './annotated-text.ts';
import type { Frontier } from './annotated-text.ts';
import {
  applyTextOperation,
  insertAnchorForOffset,
  materializeText,
  projectEndpointToOffset,
  textOperationForOffsetEdit,
  type ContinuousTextFamily,
} from './annotated-text-continuous.ts';
import {
  captureDeleteContribution,
  type AnnotationDeclarationShape,
  type DeleteFact,
  type StoredAnnotationImage,
} from './annotated-text-delete-history.ts';
import { parseRegionEditDescriptor, type RegionEditDescriptor } from './annotated-text-region-descriptor.ts';
import {
  sha256Utf8,
} from './annotated-text-region-limits.ts';
import { regionStaleError } from './annotated-text-region-limits.ts';
import {
  computeAffectedClosure,
  digestAffectedClosure,
  namedTransitionIds,
  reduceRegionPostimage,
  regionImageFromStored,
  type RegionAnnotationImage,
  type RegionDeclaration,
  type RegionPostimage,
} from './annotated-text-region-reducer.ts';

export type RegionTextOperations =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'delete'; operation: unknown }>
  | Readonly<{ kind: 'insert'; operation: unknown }>
  | Readonly<{ kind: 'replace'; operations: readonly [unknown, unknown] }>;

export type RegionPlan = Readonly<{
  descriptor: RegionEditDescriptor;
  before: Readonly<{ structuralRevision: number; frontier: Frontier }>;
  after: Readonly<{ structuralRevision: number; frontier: Frontier }>;
  afterFamily: ContinuousTextFamily;
  textOperations: RegionTextOperations;
  postimage: RegionPostimage;
  contribution: DeleteFact | null;
}>;

function sameFrontier(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actorIds(actor: string): { deleteActor: string; insertActor: string } {
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
}: {
  family: ContinuousTextFamily;
  from: number;
  to: number;
  replacement: string;
  actor: string;
  lamport: number;
}): { afterFamily: ContinuousTextFamily; textOperations: RegionTextOperations } {
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
    textOperations: Object.freeze({ kind: 'replace', operations: Object.freeze([deleteOperation, insertOperation]) as readonly [unknown, unknown] }),
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
}: {
  descriptor: unknown;
  family: ContinuousTextFamily;
  structureVersion: number;
  annotations: readonly (StoredAnnotationImage & { empty?: string; cardinality?: string })[];
  declarations: readonly RegionDeclaration[];
  actor: string;
  lamport: number;
}): RegionPlan {
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
  const images: RegionAnnotationImage[] = annotations.map((image) => (
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

  let contribution: DeleteFact | null = null;
  if (textOperations.kind !== 'none' && descriptor.from < descriptor.to) {
    contribution = captureDeleteContribution({
      documentId: descriptor.id,
      family,
      fromUtf16: descriptor.from,
      toUtf16: descriptor.to,
      annotations: annotations as StoredAnnotationImage[],
      declarations: declarations as AnnotationDeclarationShape[],
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
  });
}

function collectCoveredIds(
  closure: readonly RegionAnnotationImage[],
  family: ContinuousTextFamily,
  from: number,
  to: number,
): string[] {
  const ids: string[] = [];
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
