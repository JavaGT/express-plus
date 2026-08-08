import { getLog } from '../log.mjs';
import { serializeField, flattenStruct, resolveStrategy } from '../field-strategy.mjs';
import * as eventHandle from '../event-handle.mjs';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.mjs';
import { CASCADE_DESCENDANT } from './removal-cascade.mjs';
import { applyTextOp, assertWellFormedText, canonicalTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.mjs';
import {
  applyTextOperation as applyContinuousTextOperation,
  importTextToFamily,
  resolveOffsetToEndpoint,
  restoreTextFamily,
  textFamilyCheckpoint as continuousTextFamilyCheckpoint,
} from '../annotated-text-continuous.mjs';
import { assertWordEvidencePayload } from '../word-evidence.mjs';
import { resolveDeclarationMeasurementExtension } from '../annotated-text-field.mjs';
import { frozenJsonSnapshot } from '../annotated-text-r2.mjs';
import { markAnnotatedEntityProjection } from '../annotated-text-history.mjs';
                                             
                                                                                         

                                   
                   

                           
               
                
                   
                 
                         
                                                                             
                                                                                            
                                          
                                               
                         
 

                                              

                                                                                                                 

                    
              
                   
                                                            
                         
 

                     
                                           
                         
                        
                
                         
                         
 

                        
                              
                       
 

                                 
                        
                                                                             
 

                         
                                         
                                               
                                                   
                                  
                  
                                             
                     
                  
                   
                                                
 

                            
             
                  
                       
                      
               
                  
                          
                                                
                                                                                                                  
                        
                          
    
                       
                         
 

                                                                                       

                                 
                    
                  
                                          
                                          
                           
 

function isTextRevision(value         )                        {
  const record = value                           ;
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(record).sort().join() === 'frontier,structuralRevision' &&
    Number.isSafeInteger(record.structuralRevision          ) && (record.structuralRevision          ) >= 1 &&
    Array.isArray(record.frontier);
}

function initializeAnnotatedText({ name, fields, event, db, row }                                                                      ) {
  const metadata = event.data?.__workbench?.annotatedText;
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'annotatedText') continue;
    const imported = metadata?.[fieldName]                                     ;
    const initialBlockId = imported?.initialBlockId;
    if (!imported || imported.version !== 1 || typeof imported.actor !== 'string' || !/^[0-9a-f]{32}$/.test(imported.actor) ||
        !Array.isArray(imported.blocks) || imported.blocks.length === 0 || typeof initialBlockId !== 'string' || initialBlockId.length === 0 ||
        imported.blocks[0]?.id !== initialBlockId) {
      throw new Error(`${name}.${fieldName} created event is missing initial block metadata`);
    }
    const prefix = `${name}_${fieldName}`;
    for (const [blockIndex, importedBlock] of imported.blocks.entries()) {
      if (!importedBlock || typeof importedBlock !== 'object' || Array.isArray(importedBlock) ||
          (Object.keys(importedBlock).length < 3 || Object.keys(importedBlock).length > 6) ||
          typeof importedBlock.id !== 'string' || importedBlock.id.length === 0 || typeof importedBlock.text !== 'string' ||
          (importedBlock.fields !== null && (!importedBlock.fields || typeof importedBlock.fields !== 'object' || Array.isArray(importedBlock.fields)))) {
        throw new Error(`${name}.${fieldName} created event has invalid imported block ${blockIndex}`);
      }
      for (const key of Object.keys(importedBlock)) if (!['id', 'text', 'fields', 'measurements', 'wordEvidence'].includes(key)) throw new Error(`${name}.${fieldName} created event has unknown imported block key '${key}'`);
      assertWellFormedText(importedBlock.text);
      if (importedBlock.text.length === 0 && imported.blocks.some((candidate) => candidate.fields !== null)) throw new Error(`${name}.${fieldName} created event has an empty imported block`);
      if (importedBlock.wordEvidence !== undefined) {
        try {
          assertWordEvidencePayload(importedBlock.wordEvidence, { families: fields[fieldName].wordEvidence           , blockText: importedBlock.text });
        } catch (error) {
          throw new Error(`${name}.${fieldName} created event block ${blockIndex} has invalid word evidence payload: ${(error         ).message}`);
        }
      }
    }
    const fullText = imported.blocks.map((importedBlock) => importedBlock.text).join('');
    const family = importTextToFamily(row.id          , imported.actor, fullText);
    const checkpoint = JSON.stringify(continuousTextFamilyCheckpoint(family));
    const state = db.prepare(`SELECT * FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
    if (state) {
      const expected = state.structure_version === 1 && state.family_checkpoint === checkpoint;
      if (!expected) throw new Error(`${name}.${fieldName} created projection conflicts with existing initialization`);
      continue;
    }
    db.prepare(`INSERT INTO ${prefix}_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)`)
      .run(row.id, checkpoint);
    // Blockless measurements are DOCUMENT-scoped (the table has no block_id and
    // enforces one row per (document_id, family)); merge the per-block imported
    // measurements across blocks, rejecting a duplicate family.
    const measurementByFamily = new Map();
    for (const importedBlock of imported.blocks) {
      const importedMeasurements = importedBlock.measurements ?? [];
      if (!Array.isArray(importedMeasurements)) throw new Error(`${name}.${fieldName} created event imported measurements are invalid`);
      for (const measurement of importedMeasurements) {
        if (!measurement || typeof measurement !== 'object' || Object.keys(measurement).length !== 4 || typeof measurement.id !== 'string' || typeof measurement.family !== 'string' || !Number.isSafeInteger(measurement.formatVersion) || !Object.hasOwn(measurement, 'payload')) throw new Error(`${name}.${fieldName} created event imported measurement is invalid`);
        if (measurementByFamily.has(measurement.family)) throw new Error(`${name}.${fieldName} created event has duplicate measurement family`);
        measurementByFamily.set(measurement.family, measurement);
      }
    }
    for (const [measurementFamily, measurement] of measurementByFamily) {
      const config = descriptor.measurements .find((entry) => entry.measurementName === measurementFamily);
      const extension = config && resolveDeclarationMeasurementExtension(config);
      if (!config || measurement.formatVersion !== config.formatVersion || !extension) throw new Error(`${name}.${fieldName} created event measurement declaration mismatch`);
      let payload;
      try { payload = frozenJsonSnapshot(measurement.payload); } catch { throw new Error(`${name}.${fieldName} created event measurement payload is not JSON`); }
      try { if (extension.validate({ version: 1, formatVersion: config.formatVersion, blockText: fullText, payload }) !== undefined) throw new Error('returned a value'); } catch { throw new Error(`${name}.${fieldName} created event measurement validation failed`); }
      db.prepare(`INSERT INTO ${prefix}_measurement (id, document_id, family, format_version, payload) VALUES (?, ?, ?, ?, ?)`).run(measurement.id, row.id, measurementFamily, config.formatVersion, JSON.stringify(payload));
    }
    if (imported.ranges !== undefined) {
      seedImportedAnnotationRanges({ name, fieldName, prefix, descriptor, db, row, family, fullText, ranges: imported.ranges });
    }
  }
}

// Seed create-source annotation ranges (issue #216) in the SAME create
// transaction as the text family: one `_annotation` row, its `_annotation_{family}`
// field row, and one `_membership` row. Endpoints use the membership-valid
// affinity — END = right, START = right (the document-root start resolves to
// left automatically) — matching the runtime range-apply semantics.
function seedImportedAnnotationRanges({ name, fieldName, prefix, descriptor, db, row, family, fullText, ranges }   
               
                    
                 
                              
         
           
                                                
                   
                                         
 ) {
  const frontier = family.checkpoint.frontier;
  for (const [index, range] of ranges.entries()) {
    if (!range || typeof range !== 'object' || Array.isArray(range)) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} is invalid`);
    }
    const allowedRange = new Set(['annotationId', 'family', 'start', 'end', 'fields']);
    for (const key of Object.keys(range)) {
      if (!allowedRange.has(key)) throw new Error(`${name}.${fieldName} created event imported range ${index} has unknown key '${key}'`);
    }
    const { annotationId, family: rangeFamily, start, end } = range;
    if (typeof annotationId !== 'string' || annotationId.length === 0) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} annotationId must be a non-empty string`);
    }
    if (typeof rangeFamily !== 'string' || rangeFamily.length === 0) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} family must be a non-empty string`);
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start          ) < 0 || (end          ) <= (start          ) || (end          ) > fullText.length) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} offsets are invalid`);
    }
    const declared = descriptor.annotations?.find((entry) => entry.annotationName === rangeFamily);
    if (!declared) throw new Error(`${name}.${fieldName} created event imported range ${index} family '${rangeFamily}' is not declared`);
    const fieldEntries = Object.entries(declared.fields);
    const supplied = (range.fields ?? {})                           ;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} fields must be a non-array object`);
    }
    const suppliedNames = Object.keys(supplied).sort();
    const declaredNames = fieldEntries.map(([fieldName]) => fieldName).sort();
    if (JSON.stringify(suppliedNames) !== JSON.stringify(declaredNames)) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} fields disagree with declaration`);
    }
    const storedFields = fieldEntries.map(([declaredName, field]) => {
      const value = supplied[declaredName];
      if (value === null && field.nullable === true) return null;
      const strategy = resolveStrategy(field.kind);
      const validation = strategy.validate(value, field);
      if (validation !== true || (typeof field.validate === 'function' && field.validate(value) !== true)) {
        throw new Error(`${name}.${fieldName} created event imported range ${index} field '${declaredName}' failed validation`);
      }
      return serializeField(field, value);
    });
    let startEndpoint;
    let endEndpoint;
    try {
      startEndpoint = resolveOffsetToEndpoint(family, start          , frontier, 'right');
      endEndpoint = resolveOffsetToEndpoint(family, end          , frontier, 'right');
    } catch (error) {
      throw new Error(`${name}.${fieldName} created event imported range ${index} offsets cannot be resolved: ${(error         ).message}`);
    }
    db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
      .run(annotationId, row.id, row[descriptor.project ], row[descriptor.owner ], rangeFamily);
    if (fieldEntries.length) {
      const names = fieldEntries.map(([declaredName]) => declaredName);
      db.prepare(`INSERT INTO ${prefix}_annotation_${rangeFamily} (annotation_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`)
        .run(annotationId, ...storedFields);
    }
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, start_point, end_point) VALUES (?, ?, ?)`)
      .run(annotationId, JSON.stringify(startEndpoint), JSON.stringify(endEndpoint));
  }
}

