// Pure commit planning for annotated-text offset and annotation operations.
//
// Position tokens are issued against a family checkpoint frozen at issue time
// (`positionFamily`). The document's authoritative family is `family` (current
// checkpoint). Offset → endpoint resolution MUST use the position's family +
// that family's frontier; then re-project the endpoint onto the CURRENT family
// via projectEndpointToBlockOffset with basisFrontier replaced by
// family.checkpoint.frontier. Never trust client-supplied annotation bounds for
// boundary routing — only server-visible snapshot + membership presence.
//
// This planner does not write DB, mint authoring frames, or fold client ops.
// Live delivery remains snapshot-resync. One write authority stays the entity
// commit handler.

import {
  applyTextOperationToBlock, applyTextOperationToNewBlock, materializeBlock,
  projectEndpointToBlockOffset, removeEmptyBlock, resolvePositionToEndpoint,
  textFamilyCheckpoint, textOperationForOffsetEdit,
} from './annotated-text-family.mjs';
import { canonicalTextOp } from './annotated-text.mjs';
import { removeAnnotation } from './annotated-text-membership.mjs';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function positionOffset(family, position) {
  const endpoint = resolvePositionToEndpoint(
    position.positionFamily, position.blockId, position.offset,
    position.positionFamily.checkpoint.frontier, position.affinity,
  );
  return projectEndpointToBlockOffset(family, position.blockId, Object.freeze({
    ...endpoint, basisFrontier: family.checkpoint.frontier,
  }));
}

function before(family, structuralRevision) {
  return Object.freeze({ structuralRevision, frontier: family.checkpoint.frontier });
}

export function planTextOffsetEdit({ documentId, structureVersion, family, actor, lamport,
  visibleBlockIds, membershipBlockIds, sourceBlocks, mintBlockId, edit }) {
  const blockId = edit.kind === 'text.insert' ? edit.at.blockId : edit.from.blockId;
  const offset = positionOffset(family, edit.kind === 'text.insert' ? edit.at : edit.from);
  let toOffset;
  if (edit.kind !== 'text.insert') {
    if (edit.to.blockId !== blockId) { const error = new Error('replacement endpoints must be on the same block'); error.code = 'position-invalid'; throw error; }
    toOffset = positionOffset(family, edit.to);
  }

  if (edit.kind === 'text.insert' && (offset === 0 || offset === materializeBlock(family, blockId).length) && new Set(membershipBlockIds).has(blockId)) {
    const visibleIds = new Set(visibleBlockIds);
    const sourceIndex = family.blocks.findIndex((block) => block.id === blockId);
    const candidate = family.blocks[sourceIndex + (offset === 0 ? -1 : 1)];
    const destination = candidate && visibleIds.has(candidate.id) && materializeBlock(family, candidate.id).length > 0 && !new Set(membershipBlockIds).has(candidate.id) ? candidate : null;
    if (destination) {
      const destinationOffset = offset === 0 ? materializeBlock(family, destination.id).length : 0;
      const routedEdit = { kind: 'text.insert', at: { blockId: destination.id, offset: destinationOffset, affinity: offset === 0 ? 'left' : 'right' }, text: edit.text };
      const operation = textOperationForOffsetEdit(family, routedEdit, actor, lamport);
      const routedFamily = applyTextOperationToBlock(family, destination.id, operation);
      return deepFreeze({ version: 1, id: documentId, before: before(family, structureVersion), operation: { kind: 'text.apply', blockId: destination.id, operation }, after: { structuralRevision: structureVersion, frontier: routedFamily.checkpoint.frontier }, family: textFamilyCheckpoint(routedFamily) });
    }
    const newBlockId = mintBlockId();
    const side = offset === 0 ? 'before' : 'after';
    const destinationOffset = side === 'before' ? 0 : materializeBlock(family, blockId).length;
    const routedEdit = { kind: 'text.insert', at: { blockId, offset: destinationOffset, affinity: side === 'before' ? 'left' : 'right' }, text: edit.text };
    const operation = textOperationForOffsetEdit(family, routedEdit, actor, lamport);
    const nextFamily = applyTextOperationToNewBlock(family, blockId, newBlockId, operation, side);
    const source = sourceBlocks?.[blockId];
    if (!source) throw new Error('source block not found');
    return deepFreeze({ version: 9, id: documentId, before: before(family, structureVersion), operation: { kind: 'text.insert-block', sourceBlockId: blockId, blockId: newBlockId, side, operation }, after: { structuralRevision: structureVersion + 1, frontier: nextFamily.checkpoint.frontier }, family: textFamilyCheckpoint(nextFamily), block: { id: newBlockId, epoch: source.epoch, fields: source.fields }, memberships: [], measurements: [] });
  }

  const textEdit = edit.kind === 'text.insert'
    ? { kind: 'text.insert', at: { blockId, offset, affinity: edit.at.affinity }, text: edit.text }
    : { kind: 'text.delete', from: { blockId, offset, affinity: edit.from.affinity }, to: { blockId, offset: toOffset, affinity: edit.to.affinity } };
  if (edit.kind === 'text.replace') {
    const deleteOperation = textOperationForOffsetEdit(family, textEdit, `${actor.slice(0, 30)}d0`, lamport);
    const intermediate = applyTextOperationToBlock(family, blockId, deleteOperation);
    const start = resolvePositionToEndpoint(family, blockId, offset, family.checkpoint.frontier, edit.from.affinity).point[1];
    let insertOperation = ['workbench.text', 1, [`${actor.slice(0, 30)}e0`, 1], lamport + 1, intermediate.checkpoint.frontier, ['insert', start, edit.text]];
    insertOperation = canonicalTextOp(insertOperation);
    const nextFamily = applyTextOperationToBlock(intermediate, blockId, insertOperation);
    return deepFreeze({ version: 6, id: documentId, before: before(family, structureVersion), operation: { kind: 'text.replace', blockId, operations: [deleteOperation, insertOperation] }, after: { structuralRevision: structureVersion, frontier: nextFamily.checkpoint.frontier }, family: textFamilyCheckpoint(nextFamily) });
  }
  const operation = textOperationForOffsetEdit(family, textEdit, actor, lamport);
  let nextFamily = applyTextOperationToBlock(family, blockId, operation);
  // Empty unannotated blocks are split leftovers. Prune them with the delete that
  // emptied them so recipient snapshots do not keep hollow neighbors forever.
  // Annotated empties stay until annotation.remove (empty: orphan|delete).
  const membershipSet = new Set(membershipBlockIds);
  const prunedBlockIds = [];
  if (edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    for (const block of [...nextFamily.blocks]) {
      if (nextFamily.blocks.length === 1 || membershipSet.has(block.id) || materializeBlock(nextFamily, block.id).length !== 0) continue;
      nextFamily = removeEmptyBlock(nextFamily, block.id);
      prunedBlockIds.push(block.id);
    }
  }
  if (prunedBlockIds.length) {
    return deepFreeze({
      version: 12,
      id: documentId,
      before: before(family, structureVersion),
      operation: { kind: 'text.apply', blockId, operation },
      after: { structuralRevision: structureVersion + 1, frontier: nextFamily.checkpoint.frontier },
      family: textFamilyCheckpoint(nextFamily),
      prunedBlockIds: Object.freeze([...prunedBlockIds]),
    });
  }
  return deepFreeze({ version: 1, id: documentId, before: before(family, structureVersion), operation: { kind: 'text.apply', blockId, operation }, after: { structuralRevision: structureVersion, frontier: nextFamily.checkpoint.frontier }, family: textFamilyCheckpoint(nextFamily) });
}

