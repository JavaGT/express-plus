import { getLog } from '../log.mjs';
import { serializeField, flattenStruct, resolveStrategy } from '../field-strategy.mjs';
import * as eventHandle from '../event-handle.mjs';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.mjs';
import { applyTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.mjs';

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