function applyAnnotatedTextOperation({ name, fields, handle, event, db }                                                                                                     ) {
  if (handle.kind !== eventHandle.EventKind.native || handle.nativeName !== 'operated') return false;
  const descriptor = fields[handle.field];
  if (descriptor?.kind !== 'annotatedText') return false;
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated event has no data`);
  }
  if (data.version === 13) return applySpanNativeAnnotatedTextOperation({ name, handle, db, descriptor, data: data                                });
  throw new Error(`${name}.${handle.field}.operated event has unknown version ${data.version}`);
}

// The active durable codec is one exact envelope.  The operation-specific
// reducers below consume only the facts in this envelope; versions before 13
// are deliberately not accepted by the projection.
function applySpanNativeAnnotatedTextOperation({ name, handle, db, descriptor, data }                                                                                                          ) {
  const prefix = `${name}.${handle.field}.operated v13`;
  const factKeys = ['actorId', 'annotation', 'emptiedAnnotations', 'family', 'lifecycle', 'measurements', 'ranges', 'removedAnnotationIds', 'result', 'selectedRange'];
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join() !== 'after,before,facts,id,operation,version' || data.version !== 13 ||
      typeof data.id !== 'string' || !data.id || !isTextRevision(data.before) || !isTextRevision(data.after) ||
      !data.operation || typeof data.operation !== 'object' || Array.isArray(data.operation) ||
      !data.facts || typeof data.facts !== 'object' || Array.isArray(data.facts) ||
      Object.keys(data.facts).sort().join() !== factKeys.join()) {
    throw new Error(`${prefix} event has invalid envelope`);
  }
  const f = data.facts;
  if (!Array.isArray(f.ranges) || !Array.isArray(f.measurements) || !Array.isArray(f.emptiedAnnotations) || !Array.isArray(f.removedAnnotationIds) ||
      (f.family !== null && (!f.family || typeof f.family !== 'object')) ||
      (f.annotation !== null && (!f.annotation || typeof f.annotation !== 'object')) ||
      (f.lifecycle !== null && (!f.lifecycle || typeof f.lifecycle !== 'object')) ||
      (f.result !== null && (!f.result || typeof f.result !== 'object')) ||
      (f.actorId !== null && (typeof f.actorId !== 'string' || !f.actorId)) ||
      (f.selectedRange !== null && (!f.selectedRange || typeof f.selectedRange !== 'object'))) throw new Error(`${prefix} event has invalid facts`);
  switch (data.operation.kind) {
    case 'text.apply': return projectBlocklessTextApply({ name, handle, db, data });
    case 'text.replace': return projectBlocklessTextReplace({ name, handle, db, data });
    case 'annotation.apply-range': return projectBlocklessAnnotationApplyRange({ name, handle, db, descriptor, data });
    case 'annotation.remove': return projectBlocklessAnnotationRemove({ name, handle, db, data });
    default: throw new Error(`${prefix} event has unknown operation kind '${data.operation.kind}'`);
  }
}

function projectBlocklessTextApply({ name, handle, db, data }                                                                             ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'text.apply' || !Array.isArray(operation.operation) ||
      !f.family || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v13 text.apply event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamily(JSON.parse(currentRow.family_checkpoint          ));
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  let canonical;
  try { canonical = canonicalTextOp(operation.operation); } catch { throw new Error(`${name}.${handle.field}.operated v13 text operation is invalid`); }
  if (JSON.stringify(canonical) !== JSON.stringify(operation.operation) || JSON.stringify(canonical[4]) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 text operation is not canonical or has the wrong frontier`);
  let next;
  try { next = applyContinuousTextOperation(current, canonical); } catch { throw new Error(`${name}.${handle.field}.operated v13 text operation is not applicable to prior state`); }
  if (JSON.stringify(continuousTextFamilyCheckpoint(next)) !== JSON.stringify(f.family) ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v13 family does not match the operation`);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`).run(data.after.structuralRevision, JSON.stringify(f.family), data.id);
  applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data });
}

