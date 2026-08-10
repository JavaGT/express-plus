// Commit admission for annotated-text operations (issue #33 blockless).
//
// One continuous RGA text per document; annotations are document-scoped
// ranges; authoring positions are document-scoped frames carrying an absolute
// UTF-16 offset basis. This module does NOT write DB rows, mint authoring
// frames, or fold client ops — it admits a validated v9 command and returns the
// blockless operated event/plan.

import { createHash } from 'node:crypto';
import { ValidationError,                      } from './field-strategy.mjs';
import * as eventHandles from './event-handle.mjs';
import { authorizeFieldOp } from './strategy/index.mjs';
import { write } from './grant.mjs';
import { restoreTextFamily, materializeText,                           } from './annotated-text-continuous.mjs';
import { resolveAnnotatedTextOwningScope } from './annotated-text-field.mjs';
import { resolveStream, resolveLease, resolvePosition } from './annotated-text-authoring-stream.mjs';
import { readSeq } from './committed-log.mjs';
import { planAnnotationRemove, planTextOffsetEdit, planTextRangeApply } from './annotated-text-plan.mjs';
import { mapVisibleOffsetToCanonical, authoringRedactionsForRecipient,                         } from './annotated-text-recipient-projection.mjs';
import { projectAnnotatedTextSnapshot } from './annotated-text-snapshot.mjs';
                                                                     
                                                
import { rawRow } from './entity/query.mjs';

                     
                                               
                               
                                 
 

                    
                                  
                             
 

                         
                        
                 
                             
 

                        
             
                 
                                   
                                         
 

// The v9 edit is validated (shape-checked) before this module runs; the loose
// shape below reflects only the fields this admission reads, across every
// supported and rejected edit kind.
                       
               
                     
                       
                     
                
                         
                        
                            
 

                     
             
             
                                                                               
                    
 

                            
               
                              
 

                           
             
 

                          
             
 

                             
                           
                            
                             
 

                          
               
                    
                 
                              
                           
                    
                     
               
                
                                          
                   
                     
 

                                            
           
                        
                          
                        
             
                               
                 
                                     
                
                  
 

                            
             
                 
                             
                               
 

                       
                       
                            
                          
 

                            
                           
                           
                      
                    
 

/** Resolve the authoring stream + lease for a v9 command. */
export function assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal }   
               
                    
                 
                     
               
                                          
 )                                                     {
  const stream = resolveStream({ db, prefix, streamToken: command.authoring.stream, documentId: command.id, principalType: principal?.type ?? 'principal', principalId: principal?.id ?? '' })                          ;
  if (!stream) throw new ValidationError(`${name}.${fieldName}.operation authoring stream unavailable`, { code: 'authoring-stream-unavailable' });
  const lease = resolveLease({ db, prefix, leaseToken: command.authoring.lease, streamId: stream.id })                         ;
  if (!lease) throw new ValidationError(`${name}.${fieldName}.operation authoring lease unavailable`, { code: 'authoring-lease-unavailable' });
  return { stream, lease };
}

