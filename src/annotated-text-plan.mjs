// Pure commit planning for annotated-text operations (issue #33 blockless).
//
// One continuous RGA text per document; annotations are document-scoped
// character ranges. Positions are ABSOLUTE UTF-16 offsets (the authoring
// position frame resolves to an absolute offset — there are no blocks).
//
// This planner does not write DB, mint authoring frames, or fold client ops.
// One write authority stays the entity commit handler.

import {
  applyTextOperation,
  materializeText,
  resolveOffsetToEndpoint,
  textFamilyCheckpoint,
  textOperationForOffsetEdit,
  projectEndpointToOffset,
} from './annotated-text-continuous.mjs';
import { canonicalTextOp } from './annotated-text.mjs';
import { packOperatedFacts } from './annotated-text-operated-facts.mjs';
                                                                           
                                                                     
                                                    

function deepFreeze   (value   )    {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value)     ; }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  Object.values(value                           ).forEach(deepFreeze);
  return Object.freeze(value)     ;
}

                      
                             
                     
 

                    
              
             
                     
                                                            
                 
             
 

                      
             
                 
                             
 

                           
                       
                            
                          
 

                 
                                                                                             
                                                                             
                                                                                                                         

                             
                       
                             
                
                                 
                   
                              
                               
    
 

function before(family                      , structuralRevision        )             {
  return Object.freeze({ structuralRevision, frontier: family.checkpoint.frontier });
}

function unifiedPlan(data                     )           {
  return deepFreeze({
    // v14 keeps the semantic operation and deterministic non-text facts, but
    // no longer embeds the complete post-edit CRDT checkpoint in every event.
    // The owning projection derives that checkpoint by reducing `operation`
    // against its current state; historical v13 events remain replayable.
    version: 14,
    id: data.id,
    before: data.before,
    after: data.after,
    operation: data.operation,
    facts: packOperatedFacts({ ...data, family: null }),
  });
}

function assertForwardOffset(text        , fromOffset        , toOffset        ) {
  if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset) || fromOffset < 0 || toOffset < fromOffset || toOffset > text.length) {
    const error = new Error('selection must be a forward, in-bounds range')                            ;
    error.code = 'position-invalid';
    throw error;
  }
}

/** A range becomes empty when its visible width drops to zero after an edit. */
function emptiedRanges({ beforeFamily, afterFamily, ranges, annotations, structureVersion }   
                                     
                                    
                            
                            
                           
 )                      {
  const emptied                      = [];
  for (const range of ranges) {
    if (projectEndpointToOffset(afterFamily, range.start) < projectEndpointToOffset(afterFamily, range.end)) continue;
    const annotation = annotations.find((candidate) => candidate.id === range.annotationId);
    if (!annotation) continue;
    emptied.push({
      annotationId: range.annotationId,
      empty: annotation.empty,
      disposition: annotation.empty === 'orphan'
        ? { kind: 'orphaned', family: annotation.family, savedQuote: materializeRangeBetween(beforeFamily, range), lastRange: null }
        : { kind: 'deleted', family: annotation.family, savedQuote: null, lastRange: null },
    });
  }
  void structureVersion;
  return emptied;
}

function materializeRangeBetween(family                      , range                 )         {
  let text = '';
  const startPos = projectEndpointToOffset(family, range.start);
  const endPos = projectEndpointToOffset(family, range.end);
  const full = materializeText(family);
  if (startPos >= endPos) return text;
  return full.slice(startPos, endPos);
}

/**
 * Plan a document-wide text insert/delete/replace. The edit names ABSOLUTE
 * offsets; the operation applies to the whole continuous family.
 */
export function planTextOffsetEdit({ documentId, structureVersion, family, actor, lamport, edit, annotations = [], ranges = [] }   
                     
                           
                               
                
                  
                   
                             
                             
 )           {
  const text = materializeText(family);
  if (edit.kind === 'text.insert') {
    assertForwardOffset(text, edit.at.offset, edit.at.offset);
    const operation = textOperationForOffsetEdit(family, { kind: 'text.insert', at: edit.at, text: edit.text }, actor, lamport);
    const nextFamily = applyTextOperation(family, operation);
    return unifiedPlan({
      id: documentId,
      before: before(family, structureVersion),
      operation: { kind: 'text.apply', operation },
      after: Object.freeze({ structuralRevision: structureVersion, frontier: nextFamily.checkpoint.frontier }),
      family: textFamilyCheckpoint(nextFamily),
    });
  }
  if (edit.kind === 'text.delete' || edit.kind === 'text.replace') {
    assertForwardOffset(text, edit.from.offset, edit.to.offset);
    if (edit.from.offset === edit.to.offset) {
      const error = new Error('delete range must be non-empty')                            ;
      error.code = 'position-invalid';
      throw error;
    }
    if (edit.kind === 'text.replace') {
      const deleteOperation = textOperationForOffsetEdit(family, { kind: 'text.delete', from: edit.from, to: edit.to }, `${actor.slice(0, 30)}d0`, lamport);
      const intermediate = applyTextOperation(family, deleteOperation);
      const anchor = resolveOffsetToEndpoint(intermediate, edit.from.offset, intermediate.checkpoint.frontier, edit.from.affinity).point[1];
      let insertOperation          = ['workbench.text', 1, [`${actor.slice(0, 30)}e0`, 1], lamport + 1, intermediate.checkpoint.frontier, ['insert', anchor, edit.text]];
      insertOperation = canonicalTextOp(insertOperation);
      const nextFamily = applyTextOperation(intermediate, insertOperation);
      // A replacement can empty an annotation range exactly like a delete does;
      // the emptied-annotation dispositions must be planned and applied.
      const emptied = emptiedRanges({ beforeFamily: family, afterFamily: nextFamily, ranges, annotations, structureVersion });
      return unifiedPlan({
        id: documentId,
        before: before(family, structureVersion),
        operation: { kind: 'text.replace', operations: [deleteOperation, insertOperation] },
        after: Object.freeze({ structuralRevision: structureVersion + (emptied.length ? 1 : 0), frontier: nextFamily.checkpoint.frontier }),
        family: textFamilyCheckpoint(nextFamily),
        emptiedAnnotations: Object.freeze(emptied),
      });
    }
    const operation = textOperationForOffsetEdit(family, { kind: 'text.delete', from: edit.from, to: edit.to }, actor, lamport);
    const nextFamily = applyTextOperation(family, operation);
    const emptied = emptiedRanges({ beforeFamily: family, afterFamily: nextFamily, ranges, annotations, structureVersion });
    return unifiedPlan({
      id: documentId,
      before: before(family, structureVersion),
      operation: { kind: 'text.apply', operation },
      after: Object.freeze({ structuralRevision: structureVersion + (emptied.length ? 1 : 0), frontier: nextFamily.checkpoint.frontier }),
      family: textFamilyCheckpoint(nextFamily),
      emptiedAnnotations: Object.freeze(emptied),
    });
  }
  const error = new Error(`unsupported edit kind: ${(edit       ).kind}`)                            ;
  error.code = 'position-invalid';
  throw error;
}