function projectBlocklessTextReplace({ name, handle, db, data }                                                                             ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'text.replace' || !Array.isArray(operation.operations) || operation.operations.length !== 2 ||
      !f.family || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v13 text.replace event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamily(JSON.parse(currentRow.family_checkpoint          ));
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  let next = current;
  for (const raw of operation.operations) {
    let canonical;
    try { canonical = canonicalTextOp(raw); } catch { throw new Error(`${name}.${handle.field}.operated v13 replace operation is invalid`); }
    if (JSON.stringify(canonical[4]) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v13 replace operation has the wrong frontier`);
    try { next = applyContinuousTextOperation(next, canonical); } catch { throw new Error(`${name}.${handle.field}.operated v13 replace operation is not applicable to prior state`); }
  }
  if (JSON.stringify(continuousTextFamilyCheckpoint(next)) !== JSON.stringify(f.family) ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) throw new Error(`${name}.${handle.field}.operated v13 family does not match the replace`);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`).run(data.after.structuralRevision, JSON.stringify(f.family), data.id);
  applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data });
}

function applyEmptiedAnnotationDispositions({ name, handle, db, prefix, data }                                                                                             ) {
  for (const emptied of data.facts.emptiedAnnotations) {
    if (!emptied || typeof emptied !== 'object' || typeof emptied.annotationId !== 'string' || !emptied.disposition ||
        typeof emptied.disposition !== 'object' || (emptied.disposition.kind !== 'orphaned' && emptied.disposition.kind !== 'deleted')) throw new Error(`${name}.${handle.field}.operated v13 emptied annotation is invalid`);
    const annotation = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(emptied.annotationId, data.id);
    if (!annotation) throw new Error(`${name}.${handle.field}.operated v13 emptied annotation does not exist`);
    if (emptied.disposition.kind === 'orphaned') {
      db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(emptied.annotationId);
      db.prepare(`INSERT INTO ${prefix}_annotation_orphan_state (annotation_id, saved_quote, last_range) VALUES (?, ?, ?)`)
        .run(emptied.annotationId, typeof emptied.disposition.savedQuote === 'string' ? emptied.disposition.savedQuote : '', JSON.stringify(emptied.disposition.lastRange ?? null));
    } else {
      deleteAnnotatedTextAnnotation(db, prefix, emptied.annotationId);
    }
  }
}

