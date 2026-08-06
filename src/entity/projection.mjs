import { getLog } from '../log.mjs';
import { serializeField, flattenStruct, resolveStrategy, deserializeField } from '../field-strategy.mjs';
import * as eventHandle from '../event-handle.mjs';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.mjs';
import { CASCADE_DESCENDANT } from './removal-cascade.mjs';
import { applyTextOp, assertUtf16Offset, assertWellFormedText, canonicalTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.mjs';
import { applyTextOperationToBlock, createTextFamily, restoreTextFamilyCheckpoint, textFamilyCheckpoint, splitBlock, mergeBlocks, materializeBlock, resolvePositionToEndpoint, rgaTraversal } from '../annotated-text-family.mjs';
import { splitBlockMemberships, mergeBlocksMemberships, addMembership, removeMembership } from '../annotated-text-membership.mjs';
import { getAnnotatedTextCompiledMetadata, resolveDeclarationMeasurementExtension } from '../annotated-text-field.mjs';
import { deriveBlockPosition, frozenJsonSnapshot } from '../annotated-text-r2.mjs';
import { markAnnotatedEntityProjection } from '../annotated-text-history.mjs';

const INITIAL_BLOCK_POSITION = 'a0';

function defaultBlockCells(descriptor) {
  const cells = {};
  for (const [name, field] of Object.entries(descriptor.block ?? {})) {
    if (field.default === undefined) {
      if (field.nullable || field.optional) cells[name] = null;
      else throw new Error(`annotated-text block field '${name}' requires a default for initialization`);
    } else {
      const value = typeof field.default === 'function' ? field.default() : field.default;
      const materialized = value !== null && typeof value === 'object' ? structuredClone(value) : value;
      const strategy = resolveStrategy(field.kind);
      const structural = strategy.validate(materialized, field);
      if (structural !== true) throw new Error(`annotated-text block field '${name}': ${structural}`);
      if (typeof field.validate === 'function' && field.validate(materialized) !== true) {
        throw new Error(`annotated-text block field '${name}' failed validation`);
      }
      cells[name] = serializeField(field, materialized);
    }
  }
  return cells;
}

function initializeAnnotatedText({ name, fields, event, db, row }) {
  const metadata = event.data?.__workbench?.annotatedText;
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'annotatedText') continue;
    const imported = metadata?.[fieldName];
    const initialBlockId = imported?.initialBlockId;
    if (!imported || imported.version !== 1 || typeof imported.actor !== 'string' || !/^[0-9a-f]{32}$/.test(imported.actor) ||
        !Array.isArray(imported.blocks) || imported.blocks.length === 0 || typeof initialBlockId !== 'string' || initialBlockId.length === 0 ||
        imported.blocks[0]?.id !== initialBlockId) {
      throw new Error(`${name}.${fieldName} created event is missing initial block metadata`);
    }
    const prefix = `${name}_${fieldName}`;
    let textState = createTextState();
    const fullText = imported.blocks.map((block, index) => {
      if (!block || typeof block !== 'object' || Array.isArray(block) ||
          (Object.keys(block).length < 3 || Object.keys(block).length > 5) ||
          typeof block.id !== 'string' || block.id.length === 0 || typeof block.text !== 'string' ||
          (block.fields !== null && (!block.fields || typeof block.fields !== 'object' || Array.isArray(block.fields)))) {
        throw new Error(`${name}.${fieldName} created event has invalid imported block ${index}`);
      }
      for (const key of Object.keys(block)) if (!['id', 'text', 'fields', 'measurements'].includes(key)) throw new Error(`${name}.${fieldName} created event has unknown imported block key '${key}'`);
      assertWellFormedText(block.text);
      if (block.text.length === 0 && imported.blocks.some((candidate) => candidate.fields !== null)) throw new Error(`${name}.${fieldName} created event has an empty imported block`);
      return block.text;
    }).join('');
    if (fullText.length > 0) {
      textState = applyTextOp(textState, ['workbench.text', 1, [imported.actor, 1], 1, [], ['insert', ['root'], fullText]]);
    }
    let family = createTextFamily(row.id, textCheckpoint(textState), initialBlockId);
    let currentBlockId = initialBlockId;
    for (let index = 0; index < imported.blocks.length - 1; index++) {
      const split = splitBlock(family, currentBlockId, imported.blocks[index + 1].id, imported.blocks[index].text.length);
      if (split.type !== 'split') throw new Error(`${name}.${fieldName} created event import did not produce a block split`);
      family = split.family;
      currentBlockId = imported.blocks[index + 1].id;
    }
    const checkpoint = JSON.stringify(textFamilyCheckpoint(family));
    const state = db.prepare(`SELECT * FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
    const blocks = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ?`).all(row.id);
    if (state || blocks.length > 0) {
      const expected = state
        && state.structure_version === 1
        && state.family_checkpoint === checkpoint
        && blocks.length === imported.blocks.length
        && blocks.every((block, index) => block.id === imported.blocks[index].id && block.position === deriveBlockPosition(index) && block.epoch === 1 && block.structure_version === 1);
      if (!expected) throw new Error(`${name}.${fieldName} created projection conflicts with existing initialization`);
      continue;
    }
    db.prepare(`INSERT INTO ${prefix}_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)`)
      .run(row.id, checkpoint);
    for (let index = 0; index < imported.blocks.length; index++) {
      const importedBlock = imported.blocks[index];
      const cells = importedBlock.fields === null ? defaultBlockCells(descriptor) : {};
      if (importedBlock.fields !== null) {
        const declared = Object.keys(descriptor.block ?? {});
        if (Object.keys(importedBlock.fields).length !== declared.length || Object.keys(importedBlock.fields).some((key) => !declared.includes(key))) {
          throw new Error(`${name}.${fieldName} created event imported block fields disagree with declaration`);
        }
        for (const key of declared) {
          const field = descriptor.block[key];
          const strategy = resolveStrategy(field.kind);
          const validation = strategy.validate(importedBlock.fields[key], field);
          if (validation !== true || (typeof field.validate === 'function' && field.validate(importedBlock.fields[key]) !== true)) {
            throw new Error(`${name}.${fieldName} created event imported block field '${key}' failed validation`);
          }
          cells[key] = serializeField(field, importedBlock.fields[key]);
        }
      }
      const block = { id: importedBlock.id, document_id: row.id, project_id: row[descriptor.project], owner_id: row[descriptor.owner], position: deriveBlockPosition(index), epoch: 1, structure_version: 1, ...cells };
      const columns = Object.keys(block);
      db.prepare(`INSERT INTO ${prefix}_block (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`).run(block);
      db.prepare(`INSERT INTO ${prefix}_block_group (block_id, group_id) VALUES (?, ?)`).run(importedBlock.id, importedBlock.id);
      const importedMeasurements = importedBlock.measurements ?? [];
      if (!Array.isArray(importedMeasurements)) throw new Error(`${name}.${fieldName} created event imported measurements are invalid`);
      const families = new Set();
      for (const measurement of importedMeasurements) {
        if (!measurement || typeof measurement !== 'object' || Object.keys(measurement).length !== 4 || typeof measurement.id !== 'string' || typeof measurement.family !== 'string' || !Number.isSafeInteger(measurement.formatVersion) || !Object.hasOwn(measurement, 'payload')) throw new Error(`${name}.${fieldName} created event imported measurement is invalid`);
        if (families.has(measurement.family)) throw new Error(`${name}.${fieldName} created event has duplicate measurement family`);
        families.add(measurement.family);
        const config = descriptor.measurements.find((entry) => entry.measurementName === measurement.family);
        const extension = config && resolveDeclarationMeasurementExtension(config);
        if (!config || measurement.formatVersion !== config.formatVersion || !extension) throw new Error(`${name}.${fieldName} created event measurement declaration mismatch`);
        let payload;
        try { payload = frozenJsonSnapshot(measurement.payload); } catch { throw new Error(`${name}.${fieldName} created event measurement payload is not JSON`); }
        try { if (extension.validate({ version: 1, formatVersion: config.formatVersion, blockText: importedBlock.text, payload }) !== undefined) throw new Error('returned a value'); } catch { throw new Error(`${name}.${fieldName} created event measurement validation failed`); }
        db.prepare(`INSERT INTO ${prefix}_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, ?, ?, ?)`).run(measurement.id, importedBlock.id, measurement.family, config.formatVersion, JSON.stringify(payload));
      }
    }
  }
}

