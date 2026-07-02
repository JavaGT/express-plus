import { deserializeField, verifyHash, structCellColumn } from '../field-strategy.mjs';

export function createEntityHydrator({ record, entityName, fields, sideTableStrategyEntries }) {
  const hashFields = Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'hash')
    .map(([fieldName]) => fieldName);
  const storedValueFields = Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'value' || descriptor.kind === 'projected' || (descriptor.kind === 'computed' && descriptor.mode === 'stored'));
  const structFields = Object.entries(fields).filter(([, d]) => d.kind === 'struct');

  const deserializeStoredCells = (row) => {
    if (!row) return row;
    for (const [fieldName, descriptor] of storedValueFields) {
      if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
        row[fieldName] = deserializeField(descriptor, row[fieldName]);
      }
    }
    return row;
  };

  const hydrate = (row, principal = null, dispatch = null) => {
    if (!row) return row;
    deserializeStoredCells(row);
    for (const fieldName of hashFields) {
      const stored = row[fieldName];
      if (stored === null || stored === undefined) continue;
      row[fieldName] = { verify: (plaintext) => verifyHash(plaintext, stored) };
    }
    for (const [fieldName, descriptor] of structFields) {
      const namespace = {};
      let any = false;
      for (const cellName of Object.keys(descriptor.cells)) {
        const column = structCellColumn(fieldName, cellName);
        if (column in row) {
          namespace[cellName] = row[column];
          delete row[column];
          if (row[column] !== null) any = true;
        }
      }
      row[fieldName] = any || Object.keys(namespace).length > 0 ? namespace : null;
    }
    for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
      for (const [fieldName, descriptor] of strategyFields) {
        row[fieldName] = strategy.handle({ record, entityName, fieldName, descriptor, row, principal, dispatch });
      }
    }
    for (const [fieldName, descriptor] of Object.entries(fields)) {
      if (descriptor.kind === 'computed' && descriptor.mode === 'pull') {
        try { row[fieldName] = descriptor.compute(row); } catch {}
      }
    }
    return row;
  };

  return { hydrate, deserializeStoredCells };
}