function projectBlocklessAnnotationApplyRange({ name, handle, db, descriptor, data }                                                                                                          ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.apply-range' || !operation.annotation || !operation.selection ||
      !f.annotation || !f.selectedRange || !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v13 annotation.apply-range event has invalid data`);
  const annOp = operation.annotation;
  const annFact = f.annotation;
  if (JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annFact).sort()) ||
      annOp.id !== annFact.id || annOp.family !== annFact.family ||
      JSON.stringify(annOp.fields) !== JSON.stringify(annFact.fields) ||
      JSON.stringify(annOp.protectedTargetIds ?? []) !== JSON.stringify(annFact.protectedTargetIds ?? []) ||
      typeof annOp.id !== 'string' || typeof annOp.family !== 'string' ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields)) throw new Error(`${name}.${handle.field}.operated v13 annotation facts do not match the operation`);
  const range = f.ranges.find((entry) => entry && typeof entry === 'object' && entry.annotationId === annOp.id);
  if (!range || !range.start || !range.end) throw new Error(`${name}.${handle.field}.operated v13 annotation range is missing`);
  if (f.selectedRange.annotationId !== annOp.id) throw new Error(`${name}.${handle.field}.operated v13 selected range does not match the annotation`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamily(JSON.parse(currentRow.family_checkpoint          ));
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v13 annotation apply must not change the text family`);
  if (JSON.stringify(continuousTextFamilyCheckpoint(current)) !== JSON.stringify(f.family)) throw new Error(`${name}.${handle.field}.operated v13 annotation family does not match the document`);
  const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(data.id);
  if (!row) throw new Error(`${name}.${handle.field}.operated v13 document row is missing`);
  const declared = descriptor.annotations .find((entry) => entry.annotationName === annOp.family);
  if (!declared) throw new Error(`${name}.${handle.field}.operated v13 annotation family is not declared`);
  const targetIds = (annOp.protectedTargetIds ?? [])            ;
  if (Array.isArray(targetIds) && targetIds.some((id, index, ids) => typeof id !== 'string' || (index > 0 && ids[index - 1] >= id))) throw new Error(`${name}.${handle.field}.operated v13 protected targets are invalid`);
  for (const targetId of targetIds) {
    const target = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(targetId, data.id);
    if (!target) throw new Error(`${name}.${handle.field}.operated v13 protected target does not exist`);
  }
  db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
    .run(annOp.id, data.id, row[descriptor.project          ], row[descriptor.owner          ], annOp.family);
  const fieldNames = Object.keys(declared.fields);
  // Fail closed: the annotation's field payload must EXACTLY match the declared
  // schema — unknown keys (including on a zero-field family) are rejected, so
  // the durable row can never silently drop or ignore attacker-supplied fields.
  const suppliedFieldNames = Object.keys(annOp.fields).sort();
  if (suppliedFieldNames.length !== fieldNames.length || [...fieldNames].sort().some((fieldName, index) => suppliedFieldNames[index] !== fieldName)) {
    throw new Error(`${name}.${handle.field}.operated v13 annotation fields disagree with declaration`);
  }
  const stored = db.prepare(`SELECT * FROM ${prefix}_annotation_${annOp.family} WHERE annotation_id = ?`).get(annOp.id);
  if (fieldNames.length) {
    const values = fieldNames.map((fieldName) => {
      if (!Object.hasOwn(annOp.fields , fieldName)) throw new Error(`${name}.${handle.field}.operated v13 annotation is missing field '${fieldName}'`);
      const field = declared.fields[fieldName];
      const strategy = resolveStrategy(field.kind);
      const validation = strategy.validate(annOp.fields [fieldName], field);
      if (validation !== true || (typeof field.validate === 'function' && field.validate(annOp.fields [fieldName]) !== true)) throw new Error(`${name}.${handle.field}.operated v13 annotation field '${fieldName}' failed validation`);
      return serializeField(field, annOp.fields [fieldName]);
    });
    if (stored) {
      db.prepare(`UPDATE ${prefix}_annotation_${annOp.family} SET ${fieldNames.map((fieldName) => `${fieldName} = ?`).join(', ')} WHERE annotation_id = ?`).run(...values, annOp.id);
    } else {
      db.prepare(`INSERT INTO ${prefix}_annotation_${annOp.family} (annotation_id, ${fieldNames.join(', ')}) VALUES (?, ${fieldNames.map(() => '?').join(', ')})`).run(annOp.id, ...values);
    }
  }
  db.prepare(`DELETE FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? OR target_annotation_id = ?`).run(annOp.id, annOp.id);
  for (const targetId of targetIds) db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`).run(annOp.id, targetId);
  db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(annOp.id);
  db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, start_point, end_point) VALUES (?, ?, ?)`).run(annOp.id, JSON.stringify(range.start), JSON.stringify(range.end));
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