function applyAnnotatedTextOperation({ name, fields, handle, event, db, privateFact }) {
  if (handle.kind !== eventHandle.EventKind.native || handle.nativeName !== 'operated') return false;
  const descriptor = fields[handle.field];
  if (descriptor?.kind !== 'annotatedText') return false;
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated event has no data`);
  }
  if (data.version === 1) return applyR1AnnotatedTextOperation({ name, handle, db, data });
   if (data.version === 2) return applyStructuralSplitProjection({ name, handle, db, descriptor, data });
  if (data.version === 3) return applyR3AnnotatedTextOperation({ name, handle, db, descriptor, data });
  if (data.version === 4) return applyR4AnnotatedTextOperation({ name, handle, db, descriptor, data });
  if (data.version === 7) return applyR7AnnotatedTextOperation({ name, handle, db, descriptor, data });
  if (data.version === 5) return applyR5AnnotatedTextOperation({ name, handle, db, descriptor, data });
  if (data.version === 6) return applyR6AnnotatedTextOperation({ name, handle, db, data });
  if (data.version === 8) return applyR8AnnotatedTextOperation({ name, handle, db, descriptor, data, privateFact });
  throw new Error(`${name}.${handle.field}.operated event has unknown version ${data.version}`);
}

function stageBlockPositions(db, prefix, existingById) {
  for (const id of Object.keys(existingById)) {
    db.prepare(`UPDATE ${prefix}_block SET position = ? WHERE id = ?`).run(`~${id}`, id);
  }
}

function applyR8AnnotatedTextOperation({ name, handle, db, descriptor, data, privateFact }) {
  const prefix = `${name}_${handle.field}`;
  const shape = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort().join() : '';
   const structuralShape = 'after,before,blocks,family,id,measurements,memberships,operation,version';
   const splitAssignmentShape = 'after,annotation,before,blocks,family,groupMembership,id,measurements,memberships,operation,version';
   const assignmentShape = 'after,before,id,operation,postimage,preimage,removedAnnotationIds,version';
  const exactRevision = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === 'frontier,structuralRevision' && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);
  if (shape !== structuralShape && shape !== splitAssignmentShape && shape !== assignmentShape) throw new Error(`${name}.${handle.field}.operated v8 event has invalid data shape`);
  if (!exactRevision(data.before) || !exactRevision(data.after)) throw new Error(`${name}.${handle.field}.operated v8 event revisions are invalid`);
  if ((shape === structuralShape || shape === splitAssignmentShape) && (data.version !== 8 || typeof data.id !== 'string' || !data.operation || !data.before || !data.after || !Array.isArray(data.blocks) || !Array.isArray(data.memberships) || !Array.isArray(data.measurements))) throw new Error(`${name}.${handle.field}.operated v8 event has invalid structural data`);
  if (shape === assignmentShape && (data.version !== 8 || typeof data.id !== 'string' || !data.operation || !data.before || !data.after || !Array.isArray(data.preimage) || !Array.isArray(data.postimage) || !Array.isArray(data.removedAnnotationIds))) throw new Error(`${name}.${handle.field}.operated v8 event has invalid assignment data`);
  if (data.operation.kind === 'block.continue' || data.operation.kind === 'block.split-and-assign') {
    const expectedKeys = data.operation.kind === 'block.continue' ? ['groupId', 'kind', 'leftBlockId', 'rightBlockId', 'utf16Offset'] : ['kind', 'leftBlockId', 'leftGroupId', 'rightBlockId', 'rightGroupId', 'utf16Offset'];
    if (Object.keys(data.operation).sort().join() !== expectedKeys.join() || typeof data.operation.leftBlockId !== 'string' || typeof data.operation.rightBlockId !== 'string' || data.operation.leftBlockId === data.operation.rightBlockId || !Number.isSafeInteger(data.operation.utf16Offset) || data.operation.utf16Offset < 1) throw new Error(`${name}.${handle.field}.operated v8 operation is invalid`);
    if (data.operation.kind === 'block.continue' ? shape !== structuralShape : shape !== splitAssignmentShape) throw new Error(`${name}.${handle.field}.operated v8 structural fields are invalid`);
     const sourceGroup = db.prepare(`SELECT block_group.group_id FROM ${prefix}_block_group AS block_group JOIN ${prefix}_block AS block ON block.id = block_group.block_id WHERE block.id = ? AND block.document_id = ?`).get(data.operation.leftBlockId, data.id);
    if (!sourceGroup || sourceGroup.group_id !== (data.operation.kind === 'block.continue' ? data.operation.groupId : data.operation.leftGroupId)) throw new Error(`${name}.${handle.field}.operated v8 source group fact mismatch`);
    if (data.operation.kind === 'block.split-and-assign' && data.operation.rightGroupId !== data.operation.rightBlockId) throw new Error(`${name}.${handle.field}.operated v8 right group must equal right block`);
    if (data.operation.kind === 'block.split-and-assign') {
       const annotation = data.annotation;
      const decl = descriptor.annotations.find((a) => a.annotationName === annotation?.family);
      const meta = getAnnotatedTextCompiledMetadata(descriptor)?.annotationHandles?.[annotation?.family];
       if (!decl || !meta || decl.kind !== 'annotation' || meta.appliesTo !== 'block-group' || meta.cardinality !== 'one' || !annotation || Object.keys(annotation).sort().join() !== 'family,fields,id' || typeof annotation.id !== 'string' || !annotation.id || db.prepare(`SELECT 1 FROM ${prefix}_annotation WHERE id = ?`).get(annotation.id) || JSON.stringify(Object.keys(annotation.fields ?? {}).sort()) !== JSON.stringify(Object.keys(decl.fields).sort())) throw new Error(`${name}.${handle.field}.operated v8 split annotation invalid`);
      for (const [key, value] of Object.entries(annotation.fields)) {
        const result = resolveStrategy(decl.fields[key].kind).validate(value, decl.fields[key]);
        if (result !== true || (typeof decl.fields[key].validate === 'function' && decl.fields[key].validate(value) !== true)) throw new Error(`${name}.${handle.field}.operated v8 split annotation field invalid`);
      }
       if (!data.groupMembership || Object.keys(data.groupMembership).sort().join() !== 'annotationId,groupId,ordinal' || data.groupMembership.annotationId !== annotation.id || data.groupMembership.groupId !== data.operation.rightGroupId || data.groupMembership.ordinal !== 0) throw new Error(`${name}.${handle.field}.operated v8 group membership fact invalid`);
     }
     const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
     if (!state || state.structure_version !== data.before.structuralRevision || JSON.stringify(JSON.parse(state.family_checkpoint).checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v8 event conflicts with projection state`);
     if (data.after.structuralRevision !== data.before.structuralRevision + 1 || JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v8 event has inconsistent after revision`);
     const structural = {
       version: 2, id: data.id, before: data.before, after: data.after, family: data.family,
       blocks: data.blocks, memberships: data.memberships, measurements: data.measurements,
       operation: { kind: 'block.split', leftBlockId: data.operation.leftBlockId, rightBlockId: data.operation.rightBlockId, utf16Offset: data.operation.utf16Offset },
     };
    applyStructuralSplitProjection({ name, handle, db, descriptor, data: structural });
    if (data.operation.kind === 'block.split-and-assign') db.prepare(`UPDATE ${prefix}_block_group SET group_id = ? WHERE block_id = ?`).run(data.operation.rightGroupId, data.operation.rightBlockId);
    if (data.operation.kind === 'block.split-and-assign') {
       const annotation = data.annotation;
      const decl = descriptor.annotations.find((a) => a.annotationName === annotation.family);
      const source = db.prepare(`SELECT project_id, owner_id FROM ${prefix}_block WHERE id = ?`).get(data.operation.rightBlockId);
      db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`).run(annotation.id, data.id, source.project_id, source.owner_id, annotation.family);
      const names = Object.keys(decl.fields).sort();
      if (names.length) db.prepare(`INSERT INTO ${prefix}_annotation_${annotation.family} (annotation_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`).run(annotation.id, ...names.map((n) => serializeField(decl.fields[n], annotation.fields[n])));
      db.prepare(`INSERT INTO ${prefix}_group_membership (annotation_id, group_id, ordinal) VALUES (?, ?, 0)`).run(annotation.id, data.operation.rightGroupId);
    }
    return true;
  }
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state || state.structure_version !== data.before.structuralRevision || JSON.stringify(JSON.parse(state.family_checkpoint).checkpoint.frontier) !== JSON.stringify(data.before.frontier)) throw new Error(`${name}.${handle.field}.operated v8 event conflicts with projection state`);
  if (JSON.stringify(data.after) !== JSON.stringify(data.before)) throw new Error(`${name}.${handle.field}.operated v8 assignment event must not advance structural state`);
   if (!['block-group.assignment.set', 'block-group.assignment.clear'].includes(data.operation.kind) || !Array.isArray(data.operation.groupIds) || !Array.isArray(data.preimage) || !Array.isArray(data.postimage) || !Array.isArray(data.removedAnnotationIds)) throw new Error(`${name}.${handle.field}.operated v8 event operation is unsupported by projection`);
   const operationKeys = data.operation.kind.endsWith('.set') ? ['annotation', 'groupIds', 'kind'] : ['family', 'groupIds', 'kind'];
   if (Object.keys(data.operation).sort().join() !== operationKeys.join() || data.operation.groupIds.some((id) => typeof id !== 'string' || !id) || new Set(data.operation.groupIds).size !== data.operation.groupIds.length || (data.operation.kind.endsWith('.clear') && (typeof data.operation.family !== 'string' || !data.operation.family))) throw new Error(`${name}.${handle.field}.operated v8 assignment operation is invalid`);
   if (data.operation.kind.endsWith('.set')) {
     const annotation = data.operation.annotation;
     if (!annotation || Array.isArray(annotation) || Object.keys(annotation).sort().join() !== 'family,fields,id' || typeof annotation.id !== 'string' || !annotation.id || typeof annotation.family !== 'string' || !annotation.family || !annotation.fields || typeof annotation.fields !== 'object' || Array.isArray(annotation.fields)) throw new Error(`${name}.${handle.field}.operated v8 assignment annotation is invalid`);
   }
   if (data.before.structuralRevision !== data.after.structuralRevision || JSON.stringify(data.before.frontier) !== JSON.stringify(data.after.frontier)) throw new Error(`${name}.${handle.field}.operated v8 assignment revision mismatch`);
   const validImage = (image) => image.length === data.operation.groupIds.length && image.every((entry, index) => entry && !Array.isArray(entry) && Object.keys(entry).sort().join() === 'annotationId,groupId' && entry.groupId === data.operation.groupIds[index] && (entry.annotationId === null || (typeof entry.annotationId === 'string' && entry.annotationId.length > 0)));
   if (!validImage(data.preimage) || !validImage(data.postimage) || data.removedAnnotationIds.some((id) => typeof id !== 'string' || !id) || new Set(data.removedAnnotationIds).size !== data.removedAnnotationIds.length || JSON.stringify(data.removedAnnotationIds) !== JSON.stringify([...data.removedAnnotationIds].sort())) throw new Error(`${name}.${handle.field}.operated v8 assignment images are invalid`);
  const family = data.operation.kind.endsWith('.set') ? data.operation.annotation?.family : data.operation.family;
  const decl = descriptor.annotations.find((a) => a.annotationName === family);
  const meta = getAnnotatedTextCompiledMetadata(descriptor)?.annotationHandles?.[family];
  if (!decl || decl.kind !== 'annotation' || !meta || meta.appliesTo !== 'block-group' || meta.cardinality !== 'one') throw new Error(`${name}.${handle.field}.operated v8 event annotation family is invalid`);
   const groupIds = data.operation.groupIds;
   const resolvedGroups = db.prepare(`SELECT DISTINCT block_group.group_id FROM ${prefix}_block_group AS block_group JOIN ${prefix}_block AS block ON block.id = block_group.block_id AND block.document_id = ? WHERE block_group.group_id IN (${groupIds.map(() => '?').join(',')})`).all(data.id, ...groupIds);
   if (resolvedGroups.length !== groupIds.length) throw new Error(`${name}.${handle.field}.operated v8 group IDs are unknown or cross-document`);
  if (!groupIds.length || new Set(groupIds).size !== groupIds.length) throw new Error(`${name}.${handle.field}.operated v8 group IDs are invalid`);
  if (JSON.stringify(groupIds) !== JSON.stringify([...new Set(groupIds)].sort((a, b) => {
     const pa = db.prepare(`SELECT MIN(block.position) AS p FROM ${prefix}_block AS block JOIN ${prefix}_block_group AS block_group ON block_group.block_id = block.id WHERE block_group.group_id = ? AND block.document_id = ?` ).get(a, data.id)?.p ?? '';
     const pb = db.prepare(`SELECT MIN(block.position) AS p FROM ${prefix}_block AS block JOIN ${prefix}_block_group AS block_group ON block_group.block_id = block.id WHERE block_group.group_id = ? AND block.document_id = ?` ).get(b, data.id)?.p ?? '';
    return pa.localeCompare(pb);
  }))) throw new Error(`${name}.${handle.field}.operated v8 group IDs are not document ordered`);
  const expectedPreimage = groupIds.map((groupId) => ({ groupId, annotationId: db.prepare(`SELECT a.id FROM ${prefix}_group_membership m JOIN ${prefix}_annotation a ON a.id = m.annotation_id JOIN ${prefix}_block_group bg ON bg.group_id = m.group_id JOIN ${prefix}_block b ON b.id = bg.block_id WHERE m.group_id = ? AND a.family = ? AND a.document_id = ? AND b.document_id = ? LIMIT 1`).get(groupId, family, data.id, data.id)?.id ?? null }));
  if (JSON.stringify(data.preimage) !== JSON.stringify(expectedPreimage)) throw new Error(`${name}.${handle.field}.operated v8 preimage mismatch`);
  const expectedPostimage = expectedPreimage.map(({ groupId }) => ({ groupId, annotationId: data.operation.kind.endsWith('.set') ? data.operation.annotation?.id : null }));
  if (JSON.stringify(data.postimage) !== JSON.stringify(expectedPostimage)) throw new Error(`${name}.${handle.field}.operated v8 postimage mismatch`);
   const existing = db.prepare(`SELECT m.annotation_id, m.group_id FROM ${prefix}_group_membership AS m JOIN ${prefix}_annotation AS a ON a.id = m.annotation_id WHERE m.group_id IN (${groupIds.map(() => '?').join(',')}) AND a.document_id = ? AND a.family = ?`).all(...groupIds, data.id, family);
  const oldIds = [...new Set(existing.map((r) => r.annotation_id))];
  const selectedSet = new Set(groupIds);
  const expectedRemoved = oldIds.filter((id) => db.prepare(`SELECT group_id FROM ${prefix}_group_membership WHERE annotation_id = ? UNION SELECT '__block__' AS group_id FROM ${prefix}_membership WHERE annotation_id = ?`).all(id, id).every((membership) => membership.group_id !== '__block__' && selectedSet.has(membership.group_id))).sort();
  if (JSON.stringify(data.removedAnnotationIds) !== JSON.stringify(expectedRemoved)) throw new Error(`${name}.${handle.field}.operated v8 removal facts mismatch`);
  if (data.operation.kind.endsWith('.set')) {
    const dataAnnotation = data.operation.annotation;
     if (!dataAnnotation || typeof dataAnnotation.id !== 'string' || !dataAnnotation.id || dataAnnotation.family !== family || !dataAnnotation.fields || typeof dataAnnotation.fields !== 'object' || Array.isArray(dataAnnotation.fields) || Object.keys(dataAnnotation).length !== 3 || db.prepare(`SELECT 1 FROM ${prefix}_annotation WHERE id = ?`).get(dataAnnotation.id)) throw new Error(`${name}.${handle.field}.operated v8 event annotation id is not fresh`);
     const keys = Object.keys(dataAnnotation.fields ?? {}).sort();
     if (JSON.stringify(keys) !== JSON.stringify(Object.keys(decl.fields).sort())) throw new Error(`${name}.${handle.field}.operated v8 event annotation fields are invalid`);
     for (const [key, value] of Object.entries(dataAnnotation.fields)) {
       const result = resolveStrategy(decl.fields[key].kind).validate(value, decl.fields[key]);
       if (result !== true || (typeof decl.fields[key].validate === 'function' && decl.fields[key].validate(value) !== true)) throw new Error(`${name}.${handle.field}.operated v8 event annotation field is invalid`);
     }
    const source = db.prepare(`SELECT project_id, owner_id FROM ${prefix}_block WHERE document_id = ? ORDER BY position LIMIT 1`).get(data.id);
    db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`).run(dataAnnotation.id, data.id, source.project_id, source.owner_id, family);
    const names = Object.keys(decl.fields).sort();
    if (names.length) db.prepare(`INSERT INTO ${prefix}_annotation_${family} (annotation_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`).run(dataAnnotation.id, ...names.map((n) => serializeField(decl.fields[n], dataAnnotation.fields[n])));
    db.prepare(`DELETE FROM ${prefix}_group_membership WHERE group_id IN (${groupIds.map(() => '?').join(',')}) AND annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ? AND family = ?)`).run(...groupIds, data.id, family);
    for (const groupId of groupIds) db.prepare(`INSERT INTO ${prefix}_group_membership (annotation_id, group_id, ordinal) VALUES (?, ?, ?)`).run(dataAnnotation.id, groupId, groupIds.indexOf(groupId));
  } else {
    db.prepare(`DELETE FROM ${prefix}_group_membership WHERE group_id IN (${groupIds.map(() => '?').join(',')}) AND annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ? AND family = ?)`).run(...groupIds, data.id, family);
  }
   for (const id of expectedRemoved) if (!db.prepare(`SELECT 1 FROM ${prefix}_group_membership WHERE annotation_id = ? UNION SELECT annotation_id FROM ${prefix}_membership WHERE annotation_id = ?`).get(id, id)) db.prepare(`DELETE FROM ${prefix}_annotation WHERE id = ?`).run(id);
  return true;
}

function applyR5AnnotatedTextOperation({ name, handle, db, descriptor, data }) {
  const prefix = `${name}_${handle.field}`;
  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);
  const operation = data?.operation;
  if (!data || typeof data !== 'object' || Object.keys(data).length !== 7 || data.version !== 5 ||
      typeof data.id !== 'string' || data.id.length === 0 || !isVersion(data.before) || !isVersion(data.after) ||
      JSON.stringify(data.after) !== JSON.stringify(data.before) || !operation || typeof operation !== 'object' || Array.isArray(operation) ||
      JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(['annotationId', 'blockId', 'kind']) ||
      operation.kind !== 'annotation.detach' || typeof operation.annotationId !== 'string' || operation.annotationId.length === 0 ||
      typeof operation.blockId !== 'string' || operation.blockId.length === 0 || !data.lifecycle || typeof data.lifecycle !== 'object' || Array.isArray(data.lifecycle) ||
      Object.keys(data.lifecycle).length !== 1 || (data.lifecycle.empty !== 'delete' && data.lifecycle.empty !== 'orphan') || !data.result || typeof data.result !== 'object' || Array.isArray(data.result) ||
      JSON.stringify(Object.keys(data.result).sort()) !== JSON.stringify(['changedProtectors', 'disposition', 'memberships'])) {
    throw new Error(`${name}.${handle.field}.operated v5 event has invalid data`);
  }
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision || JSON.stringify(family.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v5 event conflicts with projection state`);
  }
  const sourceMemberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
       FROM ${prefix}_membership AS membership JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
      WHERE annotation.document_id = ?`,
  ).all(data.id);
  const memberships = sourceMemberships.map((membership) => ({
    annotationId: membership.annotation_id, blockId: membership.block_id, ordinal: membership.ordinal,
    start: JSON.parse(membership.start_point), end: JSON.parse(membership.end_point),
  }));
  const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ? ORDER BY id`).all(data.id);
  const targets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?) ORDER BY annotation_id, target_annotation_id`,
  ).all(data.id);
  const targetsByAnnotation = new Map();
  for (const target of targets) targetsByAnnotation.set(target.annotation_id, [...(targetsByAnnotation.get(target.annotation_id) ?? []), target.target_annotation_id]);
  const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
  const annotations = annotationRows.map((annotation) => {
    const metadata = compiledMeta.annotationHandles[annotation.family];
    if (!metadata) throw new Error(`${name}.${handle.field}.operated v5 event references unknown annotation family`);
    return { id: annotation.id, family: annotation.family, empty: annotation.id === operation.annotationId ? data.lifecycle.empty : metadata.empty, protectedTargetIds: targetsByAnnotation.get(annotation.id) ?? [] };
  });
  const targetAnnotation = annotations.find((annotation) => annotation.id === operation.annotationId);
  if (!targetAnnotation) throw new Error(`${name}.${handle.field}.operated v5 annotation not found`);
  let reduced;
  try {
    reduced = removeMembership(family, annotations, memberships, operation.annotationId, operation.blockId, { structuralRevision: state.structure_version });
  } catch {
    throw new Error(`${name}.${handle.field}.operated v5 operation is not applicable to projection state`);
  }
  const outcome = reduced.outcomes[0];
  const expected = {
    memberships: {
      annotationId: operation.annotationId,
      postimage: reduced.memberships.filter((membership) => membership.annotationId === operation.annotationId)
        .map((membership) => ({ blockId: membership.blockId, ordinal: membership.ordinal })),
    },
    disposition: !outcome
      ? { kind: 'retained' }
      : outcome.type === 'delete'
        ? { kind: 'deleted', family: targetAnnotation.family, savedQuote: null, lastMemberships: null }
        : { kind: 'orphaned', family: targetAnnotation.family, savedQuote: outcome.savedQuote, lastMemberships: outcome.lastMemberships },
    changedProtectors: reduced.annotations
      .filter((annotation) => JSON.stringify(annotation.protectedTargetIds ?? []) !== JSON.stringify(targetsByAnnotation.get(annotation.id) ?? []))
      .map((annotation) => ({ annotationId: annotation.id, protectsPostimage: annotation.protectedTargetIds ?? [] }))
      .sort((left, right) => left.annotationId.localeCompare(right.annotationId)),
  };
  if (JSON.stringify(data.result) !== JSON.stringify(expected)) throw new Error(`${name}.${handle.field}.operated v5 event result does not match derived state`);

  db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(operation.annotationId);
  for (const membership of reduced.memberships.filter((item) => item.annotationId === operation.annotationId)) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(membership.annotationId, membership.blockId, membership.ordinal, JSON.stringify(membership.start), JSON.stringify(membership.end));
  }
  for (const protector of expected.changedProtectors) {
    db.prepare(`DELETE FROM ${prefix}_annotation_protected_target WHERE annotation_id = ?`).run(protector.annotationId);
    for (const targetId of protector.protectsPostimage) {
      db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`).run(protector.annotationId, targetId);
    }
  }
  if (outcome?.type === 'delete') {
    db.prepare(`DELETE FROM ${prefix}_annotation WHERE id = ?`).run(operation.annotationId);
  } else if (outcome?.type === 'orphan') {
    db.prepare(`INSERT INTO ${prefix}_annotation_orphan_state (annotation_id, saved_quote, last_memberships) VALUES (?, ?, ?)`)
      .run(operation.annotationId, outcome.savedQuote, JSON.stringify(outcome.lastMemberships));
  }
  return true;
}