function loadAnnotations({ db, prefix, compiledMeta, documentId }   
               
                 
                    
                     
 )                     {
  const rows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(documentId);
  const targets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target
      WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
      ORDER BY annotation_id, target_annotation_id`,
  ).all(documentId);
  const targetsByAnnotation = new Map();
  for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const annotations                     = [];
  for (const row of rows) {
    const metadata = compiledMeta.annotationHandles[row.family];
    if (!metadata) throw new ValidationError(`annotated-text unknown annotation family '${row.family}'`);
    annotations.push({ id: row.id, family: row.family, empty: metadata.empty, protectedTargetIds: targetsByAnnotation.get(row.id) ?? [] });
  }
  return annotations;
}

function loadRanges({ db, prefix, documentId }   
               
                 
                     
 )                {
  const rows = db.prepare(`SELECT annotation_id, start_point, end_point FROM ${prefix}_membership WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`).all(documentId);
  return rows.map((row) => ({
    annotationId: row.annotation_id,
    start: JSON.parse(row.start_point),
    end: JSON.parse(row.end_point),
  }));
}

/** Cross-cutting admission shared by every edit kind. */
async function assertV9AuthoringPrelude(ctx                )                     {
  const { name, fieldName, prefix, descriptor, record, compiledMeta, command, db, scope, principal, actionId } = ctx;
  const row = rawRow(db, name, command.id);
  if (!row) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const documentScope = resolveAnnotatedTextOwningScope(descriptor, record.fields, row).key;
  if (scope !== documentScope) throw new ValidationError(`${name}.${fieldName}.operation requires document scope '${documentScope}'`);
  await authorizeFieldOp(record, fieldName, write                     , row, principal);
  const { stream, lease } = assertV9AuthoringBinding({ name, fieldName, prefix, command, db, principal });
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(command.id);
  if (!state) throw new ValidationError(`${name}.${fieldName}.operation document does not exist`);
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  const cursor = readSeq(db, documentScope) + 1;
  const token = command.edit?.at?.positionToken ?? command.edit?.from?.positionToken ?? command.edit?.to?.positionToken ?? command.edit?.positionToken;
  const position = token
    ? resolvePosition({ db, prefix, positionToken: token, leaseId: lease.id })                                       
    : null;
  if (token && !position) throw new ValidationError(`${name}.${fieldName}.operation position token unavailable`, { code: 'position-token-unavailable' });
  if (position && !position.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation position no longer visible`, { code: 'position-no-longer-visible' });
  if (position) {
    // Fail closed on a stale authoring basis: the client's absolute offset is
    // meaningful only against the family its position frame was issued for. If
    // the current family frontier differs, the offset can land somewhere else;
    // require the client to re-bootstrap instead of trusting the offset.
    const positionFamily = restoreTextFamily(JSON.parse(position.family_checkpoint));
    if (JSON.stringify(positionFamily.checkpoint.frontier) !== JSON.stringify(family.checkpoint.frontier)) {
      throw new ValidationError(`${name}.${fieldName}.operation authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
    }
    // A protection applied WITHOUT a text change leaves the family frontier
    // untouched, so the family check above cannot see it. The frame's
    // redactions column carries the principal's wire→canonical basis at issue
    // time; recompute the CURRENT basis through the principal's own recipient
    // view and fail closed when the deny set moved under the frame.
    assertRedactionsBasesMatch(await currentAuthoringRedactions(ctx, row), parsedRedactions(position), 'position');
  }
  const actor = createHash('sha256').update(`${name}\u0000${fieldName}\u0000${command.id}\u0000${principal?.id ?? ''}\u0000${command.authoring.mutationId}`).digest('hex').slice(0, 32);
  const lamport = Math.max(0, ...Object.values(family.checkpoint.elements).map((element) => element.lamport)) + 1;
  return Object.freeze({
    name, fieldName, prefix, descriptor, record, compiledMeta, command, row, db, scope, principal, actionId,
    documentScope, stream, lease, state, family, cursor, position, actor, lamport,
  });
}

function assertOffsetInDocument(family                      , offset        , label        )       {
  const length = materializeText(family).length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new ValidationError(`annotated-text ${label} offset ${offset} is outside the document`, { code: 'position-invalid' });
  }
}

// The recipient's wire→canonical offset basis, bound to its authoring
// position frame (the frame's `redactions` column carries the exact authoring
// entries `authoringRedactionsForRecipient` produced at issue time). An empty
// frame (fully-visible recipient) maps as identity.
function parsedRedactions(position                          )                       {
  const raw = position?.redactions;
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function assertRedactionsBasesMatch(primary                      , other                      , label        )       {
  if (JSON.stringify(primary) !== JSON.stringify(other)) {
    throw new ValidationError(`annotated-text ${label} authoring redaction bases differ; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
}

// The acting principal's CURRENT wire→canonical basis at admit time, projected
// through the principal's own recipient view. The position frame the client
// edits against carries the same basis at issue time (the receipt issues the
// frame against the post-commit projection); a protection applied without a
// text change shifts this basis while leaving the family frontier unchanged,
// so the prelude compares the two and fails closed on a stale frame.
async function currentAuthoringRedactions(ctx                , row     )                                {
  const { db, record, fieldName, descriptor, principal } = ctx;
  let current;
  try {
    current = await projectAnnotatedTextSnapshot({
      db, entity: record, row, principal, fieldName, descriptor, mintBasis: false,
    });
  } catch {
    throw new ValidationError(`${ctx.name}.${ctx.fieldName}.operation cannot revalidate the authoring basis; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
  return authoringRedactionsForRecipient(current);
}

/**
 * Map a redacted recipient's wire offsets to canonical. A redacted recipient
 * never holds raw canonical offsets (its projection removed the denied text),
 * so every submitted offset is a wire offset against its own frame. A range
 * pins its endpoints to the boundaries facing the range interior; a collapsed
 * point at a placeholder is the affinity-bound gap.
 */
function mapWireRangeToCanonical(fromOffset        , fromAffinity                  , toOffset        , toAffinity                  , redactions                      , isRange         )                               {
  const from = mapVisibleOffsetToCanonical(fromOffset, fromAffinity, redactions, isRange ? 'right' : null);
  const to = isRange
    ? mapVisibleOffsetToCanonical(toOffset, toAffinity, redactions, 'left')
    : from;
  return { from, to };
}

// Fail closed on any mapped edit that would reach hidden text: an endpoint
// strictly inside a denied interval, or a range that contains one (a selection
// spanning the placeholder). Honest wire offsets never trigger these — the
// gate is the corruption wall against forged or future-rotten offsets. The
// containment check is order-insensitive: a forged range whose endpoints pin
// to reversed boundaries (an equal-offset range at a marker with left/right
// affinities spans the hidden interval) maps backwards and is caught here too.
function assertEditLandsInVisibleText(from        , to        , redactions                      , label        )       {
  const strictlyInside = (value        ) => redactions.some((redaction) => redaction.start < value && value < redaction.end);
  if (strictlyInside(from) || strictlyInside(to)) {
    throw new ValidationError(`annotated-text ${label} position maps inside a redacted interval`, { code: 'position-redacted' });
  }
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  if (redactions.some((redaction) => lo <= redaction.start && redaction.end <= hi)) {
    throw new ValidationError(`annotated-text ${label} selection spans a redacted interval`, { code: 'position-redacted' });
  }
}

/** text.insert | text.delete | text.replace */
async function admitTextEdit(ctx                                   )                     {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, actor, lamport, edit } = ctx;
  // The position's family-basis equality with the current family is enforced in
  // the prelude; the client's offset is absolute against that same basis. For a
  // redacted recipient the offset is a WIRE offset (its frame's redactions are
  // the wire→canonical table); it is mapped before planning so edits land in
  // visible text only.
  const at = (edit.at ?? edit.from) ;
  const offset = at.offset;
  const redactions = parsedRedactions(ctx.position);
  let toOffset = offset;
  let toAffinity                   = 'right';
  if (edit.kind !== 'text.insert') {
    if (!edit.to?.positionToken) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    const toPosition = resolvePosition({ db, prefix, positionToken: edit.to.positionToken, leaseId: lease.id })                                       ;
    if (!toPosition) throw new ValidationError(`${name}.${fieldName}.operation replacement end position token unavailable`, { code: 'position-token-unavailable' });
    if (!toPosition.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation replacement end position no longer visible`, { code: 'position-no-longer-visible' });
    const toPositionFamily = restoreTextFamily(JSON.parse(toPosition.family_checkpoint));
    if (JSON.stringify(toPositionFamily.checkpoint.frontier) !== JSON.stringify(family.checkpoint.frontier)) {
      throw new ValidationError(`${name}.${fieldName}.operation replacement end authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
    }
    assertRedactionsBasesMatch(redactions, parsedRedactions(toPosition), 'replacement end');
    toOffset = edit.to.offset;
    toAffinity = edit.to.affinity;
  }
  const fromAffinity = at.affinity ?? 'right';
  // A two-ended edit at equal wire offsets is a range only when its endpoints
  // pin to different boundaries (left/right at a marker spans the hidden
  // interval); an insert is always the collapsed affinity-bound gap.
  const isRange = edit.kind !== 'text.insert' && (offset !== toOffset || fromAffinity !== toAffinity);
  const mapped = mapWireRangeToCanonical(offset, fromAffinity, toOffset, toAffinity, redactions, isRange);
  assertEditLandsInVisibleText(mapped.from, mapped.to, redactions, edit.kind === 'text.insert' ? 'position' : 'replacement');
  assertOffsetInDocument(family, mapped.from, 'position');
  if (edit.kind !== 'text.insert') assertOffsetInDocument(family, mapped.to, 'replacement end');
  const annotations = loadAnnotations({ db, prefix, compiledMeta: ctx.compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const plannerEdit = edit.kind === 'text.insert'
    ? { kind: 'text.insert', at: { offset: mapped.from, affinity: edit.at .affinity }, text: edit.text }
    : { kind: edit.kind, from: { offset: mapped.from, affinity: edit.from .affinity }, to: { offset: mapped.to, affinity: edit.to .affinity }, text: edit.text };
  let plan;
  try {
    plan = planTextOffsetEdit({
      documentId: command.id, structureVersion: state.structure_version, family, actor, lamport,
      annotations, ranges, edit: plannerEdit       ,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.apply (document range) */
async function admitTextRangeApply(ctx                                        )                     {
  const { name, fieldName, command, db, prefix, documentScope, lease, family, state, edit, compiledMeta } = ctx;
  const fromToken = edit.from?.positionToken;
  const toToken = edit.to?.positionToken;
  if (!fromToken || !toToken) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  const fromPos = resolvePosition({ db, prefix, positionToken: fromToken, leaseId: lease.id })                                       ;
  const toPos = resolvePosition({ db, prefix, positionToken: toToken, leaseId: lease.id })                                       ;
  if (!fromPos || !toPos) throw new ValidationError(`${name}.${fieldName}.operation annotation selection tokens unavailable`, { code: 'position-token-unavailable' });
  if (!fromPos.visible_at_issue || !toPos.visible_at_issue) throw new ValidationError(`${name}.${fieldName}.operation annotation selection position no longer visible`, { code: 'position-no-longer-visible' });
  const fromPosFamily = restoreTextFamily(JSON.parse(fromPos.family_checkpoint));
  const toPosFamily = restoreTextFamily(JSON.parse(toPos.family_checkpoint));
  if (JSON.stringify(fromPosFamily.checkpoint.frontier) !== JSON.stringify(family.checkpoint.frontier) ||
      JSON.stringify(toPosFamily.checkpoint.frontier) !== JSON.stringify(family.checkpoint.frontier)) {
    throw new ValidationError(`${name}.${fieldName}.operation annotation selection authoring basis is stale; re-bootstrap the snapshot`, { code: 'position-stale' });
  }
  const redactions = parsedRedactions(fromPos);
  assertRedactionsBasesMatch(redactions, parsedRedactions(toPos), 'annotation selection');
  const mapped = mapWireRangeToCanonical(edit.from.offset, edit.from.affinity, edit.to.offset, edit.to.affinity, redactions,
    edit.from.offset !== edit.to.offset || edit.from.affinity !== edit.to.affinity);
  assertEditLandsInVisibleText(mapped.from, mapped.to, redactions, 'annotation selection');
  const familyMeta = compiledMeta.annotationHandles[edit.annotation?.family];
  if (!familyMeta) throw new ValidationError(`${name}.${fieldName}.operation unknown annotation family`, { code: 'position-invalid' });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const sameFamilyAnnotationIds = new Set(annotations.filter((candidate) => candidate.family === edit.annotation.family).map((candidate) => candidate.id));
  const annotation = {
    id: edit.annotation.id,
    family: edit.annotation.family,
    empty: familyMeta.empty,
    fields: edit.annotation.fields ?? {},
    protectedTargetIds: Array.isArray(edit.annotation?.protectedTargetIds) ? [...edit.annotation.protectedTargetIds].sort() : [],
  };
  let plan;
  try {
    plan = planTextRangeApply({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotation,
      from: { offset: mapped.from, affinity: edit.from.affinity },
      to: { offset: mapped.to, affinity: edit.to.affinity },
      ranges, actorId: ctx.principal?.id ?? '',
      cardinality: familyMeta.cardinality,
      sameFamilyAnnotationIds,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

/** annotation.remove (document range) */
async function admitAnnotationRemove(ctx                               )                     {
  const { name, fieldName, command, db, prefix, documentScope, family, state, compiledMeta } = ctx;
  const annotations = loadAnnotations({ db, prefix, compiledMeta, documentId: command.id });
  const ranges = loadRanges({ db, prefix, documentId: command.id });
  if (!annotations.some((annotation) => annotation.id === edit_annotationId(command))) {
    throw new ValidationError(`${name}.${fieldName}.operation annotation not found`);
  }
  let plan;
  try {
    plan = planAnnotationRemove({
      documentId: command.id, structureVersion: state.structure_version, family,
      annotationId: edit_annotationId(command)          , annotations, ranges,
    });
  } catch (error) {
    const err = error                             ;
    throw new ValidationError(`${name}.${fieldName}.operation ${err.message}`, err.code ? { code: err.code } : undefined);
  }
  const handle = eventHandles.native(name, fieldName, 'operated');
  return [{ handle, type: handle.type, scope: documentScope, data: plan }];
}

function edit_annotationId(command           )                     {
  return command.edit?.annotationId ?? command.edit?.annotation?.id;
}

/**
 * Admit a validated v9 annotated-text command. Structure edits (block.split,
 * block.merge, block.continue, block-group.assignment) are gone in the
 * blockless model and are rejected. `handlers` from the block era are ignored.
 */
export async function admitV9AnnotatedTextEdit(ctx                )                     {
  const prelude = await assertV9AuthoringPrelude(ctx);
  const edit = prelude.command.edit;
  if (edit.kind === 'text.insert' || edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    return admitTextEdit({ ...prelude, edit });
  }
  if (edit.kind === 'annotation.apply') {
    return admitTextRangeApply({ ...prelude, edit: edit                     });
  }
  if (edit.kind === 'annotation.remove') {
    return admitAnnotationRemove({ ...prelude, edit });
  }
  throw new ValidationError(`${prelude.name}.${prelude.fieldName}.operation block-era edit '${edit.kind}' is not supported (issue #33)`, { code: 'position-invalid' });
}