function projectBlocklessAnnotationRemove({ name, handle, db, data }                                                                             ) {
  const prefix = `${name}_${handle.field}`;
  const operation = data.operation;
  const f = data.facts;
  if (!operation || operation.kind !== 'annotation.remove' || typeof operation.annotationId !== 'string' ||
      !Array.isArray(f.removedAnnotationIds) || f.removedAnnotationIds.length !== 1 || f.removedAnnotationIds[0] !== operation.annotationId ||
      !isTextRevision(data.before) || !isTextRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v13 annotation.remove event has invalid data`);
  const currentRow = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!currentRow) throw new Error(`${name}.${handle.field}.operated v13 document does not exist`);
  const current = restoreTextFamily(JSON.parse(currentRow.family_checkpoint          ));
  if (currentRow.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v13 event conflicts with projection state`);
  if (JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.after.frontier) ||
      data.after.structuralRevision !== data.before.structuralRevision) throw new Error(`${name}.${handle.field}.operated v13 annotation remove must not change the text family`);
  if (JSON.stringify(continuousTextFamilyCheckpoint(current)) !== JSON.stringify(f.family)) throw new Error(`${name}.${handle.field}.operated v13 annotation family does not match the document`);
  const annotation = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(operation.annotationId, data.id);
  if (!annotation) throw new Error(`${name}.${handle.field}.operated v13 annotation to remove does not exist`);
  deleteAnnotatedTextAnnotation(db, prefix, operation.annotationId);
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ? WHERE document_id = ?`).run(data.after.structuralRevision, data.id);
}

function deleteAnnotatedTextAnnotation(db    , prefix        , annotationId        ) {
  db.prepare(`DELETE FROM ${prefix}_annotation_protected_target WHERE annotation_id = ? OR target_annotation_id = ?`).run(annotationId, annotationId);
  db.prepare(`DELETE FROM ${prefix}_annotation WHERE id = ?`).run(annotationId);
}

function buildProjectedComputeRow(storedRow     , fields        )      {
  const row = { ...storedRow };
  for (const [fName, desc] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(row, fName)) {
      try {
        row[fName] = resolveStrategy(desc.kind).deserialize?.(row[fName], desc) ?? row[fName];
      } catch {}
    }
  }
  return row;
}

export function createEntityProjection({ name, fields, verbs, storedComputedFields, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }   
               
                 
                                          
                                             
                                                          
                               
                                     
 ) {
  const projection = {
    eventTypes: [
      verbs.created.type,
      verbs.updated.type,
      verbs.removed.type,
      ...Object.entries(fields)
        .filter(([, descriptor]) => descriptor.kind === 'crdt' && descriptor.type === 'text')
        .map(([fieldName]) => eventHandle.native(name, fieldName, 'applied').type),
      ...Object.entries(fields)
        .filter(([, descriptor]) => descriptor.kind === 'annotatedText')
        .flatMap(([fieldName]) => [eventHandle.native(name, fieldName, 'operated').type, eventHandle.native(name, fieldName, 'retired').type]),
      ...sideTableStrategyEntries.flatMap(({ strategy, fields: strategyFields }) =>
        strategy.eventTypes(name, strategyFields)),
    ],
    apply: (event           , db    ) => {
      const table = name;
      const handle = event.handle;
      if (handle?.brand !== 'event-handle' || handle.entity !== name) return;
      for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
        if (strategy.projectionApply({ entityName: name, fieldEntries: strategyFields, handle, event: event                              , db })) return;
      }
      if (handle.kind === eventHandle.EventKind.native && handle.nativeName === 'retired') {
        const descriptor = fields[handle.field];
        if (descriptor?.kind !== 'annotatedText') return;
        const data = event.data;
        if (!data || data.version !== 1 || typeof data.id !== 'string' || !data.id || typeof data.generation !== 'string' || !data.generation || typeof data.retiredAt !== 'string') throw new Error(`${name}.${handle.field}.retired has invalid facts`);
        const existing = db.prepare(`SELECT generation FROM ${name}_${handle.field}_retired WHERE document_id = ?`).get(data.id);
        if (existing && existing.generation !== data.generation) throw new Error(`${name}.${handle.field}.retired generation conflicts`);
        db.prepare(`INSERT OR IGNORE INTO ${name}_${handle.field}_retired (document_id, generation, retired_at) VALUES (?, ?, ?)`).run(data.id, data.generation, data.retiredAt);
        return;
      }
      if (applyAnnotatedTextOperation({ name, fields, handle, event, db })) return;
      if (handle.kind === eventHandle.EventKind.native && handle.nativeName === 'applied') {
        const descriptor = fields[handle.field];
        if (descriptor?.kind !== 'crdt' || descriptor.type !== 'text') return;
        const id = event.data?.id;
        if (!id) return;
        const current = db.prepare(`SELECT ${handle.field} FROM ${table} WHERE id = ?`).get(id);
        if (!current) return;
        const state = restoreTextCheckpoint(JSON.parse(current[handle.field]          ));
        const next = applyTextOp(state, event.data?.operation);
        db.prepare(`UPDATE ${table} SET ${handle.field} = ? WHERE id = ?`)
          .run(JSON.stringify(textCheckpoint(next)), id);
        getLog().debug('dispatch', `${name}.${handle.field}.applied`, { id });
        return;
      }
      if (handle.kind === eventHandle.EventKind.created) {
        for (const [fieldName, descriptor] of Object.entries(fields)) {
          if (descriptor.kind === 'annotatedText' && db.prepare(`SELECT 1 FROM ${name}_${fieldName}_retired WHERE document_id = ?`).get(event.data?.id)) {
            throw new Error(`${name}.${fieldName} document id is permanently retired`);
          }
        }
        const row                          = {};
        for (const [key, value] of Object.entries(event.data ?? {})) {
          if (key === '__workbench') continue;
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') {
            Object.assign(row, flattenStruct(key, descriptor, value));
            continue;
          }
          if (descriptor) {
            row[key] = serializeField(descriptor, value);
          } else {
            row[key] = value;
          }
        }
        for (const [fieldName, descriptor] of Object.entries(fields)) {
          if (descriptor.kind === 'crdt' && descriptor.type === 'text') {
            row[fieldName] = JSON.stringify(textCheckpoint(createTextState()));
          }
        }
        for (const [fieldName, { compute }] of storedComputedFields) {
          try {
            const computeRow = buildProjectedComputeRow(row, fields);
            const result = compute (computeRow);
            row[fieldName] = resolveStrategy('computed').serialize (result);
          } catch {
            throw new Error(`${name}.${fieldName} computed.stored compute failed`);
          }
        }
        const cols = Object.keys(row);
        if (cols.length > 0) {
          db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
          ).run(row);
          initializeAnnotatedText({ name, fields, event, db, row });
          getLog().debug('dispatch', `${name}.created`, { id: row.id ?? event.data?.id });
        }
      } else if (handle.kind === eventHandle.EventKind.updated) {
        if (conditionalHistory) return;
        const { id, ...data } = (event.data ?? {})            ;
        if (!id) return;
        const updates = [];
        const params                          = { id };
        for (const [key, value] of Object.entries(data)) {
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') {
            for (const [column, cell] of Object.entries(flattenStruct(key, descriptor, value))) {
              updates.push(`${column} = :${column}`);
              params[column] = cell;
            }
            continue;
          }
          const stored = descriptor ? serializeField(descriptor, value) : value;
          updates.push(`${key} = :${key}`);
          params[key] = stored;
        }
        if (storedComputedFields.length > 0) {
          const existing = db.prepare(`SELECT * FROM ${table} WHERE id = :id`).get({ id });
          if (existing) {
            const merged = { ...existing };
            for (const [key] of Object.entries(data)) {
              if (Object.prototype.hasOwnProperty.call(fields, key)) {
                merged[key] = Object.prototype.hasOwnProperty.call(params, key) ? params[key] : data[key];
              }
            }
            for (const [fieldName, { compute }] of storedComputedFields) {
              try {
                const computeRow = buildProjectedComputeRow(merged, fields);
                const result = compute (computeRow);
                const stored = resolveStrategy('computed').serialize (result);
                updates.push(`${fieldName} = :${fieldName}`);
                params[fieldName] = stored;
              } catch {
                throw new Error(`${name}.${fieldName} computed.stored compute failed`);
              }
            }
          }
        }
        if (updates.length > 0) {
          db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = :id`).run(params);
          getLog().debug('dispatch', `${name}.updated`, { id: params.id });
        }
      } else if (handle.kind === eventHandle.EventKind.removed) {
        // A cascade root with conditional-create history deletes from its exact
        // private fact. Its descendants have no private facts in that receipt.
        if (conditionalCreateHistory && !event[CASCADE_DESCENDANT]) return;
        const id = event.data?.id;
        // Capture the deleted-row history anchor BEFORE the delete, in the
        // same projection-consumer call (same transaction as the DELETE) —
        // atomic, so a committed removal can never leave the anchor missing.
        const existingRow = id ? db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) : undefined;
        if (existingRow) captureDeletedRowAnchor(db                                                 , name, id          , existingRow, event.committedAt          );
        // A protecting annotation's target edge is ON DELETE RESTRICT. The row
        // delete cascades into the annotation rows, so tear down the document's
        // protected-target edges first or removing a document that carries a
        // protecting span fails the FK constraint.
        if (id) {
          for (const [fieldName, descriptor] of Object.entries(fields)) {
            if (descriptor.kind !== 'annotatedText') continue;
            const prefix = `${name}_${fieldName}`;
            db.prepare(
              `DELETE FROM ${prefix}_annotation_protected_target
               WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)
                  OR target_annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?)`,
            ).run(id, id);
          }
        }
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        getLog().debug('dispatch', `${name}.removed`, { id });
      }
    },
  };
  if (Object.values(fields).some((field) => field.kind === 'annotatedText')) markAnnotatedEntityProjection(projection);
  return Object.freeze(projection);
}