function applyR1AnnotatedTextOperation({ name, handle, db, data }) {
  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);
  const operation = data?.operation;
  if (Object.keys(data).length !== 6 || data.version !== 1 ||
      !isVersion(data.before) || !isVersion(data.after) ||
      !operation || typeof operation !== 'object' || Object.keys(operation).length !== 3 ||
      operation.kind !== 'text.apply' || typeof operation.blockId !== 'string' || operation.blockId.length === 0 ||
      !Object.hasOwn(operation, 'operation') || !data.family) {
    throw new Error(`${name}.${handle.field}.operated event has invalid composite data`);
  }
  let canonicalOperation;
  try {
    canonicalOperation = canonicalTextOp(operation.operation);
  } catch {
    throw new Error(`${name}.${handle.field}.operated event has invalid text operation`);
  }
  if (JSON.stringify(canonicalOperation) !== JSON.stringify(operation.operation)) {
    throw new Error(`${name}.${handle.field}.operated event text operation is not canonical`);
  }
  const prefix = `${name}_${handle.field}`;
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const current = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated event conflicts with projection state`);
  }
  const next = restoreTextFamilyCheckpoint(data.family);
  if (next.id !== data.id || JSON.stringify(textFamilyCheckpoint(next)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated event family is not canonical`);
  }
  if (data.after.structuralRevision !== data.before.structuralRevision ||
      data.after.structuralRevision !== state.structure_version ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(next.checkpoint.frontier)) {
    throw new Error(`${name}.${handle.field}.operated event has inconsistent post-state version`);
  }
  let reduced;
  try {
    reduced = applyTextOperationToBlock(current, operation.blockId, canonicalOperation);
  } catch {
    throw new Error(`${name}.${handle.field}.operated event text operation is not applicable to prior state`);
  }
  if (JSON.stringify(textFamilyCheckpoint(reduced)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated event family does not match its text operation`);
  }
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(data.after.structuralRevision, JSON.stringify(textFamilyCheckpoint(reduced)), data.id);
  getLog().debug('dispatch', `${name}.${handle.field}.operated`, { id: data.id });
  return true;
}

function applyR6AnnotatedTextOperation({ name, handle, db, data }) {
  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);
  const operation = data?.operation;
  if (Object.keys(data).length !== 6 || data.version !== 6 ||
      !isVersion(data.before) || !isVersion(data.after) ||
      !operation || typeof operation !== 'object' || Array.isArray(operation) ||
      JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(['blockId', 'kind', 'operations']) ||
      operation.kind !== 'text.replace' || typeof operation.blockId !== 'string' || operation.blockId.length === 0 ||
      !Array.isArray(operation.operations) || operation.operations.length !== 2 || !data.family) {
    throw new Error(`${name}.${handle.field}.operated v6 event has invalid composite data`);
  }
  const operations = operation.operations.map((candidate) => {
    let canonical;
    try { canonical = canonicalTextOp(candidate); } catch {
      throw new Error(`${name}.${handle.field}.operated v6 event has invalid text operation`);
    }
    if (JSON.stringify(canonical) !== JSON.stringify(candidate)) {
      throw new Error(`${name}.${handle.field}.operated v6 event text operation is not canonical`);
    }
    return canonical;
  });
  if (operations[0][5][0] !== 'delete' || operations[1][5][0] !== 'insert') {
    throw new Error(`${name}.${handle.field}.operated v6 event must contain delete then insert`);
  }

  const prefix = `${name}_${handle.field}`;
  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const current = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v6 event conflicts with projection state`);
  }
  const block = current.blocks.find((candidate) => candidate.id === operation.blockId);
  if (!block) throw new Error(`${name}.${handle.field}.operated v6 event block does not exist`);
  const deletedKeys = new Set();
  for (const [opId, first, count] of operations[0][5][1]) {
    for (let ordinal = first; ordinal < first + count; ordinal++) deletedKeys.add(`${opId[0]}:${opId[1]}:${ordinal}`);
  }
  const ownedKeys = new Set(block.elementKeys);
  const visibleElements = rgaTraversal(current.checkpoint)
    .filter(([, element]) => ownedKeys.has(`${element.op[0]}:${element.op[1]}:${element.ordinal}`) && element.deletedBy.length === 0);
  const deletedIndexes = visibleElements.flatMap(([key], index) => deletedKeys.has(key) ? [index] : []);
  if (deletedIndexes.length !== deletedKeys.size || deletedIndexes.length === 0 ||
      deletedIndexes.some((index, offset) => index !== deletedIndexes[0] + offset)) {
    throw new Error(`${name}.${handle.field}.operated v6 event deletion is not one contiguous visible range`);
  }
  const startOffset = visibleElements.slice(0, deletedIndexes[0]).reduce((total, [, element]) => total + element.scalar.length, 0);
  let leftAnchor;
  let rightAnchor;
  try {
    leftAnchor = resolvePositionToEndpoint(current, operation.blockId, startOffset, current.checkpoint.frontier, 'left').point[1];
    rightAnchor = resolvePositionToEndpoint(current, operation.blockId, startOffset, current.checkpoint.frontier, 'right').point[1];
  } catch {
    throw new Error(`${name}.${handle.field}.operated v6 event replacement start cannot be resolved`);
  }
  const insertAnchor = operations[1][5][1];
  if (JSON.stringify(insertAnchor) !== JSON.stringify(leftAnchor) && JSON.stringify(insertAnchor) !== JSON.stringify(rightAnchor)) {
    throw new Error(`${name}.${handle.field}.operated v6 event insertion is not anchored at the deleted range start`);
  }
  if (data.after.structuralRevision !== data.before.structuralRevision ||
      data.after.structuralRevision !== state.structure_version) {
    throw new Error(`${name}.${handle.field}.operated v6 event has inconsistent structural revision`);
  }

  let reduced = current;
  try {
    for (const textOperation of operations) {
      reduced = applyTextOperationToBlock(reduced, operation.blockId, textOperation);
    }
  } catch {
    throw new Error(`${name}.${handle.field}.operated v6 event operations are not applicable to prior state`);
  }
  const next = restoreTextFamilyCheckpoint(data.family);
  if (next.id !== data.id || JSON.stringify(textFamilyCheckpoint(next)) !== JSON.stringify(data.family) ||
      JSON.stringify(textFamilyCheckpoint(reduced)) !== JSON.stringify(data.family) ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(reduced.checkpoint.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v6 event family does not match its operations`);
  }
  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(data.after.structuralRevision, JSON.stringify(textFamilyCheckpoint(reduced)), data.id);
  getLog().debug('dispatch', `${name}.${handle.field}.operated v6`, { id: data.id });
  return true;
}

function applyStructuralSplitProjection({ name, handle, db, descriptor, data }) {
  const prefix = `${name}_${handle.field}`;
  const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
  const measurementConfigs = compiledMeta?.measurementConfigs ?? {};

  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);

  const operation = data.operation;
  if (Object.keys(data).length !== 9 || data.version !== 2 ||
      !isVersion(data.before) || !isVersion(data.after) ||
      !operation || typeof operation !== 'object' ||
      operation.kind !== 'block.split' ||
      typeof operation.leftBlockId !== 'string' || typeof operation.rightBlockId !== 'string' ||
      !Number.isInteger(operation.utf16Offset) || operation.utf16Offset < 0 ||
      !data.family || !data.blocks || !data.memberships || !data.measurements) {
    throw new Error(`${name}.${handle.field}.operated v2 event has invalid composite data`);
  }

  const { leftBlockId, rightBlockId, utf16Offset } = operation;

  if (!Array.isArray(data.blocks) || data.blocks.length !== 2) {
    throw new Error(`${name}.${handle.field}.operated v2 event blocks must have exactly 2 entries`);
  }
  const leftBlockFact = data.blocks[0];
  const rightBlockFact = data.blocks[1];
  if (leftBlockFact.id !== leftBlockId || rightBlockFact.id !== rightBlockId) {
    throw new Error(`${name}.${handle.field}.operated v2 event block fact IDs do not match operation`);
  }
  if (typeof leftBlockFact.epoch !== 'number' || typeof rightBlockFact.epoch !== 'number') {
    throw new Error(`${name}.${handle.field}.operated v2 event block facts must have epoch`);
  }

  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const current = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision ||
      JSON.stringify(current.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v2 event conflicts with projection state`);
  }

  const next = restoreTextFamilyCheckpoint(data.family);
  if (next.id !== data.id || JSON.stringify(textFamilyCheckpoint(next)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v2 event family is not canonical`);
  }

  const expectedAfterRevision = data.before.structuralRevision + 1;
  if (data.after.structuralRevision !== expectedAfterRevision ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v2 event has inconsistent after revision`);
  }

  let reduced;
  try {
    reduced = splitBlock(current, leftBlockId, rightBlockId, utf16Offset);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v2 event split is not applicable to prior state`);
  }
  if (reduced.type !== 'split') {
    throw new Error(`${name}.${handle.field}.operated v2 event split returned unchanged but event was emitted`);
  }
  if (JSON.stringify(textFamilyCheckpoint(reduced.family)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v2 event family does not match its split operation`);
  }

  const sourceBlock = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(leftBlockId);
  if (!sourceBlock) throw new Error(`${name}.${handle.field}.operated v2 source block not found`);
  const sourceGroup = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(leftBlockId);
  if (!sourceGroup || typeof sourceGroup.group_id !== 'string' || sourceGroup.group_id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated v2 source block group not found`);
  }
  if (sourceBlock.epoch !== leftBlockFact.epoch || sourceBlock.epoch !== rightBlockFact.epoch) {
    throw new Error(`${name}.${handle.field}.operated v2 event block fact epochs do not match source`);
  }

  const blockFieldNames = Object.keys(descriptor.block ?? {});
  for (const [factIdx, blockFact] of [leftBlockFact, rightBlockFact].entries()) {
    if (!blockFact.fields || typeof blockFact.fields !== 'object') {
      throw new Error(`${name}.${handle.field}.operated v2 event block fact ${factIdx} has no fields`);
    }
    const factFieldKeys = Object.keys(blockFact.fields).sort();
    if (JSON.stringify(factFieldKeys) !== JSON.stringify([...blockFieldNames].sort())) {
      throw new Error(`${name}.${handle.field}.operated v2 event block fact ${factIdx} fields do not match declaration`);
    }
  }
  for (const fieldName of blockFieldNames) {
    const sourceValue = deserializeField(descriptor.block[fieldName], sourceBlock[fieldName]);
    if (JSON.stringify(leftBlockFact.fields[fieldName]) !== JSON.stringify(sourceValue) ||
        JSON.stringify(rightBlockFact.fields[fieldName]) !== JSON.stringify(sourceValue)) {
      throw new Error(`${name}.${handle.field}.operated v2 event block fields do not match source`);
    }
  }

  const sourceMemberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
       FROM ${prefix}_membership AS membership
       JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
      WHERE annotation.document_id = ?`,
  ).all(data.id);
  const pureMemberships = sourceMemberships.map(m => ({
    annotationId: m.annotation_id,
    blockId: m.block_id,
    ordinal: m.ordinal,
    start: JSON.parse(m.start_point),
    end: JSON.parse(m.end_point),
  }));

  const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id);
  const pureAnnotations = annotationRows.map(a => ({ id: a.id, family: a.family }));

  const membershipResult = splitBlockMemberships(reduced.family, pureAnnotations, pureMemberships, leftBlockId, rightBlockId);
  const affectedAnnotationIds = new Set(pureMemberships.filter(m => m.blockId === leftBlockId).map(m => m.annotationId));
  const expectedMemberships = membershipResult.memberships.filter(m => affectedAnnotationIds.has(m.annotationId)).map(m => ({
    annotationId: m.annotationId,
    blockId: m.blockId,
    ordinal: m.ordinal,
    start: m.start,
    end: m.end,
  }));

  if (JSON.stringify(data.memberships) !== JSON.stringify(expectedMemberships)) {
    throw new Error(`${name}.${handle.field}.operated v2 event memberships do not match split membership projection`);
  }

  if (!Array.isArray(data.measurements)) {
    throw new Error(`${name}.${handle.field}.operated v2 event measurements must be an array`);
  }

  const sourceMeasurements = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(leftBlockId);

  if (data.measurements.length !== sourceMeasurements.length * 2) {
    throw new Error(`${name}.${handle.field}.operated v2 event measurement count mismatch`);
  }

  const sourceByFamily = {};
  const sourceIds = new Set();
  for (const sm of sourceMeasurements) {
    sourceByFamily[sm.family] = sm;
    sourceIds.add(sm.id);
  }

  const seenIds = new Set();
  for (let i = 0; i < data.measurements.length; i += 2) {
    const leftFact = data.measurements[i];
    const rightFact = data.measurements[i + 1];

    for (const [factName, fact] of [['left', leftFact], ['right', rightFact]]) {
      if (!fact || typeof fact !== 'object' || Array.isArray(fact) ||
          JSON.stringify(Object.keys(fact).sort()) !== JSON.stringify(['blockId', 'family', 'formatVersion', 'id', 'payload'])) {
        throw new Error(`${name}.${handle.field}.operated v2 event ${factName} measurement fact has invalid shape`);
      }
    }

    if (leftFact.family !== rightFact.family) {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement pair family mismatch`);
    }
    const family = leftFact.family;
    const sourceRow = sourceByFamily[family];
    if (!sourceRow) {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement family '${family}' has no source row`);
    }

    if (leftFact.id !== sourceRow.id) {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement left id does not match source`);
    }
    if (rightFact.id === sourceRow.id || sourceIds.has(rightFact.id)) {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement right id collides with a source`);
    }
    if (seenIds.has(rightFact.id)) {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement right id is not unique`);
    }
    seenIds.add(rightFact.id);

    const config = measurementConfigs[family];
    if (!config || leftFact.blockId !== leftBlockId || rightFact.blockId !== rightBlockId ||
        leftFact.formatVersion !== sourceRow.format_version || rightFact.formatVersion !== sourceRow.format_version ||
        leftFact.formatVersion !== config.formatVersion) {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement block or format version mismatch`);
    }

    try {
      if (JSON.stringify(leftFact.payload) === undefined || JSON.stringify(rightFact.payload) === undefined) {
        throw new Error('measurement payload is not JSON');
      }
    } catch {
      throw new Error(`${name}.${handle.field}.operated v2 event measurement payload is not valid JSON`);
    }
  }

  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(data.after.structuralRevision, JSON.stringify(textFamilyCheckpoint(reduced.family)), data.id);

  const blockColumns = ['id', 'document_id', 'project_id', 'owner_id', 'position', 'epoch', 'structure_version', ...blockFieldNames];
  const blockParamNames = blockColumns.map(c => `:${c}`).join(', ');
  const blockColumnNames = blockColumns.join(', ');

  const familyBlocks = reduced.family.blocks;

  const blocksToUpdate = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ?`).all(data.id);
  const existingById = {};
  for (const b of blocksToUpdate) existingById[b.id] = b;

  if (!existingById[leftBlockId]) {
    throw new Error(`${name}.${handle.field}.operated v2 source block vanished before projection`);
  }
  if (existingById[rightBlockId]) {
    throw new Error(`${name}.${handle.field}.operated v2 right block already exists`);
  }
  for (const fb of familyBlocks) {
    if (!existingById[fb.id] && fb.id !== rightBlockId) {
      throw new Error(`${name}.${handle.field}.operated v2 family references unknown block '${fb.id}'`);
    }
  }
  stageBlockPositions(db, prefix, existingById);

  for (const [index, fb] of familyBlocks.entries()) {
    const pos = deriveBlockPosition(index);
    const bid = fb.id;
    const existing = existingById[bid];
    if (existing) {
      if (existing.structure_version >= data.after.structuralRevision) {
        throw new Error(`${name}.${handle.field}.operated v2 block '${bid}' structure_version already at or past target`);
      }
      db.prepare(`UPDATE ${prefix}_block SET position = ?, structure_version = ? WHERE id = ?`)
        .run(pos, data.after.structuralRevision, bid);
    } else {
      const blockRow = {
        id: bid,
        document_id: data.id,
        project_id: sourceBlock.project_id,
        owner_id: sourceBlock.owner_id,
        position: pos,
        epoch: rightBlockFact.epoch,
        structure_version: data.after.structuralRevision,
      };
      for (const bf of blockFieldNames) {
        blockRow[bf] = serializeField(descriptor.block[bf], rightBlockFact.fields[bf]);
      }
      db.prepare(`INSERT INTO ${prefix}_block (${blockColumnNames}) VALUES (${blockParamNames})`).run(blockRow);
      db.prepare(`INSERT INTO ${prefix}_block_group (block_id, group_id) VALUES (?, ?)`).run(bid, sourceGroup.group_id);
    }
  }

  for (const annId of affectedAnnotationIds) {
    db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(annId);
  }

  for (const m of membershipResult.memberships.filter(m => affectedAnnotationIds.has(m.annotationId))) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(m.annotationId, m.blockId, m.ordinal, JSON.stringify(m.start), JSON.stringify(m.end));
  }

  for (let i = 0; i < data.measurements.length; i += 2) {
    const leftFact = data.measurements[i];
    const rightFact = data.measurements[i + 1];
    db.prepare(`UPDATE ${prefix}_measurement SET block_id = ?, family = ?, format_version = ?, payload = ? WHERE id = ?`)
      .run(leftFact.blockId, leftFact.family, leftFact.formatVersion, JSON.stringify(leftFact.payload), leftFact.id);
    db.prepare(`INSERT INTO ${prefix}_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(rightFact.id, rightFact.blockId, rightFact.family, rightFact.formatVersion, JSON.stringify(rightFact.payload));
  }

  getLog().debug('dispatch', `${name}.${handle.field}.operated v2`, { id: data.id, leftBlockId, rightBlockId });
  return true;
}

