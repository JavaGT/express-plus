// Commit admission for v9 annotated-text offset edits, split by edit kind.
//
// The entity r1Handler closes over name/fieldName/prefix/descriptor/compiledMeta
// and the internal block/annotation handlers (splitHandler, r3/r4/r5). This
// module extracts the mega-handler body into a shared prelude plus per-kind
// admit functions so the kind-specific logic reads as a named whole. Behavior,
// public v9 wire, durable event meanings, and ValidationError codes/messages are
// unchanged from the previous single-handler body.
//
// This module does NOT write DB rows, mint authoring frames, or fold client ops.
// It only admits a validated `command` (the caller runs the payload assert) and
// returns the same event/plan structures the monolithic handler returned.

import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, deserializeField, resolveStrategy } from './field-strategy.mjs';
import * as eventHandles from './event-handle.mjs';
import { authorizeFieldOp } from './strategy/index.mjs';
import { write } from './grant.mjs';
import { restoreTextFamilyCheckpoint, materializeBlock, resolvePositionToEndpoint, projectEndpointToBlockOffset } from './annotated-text-family.mjs';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';
import { authoringRedactionsForRecipient } from './annotated-text-recipient-projection.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { resolveStream, resolveLease, resolvePosition, resolveGroup, issuePositionFrame, recordSplit } from './annotated-text-authoring-stream.mjs';
import { readSeq } from './committed-log.mjs';
import { planAnnotationApplyOffsets, planAnnotationRemove, planTextOffsetEdit } from './annotated-text-plan.mjs';
import { packOperatedFacts } from './annotated-text-operated-facts.mjs';