export function createConditionalHistoryProjection({ name, verbs }                                                           ) {
  return Object.freeze({
    actionType: `${name}.update`,
    eventTypes: [verbs.updated.type],
    privateFact: true,
    replay: false,
    apply: (event           , db    , { privateFact }                                                 ) => {
      const before = privateFact?.before;
      const after = privateFact?.after;
      if (!before || !after || before.id !== after.id || event.data?.id !== before.id) throw new Error(`${name}.update private fact is invalid`);
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name          );
      if (columns.some((column) => !Object.hasOwn(before, column) || !Object.hasOwn(after, column))) throw new Error(`${name}.update private fact is incomplete`);
      const current = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      const params                          = {};
      const assignments = columns.filter((column) => column !== 'id').map((column) => {
        params[`after_${column}`] = after[column];
        return `${column} = :after_${column}`;
      });
      const preimage = columns.map((column) => {
        params[`before_${column}`] = before[column];
        return `${column} IS :before_${column}`;
      });
      const result = db.prepare(`UPDATE ${name} SET ${assignments.join(', ')} WHERE ${preimage.join(' AND ')}`).run(params);
      if (Number(result.changes) !== 1) {
        if (!db.prepare(`SELECT 1 FROM ${name} WHERE id = ?`).get(before.id)) {
          throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
        }
        throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      }
    },
  });
}