function applyR3AnnotatedTextOperation({ name, handle, db, descriptor, data }) {
  const prefix = `${name}_${handle.field}`;
  const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
  const measurementConfigs = compiledMeta?.measurementConfigs ?? {};
  const measurementFamilyList = compiledMeta?.measurementFamilyList ?? [];

  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);

  const operation = data.operation;
  if (Object.keys(data).length !== 9 || data.version !== 3 ||
      !isVersion(data.before) || !isVersion(data.after) ||
      !operation || typeof operation !== 'object' ||
      operation.kind !== 'block.merge' ||
      typeof operation.leftBlockId !== 'string' || typeof operation.rightBlockId !== 'string' ||
      !data.family || !data.block || !data.memberships || !data.measurements) {
    throw new Error(`${name}.${handle.field}.operated v3 event has invalid composite data`);
  }

  const { leftBlockId, rightBlockId } = operation;
  if (leftBlockId === rightBlockId) {
    throw new Error(`${name}.${handle.field}.operated v3 event left and right block IDs must differ`);
  }

  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const currentFamily = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision ||
      JSON.stringify(currentFamily.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v3 event conflicts with projection state`);
  }

  const next = restoreTextFamilyCheckpoint(data.family);
  if (next.id !== data.id || JSON.stringify(textFamilyCheckpoint(next)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v3 event family is not canonical`);
  }

  const expectedAfterRevision = data.before.structuralRevision + 1;
  if (data.after.structuralRevision !== expectedAfterRevision ||
      JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v3 event has inconsistent after revision`);
  }

  let reduced;
  try {
    reduced = mergeBlocks(currentFamily, leftBlockId, rightBlockId);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v3 event merge is not applicable to prior state`);
  }
  if (JSON.stringify(textFamilyCheckpoint(reduced)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v3 event family does not match its merge operation`);
  }

  const leftBlockStored = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(leftBlockId);
  if (!leftBlockStored) throw new Error(`${name}.${handle.field}.operated v3 left block not found`);
  const rightBlockStored = db.prepare(`SELECT * FROM ${prefix}_block WHERE id = ?`).get(rightBlockId);
  if (!rightBlockStored) throw new Error(`${name}.${handle.field}.operated v3 right block not found`);
  if (rightBlockStored.epoch !== leftBlockStored.epoch) {
    throw new Error(`${name}.${handle.field}.operated v3 event right block epoch must equal left block epoch`);
  }

  const blockFieldNames = Object.keys(descriptor.block ?? {});

  const leftBlockCells = {};
  for (const bf of blockFieldNames) {
    const bd = descriptor.block[bf];
    leftBlockCells[bf] = deserializeField(bd, leftBlockStored[bf]);
  }

  const rightBlockCells = {};
  for (const bf of blockFieldNames) {
    const bd = descriptor.block[bf];
    rightBlockCells[bf] = deserializeField(bd, rightBlockStored[bf]);
  }

  if (JSON.stringify(rightBlockCells) !== JSON.stringify(leftBlockCells)) {
    throw new Error(`${name}.${handle.field}.operated v3 event right block cells must equal left block cells`);
  }

  const blockFact = data.block;
  if (!blockFact || typeof blockFact !== 'object' || Array.isArray(blockFact) ||
      JSON.stringify(Object.keys(blockFact).sort()) !== JSON.stringify(['cells', 'epoch', 'id'].sort()) ||
      blockFact.id !== leftBlockId || blockFact.epoch !== leftBlockStored.epoch) {
    throw new Error(`${name}.${handle.field}.operated v3 event block fact does not match stored left block`);
  }
  const factCellKeys = Object.keys(blockFact.cells).sort();
  if (JSON.stringify(factCellKeys) !== JSON.stringify([...blockFieldNames].sort())) {
    throw new Error(`${name}.${handle.field}.operated v3 event block fact cells do not match declaration`);
  }
  for (const fieldName of blockFieldNames) {
    if (JSON.stringify(blockFact.cells[fieldName]) !== JSON.stringify(leftBlockCells[fieldName])) {
      throw new Error(`${name}.${handle.field}.operated v3 event block fact cells do not match stored left block`);
    }
  }

  const sourceMemberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
       FROM ${prefix}_membership AS membership
       JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
      WHERE annotation.document_id = ?`,
  ).all(data.id);
  const pureMemberships = sourceMemberships.map(m => ({
    annotationId: m.annotation_id,
    blockId: m.block_id,
    ordinal: m.ordinal,
    start: JSON.parse(m.start_point),
    end: JSON.parse(m.end_point),
  }));

  const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id);
  const pureAnnotations = annotationRows.map(a => ({ id: a.id, family: a.family }));

  let membershipResult;
  try {
    membershipResult = mergeBlocksMemberships(currentFamily, pureAnnotations, pureMemberships, leftBlockId, rightBlockId);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v3 event membership merge is not applicable to prior state`);
  }

  const affectedAnnotationIds = new Set(pureMemberships.filter(m => m.blockId === leftBlockId || m.blockId === rightBlockId).map(m => m.annotationId));
  const expectedMemberships = membershipResult.memberships.filter(m => affectedAnnotationIds.has(m.annotationId)).map(m => ({
    annotationId: m.annotationId,
    blockId: m.blockId,
    ordinal: m.ordinal,
    start: m.start,
    end: m.end,
  }));

  if (JSON.stringify(data.memberships) !== JSON.stringify(expectedMemberships)) {
    throw new Error(`${name}.${handle.field}.operated v3 event memberships do not match merge membership projection`);
  }

  if (!Array.isArray(data.measurements)) {
    throw new Error(`${name}.${handle.field}.operated v3 event measurements must be an array`);
  }

  const expectedKeys = ['family', 'formatVersion', 'leftSource', 'rightSource', 'result', 'removedId'];

  const leftMeasRows = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(leftBlockId);
  const rightMeasRows = db.prepare(`SELECT id, family, format_version, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family`).all(rightBlockId);

  const leftMeasByFamily = {};
  for (const row of leftMeasRows) leftMeasByFamily[row.family] = row;
  const rightMeasByFamily = {};
  for (const row of rightMeasRows) rightMeasByFamily[row.family] = row;

  const leftFamilies = leftMeasRows.map(r => r.family);
  const rightFamilies = rightMeasRows.map(r => r.family);
  const allSourceFamilies = new Set([...leftFamilies, ...rightFamilies]);

  const factFamilies = data.measurements.map(f => f.family);
  const factFamilySet = new Set(factFamilies);

  if (factFamilies.length !== factFamilySet.size) {
    throw new Error(`${name}.${handle.field}.operated v3 event measurements contain duplicate families`);
  }
  if (factFamilies.length !== allSourceFamilies.size) {
    throw new Error(`${name}.${handle.field}.operated v3 event measurement family count does not match source rows`);
  }
  for (const family of allSourceFamilies) {
    if (!factFamilySet.has(family)) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurements missing family '${family}' present in source blocks`);
    }
  }
  for (const family of factFamilies) {
    if (!allSourceFamilies.has(family)) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurements contain family '${family}' not present in source blocks`);
    }
  }
  for (const family of factFamilies) {
    if (!measurementConfigs[family]) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact has unknown family '${family}'`);
    }
  }

  const factSnapshots = [];

  for (let i = 0; i < data.measurements.length; i++) {
    const fact = data.measurements[i];
    if (!fact || typeof fact !== 'object' || Array.isArray(fact) ||
        JSON.stringify(Object.keys(fact).sort()) !== JSON.stringify([...expectedKeys].sort())) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} has invalid shape`);
    }

    if (typeof fact.family !== 'string' || typeof fact.formatVersion !== 'number') {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} has invalid family or formatVersion`);
    }

    const config = measurementConfigs[fact.family];
    if (!config) throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} has unknown family '${fact.family}'`);
    if (fact.formatVersion !== config.formatVersion) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} format version does not match declaration`);
    }

    const leftSource = fact.leftSource;
    const rightSource = fact.rightSource;
    const result = fact.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(['blockId', 'id', 'payload'].sort())) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} result has invalid shape`);
    }
    if (typeof result.id !== 'string' || result.id.length === 0) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} result id must be a nonempty string`);
    }
    if (result.blockId !== leftBlockId) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} result blockId must be left blockId`);
    }
    const removedId = fact.removedId;

    const leftRow = leftMeasByFamily[fact.family];
    const rightRow = rightMeasByFamily[fact.family];

    if (leftSource === null) {
      if (leftRow) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource must be non-null when left has a row for family '${fact.family}'`);
      }
    } else {
      if (!leftRow) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource must be null when left has no row for family '${fact.family}'`);
      }
      if (typeof leftSource !== 'object' || Array.isArray(leftSource) ||
          JSON.stringify(Object.keys(leftSource).sort()) !== JSON.stringify(['blockId', 'id', 'payload'].sort())) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource has invalid shape`);
      }
      if (leftSource.blockId !== leftBlockId) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource blockId must be left block`);
      }
      if (leftSource.id !== leftRow.id) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource id does not match stored row`);
      }
      if (leftRow.family !== fact.family) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource family does not match fact`);
      }
      if (leftRow.format_version !== fact.formatVersion) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource format_version does not match fact`);
      }
      if (JSON.stringify(JSON.parse(leftRow.payload)) !== JSON.stringify(leftSource.payload)) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} leftSource payload does not match stored row`);
      }
      frozenJsonSnapshot(leftSource.payload);
      if (result.id !== leftSource.id) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} result id must be leftSource id when leftSource is present`);
      }
    }

    if (rightSource === null) {
      if (rightRow) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource must be non-null when right has a row for family '${fact.family}'`);
      }
    } else {
      if (!rightRow) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource must be null when right has no row for family '${fact.family}'`);
      }
      if (typeof rightSource !== 'object' || Array.isArray(rightSource) ||
          JSON.stringify(Object.keys(rightSource).sort()) !== JSON.stringify(['blockId', 'id', 'payload'].sort())) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource has invalid shape`);
      }
      if (rightSource.blockId !== rightBlockId) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource blockId must be right block`);
      }
      if (rightSource.id !== rightRow.id) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource id does not match stored row`);
      }
      if (rightRow.family !== fact.family) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource family does not match fact`);
      }
      if (rightRow.format_version !== fact.formatVersion) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource format_version does not match fact`);
      }
      if (JSON.stringify(JSON.parse(rightRow.payload)) !== JSON.stringify(rightSource.payload)) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} rightSource payload does not match stored row`);
      }
      frozenJsonSnapshot(rightSource.payload);
      if (leftSource === null && result.id !== rightSource.id) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} result id must be rightSource id when only rightSource is present`);
      }
    }

    if (leftSource !== null && rightSource !== null) {
      if (removedId !== rightSource.id) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} removedId must be rightSource id when both sources present`);
      }
    } else if (leftSource === null && rightSource === null) {
      throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} has both sources null`);
    } else {
      if (removedId !== null) {
        throw new Error(`${name}.${handle.field}.operated v3 event measurement fact ${i} removedId must be null when one source is absent`);
      }
    }

    const resultSnapshot = frozenJsonSnapshot(result.payload);
    factSnapshots.push(resultSnapshot);
  }

  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(data.after.structuralRevision, JSON.stringify(textFamilyCheckpoint(reduced)), data.id);

  const familyBlocks = reduced.blocks;
  const blocksToUpdate = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ?`).all(data.id);
  const existingById = {};
  for (const b of blocksToUpdate) existingById[b.id] = b;

  if (!existingById[leftBlockId]) {
    throw new Error(`${name}.${handle.field}.operated v3 left block vanished before projection`);
  }
  if (!existingById[rightBlockId]) {
    throw new Error(`${name}.${handle.field}.operated v3 right block vanished before projection`);
  }
  stageBlockPositions(db, prefix, existingById);

  for (const [index, fb] of familyBlocks.entries()) {
    const pos = deriveBlockPosition(index);
    const bid = fb.id;
    const existing = existingById[bid];
    if (!existing) {
      throw new Error(`${name}.${handle.field}.operated v3 family references unknown block '${bid}'`);
    }
    if (existing.structure_version >= data.after.structuralRevision) {
      throw new Error(`${name}.${handle.field}.operated v3 block '${bid}' structure_version already at or past target`);
    }
    db.prepare(`UPDATE ${prefix}_block SET position = ?, structure_version = ? WHERE id = ?`)
      .run(pos, data.after.structuralRevision, bid);
  }

  for (const annId of affectedAnnotationIds) {
    db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(annId);
  }

  for (const m of membershipResult.memberships.filter(m => affectedAnnotationIds.has(m.annotationId))) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(m.annotationId, m.blockId, m.ordinal, JSON.stringify(m.start), JSON.stringify(m.end));
  }

  for (let fi = 0; fi < data.measurements.length; fi++) {
    const fact = data.measurements[fi];
    const result = fact.result;
    const removedId = fact.removedId;

    if (removedId) {
      db.prepare(`DELETE FROM ${prefix}_measurement WHERE id = ?`).run(removedId);
    }

    db.prepare(`UPDATE ${prefix}_measurement SET block_id = ?, payload = ? WHERE id = ?`)
      .run(result.blockId, JSON.stringify(factSnapshots[fi]), result.id);
  }

  db.prepare(`DELETE FROM ${prefix}_block WHERE id = ?`).run(rightBlockId);

  getLog().debug('dispatch', `${name}.${handle.field}.operated v3`, { id: data.id, leftBlockId, rightBlockId });
  return true;
}

