import { getLog } from '../log.mjs';
import { serializeField, flattenStruct, resolveStrategy } from '../field-strategy.mjs';
import * as eventHandle from '../event-handle.mjs';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.mjs';
import { applyTextOp, canonicalTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.mjs';
import { applyTextOperationToBlock, createTextFamily, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from '../annotated-text-family.mjs';

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
  const isVersion = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1 && Array.isArray(value.frontier);
  const operation = data?.operation;
  if (!data || typeof data !== 'object' || Object.keys(data).length !== 6 || data.version !== 1 ||
      typeof data.id !== 'string' || data.id.length === 0 || !isVersion(data.before) || !isVersion(data.after) ||
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
