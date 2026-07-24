import { getLog } from '../log.mjs';
import { serializeField, flattenStruct, resolveStrategy, deserializeField } from '../field-strategy.mjs';
import * as eventHandle from '../event-handle.mjs';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.mjs';
import { applyTextOp, canonicalTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.mjs';
import { applyTextOperationToBlock, createTextFamily, restoreTextFamilyCheckpoint, textFamilyCheckpoint, splitBlock } from '../annotated-text-family.mjs';
import { splitBlockMemberships } from '../annotated-text-membership.mjs';
import { getAnnotatedTextCompiledMetadata } from '../annotated-text-field.mjs';
import { deriveBlockPosition } from '../annotated-text-r2.mjs';

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
    const initialBlockId = metadata?.[fieldName]?.initialBlockId;
    if (typeof initialBlockId !== 'string' || initialBlockId.length === 0) {
      throw new Error(`${name}.${fieldName} created event is missing initial block metadata`);
    }
    const prefix = `${name}_${fieldName}`;
    const checkpoint = JSON.stringify(textFamilyCheckpoint(
      createTextFamily(row.id, textCheckpoint(createTextState()), initialBlockId),
    ));
    const state = db.prepare(`SELECT * FROM ${prefix}_state WHERE document_id = ?`).get(row.id);
    const blocks = db.prepare(`SELECT * FROM ${prefix}_block WHERE document_id = ?`).all(row.id);
    if (state || blocks.length > 0) {
      const expected = state
        && state.structure_version === 1
        && state.family_checkpoint === checkpoint
        && blocks.length === 1
        && blocks[0].id === initialBlockId
        && blocks[0].position === INITIAL_BLOCK_POSITION
        && blocks[0].epoch === 1
        && blocks[0].structure_version === 1;
      if (!expected) throw new Error(`${name}.${fieldName} created projection conflicts with existing initialization`);
      continue;
    }
    db.prepare(`INSERT INTO ${prefix}_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)`)
      .run(row.id, checkpoint);
    const block = {
      id: initialBlockId,
      document_id: row.id,
      project_id: row[descriptor.project],
      owner_id: row[descriptor.owner],
      position: INITIAL_BLOCK_POSITION,
      epoch: 1,
      structure_version: 1,
      ...defaultBlockCells(descriptor),
    };
    const columns = Object.keys(block);
    db.prepare(`INSERT INTO ${prefix}_block (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`)
      .run(block);
  }
}

function applyAnnotatedTextOperation({ name, fields, handle, event, db }) {
  if (handle.kind !== eventHandle.EventKind.native || handle.nativeName !== 'operated') return false;
  const descriptor = fields[handle.field];
  if (descriptor?.kind !== 'annotatedText') return false;
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error(`${name}.${handle.field}.operated event has no data`);
  }
  if (data.version === 1) return applyR1AnnotatedTextOperation({ name, handle, db, data });
  if (data.version === 2) return applyR2AnnotatedTextOperation({ name, handle, db, descriptor, data });
  throw new Error(`${name}.${handle.field}.operated event has unknown version ${data.version}`);
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

function applyR2AnnotatedTextOperation({ name, handle, db, descriptor, data }) {
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

export function createEntityProjection({ name, fields, verbs, storedComputedFields, sideTableStrategyEntries }) {
  return Object.freeze({
    eventTypes: [
      verbs.created.type,
      verbs.updated.type,
      verbs.removed.type,
      ...Object.entries(fields)
        .filter(([, descriptor]) => descriptor.kind === 'crdt' && descriptor.type === 'text')
        .map(([fieldName]) => eventHandle.native(name, fieldName, 'applied').type),
      ...Object.entries(fields)
        .filter(([, descriptor]) => descriptor.kind === 'annotatedText')
        .map(([fieldName]) => eventHandle.native(name, fieldName, 'operated').type),
      ...sideTableStrategyEntries.flatMap(({ strategy, fields: strategyFields }) =>
        strategy.eventTypes(name, strategyFields)),
    ],
    apply: (event, db) => {
      const table = name;
      const handle = event.handle;
      if (handle?.brand !== 'event-handle' || handle.entity !== name) return;
      for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
        if (strategy.projectionApply({ entityName: name, fieldEntries: strategyFields, handle, event, db })) return;
      }
      if (applyAnnotatedTextOperation({ name, fields, handle, event, db })) return;
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
  });
}