function applyR4AnnotatedTextOperation({ name, handle, db, descriptor, data }) {
  const prefix = `${name}_${handle.field}`;
  const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
  const measurementConfigs = compiledMeta?.measurementConfigs ?? {};

  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);

  const operation = data.operation;
  if ((Object.keys(data).length !== 13 && Object.keys(data).length !== 14) || data.version !== 4 ||
      (Object.keys(data).length === 14 &&
        (!Object.hasOwn(data, 'actorId') ||
          (data.actorId !== null && (typeof data.actorId !== 'string' || data.actorId.length === 0 || data.actorId.length > 200)))) ||
      !isVersion(data.before) || !isVersion(data.after) ||
      !operation || typeof operation !== 'object' || Array.isArray(operation) ||
      JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(['annotation', 'kind', 'selection']) ||
      operation.kind !== 'annotation.apply' ||
      !operation.selection || !operation.annotation ||
      !data.family || !data.annotation || !data.splitBlockIds || !data.selectedBlockId ||
      !data.splitOps || !data.blocks || !data.memberships || !data.measurements) {
    throw new Error(`${name}.${handle.field}.operated v4 event has invalid composite data`);
  }

  const { blockId, startUtf16Offset, endUtf16Offset } = operation.selection;
  if (typeof operation.selection !== 'object' || Array.isArray(operation.selection) ||
      JSON.stringify(Object.keys(operation.selection).sort()) !== JSON.stringify(['blockId', 'endUtf16Offset', 'startUtf16Offset']) ||
      typeof blockId !== 'string' || blockId.length === 0 ||
      !Number.isSafeInteger(startUtf16Offset) || startUtf16Offset < 0 ||
      !Number.isSafeInteger(endUtf16Offset) || endUtf16Offset < 0) {
    throw new Error(`${name}.${handle.field}.operated v4 event has invalid selection in operation`);
  }

  const annOp = operation.annotation;
  if (typeof annOp !== 'object' || Array.isArray(annOp) ||
      JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annOp).includes('protectedTargetIds') ? ['family', 'fields', 'id', 'protectedTargetIds'] : ['family', 'fields', 'id']) ||
      typeof annOp.id !== 'string' || annOp.id.length === 0 ||
      typeof annOp.family !== 'string' || annOp.family.length === 0 ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields) ||
      (annOp.protectedTargetIds !== undefined && (!Array.isArray(annOp.protectedTargetIds) || annOp.protectedTargetIds.some((id, index, ids) => typeof id !== 'string' || id.length === 0 || (index > 0 && ids[index - 1] >= id))))) {
    throw new Error(`${name}.${handle.field}.operated v4 event has invalid annotation in operation`);
  }

  const evAnn = data.annotation;
  if (!evAnn || typeof evAnn !== 'object' || Array.isArray(evAnn) ||
      JSON.stringify(Object.keys(evAnn).sort()) !== JSON.stringify(Object.keys(evAnn).includes('protectedTargetIds') ? ['family', 'fields', 'id', 'protectedTargetIds'] : ['family', 'fields', 'id']) ||
      evAnn.id !== annOp.id || evAnn.family !== annOp.family ||
      JSON.stringify(evAnn.fields) !== JSON.stringify(annOp.fields) ||
      JSON.stringify(evAnn.protectedTargetIds ?? []) !== JSON.stringify(annOp.protectedTargetIds ?? [])) {
    throw new Error(`${name}.${handle.field}.operated v4 event annotation facts do not match operation`);
  }

  if (!Array.isArray(data.splitBlockIds)) {
    throw new Error(`${name}.${handle.field}.operated v4 event splitBlockIds must be an array`);
  }
  if (typeof data.selectedBlockId !== 'string' || data.selectedBlockId.length === 0) {
    throw new Error(`${name}.${handle.field}.operated v4 event selectedBlockId must be a non-empty string`);
  }
  if (!Array.isArray(data.splitOps)) {
    throw new Error(`${name}.${handle.field}.operated v4 event splitOps must be an array`);
  }
  if (!Array.isArray(data.blocks)) {
    throw new Error(`${name}.${handle.field}.operated v4 event blocks must be an array`);
  }
  if (!Array.isArray(data.memberships)) {
    throw new Error(`${name}.${handle.field}.operated v4 event memberships must be an array`);
  }
  if (!Array.isArray(data.measurements)) {
    throw new Error(`${name}.${handle.field}.operated v4 event measurements must be an array`);
  }

  if (data.splitOps.length !== data.splitBlockIds.length) {
    throw new Error(`${name}.${handle.field}.operated v4 event splitOps length does not match splitBlockIds`);
  }

  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const currentFamily = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision ||
      JSON.stringify(currentFamily.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v4 event conflicts with projection state`);
  }

  let sourceBlockText;
  try {
    sourceBlockText = materializeBlock(currentFamily, blockId);
    assertUtf16Offset(sourceBlockText, startUtf16Offset);
    assertUtf16Offset(sourceBlockText, endUtf16Offset);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v4 event selection is not a valid UTF-16 range in its source block`);
  }
  if (startUtf16Offset >= endUtf16Offset || endUtf16Offset > sourceBlockText.length) {
    throw new Error(`${name}.${handle.field}.operated v4 event selection must be non-empty and within its source block`);
  }

  const anySplit = data.splitOps.length > 0;

  const expectedSplitCount = (startUtf16Offset > 0 ? 1 : 0) + (endUtf16Offset < sourceBlockText.length ? 1 : 0);
  if (data.splitOps.length !== expectedSplitCount || data.splitOps.length > 2 ||
      new Set(data.splitBlockIds).size !== data.splitBlockIds.length ||
      data.splitBlockIds.some((id) => typeof id !== 'string' || id.length === 0 || id === blockId)) {
    throw new Error(`${name}.${handle.field}.operated v4 event split count or IDs do not match selection topology`);
  }

  if (anySplit) {
    const expectedAfterRevision = data.before.structuralRevision + 1;
    if (data.after.structuralRevision !== expectedAfterRevision ||
        JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) {
      throw new Error(`${name}.${handle.field}.operated v4 event has inconsistent after revision`);
    }
  } else {
    if (data.after.structuralRevision !== data.before.structuralRevision ||
        JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) {
      throw new Error(`${name}.${handle.field}.operated v4 event has inconsistent after revision (no splits)`);
    }
  }

  const next = restoreTextFamilyCheckpoint(data.family);
  if (next.id !== data.id || JSON.stringify(textFamilyCheckpoint(next)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v4 event family is not canonical`);
  }

  let reduced = currentFamily;
  let selectedBlockId = blockId;
  for (const [idx, sop] of data.splitOps.entries()) {
    const newBlockId = data.splitBlockIds[idx];
    const expectedBlockId = idx === 0 ? blockId : selectedBlockId;
    const expectedOffset = idx === 0 && startUtf16Offset > 0
      ? startUtf16Offset
      : (startUtf16Offset > 0 ? endUtf16Offset - startUtf16Offset : endUtf16Offset);
    if (sop.newBlockId !== newBlockId) {
      throw new Error(`${name}.${handle.field}.operated v4 event splitOp ${idx} newBlockId does not match splitBlockIds`);
    }
    if (!sop || typeof sop !== 'object' || Array.isArray(sop) ||
        JSON.stringify(Object.keys(sop).sort()) !== JSON.stringify(['blockId', 'newBlockId', 'utf16Offset']) ||
        typeof sop.blockId !== 'string' || sop.blockId.length === 0 ||
        !Number.isSafeInteger(sop.utf16Offset) || sop.utf16Offset < 0 ||
        sop.blockId !== expectedBlockId || sop.utf16Offset !== expectedOffset) {
      throw new Error(`${name}.${handle.field}.operated v4 event splitOp ${idx} has invalid shape`);
    }
    try {
      reduced = splitBlock(reduced, sop.blockId, newBlockId, sop.utf16Offset);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v4 event split ${idx} is not applicable to prior state`);
    }
    if (reduced.type === 'unchanged') {
      throw new Error(`${name}.${handle.field}.operated v4 event split ${idx} returned unchanged but event was emitted`);
    }
    reduced = reduced.family;
    if (idx === 0 && startUtf16Offset > 0) selectedBlockId = newBlockId;
  }

  if (JSON.stringify(textFamilyCheckpoint(reduced)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v4 event family does not match its splits`);
  }

  if (data.selectedBlockId !== selectedBlockId) {
    throw new Error(`${name}.${handle.field}.operated v4 event selectedBlockId does not match derived selected block`);
  }

  if (data.blocks.length !== data.splitOps.length * 2) {
    throw new Error(`${name}.${handle.field}.operated v4 event blocks count must be 2 per split`);
  }

  const blockFieldNames = Object.keys(descriptor.block ?? {});
  for (let i = 0; i < data.blocks.length; i++) {
    const bf = data.blocks[i];
    if (!bf || typeof bf !== 'object' || Array.isArray(bf) ||
        JSON.stringify(Object.keys(bf).sort()) !== JSON.stringify(['epoch', 'fields', 'id'].sort()) ||
        typeof bf.id !== 'string' || bf.id.length === 0 ||
        typeof bf.epoch !== 'number') {
      throw new Error(`${name}.${handle.field}.operated v4 event block fact ${i} has invalid shape`);
    }
    if (!bf.fields || typeof bf.fields !== 'object' || Array.isArray(bf.fields)) {
      throw new Error(`${name}.${handle.field}.operated v4 event block fact ${i} has no fields`);
    }
    const factFieldKeys = Object.keys(bf.fields).sort();
    if (JSON.stringify(factFieldKeys) !== JSON.stringify([...blockFieldNames].sort())) {
      throw new Error(`${name}.${handle.field}.operated v4 event block fact ${i} fields do not match declaration`);
    }
  }

  const sourceMemberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
       FROM ${prefix}_membership AS membership
       JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
      WHERE annotation.document_id = ?`,
  ).all(data.id);
  const pureMemberships = sourceMemberships.map(m => ({
    annotationId: m.annotation_id,
    blockId: m.block_id,
    ordinal: m.ordinal,
    start: JSON.parse(m.start_point),
    end: JSON.parse(m.end_point),
  }));

  const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id);
  const protectedTargets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?) ORDER BY annotation_id, target_annotation_id`,
  ).all(data.id);
  const targetsByAnnotation = new Map();
  for (const target of protectedTargets) {
    const ids = targetsByAnnotation.get(target.annotation_id) ?? [];
    ids.push(target.target_annotation_id);
    targetsByAnnotation.set(target.annotation_id, ids);
  }
  const pureAnnotations = annotationRows.map(a => ({ id: a.id, family: a.family, protectedTargetIds: targetsByAnnotation.get(a.id) ?? [] }));

  let derivedMemberships = pureMemberships;
  let derivedAnnotations = pureAnnotations;

  for (const sop of data.splitOps) {
    const mResult = splitBlockMemberships(reduced, derivedAnnotations, derivedMemberships, sop.blockId, sop.newBlockId);
    derivedAnnotations = mResult.annotations;
    derivedMemberships = mResult.memberships;
  }

  const basisFrontier = reduced.checkpoint.frontier;
  const selectedBlockText = materializeBlock(reduced, selectedBlockId);
  let startEndpoint;
  let endEndpoint;
  try {
    startEndpoint = resolvePositionToEndpoint(reduced, selectedBlockId, 0, basisFrontier);
    endEndpoint = resolvePositionToEndpoint(reduced, selectedBlockId, selectedBlockText.length, basisFrontier);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v4 event failed to resolve selected block endpoints`);
  }

  const virtualAnnotations = [...derivedAnnotations, { id: evAnn.id, family: evAnn.family, protectedTargetIds: evAnn.protectedTargetIds ?? [] }];
  let addMembershipResult;
  try {
    addMembershipResult = addMembership(reduced, virtualAnnotations, derivedMemberships, evAnn.id, selectedBlockId, startEndpoint, endEndpoint);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v4 event membership addition is not applicable to derived state`);
  }

  const splitAffectedIds = new Set(
    pureMemberships.filter((membership) => membership.blockId === blockId).map((membership) => membership.annotationId),
  );
  const expectedMemberships = addMembershipResult.memberships.filter(m => m.annotationId === evAnn.id || splitAffectedIds.has(m.annotationId)).map(m => ({
    annotationId: m.annotationId,
    blockId: m.blockId,
    ordinal: m.ordinal,
    start: m.start,
    end: m.end,
  }));

  if (JSON.stringify(data.memberships) !== JSON.stringify(expectedMemberships)) {
    throw new Error(`${name}.${handle.field}.operated v4 event memberships do not match derived state`);
  }

  const annotationFamilyMeta = compiledMeta.annotationFields[evAnn.family];
  const annotationDescriptor = descriptor.annotations.find((entry) => entry.annotationName === evAnn.family);
  if (!annotationFamilyMeta || !annotationDescriptor) {
    throw new Error(`${name}.${handle.field}.operated v4 event references unknown annotation family '${evAnn.family}'`);
  }
  if (compiledMeta.annotationHandles[evAnn.family]?.appliesTo !== 'block') {
    throw new Error(`${name}.${handle.field}.operated v4 event annotation family '${evAnn.family}' must apply to blocks`);
  }
  const protectedTargetIds = evAnn.protectedTargetIds ?? [];
  if (protectedTargetIds.length !== 0 &&
      (annotationDescriptor.kind !== 'protectingAnnotation' || annotationDescriptor.protects === null)) {
    throw new Error(`${name}.${handle.field}.operated v4 event only protecting annotations with a declared target family may name protected targets`);
  }
  if (annotationDescriptor.kind === 'protectingAnnotation' && annotationDescriptor.protects !== null) {
    for (const targetId of protectedTargetIds) {
      const target = db.prepare(`SELECT family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(targetId, data.id);
      if (!target || target.family !== annotationDescriptor.protects) {
        throw new Error(`${name}.${handle.field}.operated v4 event protected target '${targetId}' is invalid`);
      }
    }
  }
  const familyFieldNames = Object.keys(annotationDescriptor.fields).sort();
  const evFieldNames = Object.keys(evAnn.fields).sort();
  if (JSON.stringify(evFieldNames) !== JSON.stringify(familyFieldNames)) {
    throw new Error(`${name}.${handle.field}.operated v4 event annotation fields do not match declaration for family '${evAnn.family}'`);
  }
  for (const key of familyFieldNames) {
    const desc = annotationDescriptor.fields[key];
    const strategy = resolveStrategy(desc.kind);
    const validationResult = strategy.validate(evAnn.fields[key], desc);
    if (validationResult !== true) {
      throw new Error(`${name}.${handle.field}.operated v4 event annotation field '${key}' validation failed: ${validationResult}`);
    }
    if (typeof desc.validate === 'function' && desc.validate(evAnn.fields[key]) !== true) {
      throw new Error(`${name}.${handle.field}.operated v4 event annotation field '${key}' failed declared validation`);
    }
  }

  const existingAnn = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ?`).get(evAnn.id);
  if (existingAnn) {
    throw new Error(`${name}.${handle.field}.operated v4 event annotation id '${evAnn.id}' already exists`);
  }

  const sourceMeasurements = db.prepare(
    `SELECT id, family, format_version FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family, id`,
  ).all(blockId);
  const measurementDescendantBlockIds = new Set(
    reduced.blocks.filter((entry) => entry.id === blockId || data.splitBlockIds.includes(entry.id)).map((entry) => entry.id),
  );
  if (!anySplit && data.measurements.length !== 0) {
    throw new Error(`${name}.${handle.field}.operated v4 event has measurement facts without a split`);
  }
  if (anySplit && data.measurements.length !== sourceMeasurements.length * (data.splitOps.length + 1)) {
    throw new Error(`${name}.${handle.field}.operated v4 event measurement count does not match split lineage`);
  }
  const sourceMeasurementIds = new Set(sourceMeasurements.map((row) => row.id));
  const factsByFamily = new Map();
  const seenMeasurementIds = new Set();
  const measKeys = ['blockId', 'family', 'formatVersion', 'id', 'payload'];
  for (let i = 0; i < data.measurements.length; i++) {
    const mf = data.measurements[i];
    if (!mf || typeof mf !== 'object' || Array.isArray(mf) ||
        JSON.stringify(Object.keys(mf).sort()) !== JSON.stringify(measKeys.sort()) ||
        typeof mf.id !== 'string' || mf.id.length === 0 ||
        typeof mf.blockId !== 'string' || !measurementDescendantBlockIds.has(mf.blockId) ||
        typeof mf.family !== 'string' || typeof mf.formatVersion !== 'number' || seenMeasurementIds.has(mf.id)) {
      throw new Error(`${name}.${handle.field}.operated v4 event measurement fact ${i} has invalid lineage`);
    }
    seenMeasurementIds.add(mf.id);
    const source = sourceMeasurements.find((row) => row.family === mf.family);
    const config = measurementConfigs[mf.family];
    if (!source || !config || mf.formatVersion !== source.format_version || mf.formatVersion !== config.formatVersion) {
      throw new Error(`${name}.${handle.field}.operated v4 event measurement fact ${i} has invalid family or format version`);
    }
    try {
      frozenJsonSnapshot(mf.payload);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v4 event measurement fact ${i} payload is not JSON`);
    }
    const facts = factsByFamily.get(mf.family) ?? [];
    facts.push(mf);
    factsByFamily.set(mf.family, facts);
  }
  for (const source of sourceMeasurements) {
    const facts = factsByFamily.get(source.family) ?? [];
    if (facts.length !== data.splitOps.length + 1 ||
        !facts.some((fact) => fact.id === source.id && fact.blockId === blockId) ||
        facts.some((fact) => sourceMeasurementIds.has(fact.id) && fact.id !== source.id)) {
      throw new Error(`${name}.${handle.field}.operated v4 event measurement facts do not preserve source lineage for '${source.family}'`);
    }
  }
  for (const fact of data.measurements) {
    const existing = db.prepare(`SELECT id FROM ${prefix}_measurement WHERE id = ?`).get(fact.id);
    if ((sourceMeasurementIds.has(fact.id) && (!existing || fact.id !== existing.id)) ||
        (!sourceMeasurementIds.has(fact.id) && existing)) {
      throw new Error(`${name}.${handle.field}.operated v4 event measurement ID does not have fresh source lineage`);
    }
  }

  const blockColumns = ['id', 'document_id', 'project_id', 'owner_id', 'position', 'epoch', 'structure_version', ...blockFieldNames];
  const blockParamNames = blockColumns.map(c => `:${c}`).join(', ');
  const blockColumnNames = blockColumns.join(', ');

  const familyBlocks = reduced.blocks;
  const blocksToUpdate = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ?`).all(data.id);
  const existingById = {};
  for (const b of blocksToUpdate) existingById[b.id] = b;

  for (const bid of data.splitBlockIds) {
    if (existingById[bid]) {
      throw new Error(`${name}.${handle.field}.operated v4 block '${bid}' already exists`);
    }
  }
  if (!existingById[blockId]) {
    throw new Error(`${name}.${handle.field}.operated v4 source block '${blockId}' not found`);
  }
  const sourceBlock = existingById[blockId];
  const sourceGroup = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(blockId);
  if (!sourceGroup || typeof sourceGroup.group_id !== 'string' || sourceGroup.group_id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated v4 source block group not found`);
  }

  const blockFactById = {};
  for (const bf of data.blocks) blockFactById[bf.id] = bf;

  const virtualStoredBlocks = new Map([[blockId, sourceBlock]]);
  for (const [index, split] of data.splitOps.entries()) {
    const leftFact = data.blocks[index * 2];
    const rightFact = data.blocks[index * 2 + 1];
    const source = virtualStoredBlocks.get(split.blockId);
    if (!source || leftFact.id !== split.blockId || rightFact.id !== split.newBlockId ||
        leftFact.epoch !== source.epoch || rightFact.epoch !== source.epoch) {
      throw new Error(`${name}.${handle.field}.operated v4 event block facts do not match split ${index} source`);
    }
    for (const fieldName of blockFieldNames) {
      const sourceValue = deserializeField(descriptor.block[fieldName], source[fieldName]);
      if (JSON.stringify(leftFact.fields[fieldName]) !== JSON.stringify(sourceValue) ||
          JSON.stringify(rightFact.fields[fieldName]) !== JSON.stringify(sourceValue)) {
        throw new Error(`${name}.${handle.field}.operated v4 event block facts do not copy split ${index} source cells`);
      }
    }
    virtualStoredBlocks.set(split.newBlockId, source);
  }

  if (anySplit) stageBlockPositions(db, prefix, existingById);

  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(data.after.structuralRevision, JSON.stringify(textFamilyCheckpoint(reduced)), data.id);

  for (const [index, fb] of familyBlocks.entries()) {
    const pos = deriveBlockPosition(index);
    const bid = fb.id;
    const existing = existingById[bid];
    if (existing) {
      if (!anySplit) continue;
      if (existing.structure_version >= data.after.structuralRevision) {
        throw new Error(`${name}.${handle.field}.operated v4 block '${bid}' structure_version already at or past target`);
      }
      db.prepare(`UPDATE ${prefix}_block SET position = ?, structure_version = ? WHERE id = ?`)
        .run(pos, data.after.structuralRevision, bid);
    } else {
      const blockFact = blockFactById[bid];
      if (!blockFact) {
        throw new Error(`${name}.${handle.field}.operated v4 family references unknown block '${bid}'`);
      }
      const blockRow = {
        id: bid,
        document_id: data.id,
        project_id: sourceBlock.project_id,
        owner_id: sourceBlock.owner_id,
        position: pos,
        epoch: blockFact.epoch,
        structure_version: data.after.structuralRevision,
      };
      for (const bf of blockFieldNames) {
        blockRow[bf] = serializeField(descriptor.block[bf], blockFact.fields[bf]);
      }
      db.prepare(`INSERT INTO ${prefix}_block (${blockColumnNames}) VALUES (${blockParamNames})`).run(blockRow);
      db.prepare(`INSERT INTO ${prefix}_block_group (block_id, group_id) VALUES (?, ?)`).run(bid, sourceGroup.group_id);
    }
  }

  for (const annId of splitAffectedIds) {
    db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(annId);
  }

  for (const m of addMembershipResult.memberships.filter(m => splitAffectedIds.has(m.annotationId))) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(m.annotationId, m.blockId, m.ordinal, JSON.stringify(m.start), JSON.stringify(m.end));
  }

  db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
    .run(evAnn.id, data.id, sourceBlock.project_id, data.actorId != null && typeof data.actorId === 'string' && data.actorId.length > 0 ? data.actorId : sourceBlock.owner_id, evAnn.family);

  for (const targetId of protectedTargetIds) {
    db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`)
      .run(evAnn.id, targetId);
  }

  const familyTable = `${prefix}_annotation_${evAnn.family}`;
  const familyFieldNamesArray = Object.keys(annotationDescriptor.fields);
  if (familyFieldNamesArray.length > 0) {
    const famCols = ['annotation_id', ...familyFieldNamesArray];
    const famValues = [evAnn.id];
    for (const key of familyFieldNamesArray) {
      famValues.push(serializeField(annotationDescriptor.fields[key], evAnn.fields[key]));
    }
    db.prepare(`INSERT INTO ${familyTable} (${famCols.join(', ')}) VALUES (${famValues.map(() => '?').join(', ')})`)
      .run(...famValues);
  }

  for (const m of addMembershipResult.memberships.filter(m => m.annotationId === evAnn.id)) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(m.annotationId, m.blockId, m.ordinal, JSON.stringify(m.start), JSON.stringify(m.end));
  }

  for (let i = 0; i < data.measurements.length; i++) {
    const mf = data.measurements[i];
    const existingMeas = db.prepare(`SELECT id FROM ${prefix}_measurement WHERE id = ?`).get(mf.id);
    if (existingMeas) {
      db.prepare(`UPDATE ${prefix}_measurement SET block_id = ?, family = ?, format_version = ?, payload = ? WHERE id = ?`)
        .run(mf.blockId, mf.family, mf.formatVersion, JSON.stringify(mf.payload), mf.id);
    } else {
      db.prepare(`INSERT INTO ${prefix}_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, ?, ?, ?)`)
        .run(mf.id, mf.blockId, mf.family, mf.formatVersion, JSON.stringify(mf.payload));
    }
  }

  getLog().debug('dispatch', `${name}.${handle.field}.operated v4`, { id: data.id, annotationId: evAnn.id, selectedBlockId });
  return true;
}

function applyR7AnnotatedTextOperation({ name, handle, db, descriptor, data }) {
  const prefix = `${name}_${handle.field}`;
  const compiledMeta = getAnnotatedTextCompiledMetadata(descriptor);
  const measurementConfigs = compiledMeta?.measurementConfigs ?? {};

  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);

  const operation = data.operation;
   const generalized = Array.isArray(data.selectedBlockIds);
   const expectedDataKeys = ['actorId', 'after', 'annotation', 'before', 'blocks', 'family', 'id', 'measurements', 'memberships', 'operation', 'selectedBlockId', 'selectedBlockIds', 'splitBlockIds', 'splitOps', 'version'];
   if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(expectedDataKeys.sort()) || data.version !== 7 ||
       (data.actorId !== null && (typeof data.actorId !== 'string' || data.actorId.length === 0 || data.actorId.length > 200)) ||
      !isVersion(data.before) || !isVersion(data.after) ||
      !operation || typeof operation !== 'object' || Array.isArray(operation) ||
       JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(['annotation', 'kind', 'selection']) ||
      operation.kind !== 'annotation.apply' ||
      !operation.selection || !operation.annotation ||
       !data.family || !data.annotation || !data.splitBlockIds || !data.selectedBlockId || !data.selectedBlockIds ||
      !data.splitOps || !data.blocks || !data.memberships || !data.measurements) {
    throw new Error(`${name}.${handle.field}.operated v7 event has invalid composite data`);
  }

  const { blockId, startUtf16Offset, endUtf16Offset } = operation.selection;
  const endBlockId = operation.selection.endBlockId;
  if (typeof operation.selection !== 'object' || Array.isArray(operation.selection) ||
       JSON.stringify(Object.keys(operation.selection).sort()) !== JSON.stringify(['blockId', 'endBlockId', 'endUtf16Offset', 'startBlockId', 'startUtf16Offset'].sort()) ||
       operation.selection.startBlockId !== blockId ||
      typeof blockId !== 'string' || blockId.length === 0 ||
      !Number.isSafeInteger(startUtf16Offset) || startUtf16Offset < 0 ||
      !Number.isSafeInteger(endUtf16Offset) || endUtf16Offset < 0) {
    throw new Error(`${name}.${handle.field}.operated v7 event has invalid selection in operation`);
  }

  const annOp = operation.annotation;
  if (typeof annOp !== 'object' || Array.isArray(annOp) ||
      JSON.stringify(Object.keys(annOp).sort()) !== JSON.stringify(Object.keys(annOp).includes('protectedTargetIds') ? ['family', 'fields', 'id', 'protectedTargetIds'] : ['family', 'fields', 'id']) ||
      typeof annOp.id !== 'string' || annOp.id.length === 0 ||
      typeof annOp.family !== 'string' || annOp.family.length === 0 ||
      !annOp.fields || typeof annOp.fields !== 'object' || Array.isArray(annOp.fields) ||
      (annOp.protectedTargetIds !== undefined && (!Array.isArray(annOp.protectedTargetIds) || annOp.protectedTargetIds.some((id, index, ids) => typeof id !== 'string' || id.length === 0 || (index > 0 && ids[index - 1] >= id))))) {
    throw new Error(`${name}.${handle.field}.operated v7 event has invalid annotation in operation`);
  }

  const evAnn = data.annotation;
  if (!evAnn || typeof evAnn !== 'object' || Array.isArray(evAnn) ||
      JSON.stringify(Object.keys(evAnn).sort()) !== JSON.stringify(Object.keys(evAnn).includes('protectedTargetIds') ? ['family', 'fields', 'id', 'protectedTargetIds'] : ['family', 'fields', 'id']) ||
      evAnn.id !== annOp.id || evAnn.family !== annOp.family ||
      JSON.stringify(evAnn.fields) !== JSON.stringify(annOp.fields) ||
      JSON.stringify(evAnn.protectedTargetIds ?? []) !== JSON.stringify(annOp.protectedTargetIds ?? [])) {
    throw new Error(`${name}.${handle.field}.operated v7 event annotation facts do not match operation`);
  }

  if (!Array.isArray(data.splitBlockIds)) {
    throw new Error(`${name}.${handle.field}.operated v7 event splitBlockIds must be an array`);
  }
  if (typeof data.selectedBlockId !== 'string' || data.selectedBlockId.length === 0) {
    throw new Error(`${name}.${handle.field}.operated v7 event selectedBlockId must be a non-empty string`);
  }
  if (!Array.isArray(data.splitOps)) {
    throw new Error(`${name}.${handle.field}.operated v7 event splitOps must be an array`);
  }
  if (!Array.isArray(data.blocks)) {
    throw new Error(`${name}.${handle.field}.operated v7 event blocks must be an array`);
  }
  if (!Array.isArray(data.memberships)) {
    throw new Error(`${name}.${handle.field}.operated v7 event memberships must be an array`);
  }
  if (!Array.isArray(data.measurements)) {
    throw new Error(`${name}.${handle.field}.operated v7 event measurements must be an array`);
  }

  if (data.splitOps.length !== data.splitBlockIds.length) {
    throw new Error(`${name}.${handle.field}.operated v7 event splitOps length does not match splitBlockIds`);
  }

  const state = db.prepare(`SELECT structure_version, family_checkpoint FROM ${prefix}_state WHERE document_id = ?`).get(data.id);
  if (!state) throw new Error(`${name}.${handle.field}.operated document does not exist`);
  const currentFamily = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  if (state.structure_version !== data.before.structuralRevision ||
      JSON.stringify(currentFamily.checkpoint.frontier) !== JSON.stringify(data.before.frontier)) {
    throw new Error(`${name}.${handle.field}.operated v7 event conflicts with projection state`);
  }

  let sourceBlockText;
  let endBlockText;
  try {
    sourceBlockText = materializeBlock(currentFamily, blockId);
    endBlockText = materializeBlock(currentFamily, endBlockId);
    assertUtf16Offset(sourceBlockText, startUtf16Offset);
    assertUtf16Offset(endBlockText, endUtf16Offset);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v7 event selection is not a valid UTF-16 range in its source block`);
  }
  const sourceIndex = currentFamily.blocks.findIndex((block) => block.id === blockId);
  const endIndex = currentFamily.blocks.findIndex((block) => block.id === endBlockId);
  if (sourceIndex < 0 || endIndex < sourceIndex || startUtf16Offset > sourceBlockText.length || endUtf16Offset > endBlockText.length ||
      (sourceIndex === endIndex && startUtf16Offset >= endUtf16Offset)) {
    throw new Error(`${name}.${handle.field}.operated v7 event selection must be non-empty and within its source block`);
  }

  const anySplit = data.splitOps.length > 0;

  const expectedSplitCount = (startUtf16Offset > 0 ? 1 : 0) + (endUtf16Offset < endBlockText.length ? 1 : 0);
  if (data.splitOps.length !== expectedSplitCount || data.splitOps.length > 2 ||
      new Set(data.splitBlockIds).size !== data.splitBlockIds.length ||
      data.splitBlockIds.some((id) => typeof id !== 'string' || id.length === 0 || id === blockId)) {
    throw new Error(`${name}.${handle.field}.operated v7 event split count or IDs do not match selection topology`);
  }

  if (anySplit) {
    const expectedAfterRevision = data.before.structuralRevision + 1;
    if (data.after.structuralRevision !== expectedAfterRevision ||
        JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) {
      throw new Error(`${name}.${handle.field}.operated v7 event has inconsistent after revision`);
    }
  } else {
    if (data.after.structuralRevision !== data.before.structuralRevision ||
        JSON.stringify(data.after.frontier) !== JSON.stringify(data.before.frontier)) {
      throw new Error(`${name}.${handle.field}.operated v7 event has inconsistent after revision (no splits)`);
    }
  }

  const next = restoreTextFamilyCheckpoint(data.family);
  if (next.id !== data.id || JSON.stringify(textFamilyCheckpoint(next)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v7 event family is not canonical`);
  }

  let reduced = currentFamily;
  let selectedBlockId = blockId;
  for (const [idx, sop] of data.splitOps.entries()) {
    const newBlockId = data.splitBlockIds[idx];
    const isStartSplit = idx === 0 && startUtf16Offset > 0;
    const expectedBlockId = isStartSplit ? blockId : (blockId === endBlockId && startUtf16Offset > 0 ? selectedBlockId : endBlockId);
    const expectedOffset = isStartSplit ? startUtf16Offset : (blockId === endBlockId && startUtf16Offset > 0 ? endUtf16Offset - startUtf16Offset : endUtf16Offset);
    if (sop.newBlockId !== newBlockId) {
      throw new Error(`${name}.${handle.field}.operated v7 event splitOp ${idx} newBlockId does not match splitBlockIds`);
    }
    if (!sop || typeof sop !== 'object' || Array.isArray(sop) ||
        JSON.stringify(Object.keys(sop).sort()) !== JSON.stringify(['blockId', 'newBlockId', 'utf16Offset']) ||
        typeof sop.blockId !== 'string' || sop.blockId.length === 0 ||
        !Number.isSafeInteger(sop.utf16Offset) || sop.utf16Offset < 0 ||
        sop.blockId !== expectedBlockId || sop.utf16Offset !== expectedOffset) {
      throw new Error(`${name}.${handle.field}.operated v7 event splitOp ${idx} has invalid shape`);
    }
    try {
      reduced = splitBlock(reduced, sop.blockId, newBlockId, sop.utf16Offset);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v7 event split ${idx} is not applicable to prior state`);
    }
    if (reduced.type === 'unchanged') {
      throw new Error(`${name}.${handle.field}.operated v7 event split ${idx} returned unchanged but event was emitted`);
    }
    reduced = reduced.family;
    if (idx === 0 && startUtf16Offset > 0) selectedBlockId = newBlockId;
  }

  if (JSON.stringify(textFamilyCheckpoint(reduced)) !== JSON.stringify(data.family)) {
    throw new Error(`${name}.${handle.field}.operated v7 event family does not match its splits`);
  }

  if (data.selectedBlockId !== selectedBlockId) {
    throw new Error(`${name}.${handle.field}.operated v7 event selectedBlockId does not match derived selected block`);
  }
  const selectedBlockIds = generalized
    ? data.selectedBlockIds
    : [selectedBlockId];
  if (!Array.isArray(selectedBlockIds) || selectedBlockIds.length === 0 ||
      selectedBlockIds.some((id) => typeof id !== 'string' || id.length === 0) ||
      JSON.stringify(selectedBlockIds) !== JSON.stringify(reduced.blocks.slice(reduced.blocks.findIndex((b) => b.id === selectedBlockId), reduced.blocks.findIndex((b) => b.id === endBlockId) + 1).map((b) => b.id))) {
    throw new Error(`${name}.${handle.field}.operated v7 event selected block postimage is invalid`);
  }

  if (data.blocks.length !== data.splitOps.length * 2) {
    throw new Error(`${name}.${handle.field}.operated v7 event blocks count must be 2 per split`);
  }

  const blockFieldNames = Object.keys(descriptor.block ?? {});
  for (let i = 0; i < data.blocks.length; i++) {
    const bf = data.blocks[i];
    if (!bf || typeof bf !== 'object' || Array.isArray(bf) ||
        JSON.stringify(Object.keys(bf).sort()) !== JSON.stringify(['epoch', 'fields', 'id'].sort()) ||
        typeof bf.id !== 'string' || bf.id.length === 0 ||
        typeof bf.epoch !== 'number') {
      throw new Error(`${name}.${handle.field}.operated v7 event block fact ${i} has invalid shape`);
    }
    if (!bf.fields || typeof bf.fields !== 'object' || Array.isArray(bf.fields)) {
      throw new Error(`${name}.${handle.field}.operated v7 event block fact ${i} has no fields`);
    }
    const factFieldKeys = Object.keys(bf.fields).sort();
    if (JSON.stringify(factFieldKeys) !== JSON.stringify([...blockFieldNames].sort())) {
      throw new Error(`${name}.${handle.field}.operated v7 event block fact ${i} fields do not match declaration`);
    }
  }

  const sourceMemberships = db.prepare(
    `SELECT membership.annotation_id, membership.block_id, membership.ordinal, membership.start_point, membership.end_point
       FROM ${prefix}_membership AS membership
       JOIN ${prefix}_annotation AS annotation ON annotation.id = membership.annotation_id
      WHERE annotation.document_id = ?`,
  ).all(data.id);
  const pureMemberships = sourceMemberships.map(m => ({
    annotationId: m.annotation_id,
    blockId: m.block_id,
    ordinal: m.ordinal,
    start: JSON.parse(m.start_point),
    end: JSON.parse(m.end_point),
  }));

  const annotationRows = db.prepare(`SELECT id, family FROM ${prefix}_annotation WHERE document_id = ?`).all(data.id);
  const protectedTargets = db.prepare(
    `SELECT annotation_id, target_annotation_id FROM ${prefix}_annotation_protected_target WHERE annotation_id IN (SELECT id FROM ${prefix}_annotation WHERE document_id = ?) ORDER BY annotation_id, target_annotation_id`,
  ).all(data.id);
  const targetsByAnnotation = new Map();
  for (const target of protectedTargets) {
    const ids = targetsByAnnotation.get(target.annotation_id) ?? [];
    ids.push(target.target_annotation_id);
    targetsByAnnotation.set(target.annotation_id, ids);
  }
  const pureAnnotations = annotationRows.map(a => ({ id: a.id, family: a.family, protectedTargetIds: targetsByAnnotation.get(a.id) ?? [] }));

  let derivedMemberships = pureMemberships;
  let derivedAnnotations = pureAnnotations;

  for (const sop of data.splitOps) {
    const mResult = splitBlockMemberships(reduced, derivedAnnotations, derivedMemberships, sop.blockId, sop.newBlockId);
    derivedAnnotations = mResult.annotations;
    derivedMemberships = mResult.memberships;
  }

  const basisFrontier = reduced.checkpoint.frontier;
  const selectedBlockText = materializeBlock(reduced, selectedBlockId);
  let startEndpoint;
  let endEndpoint;
  try {
    startEndpoint = resolvePositionToEndpoint(reduced, selectedBlockId, 0, basisFrontier);
    endEndpoint = resolvePositionToEndpoint(reduced, selectedBlockId, selectedBlockText.length, basisFrontier);
  } catch {
    throw new Error(`${name}.${handle.field}.operated v7 event failed to resolve selected block endpoints`);
  }

  const virtualAnnotations = [...derivedAnnotations, { id: evAnn.id, family: evAnn.family, protectedTargetIds: evAnn.protectedTargetIds ?? [] }];
  let addMembershipResult = { memberships: derivedMemberships };
  try {
    for (const selectedId of selectedBlockIds) {
      const selectedText = materializeBlock(reduced, selectedId);
      addMembershipResult = addMembership(reduced, virtualAnnotations, addMembershipResult.memberships, evAnn.id, selectedId,
        resolvePositionToEndpoint(reduced, selectedId, 0, basisFrontier),
        resolvePositionToEndpoint(reduced, selectedId, selectedText.length, basisFrontier));
    }
  } catch {
    throw new Error(`${name}.${handle.field}.operated v7 event membership addition is not applicable to derived state`);
  }

  const splitAffectedIds = new Set(
    pureMemberships.filter((membership) => membership.blockId === blockId || data.splitOps.some((split) => split.blockId === membership.blockId)).map((membership) => membership.annotationId),
  );
  const expectedMemberships = addMembershipResult.memberships.filter(m => m.annotationId === evAnn.id || splitAffectedIds.has(m.annotationId)).map(m => ({
    annotationId: m.annotationId,
    blockId: m.blockId,
    ordinal: m.ordinal,
    start: m.start,
    end: m.end,
  }));

  if (JSON.stringify(data.memberships) !== JSON.stringify(expectedMemberships)) {
    throw new Error(`${name}.${handle.field}.operated v7 event memberships do not match derived state`);
  }

  const annotationFamilyMeta = compiledMeta.annotationFields[evAnn.family];
  const annotationDescriptor = descriptor.annotations.find((entry) => entry.annotationName === evAnn.family);
  if (!annotationFamilyMeta || !annotationDescriptor) {
    throw new Error(`${name}.${handle.field}.operated v7 event references unknown annotation family '${evAnn.family}'`);
  }
  if (compiledMeta.annotationHandles[evAnn.family]?.appliesTo !== 'block') {
    throw new Error(`${name}.${handle.field}.operated v7 event annotation family '${evAnn.family}' must apply to blocks`);
  }
  const protectedTargetIds = evAnn.protectedTargetIds ?? [];
  if (protectedTargetIds.length !== 0 &&
      (annotationDescriptor.kind !== 'protectingAnnotation' || annotationDescriptor.protects === null)) {
    throw new Error(`${name}.${handle.field}.operated v7 event only protecting annotations with a declared target family may name protected targets`);
  }
  if (annotationDescriptor.kind === 'protectingAnnotation' && annotationDescriptor.protects !== null) {
    for (const targetId of protectedTargetIds) {
      const target = db.prepare(`SELECT family FROM ${prefix}_annotation WHERE id = ? AND document_id = ?`).get(targetId, data.id);
      if (!target || target.family !== annotationDescriptor.protects) {
        throw new Error(`${name}.${handle.field}.operated v7 event protected target '${targetId}' is invalid`);
      }
    }
  }
  const familyFieldNames = Object.keys(annotationDescriptor.fields).sort();
  const evFieldNames = Object.keys(evAnn.fields).sort();
  if (JSON.stringify(evFieldNames) !== JSON.stringify(familyFieldNames)) {
    throw new Error(`${name}.${handle.field}.operated v7 event annotation fields do not match declaration for family '${evAnn.family}'`);
  }
  for (const key of familyFieldNames) {
    const desc = annotationDescriptor.fields[key];
    const strategy = resolveStrategy(desc.kind);
    const validationResult = strategy.validate(evAnn.fields[key], desc);
    if (validationResult !== true) {
      throw new Error(`${name}.${handle.field}.operated v7 event annotation field '${key}' validation failed: ${validationResult}`);
    }
    if (typeof desc.validate === 'function' && desc.validate(evAnn.fields[key]) !== true) {
      throw new Error(`${name}.${handle.field}.operated v7 event annotation field '${key}' failed declared validation`);
    }
  }

  const existingAnn = db.prepare(`SELECT id FROM ${prefix}_annotation WHERE id = ?`).get(evAnn.id);
  if (existingAnn) {
    throw new Error(`${name}.${handle.field}.operated v7 event annotation id '${evAnn.id}' already exists`);
  }

  const measurementSourceIds = generalized
    ? [...new Set(data.splitOps.map((split) => split.blockId))]
    : [blockId];
  const sourceMeasurements = measurementSourceIds.flatMap((sourceId) => db.prepare(
    `SELECT id, family, format_version, block_id, payload FROM ${prefix}_measurement WHERE block_id = ? ORDER BY family, id`,
  ).all(sourceId));
  const measurementDescendantBlockIds = new Set(
    data.splitOps.flatMap((split) => [split.blockId, split.newBlockId]),
  );
  if (!anySplit && data.measurements.length !== 0) {
    throw new Error(`${name}.${handle.field}.operated v7 event has measurement facts without a split`);
  }
  const expectedMeasurementCount = generalized
    ? sourceMeasurements.length * 2
    : sourceMeasurements.length * (data.splitOps.length + 1);
  if (anySplit && data.measurements.length !== expectedMeasurementCount) {
    throw new Error(`${name}.${handle.field}.operated v7 event measurement count does not match split lineage`);
  }
  const sourceMeasurementIds = new Set(sourceMeasurements.map((row) => row.id));
  const factsById = new Map();
  const seenMeasurementIds = new Set();
  const measKeys = ['blockId', 'family', 'formatVersion', 'id', 'payload'];
  for (let i = 0; i < data.measurements.length; i++) {
    const mf = data.measurements[i];
    if (!mf || typeof mf !== 'object' || Array.isArray(mf) ||
        JSON.stringify(Object.keys(mf).sort()) !== JSON.stringify(measKeys.sort()) ||
        typeof mf.id !== 'string' || mf.id.length === 0 ||
        typeof mf.blockId !== 'string' || !measurementDescendantBlockIds.has(mf.blockId) ||
        typeof mf.family !== 'string' || typeof mf.formatVersion !== 'number' || seenMeasurementIds.has(mf.id)) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement fact ${i} has invalid lineage`);
    }
    seenMeasurementIds.add(mf.id);
    const config = measurementConfigs[mf.family];
    if (!config || mf.formatVersion !== config.formatVersion) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement fact ${i} has invalid family or format version`);
    }
    try {
      frozenJsonSnapshot(mf.payload);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement fact ${i} payload is not JSON`);
    }
    factsById.set(mf.id, mf);
  }
  for (const source of sourceMeasurements) {
    const split = data.splitOps.find((candidate) => candidate.blockId === source.block_id);
    const leftFact = factsById.get(source.id);
    const rightFacts = split ? data.measurements.filter((fact) => fact.family === source.family && fact.blockId === split.newBlockId) : [];
    if (!split || !leftFact || leftFact.blockId !== source.block_id || leftFact.family !== source.family ||
        leftFact.formatVersion !== source.format_version || rightFacts.length !== 1) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement facts do not preserve lineage for source '${source.id}'`);
    }
    const rightFact = rightFacts[0];
    const config = measurementConfigs[source.family];
    const extension = config && resolveDeclarationMeasurementExtension(config);
    if (!extension || source.format_version !== config.formatVersion || rightFact.formatVersion !== config.formatVersion) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement source '${source.id}' has no matching structural adapter`);
    }
    let sourcePayload;
    try { sourcePayload = frozenJsonSnapshot(JSON.parse(source.payload)); } catch {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement source '${source.id}' is not JSON`);
    }
    const sourceText = materializeBlock(currentFamily, source.block_id);
    const leftText = materializeBlock(reduced, source.block_id);
    const rightText = materializeBlock(reduced, split.newBlockId);
    const input = Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: sourceText, utf16Offset: split.utf16Offset, payload: sourcePayload });
    let first;
    let second;
    try {
      if (extension.validate(Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: sourceText, payload: sourcePayload })) !== undefined) throw new Error('returned a value');
      first = extension.partition(input);
      second = extension.partition(input);
    } catch {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement source '${source.id}' cannot be partitioned`);
    }
    if (JSON.stringify(first) !== JSON.stringify(second) || !first || typeof first !== 'object' || Array.isArray(first) ||
        JSON.stringify(Object.keys(first).sort()) !== JSON.stringify(['leftPayload', 'rightPayload', 'version']) || first.version !== 1) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement source '${source.id}' has a non-canonical partition`);
    }
    let leftPayload;
    let rightPayload;
    try {
      leftPayload = frozenJsonSnapshot(first.leftPayload);
      rightPayload = frozenJsonSnapshot(first.rightPayload);
      if (extension.validate(Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: leftText, payload: leftPayload })) !== undefined ||
          extension.validate(Object.freeze({ version: 1, formatVersion: config.formatVersion, blockText: rightText, payload: rightPayload })) !== undefined) throw new Error('returned a value');
    } catch {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement source '${source.id}' produced invalid descendants`);
    }
    if (JSON.stringify(leftFact.payload) !== JSON.stringify(leftPayload) || JSON.stringify(rightFact.payload) !== JSON.stringify(rightPayload)) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement facts do not match partition for source '${source.id}'`);
    }
  }
  for (const fact of data.measurements) {
    const existing = db.prepare(`SELECT id FROM ${prefix}_measurement WHERE id = ?`).get(fact.id);
    if ((sourceMeasurementIds.has(fact.id) && (!existing || fact.id !== existing.id)) ||
        (!sourceMeasurementIds.has(fact.id) && existing)) {
      throw new Error(`${name}.${handle.field}.operated v7 event measurement ID does not have fresh source lineage`);
    }
  }

  const blockColumns = ['id', 'document_id', 'project_id', 'owner_id', 'position', 'epoch', 'structure_version', ...blockFieldNames];
  const blockParamNames = blockColumns.map(c => `:${c}`).join(', ');
  const blockColumnNames = blockColumns.join(', ');

  const familyBlocks = reduced.blocks;
  const blocksToUpdate = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ?`).all(data.id);
  const existingById = {};
  for (const b of blocksToUpdate) existingById[b.id] = b;

  for (const bid of data.splitBlockIds) {
    if (existingById[bid]) {
      throw new Error(`${name}.${handle.field}.operated v7 block '${bid}' already exists`);
    }
  }
  if (!existingById[blockId]) {
    throw new Error(`${name}.${handle.field}.operated v7 source block '${blockId}' not found`);
  }
  const sourceBlock = existingById[blockId];
  const sourceGroup = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(blockId);
  if (!sourceGroup || typeof sourceGroup.group_id !== 'string' || sourceGroup.group_id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated v7 source block group not found`);
  }

  const blockFactById = {};
  for (const bf of data.blocks) blockFactById[bf.id] = bf;
  const findSourceIdForBlock = (blockId) => {
    const split = data.splitOps.find((candidate) => candidate.newBlockId === blockId);
    return split ? split.blockId : blockId;
  };

  const virtualStoredBlocks = new Map([[blockId, sourceBlock]]);
  for (const [index, split] of data.splitOps.entries()) {
    const leftFact = data.blocks[index * 2];
    const rightFact = data.blocks[index * 2 + 1];
    const source = virtualStoredBlocks.get(split.blockId) ?? existingById[split.blockId];
    if (!source || leftFact.id !== split.blockId || rightFact.id !== split.newBlockId ||
        leftFact.epoch !== source.epoch || rightFact.epoch !== source.epoch) {
      throw new Error(`${name}.${handle.field}.operated v7 event block facts do not match split ${index} source`);
    }
    for (const fieldName of blockFieldNames) {
      const sourceValue = deserializeField(descriptor.block[fieldName], source[fieldName]);
      if (JSON.stringify(leftFact.fields[fieldName]) !== JSON.stringify(sourceValue) ||
          JSON.stringify(rightFact.fields[fieldName]) !== JSON.stringify(sourceValue)) {
        throw new Error(`${name}.${handle.field}.operated v7 event block facts do not copy split ${index} source cells`);
      }
    }
    virtualStoredBlocks.set(split.newBlockId, source);
  }

  if (anySplit) stageBlockPositions(db, prefix, existingById);

  db.prepare(`UPDATE ${prefix}_state SET structure_version = ?, family_checkpoint = ? WHERE document_id = ?`)
    .run(data.after.structuralRevision, JSON.stringify(textFamilyCheckpoint(reduced)), data.id);

  for (const [index, fb] of familyBlocks.entries()) {
    const pos = deriveBlockPosition(index);
    const bid = fb.id;
    const existing = existingById[bid];
    if (existing) {
      if (!anySplit) continue;
      if (existing.structure_version >= data.after.structuralRevision) {
        throw new Error(`${name}.${handle.field}.operated v7 block '${bid}' structure_version already at or past target`);
      }
      db.prepare(`UPDATE ${prefix}_block SET position = ?, structure_version = ? WHERE id = ?`)
        .run(pos, data.after.structuralRevision, bid);
    } else {
      const blockFact = blockFactById[bid];
      if (!blockFact) {
        throw new Error(`${name}.${handle.field}.operated v7 family references unknown block '${bid}'`);
      }
      const splitSource = existingById[findSourceIdForBlock(bid)] ?? sourceBlock;
      const blockRow = {
        id: bid,
        document_id: data.id,
        project_id: splitSource.project_id,
        owner_id: splitSource.owner_id,
        position: pos,
        epoch: blockFact.epoch,
        structure_version: data.after.structuralRevision,
      };
      for (const bf of blockFieldNames) {
        blockRow[bf] = serializeField(descriptor.block[bf], blockFact.fields[bf]);
      }
      db.prepare(`INSERT INTO ${prefix}_block (${blockColumnNames}) VALUES (${blockParamNames})`).run(blockRow);
      const group = db.prepare(`SELECT group_id FROM ${prefix}_block_group WHERE block_id = ?`).get(findSourceIdForBlock(bid));
      if (!group) throw new Error(`${name}.${handle.field}.operated v7 source block group not found`);
      db.prepare(`INSERT INTO ${prefix}_block_group (block_id, group_id) VALUES (?, ?)`).run(bid, group.group_id);
    }
  }

  for (const annId of splitAffectedIds) {
    db.prepare(`DELETE FROM ${prefix}_membership WHERE annotation_id = ?`).run(annId);
  }

  for (const m of addMembershipResult.memberships.filter(m => splitAffectedIds.has(m.annotationId))) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(m.annotationId, m.blockId, m.ordinal, JSON.stringify(m.start), JSON.stringify(m.end));
  }

  db.prepare(`INSERT INTO ${prefix}_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)`)
    .run(evAnn.id, data.id, sourceBlock.project_id, data.actorId != null && typeof data.actorId === 'string' && data.actorId.length > 0 ? data.actorId : sourceBlock.owner_id, evAnn.family);

  for (const targetId of protectedTargetIds) {
    db.prepare(`INSERT INTO ${prefix}_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)`)
      .run(evAnn.id, targetId);
  }

  const familyTable = `${prefix}_annotation_${evAnn.family}`;
  const familyFieldNamesArray = Object.keys(annotationDescriptor.fields);
  if (familyFieldNamesArray.length > 0) {
    const famCols = ['annotation_id', ...familyFieldNamesArray];
    const famValues = [evAnn.id];
    for (const key of familyFieldNamesArray) {
      famValues.push(serializeField(annotationDescriptor.fields[key], evAnn.fields[key]));
    }
    db.prepare(`INSERT INTO ${familyTable} (${famCols.join(', ')}) VALUES (${famValues.map(() => '?').join(', ')})`)
      .run(...famValues);
  }

  for (const m of addMembershipResult.memberships.filter(m => m.annotationId === evAnn.id)) {
    db.prepare(`INSERT INTO ${prefix}_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, ?, ?, ?)`)
      .run(m.annotationId, m.blockId, m.ordinal, JSON.stringify(m.start), JSON.stringify(m.end));
  }

  for (let i = 0; i < data.measurements.length; i++) {
    const mf = data.measurements[i];
    const existingMeas = db.prepare(`SELECT id FROM ${prefix}_measurement WHERE id = ?`).get(mf.id);
    if (existingMeas) {
      db.prepare(`UPDATE ${prefix}_measurement SET block_id = ?, family = ?, format_version = ?, payload = ? WHERE id = ?`)
        .run(mf.blockId, mf.family, mf.formatVersion, JSON.stringify(mf.payload), mf.id);
    } else {
      db.prepare(`INSERT INTO ${prefix}_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, ?, ?, ?)`)
        .run(mf.id, mf.blockId, mf.family, mf.formatVersion, JSON.stringify(mf.payload));
    }
  }

  getLog().debug('dispatch', `${name}.${handle.field}.operated v7`, { id: data.id, annotationId: evAnn.id, selectedBlockId });
  return true;
}