export function createConditionalCreateHistoryProjection({ name, verbs }                                                           ) {
  const apply = (event           , db    , { privateFact }                                                               ) => {
    const { before, after } = privateFact ?? {};
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name          );
    if (event.type === verbs.created.type) {
      if (before !== null || !after || after.id !== event.data?.id) throw new Error(`${name}.create private fact is invalid`);
      const current = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(after.id);
      if (!current) throw Object.assign(new Error(`${name}.create projection conflicts`), { status: 409 });
      if (Object.keys(after).length !== columns.length || columns.some((column) => !Object.hasOwn(after, column)) || !columns.every((column) => Object.is(current[column], after[column]))) {
        throw Object.assign(new Error(`${name}.create projection conflicts`), { status: 409 });
      }
    } else {
      if (!before || after !== null || before.id !== event.data?.id || Object.keys(before).length !== columns.length || columns.some((column) => !Object.hasOwn(before, column))) throw new Error(`${name}.remove private fact is invalid`);
      const current = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
      captureDeletedRowAnchor(db                                                 , name, before.id          , current, event.committedAt          );
      const predicates = columns.map((column) => `${column} IS :${column}`);
      const result = db.prepare(`DELETE FROM ${name} WHERE ${predicates.join(' AND ')}`).run(before);
      if (Number(result.changes) !== 1) throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
    }
  };
  return Object.freeze([Object.freeze({
    actionType: `${name}.create`,
    eventTypes: [verbs.created.type],
    privateFact: true,
    replay: false,
    apply,
  }), Object.freeze({
    actionType: `${name}.remove`,
    eventTypes: [verbs.removed.type],
    privateFact: true,
    replay: false,
    apply,
  })]);
}
