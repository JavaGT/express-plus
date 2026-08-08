// @ts-nocheck
import { deserializeField, structCellColumn, verifyHash } from '../field-strategy.ts';
import { materializeText, restoreTextCheckpoint } from '../annotated-text.ts';

// Convert one SQLite result into the field values an application declared.
// This is deliberately pure: it installs no database-backed collection handles,
// so it is safe for lifecycle callbacks and projection computations.
export function materializeStoredRow(
  storedRow: Record<string, unknown> | null | undefined,
  fields: Record<string, FieldDescriptor>,
  { freeze = false }: { freeze?: boolean } = {},
): Record<string, unknown> | null | undefined {
  if (!storedRow) return storedRow;
  const row: Record<string, unknown> = { ...storedRow };

  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind === 'crdt' && descriptor.type === 'text') {
      if (!Object.prototype.hasOwnProperty.call(row, fieldName)) continue;
      const checkpoint = JSON.parse(row[fieldName] as string);
      const state = restoreTextCheckpoint(checkpoint);
      row[fieldName] = materializeText(state);
      continue;
    }
    if (descriptor.kind === 'struct') {
      const value: Record<string, unknown> = {};
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
        : Object.freeze({ verify: (plaintext: unknown) => verifyHash(plaintext, stored) });
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

  return freeze ? Object.freeze(row) as Record<string, unknown> : row;
}

interface CellDescriptor {
  [key: string]: unknown;
}

interface FieldDescriptor {
  kind?: string;
  type?: string;
  mode?: string;
  cells?: Record<string, CellDescriptor>;
  compute?: (row: Record<string, unknown>) => unknown;
}