/** Resolve the authoring stream + lease for a v9 command. */
export function assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal }) {
  const stream = resolveStream({ db, prefix, streamToken: command.authoring.stream, documentId: command.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' });
  if (!stream) throw new ValidationError(`${name}.${fieldName}.operation authoring stream unavailable`, { code: 'authoring-stream-unavailable' });
  const lease = resolveLease({ db, prefix, leaseToken: command.authoring.lease, streamId: stream.id });
  if (!lease) throw new ValidationError(`${name}.${fieldName}.operation authoring lease unavailable`, { code: 'authoring-lease-unavailable' });
  return { stream, lease };
}

/** For block.merge edits, resolve both position tokens to rows. */
function editTokens(edit, db, prefix, leaseId) {
  if (edit.kind !== 'block.merge') return [];
  return [edit.leftPositionToken, edit.rightPositionToken].map((token) =>
    resolvePosition({ db, prefix, positionToken: token, leaseId }));
}

function frameRedactions(position, currentRecipient) {
  let redactions;
  try { redactions = JSON.parse(position.redactions ?? '[]'); } catch { redactions = null; }
  if (!Array.isArray(redactions) || redactions.some((entry) => !entry || !Number.isSafeInteger(entry.visibleStart) || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.visibleStart < 0 || entry.start < 0 || entry.end <= entry.start)) {
    throw new ValidationError('annotated-text authoring position redactions are invalid', { code: 'position-redacted' });
  }
  const block = currentRecipient.blocks.find((candidate) => candidate.kind === 'visible' && candidate.id === position.block_id);
  const current = authoringRedactionsForRecipient(currentRecipient, position.block_id);
  // A changed projection invalidates the frame rather than interpreting public
  // offsets against a possibly newly-denied canonical interval.
  if (!block || current.length !== redactions.length || current.some((entry, index) => entry.visibleStart !== redactions[index].visibleStart || entry.start !== redactions[index].start || entry.end !== redactions[index].end)) {
    throw new ValidationError('annotated-text authoring position redactions changed', { code: 'position-redacted' });
  }
  return redactions;
}

/**
 * Cross-cutting admission that every edit kind shares, exactly as the old
 * monolithic r1Handler v9 body ran it. Returns a context carrying everything the
 * per-kind admit functions need.
 */
async function assertV9AuthoringPrelude({ name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId }) {
  const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(command.id);
  if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const documentScope = resolveAnnotatedTextOwningScope(descriptor, record.fields, row).key;
  if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
  await authorizeFieldOp(record, fieldName, write, row, principal);
  const { stream, lease } = assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal });
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
  if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  const currentRecipient = await projectAnnotatedTextSnapshot({ db, entity: record, row, principal, fieldName, descriptor, mintBasis: false });
  const currentVisible = new Set(currentRecipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.id));
  const cursor = readSeq(db, documentScope) + 1;
  const primaryToken = command.edit.at?.positionToken ?? command.edit.from?.positionToken ?? command.edit.positionToken;
  const position = primaryToken ? resolvePosition({ db, prefix, positionToken: primaryToken, leaseId: lease.id }) : null;
  const groupAssignment = command.edit.kind === 'block-group.assignment.set' || command.edit.kind === 'block-group.assignment.clear';
  if (!groupAssignment && command.edit.kind !== 'block.merge' && command.edit.kind !== 'annotation.remove' && !position) throw new ValidationError(`${name}.${fieldName}.operation position token unavailable`, { code: 'position-token-unavailable' });
  if (position && (!position.visible_at_issue || !currentVisible.has(position.block_id))) throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
  const positionFamily = position ? restoreTextFamilyCheckpoint(JSON.parse(position.family_checkpoint)) : null;
  const mergePositions = editTokens(command.edit, db, prefix, lease.id);
  const edit = command.edit;
  const referencedBlocks = groupAssignment || edit.kind === 'annotation.remove' ? [] : edit.kind === 'text.insert' || edit.kind === 'block.split' ? [position.block_id]
    : edit.kind === 'text.delete' || edit.kind === 'text.replace' || edit.kind === 'annotation.apply' ? [position.block_id, edit.to?.positionToken ? resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id })?.block_id : null].filter(Boolean)
    : edit.kind === 'block.merge' ? mergePositions.map((p) => p?.block_id) : [position.block_id];
  if (referencedBlocks.some((blockId) => blockId && !currentVisible.has(blockId))) {
    throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
  }
  const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.authoring.mutationId}`).digest('hex').slice(0, 32);
  const lamport = Math.max(0, ...Object.values(family.checkpoint.elements).map((element) => element.lamport)) + 1;
  return Object.freeze({
    name, fieldName, prefix, descriptor, record, compiledMeta, command, row, db, scope, principal, actionId,
    documentScope, stream, lease, state, family, currentRecipient, currentVisible,
    cursor, position, positionFamily, mergePositions, actor, lamport, edit,
  });
}

/** text.insert | text.delete | text.replace */
function admitTextEdit(ctx) {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, currentVisible, position, positionFamily, actor, lamport, edit, descriptor, compiledMeta } = ctx;
  const blockId = position.block_id;
  const toPosition = edit.kind === 'text.insert' ? null : resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id });
  if (edit.kind !== 'text.insert' && !toPosition) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
  const sourceBlock = edit.kind === 'text.insert' ? db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(blockId) : null;
  const sourceFields = sourceBlock ? Object.fromEntries(Object.keys(descriptor.block ?? {}).map((field) => [field, deserializeField(descriptor.block[field], sourceBlock[field])])) : undefined;
  const membershipBlockIds = new Set();
  for (const block of family.blocks) if (db.prepare(`SELECT 1 FROM ${prefix}_membership WHERE block_id = ?`).get(block.id)) membershipBlockIds.add(block.id);
  const membershipRows = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
       FROM ${prefix}_membership AS membership
       JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
      WHERE annotation.document_id = ?
      ORDER BY membership.annotation_id, membership.ordinal`,
  ).all(command.id);
  const memberships = membershipRows.map((membership) => ({
    annotationId: membership.annotation_id, blockId: membership.block_id, ordinal: membership.ordinal,
    start: JSON.parse(membership.start_point), end: JSON.parse(membership.end_point),
  }));
  const targets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target
      WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
      ORDER BY annotation_id, target_annotation_id`,
  ).all(command.id);
  const targetsByAnnotation = new Map();
  for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const annotations = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(command.id).map((annotation) => {
    const metadata = compiledMeta.annotationHandles[annotation.family];
    if (!metadata) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family '${annotation.family}'`);
    return { id: annotation.id, family: annotation.family, empty: metadata.empty, protectedTargetIds: targetsByAnnotation.get(annotation.id) ?? [] };
  });
  const fromRedactions = frameRedactions(position, ctx.currentRecipient);
  const toRedactions = toPosition ? frameRedactions(toPosition, ctx.currentRecipient) : null;
  const plannerEdit = edit.kind === 'text.insert'
    ? { kind: edit.kind, text: edit.text, at: { blockId, offset: edit.at.offset, affinity: edit.at.affinity, positionFamily, redactions: fromRedactions } }
    : { kind: edit.kind, text: edit.text, from: { blockId, offset: edit.from.offset, affinity: edit.from.affinity, positionFamily, redactions: fromRedactions }, to: { blockId: toPosition.block_id, offset: edit.to.offset, affinity: edit.to.affinity, positionFamily: restoreTextFamilyCheckpoint(JSON.parse(toPosition.family_checkpoint)), redactions: toRedactions } };
  let plan;
  try {
    plan = planTextOffsetEdit({
      documentId: command.id, structureVersion: state.structure_version, family, actor, lamport,
      visibleBlockIds: currentVisible, membershipBlockIds, annotations, memberships,
      sourceBlocks: sourceBlock ? { [blockId]: { epoch: sourceBlock.epoch, fields: sourceFields } } : {},
      mintBlockId: randomUUID, edit: plannerEdit,
    });
  } catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`, error.code ? { code: error.code } : undefined); }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** block.split | block.merge | block.continue | block.split-and-assign */
function admitStructureEdit(ctx, deps) {
  const { name, fieldName, command, db, scope, prefix, documentScope, lease, family, state, position, positionFamily, mergePositions, cursor, actionId, edit } = ctx;
  const { splitHandler, r3Handler } = deps;
  if (edit.kind === 'block.merge') {
    const expected = Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier });
    if (mergePositions.length !== 2 || mergePositions.some((p) => !p)) throw new ValidationError(`${name}.${fieldName}.operation merge position token unavailable`, { code: 'position-token-unavailable' });
    return r3Handler({ payload: { version: 3, id: command.id, expected, operation: { kind: 'block.merge', leftBlockId: mergePositions[0].block_id, rightBlockId: mergePositions[1].block_id } }, db, scope });
  }
  let offset;
  try {
    const endpoint = resolvePositionToEndpoint(positionFamily, position.block_id, edit.at.offset, positionFamily.checkpoint.frontier, edit.at.affinity);
    offset = projectEndpointToBlockOffset(family, position.block_id, Object.freeze({ ...endpoint, basisFrontier: family.checkpoint.frontier }));
  } catch (error) {
    throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`);
  }
  if (edit.kind === 'block.continue' || edit.kind === 'block.split-and-assign') {
    if (offset <= 0 || offset >= materializeBlock(family, position.block_id).length) throw new ValidationError(`${name}.${fieldName}.operation position must be strictly internal`);
    const groupRow = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(position.block_id);
    if (!groupRow) throw new ValidationError(`${name}.${fieldName}.operation block group not found`);
    const splitResult = splitHandler({ payload: { version: 2, id: command.id, expected: { structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }, operation: { kind: 'block.split', blockId: position.block_id, utf16Offset: offset } }, db, scope, structural: { kind: edit.kind, groupId: groupRow.group_id, annotation: edit.annotation || null } });
    if (splitResult.length > 0) {
      const splitData = splitResult[0].data;
      const rightBlockId = splitData.operation.rightBlockId || (splitData.operation?.leftBlockId !== position.block_id ? splitData.operation.leftBlockId : null);
      if (rightBlockId) {
         const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: rightBlockId, fence: cursor, familyCheckpoint: splitData.family, visibleAtIssue: true });
         if (!frame || !recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: edit.temporaryBlock, authoritativeBlockId: rightBlockId, positionToken: frame.token, actionId, mutationId: command.authoring.mutationId, fence: cursor })) throw new ValidationError(`${name}.${fieldName}.operation authoring stream capacity exceeded`, { code: 'authoring-stream-capacity' });
      }
    }
    return splitResult;
  }
  const splitResult = splitHandler({ payload: { version: 2, id: command.id, expected: { structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }, operation: { kind: 'block.split', blockId: position.block_id, utf16Offset: offset } }, db, scope });
  if (splitResult.length > 0) {
    const splitData = splitResult[0].data;
    const rightBlockId = splitData.operation.rightBlockId;
    const frame = issuePositionFrame({ db, prefix, leaseId: lease.id, blockId: rightBlockId, fence: cursor, familyCheckpoint: splitData.family, visibleAtIssue: true });
    if (!frame || !recordSplit({ db, prefix, leaseId: lease.id, temporaryBlock: edit.temporaryBlock, authoritativeBlockId: rightBlockId, positionToken: frame.token, actionId, mutationId: command.authoring.mutationId, fence: cursor })) throw new ValidationError(`${name}.${fieldName}.operation authoring stream capacity exceeded`, { code: 'authoring-stream-capacity' });
  }
  return splitResult;
}