/** Plan a document-range annotation.apply: one contiguous range, no blocks. */
export function planTextRangeApply({ documentId, structureVersion, family, annotation, from, to, ranges = [], actorId, cardinality = 'many', sameFamilyAnnotationIds = null }   
                     
                           
                               
                         
                                                       
                                                     
                             
                  
                               
                                               
 )           {
  const text = materializeText(family);
  const startOffset = from.offset;
  const endOffset = to.offset;
  assertForwardOffset(text, startOffset, endOffset);
  if (startOffset === endOffset) {
    const error = new Error('annotation selection must be a forward, non-empty range')                            ;
    error.code = 'position-invalid';
    throw error;
  }
  const start = resolveOffsetToEndpoint(family, startOffset, family.checkpoint.frontier, from.affinity);
  const end = resolveOffsetToEndpoint(family, endOffset, family.checkpoint.frontier, to.affinity);
  const range                  = { annotationId: annotation.id, start, end };
  // Same-id replace keeps the applied annotation at exactly one range. When the
  // family is exclusive ('one' cardinality), every OTHER same-family range that
  // overlaps the selection is trimmed in OFFSET space: its overlapped middle is
  // dropped and its non-overlapped left/right remnants are kept, so at most one
  // annotation covers any region. Different-family ranges pass through.
  const nextRanges                    = [];
  for (const entry of ranges) {
    if (entry.annotationId === annotation.id) continue;
    if (cardinality === 'one' && sameFamilyAnnotationIds?.has(entry.annotationId)) {
      const existingStart = projectEndpointToOffset(family, entry.start);
      const existingEnd = projectEndpointToOffset(family, entry.end);
      if (existingEnd > startOffset && existingStart < endOffset) {
        if (existingStart < startOffset) {
          nextRanges.push({
            annotationId: entry.annotationId,
            start: entry.start,
            end: resolveOffsetToEndpoint(family, startOffset, family.checkpoint.frontier, 'left'),
          });
        }
        if (existingEnd > endOffset) {
          nextRanges.push({
            annotationId: entry.annotationId,
            start: resolveOffsetToEndpoint(family, endOffset, family.checkpoint.frontier, 'right'),
            end: entry.end,
          });
        }
        continue;
      }
    }
    nextRanges.push(entry);
  }
  nextRanges.push(range);
  return unifiedPlan({
    id: documentId,
    before: before(family, structureVersion),
    after: Object.freeze({ structuralRevision: structureVersion, frontier: family.checkpoint.frontier }),
    operation: { kind: 'annotation.apply-range', annotation, selection: { startOffset, endOffset } },
    family: textFamilyCheckpoint(family),
    annotation,
    ranges: Object.freeze(nextRanges.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
    actorId,
    selectedRange: Object.freeze({ annotationId: annotation.id, start, end }),
    measurements: [],
  });
}

/** Plan a document-range annotation.remove. */
export function planAnnotationRemove({ documentId, structureVersion, family, annotationId, annotations, ranges }   
                     
                           
                               
                       
                            
                            
 )           {
  const target = annotations.find((annotation) => annotation.id === annotationId);
  if (!target) throw new Error('annotation not found');
  const retained = ranges.filter((entry) => entry.annotationId !== annotationId);
  return unifiedPlan({
    id: documentId,
    before: before(family, structureVersion),
    operation: { kind: 'annotation.remove', annotationId },
    after: Object.freeze({ structuralRevision: structureVersion, frontier: family.checkpoint.frontier }),
    family: textFamilyCheckpoint(family),
    lifecycle: { empty: target.empty },
    result: { memberships: { annotationId, postimage: [] }, disposition: { kind: 'deleted', family: target.family, savedQuote: null, lastRange: null }, changedProtectors: [] },
    ranges: Object.freeze(retained.map((entry) => deepFreeze({ annotationId: entry.annotationId, start: entry.start, end: entry.end }))),
    removedAnnotationIds: Object.freeze([annotationId]),
  });
}

export function planAnnotationApplyOffsets()        {
  const error = new Error('planAnnotationApplyOffsets is block-era; use planTextRangeApply')                            ;
  error.code = 'position-invalid';
  throw error;
}
