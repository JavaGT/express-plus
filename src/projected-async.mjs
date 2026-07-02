import { resolveStrategy } from './field-strategy.mjs';

export function resolveProjectedAsyncTriggerTypes(desc, entityName) {
  if (!desc.from) return [`${entityName}.created`, `${entityName}.updated`];
  if (typeof desc.from === 'string') {
    const from = desc.from;
    return from.includes('.') ? [from] : [`${entityName}.${from}`];
  }
  return desc.from.map((f) => f.includes('.') ? f : `${entityName}.${f}`);
}

function projectedAsyncRow(entityRecord, row) {
  const filteredRow = {};
  if (row.id !== undefined) filteredRow.id = row.id;
  for (const [k, v] of Object.entries(row)) {
    if (Object.prototype.hasOwnProperty.call(entityRecord.fields, k)) {
      const desc = entityRecord.fields[k];
      if (desc?.kind === 'value' || desc?.kind === 'projected' || (desc?.kind === 'computed' && desc?.mode === 'stored')) {
        try { filteredRow[k] = resolveStrategy(desc.kind).deserialize?.(v, desc) ?? v; } catch { filteredRow[k] = v; }
      } else {
        filteredRow[k] = v;
      }
    }
  }
  return filteredRow;
}

export function createProjectedAsyncConsumer({ entities }) {
  return async (events, { db }) => {
    for (const ev of events) {
      const colon = ev.scope?.indexOf(':');
      if (colon < 0) continue;
      const entityName = ev.scope.slice(0, colon);
      const rowId = ev.scope.slice(colon + 1);
      const entityRecord = entities?.get(entityName);
      if (!entityRecord || !entityRecord.projectedAsyncFields?.length) continue;
      const triggered = [];
      for (const [fieldName, desc] of entityRecord.projectedAsyncFields) {
        const triggerTypes = resolveProjectedAsyncTriggerTypes(desc, entityName);
        if (triggerTypes.includes(ev.type)) triggered.push({ fieldName, compute: desc.compute });
      }
      if (triggered.length === 0) continue;
      const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = :id`).get({ id: rowId });
      if (!row) continue;
      const filteredRow = projectedAsyncRow(entityRecord, row);
      for (const { fieldName, compute } of triggered) {
        try {
          const result = await compute(filteredRow, { db });
          const serialized = resolveStrategy('projected').serialize(result);
          db.prepare(`UPDATE ${entityName} SET ${fieldName} = :val WHERE id = :id`).run({
            val: serialized, id: rowId,
          });
          const cursorRow = db.prepare(
            'SELECT lastSeq FROM _ProjectedCursor WHERE entity = :e AND field = :f',
          ).get({ e: entityName, f: fieldName });
          const next = (cursorRow?.lastSeq ?? 0) + 1;
          db.prepare(
            'INSERT OR REPLACE INTO _ProjectedCursor (entity, field, lastSeq) VALUES (:e, :f, :s)',
          ).run({ e: entityName, f: fieldName, s: next });
        } catch {
        }
      }
    }
  };
}