/** annotation.apply | annotation.detach | annotation.remove */
function admitAnnotationEdit(ctx, deps) {
  const { name, fieldName, command, db, scope, prefix, documentScope, lease, family, state, currentVisible, currentRecipient, edit, compiledMeta } = ctx;
  const { r4Handler, r5Handler } = deps;
  if (edit.kind === 'annotation.detach') {
    const expected = Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier });
    const detachPosition = resolvePosition({ db, prefix, positionToken: edit.positionToken, leaseId: lease.id });
    if (!detachPosition) throw new ValidationError(`${name}.${fieldName}.operation detach position token unavailable`, { code: 'position-token-unavailable' });
    return r5Handler({ payload: { version: 5, id: command.id, expected, operation: { kind: 'annotation.detach', annotationId: edit.annotationId, blockId: detachPosition.block_id } }, db, scope });
  }
  if (edit.kind === 'annotation.remove') {
     if (!currentRecipient.annotations.some((annotation) => annotation.id === edit.annotationId)) {
       throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
     }
     const sourceMemberships = db.prepare(
      `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
         FROM ${prefix}_membership AS membership
         JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
        WHERE annotation.document_id = ?
        ORDER BY membership.annotation_id, membership.ordinal`,
     ).all(command.id);
     const memberships = sourceMemberships.map((membership) => ({
       annotationId: membership.annotation_id, blockId: membership.block_id, ordinal: membership.ordinal,
       start: JSON.parse(membership.start_point), end: JSON.parse(membership.end_point),
     }));
     const removedBlockIds = memberships.filter((membership) => membership.annotationId === edit.annotationId).map((membership) => membership.blockId);
     if (!removedBlockIds.length || removedBlockIds.some((blockId) => !currentVisible.has(blockId))) {
       throw new ValidationError(`${name}.${fieldName}.operation annotation is not fully visible`, { code: 'position-no-longer-visible' });
     }
     const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(command.id);
     const targets = db.prepare(`SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?) ORDER BY annotation_id, target_annotation_id`).all(command.id);
     const targetsByAnnotation = new Map();
     for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
     const annotations = annotationRows.map((annotation) => ({
       id: annotation.id, family: annotation.family, empty: compiledMeta.annotationHandles[annotation.family]?.empty,
       protectedTargetIds: targetsByAnnotation.get(annotation.id) ?? [],
     }));
     const targetAnnotation = annotations.find((annotation) => annotation.id === edit.annotationId);
     if (!targetAnnotation || !targetAnnotation.empty) throw new ValidationError(`${name}.${fieldName}.operation annotation family is invalid`);
     let plan;
     try { plan = planAnnotationRemove({ documentId: command.id, structureVersion: state.structure_version, family, annotationId: edit.annotationId, annotations, memberships, visibleBlockIds: currentVisible }); }
     catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`, error.code ? { code: error.code } : undefined); }
     const handle = eventHandles.native(name, fieldName, 'operated');
     return [{ handle, type: handle.type, scope: documentScope, data: plan }];
  }
  const fromPos = resolvePosition({ db, prefix, positionToken: edit.from.positionToken, leaseId: lease.id });
  const toPos = resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id });
  if (!fromPos || !toPos) throw new ValidationError(`${name}.${fieldName}.operation annotation position token unavailable`, { code: 'position-token-unavailable' });
  const fromFamily = restoreTextFamilyCheckpoint(JSON.parse(fromPos.family_checkpoint));
  const toFamily = restoreTextFamilyCheckpoint(JSON.parse(toPos.family_checkpoint));
  let planned;
  try { planned = planAnnotationApplyOffsets({ family, structureVersion: state.structure_version, from: { blockId: fromPos.block_id, offset: edit.from.offset, affinity: edit.from.affinity, positionFamily: fromFamily }, to: { blockId: toPos.block_id, offset: edit.to.offset, affinity: edit.to.affinity, positionFamily: toFamily }, visibleBlockIds: currentRecipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.id) }); }
  catch (error) { throw new ValidationError(`${name}.${fieldName}.operation ${error.message}`, error.code ? { code: error.code } : undefined); }
  return r4Handler({ payload: { version: planned.crossBlock ? 7 : 4, id: command.id, expected: planned.expected, operation: { kind: 'annotation.apply', annotation: edit.annotation, selection: planned.selection } }, db, scope, principal: ctx.principal });
}

/** block-group.assignment.set | block-group.assignment.clear */
function admitGroupEdit(ctx) {
  const { name, fieldName, command, db, prefix, documentScope, family, state, currentVisible, edit, compiledMeta, descriptor } = ctx;
  const tokens = edit.selection.kind === 'one' ? [edit.selection.groupToken] : edit.selection.groupTokens;
  const frames = tokens.map((groupToken) => resolveGroup({ db, prefix, groupToken, leaseId: ctx.lease.id }));
  if (frames.some((frame) => !frame || !frame.assignable || !frame.group_id)) {
    throw new ValidationError(`${name}.${fieldName}.operation group token unavailable`, { code: 'position-token-unavailable' });
  }
  for (const frame of frames) {
    let visibleBlocks;
    try { visibleBlocks = JSON.parse(frame.visible_blocks); } catch { visibleBlocks = null; }
    if (!Array.isArray(visibleBlocks) || visibleBlocks.length === 0 || visibleBlocks.some((blockId) => typeof blockId !== 'string' || !currentVisible.has(blockId))) {
      throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
    }
  }
  const groupIds = frames.map((frame) => frame.group_id);
  if (new Set(groupIds).size !== groupIds.length) throw new ValidationError(`${name}.${fieldName}.operation selection is invalid`);
  const ordered = db.prepare(`SELECT block_group.group_id, MIN(block.position) AS position FROM ${prefix}_block_group AS block_group JOIN ${prefix}_block AS block ON block.id = block_group.block_id WHERE block.document_id = ? GROUP BY block_group.group_id ORDER BY position`).all(command.id);
  const rank = new Map(ordered.map((group, index) => [group.group_id, index]));
  if (groupIds.some((groupId) => !rank.has(groupId))) throw new ValidationError(`${name}.${fieldName}.operation group token unavailable`, { code: 'position-token-unavailable' });
  const canonicalGroupIds = [...groupIds].sort((left, right) => rank.get(left) - rank.get(right));
  if (edit.selection.kind === 'consecutive' && (groupIds.some((groupId, index) => index > 0 && rank.get(groupId) !== rank.get(groupIds[index - 1]) + 1) || canonicalGroupIds.some((groupId, index) => index > 0 && rank.get(groupId) !== rank.get(canonicalGroupIds[index - 1]) + 1))) {
    throw new ValidationError(`${name}.${fieldName}.operation consecutive selection is invalid`);
  }
  const familyName = edit.kind.endsWith('.set') ? edit.annotation.family : edit.family;
  const familyMeta = compiledMeta.annotationHandles[familyName];
  const familyDecl = descriptor.annotations.find((entry) => entry.annotationName === familyName);
  if (!familyMeta || !familyDecl || familyDecl.kind !== 'annotation' || familyMeta.appliesTo !== 'block-group' || familyMeta.cardinality !== 'one') {
    throw new ValidationError(`${name}.${fieldName}.operation annotation family is invalid`);
  }
  let annotation = null;
  if (edit.kind.endsWith('.set')) {
    annotation = edit.annotation;
    if (!annotation || Object.keys(annotation).sort().join() !== 'family,fields,id' || annotation.family !== familyName || typeof annotation.id !== 'string' || !annotation.id || db.prepare(`SELECT 1 FROM ${prefix}_annotation WHERE id = ?`).get(annotation.id) || JSON.stringify(Object.keys(annotation.fields ?? {}).sort()) !== JSON.stringify(Object.keys(familyDecl.fields).sort())) {
      throw new ValidationError(`${name}.${fieldName}.operation annotation must be fresh and valid`);
    }
    for (const [key, value] of Object.entries(annotation.fields)) {
      const valid = resolveStrategy(familyDecl.fields[key].kind).validate(value, familyDecl.fields[key]);
      if (valid !== true || (typeof familyDecl.fields[key].validate === 'function' && familyDecl.fields[key].validate(value) !== true)) throw new ValidationError(`${name}.${fieldName}.operation annotation field '${key}' is invalid`);
    }
  }
  const preimage = canonicalGroupIds.map((groupId) => Object.freeze({ groupId, annotationId: db.prepare(`SELECT annotation.id FROM ${prefix}_group_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE membership.group_id = ? AND annotation.document_id = ? AND annotation.family = ? LIMIT 1`).get(groupId, command.id, familyName)?.id ?? null }));
  const existing = db.prepare(`SELECT DISTINCT annotation.id FROM ${prefix}_group_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id WHERE membership.group_id IN (${canonicalGroupIds.map(() => '?').join(',')}) AND annotation.document_id = ? AND annotation.family = ?`).all(...canonicalGroupIds, command.id, familyName).map((row) => row.id);
  const selected = new Set(canonicalGroupIds);
  const removedAnnotationIds = existing.filter((id) => db.prepare(`SELECT group_id FROM ${prefix}_group_membership WHERE annotation_id = ? UNION SELECT '__block__' AS group_id FROM ${prefix}_membership WHERE annotation_id = ?`).all(id, id).every((membership) => membership.group_id !== '__block__' && selected.has(membership.group_id))).sort();
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: Object.freeze({
    version: 8, id: command.id,
    before: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
    operation: Object.freeze(edit.kind.endsWith('.set') ? { kind: edit.kind, groupIds: Object.freeze(canonicalGroupIds), annotation: Object.freeze(annotation) } : { kind: edit.kind, groupIds: Object.freeze(canonicalGroupIds), family: familyName }),
    after: Object.freeze({ structuralRevision: state.structure_version, frontier: family.checkpoint.frontier }),
    preimage: Object.freeze(preimage),
    postimage: Object.freeze(canonicalGroupIds.map((groupId) => Object.freeze({ groupId, annotationId: annotation?.id ?? null }))),
    removedAnnotationIds: Object.freeze(removedAnnotationIds),
  }) }];
}

// v13 is the one active durable representation. The public v9 authoring request
// remains deliberately unchanged; this boundary turns the temporary
// operation-specific facts produced by the admission helpers into one exact
// envelope before anything is appended to the committed log. v1–v12 are no
// longer replayed: the projection fails closed on any non-13 version.
function unifiedOperatedEvent(event) {
  const data = event.data;
  if (data.version === 13) return event;
  return Object.freeze({
    ...event,
    data: Object.freeze({
      version: 13,
      id: data.id,
      before: data.before,
      after: data.after,
      operation: data.operation,
      facts: packOperatedFacts(data),
    }),
  });
}

/**
 * Top entry for an already-validated v9 edit `command` (the caller runs
 * assertV9AnnotatedTextOffsetEditPayload first). Runs the shared prelude, then
 * dispatches by edit.kind to the per-kind admit function.
 */
export async function admitV9AnnotatedTextEdit({ name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId, handlers }) {
  const ctx = await assertV9AuthoringPrelude({ name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId });
  const edit = ctx.edit;
  let events;
  if (edit.kind === 'text.insert' || edit.kind === 'text.delete' || edit.kind === 'text.replace') events = admitTextEdit(ctx);
  else if (edit.kind === 'block.split' || edit.kind === 'block.merge' || edit.kind === 'block.continue' || edit.kind === 'block.split-and-assign') events = admitStructureEdit(ctx, handlers);
  else if (edit.kind === 'annotation.apply' || edit.kind === 'annotation.detach' || edit.kind === 'annotation.remove') events = admitAnnotationEdit(ctx, handlers);
  else if (edit.kind === 'block-group.assignment.set' || edit.kind === 'block-group.assignment.clear') events = admitGroupEdit(ctx);
  else throw new ValidationError(`${name}.${fieldName}.operation v9 edit kind not supported`);
  return events.map(unifiedOperatedEvent);
}
