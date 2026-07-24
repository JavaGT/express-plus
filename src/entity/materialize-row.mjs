import { deserializeField, structCellColumn, verifyHash } from '../field-strategy.mjs';
import { materializeText, restoreTextCheckpoint } from '../annotated-text.mjs';

// Convert one SQLite result into the field values an application declared.
// This is deliberately pure: it installs no database-backed collection handles,
// so it is safe for lifecycle callbacks and projection computations.
export function materializeStoredRow(storedRow, fields, { freeze = false } = {}) {
  if (!storedRow) return storedRow;
  const row = { ...storedRow };

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind === 'crdt' && descriptor.type === 'text') {
      const checkpoint = JSON.parse(row[fieldName]);
      const state = restoreTextCheckpoint(checkpoint);
      row[fieldName] = materializeText(state);
      continue;
    }
    if (descriptor.kind === 'struct') {
      const value = {};
      let present = false;
      for (const [cellName, cellDescriptor] of Object.entries(descriptor.cells)) {
        const column = structCellColumn(fieldName, cellName);
        if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
        const stored = row[column];
        value[cellName] = deserializeField(cellDescriptor, stored);
        delete row[column];
        if (stored !== null && stored !== undefined) present = true;
      }
      row[fieldName] = present ? Object.freeze(value) : null;
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(row, fieldName)) continue;
    if (descriptor.kind === 'hash') {
      const stored = row[fieldName];
      row[fieldName] = stored == null
        ? stored
        : Object.freeze({ verify: (plaintext) => verifyHash(plaintext, stored) });
      continue;
    }
    try {
      row[fieldName] = deserializeField(descriptor, row[fieldName]);
    } catch {
      // A descriptor without a persistence strategy has no stored-cell
      // conversion. Its raw value is retained for compatibility.
    }
  }

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'computed' || descriptor.mode !== 'pull') continue;
    try { row[fieldName] = descriptor.compute(row); } catch {}
  }

  return freeze ? Object.freeze(row) : row;
}