function buildProjectedComputeRow(storedRow, fields) {
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

export function createEntityProjection({ name, fields, verbs, storedComputedFields, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }) {
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
    apply: (event, db, context = {}) => {
      const table = name;
      const handle = event.handle;
      if (handle?.brand !== 'event-handle' || handle.entity !== name) return;
      for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
        if (strategy.projectionApply({ entityName: name, fieldEntries: strategyFields, handle, event, db })) return;
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
      if (applyAnnotatedTextOperation({ name, fields, handle, event, db, privateFact: context.privateFact })) return;
      if (handle.kind === eventHandle.EventKind.native && handle.nativeName === 'applied') {
        const descriptor = fields[handle.field];
        if (descriptor?.kind !== 'crdt' || descriptor.type !== 'text') return;
        const id = event.data?.id;
        if (!id) return;
        const current = db.prepare(`SELECT ${handle.field} FROM ${table} WHERE id = ?`).get(id);
        if (!current) return;
        const state = restoreTextCheckpoint(JSON.parse(current[handle.field]));
        const next = applyTextOp(state, event.data.operation);
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
        const row = {};
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
            const result = compute(computeRow);
            row[fieldName] = resolveStrategy('computed').serialize(result);
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
        const { id, ...data } = event.data ?? {};
        if (!id) return;
        const updates = [];
        const params = { id };
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
                const result = compute(computeRow);
                const stored = resolveStrategy('computed').serialize(result);
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
        if (existingRow) captureDeletedRowAnchor(db, name, id, existingRow, event.committedAt);
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
        getLog().debug('dispatch', `${name}.removed`, { id });
      }
    },
  };
  if (Object.values(fields).some((field) => field.kind === 'annotatedText')) markAnnotatedEntityProjection(projection);
  return Object.freeze(projection);
}

export function createConditionalHistoryProjection({ name, verbs }) {
  return Object.freeze({
    actionType: `${name}.update`,
    eventTypes: [verbs.updated.type],
    privateFact: true,
    replay: false,
    apply: (event, db, { privateFact }) => {
      const before = privateFact?.before;
      const after = privateFact?.after;
      if (!before || !after || before.id !== after.id || event.data?.id !== before.id) throw new Error(`${name}.update private fact is invalid`);
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
      if (columns.some((column) => !Object.hasOwn(before, column) || !Object.hasOwn(after, column))) throw new Error(`${name}.update private fact is incomplete`);
      const current = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      const params = {};
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

export function createConditionalCreateHistoryProjection({ name, verbs }) {
  const apply = (event, db, { privateFact }) => {
    const { before, after } = privateFact ?? {};
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
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
      captureDeletedRowAnchor(db, name, before.id, current, event.committedAt);
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