export function planAnnotationApplyOffsets({ family, structureVersion, from, to, visibleBlockIds }) {
  const startOffset = positionOffset(family, from);
  const endOffset = positionOffset(family, to);
  const fromIndex = family.blocks.findIndex((block) => block.id === from.blockId);
  const toIndex = family.blocks.findIndex((block) => block.id === to.blockId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex || (fromIndex === toIndex && startOffset >= endOffset)) {
    const error = new Error('annotation selection must be a forward, non-empty range'); error.code = 'position-invalid'; throw error;
  }
  const visible = new Set(visibleBlockIds);
  if (family.blocks.slice(fromIndex, toIndex + 1).some((block) => !visible.has(block.id))) {
    const error = new Error('annotation selection crosses a restricted or hidden block'); error.code = 'position-no-longer-visible'; throw error;
  }
  const crossBlock = from.blockId !== to.blockId;
  const selection = crossBlock
    ? { blockId: from.blockId, startBlockId: from.blockId, endBlockId: to.blockId, startUtf16Offset: startOffset, endUtf16Offset: endOffset }
    : { blockId: from.blockId, startUtf16Offset: startOffset, endUtf16Offset: endOffset };
  return deepFreeze({ crossBlock, selection, expected: { structuralRevision: structureVersion, frontier: family.checkpoint.frontier } });
}

export function planAnnotationRemove({ documentId, structureVersion, family, annotationId, annotations, memberships, visibleBlockIds }) {
  const target = annotations.find((annotation) => annotation.id === annotationId);
  if (!target) throw new Error('annotation not found');
  const removedBlockIds = memberships.filter((membership) => membership.annotationId === annotationId).map((membership) => membership.blockId);
  if (!removedBlockIds.length || removedBlockIds.some((id) => !new Set(visibleBlockIds).has(id))) { const error = new Error('annotation is not fully visible'); error.code = 'position-no-longer-visible'; throw error; }
  const reduced = removeAnnotation(family, annotations, memberships, annotationId, { structuralRevision: structureVersion });
  const outcome = reduced.outcomes[0];
  const targets = new Map(annotations.map((annotation) => [annotation.id, annotation.protectedTargetIds ?? []]));
  const result = { memberships: { annotationId, postimage: [] }, disposition: outcome.type === 'delete' ? { kind: 'deleted', family: target.family, savedQuote: null, lastMemberships: null } : { kind: 'orphaned', family: target.family, savedQuote: outcome.savedQuote, lastMemberships: outcome.lastMemberships }, changedProtectors: reduced.annotations.filter((annotation) => JSON.stringify(annotation.protectedTargetIds ?? []) !== JSON.stringify(targets.get(annotation.id) ?? [])).map((annotation) => ({ annotationId: annotation.id, protectsPostimage: [...(annotation.protectedTargetIds ?? [])] })).sort((a, b) => a.annotationId.localeCompare(b.annotationId)) };
  let prunedFamily = family; const prunedBlockIds = []; const retained = new Set(reduced.memberships.map((membership) => membership.blockId));
  for (const block of family.blocks) { if (prunedFamily.blocks.length === 1 || retained.has(block.id) || materializeBlock(prunedFamily, block.id).length !== 0) continue; prunedFamily = removeEmptyBlock(prunedFamily, block.id); prunedBlockIds.push(block.id); }
  return deepFreeze({ version: prunedBlockIds.length ? 11 : 10, id: documentId, before: before(family, structureVersion), operation: { kind: 'annotation.remove', annotationId, blockIds: removedBlockIds }, after: { structuralRevision: structureVersion + (prunedBlockIds.length ? 1 : 0), frontier: family.checkpoint.frontier }, lifecycle: { empty: target.empty }, result, ...(prunedBlockIds.length ? { family: textFamilyCheckpoint(prunedFamily), prunedBlockIds } : {}) });
}
