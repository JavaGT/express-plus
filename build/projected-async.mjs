import { resolveStrategy,                      } from './field-strategy.mjs';
import { getLog } from './log.mjs';
import { consumerCursorMap, upsertConsumerCursor } from './consumer-cursor.mjs';
import { upsert,               } from './driver.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';












export function resolveProjectedAsyncTriggerTypes(desc                               , entityName        )           {
  if (!desc.from) return [`${entityName}.created`, `${entityName}.updated`];
  if (typeof desc.from === 'string') {
    const from = desc.from;
    return from.includes('.') ? [from] : [`${entityName}.${from}`];
  }
  return desc.from.map((f) => f.includes('.') ? f : `${entityName}.${f}`);
}

function projectedAsyncRow(entityRecord                            , row                         )                          {
  const filteredRow                          = {};
  if (row.id !== undefined) filteredRow.id = row.id;
  for (const [k, v] of Object.entries(row)) {
    if (Object.prototype.hasOwnProperty.call(entityRecord.fields, k)) {
      const desc = entityRecord.fields[k]                               ;
      if (desc?.kind === 'value' || desc?.kind === 'projected' || (desc?.kind === 'computed' && desc?.mode === 'stored')) {
        try { filteredRow[k] = resolveStrategy(desc.kind).deserialize?.(v, desc) ?? v; } catch { filteredRow[k] = v; }
      } else {
        filteredRow[k] = v;
      }
    }
  }
  return filteredRow;
}






// Recompute every projected.async field for one row and write the results back,
// advancing the staleness version counter per field. Returns true iff every
// field computed successfully. Shared by the post-commit consumer (triggered
// fields only) and the boot reconcile (all fields) so there is ONE write-back
// path — not two that drift. `fields` is an array of {fieldName, compute}; the
// caller selects which fields (triggered subset vs all).
async function recomputeFields(entityRecord                            , entityName        , rowId        , db          , fields                  , { scope }                   )                   {
  const row = db.prepare(`SELECT * FROM ${entityName} WHERE id = :id`).get({ id: rowId });
  if (!row) return false;
  const filteredRow = projectedAsyncRow(entityRecord, row);
  let allSucceeded = true;
  for (const { fieldName, compute } of fields) {
    try {
      const result = await compute(filteredRow, { db });
      const serialized = resolveStrategy('projected').serialize (result);
      db.prepare(`UPDATE ${entityName} SET ${fieldName} = :val WHERE id = :id`).run({
        val: serialized, id: rowId,
      });
      const cursorRow = db.prepare(
        'SELECT lastSeq FROM _ProjectedCursor WHERE entity = :e AND field = :f',
      ).get({ e: entityName, f: fieldName });
      const next = ((cursorRow?.lastSeq                      ) ?? 0) + 1;
      upsert(db, {
        table: '_ProjectedCursor',
        keyColumns: ['entity', 'field'],
        columns: ['lastSeq'],
        values: { entity: entityName, field: fieldName, lastSeq: next },
      });
    } catch (err) {
      allSucceeded = false;
      getLog().warn('projected', 'compute failed', { entity: entityName, field: fieldName, scope, err });
    }
  }
  return allSucceeded;
}



export function createProjectedAsyncConsumer({ entities }                                                               )                                                                              {
  return async (events, { db }) => {
    for (const ev of events) {
      const handle = tryParseScopeKey(ev.scope);
      if (!handle) continue;
      const entityName = handle.entity;
      const rowId = handle.id;
      const entityRecord = entities?.get(entityName);
      if (!entityRecord || !entityRecord.projectedAsyncFields?.length) continue;
      const triggered                   = [];
      for (const [fieldName, desc] of entityRecord.projectedAsyncFields) {
        const triggerTypes = resolveProjectedAsyncTriggerTypes(desc, entityName);
        if (triggerTypes.includes(ev.type)) triggered.push({ fieldName, compute: desc.compute });
      }
      if (triggered.length === 0) continue;
      const allSucceeded = await recomputeFields(
        entityRecord, entityName, rowId, db, triggered, { scope: ev.scope },
      );
      // Per-scope recovery cursor (distinct from the staleness version counter
      // advanced inside recomputeFields). Advances to the event's real log seq
      // only when every triggered field applied successfully, so a boot-time
      // sweep can detect scopes that fell behind (process died between COMMIT
      // and this post-commit consumer, or a compute threw) and recompute them
      // from current row state. Non-triggering events do not advance it: an
      // earlier failed triggering compute could otherwise be masked as caught-
      // up by a later non-triggering event. A false-positive lagging signal is
      // harmless — catch-up recomputes from current row state (compute is pure).
      if (allSucceeded && typeof ev.seq === 'number') {
        upsertConsumerCursor(db, { consumer: 'projected.async', scope: ev.scope, lastSeq: ev.seq });
      }
    }
  };
}

// Boot-time catch-up. A scope falls behind when the process commits an event to
// _Log but dies before the post-commit consumer applies its projection (or a
// compute threw). With no reconciliation path the projected field stays stale
// forever. This sweep, run once at app.ready under the writeQueue mutex, finds
// lagging scopes (recovery cursor missing or behind the scope's _Log head) and
// recomputes every projected.async field from the CURRENT row state — the row
// already reflects every committed event, so one recompute makes the scope
// current regardless of how many events were missed. Scopes whose row was
// removed have their recovery cursor cleaned up. Idempotent: a scope already at
// head is untouched, so running twice changes nothing.
export function readProjectedCursors(db          , entity                            )                                            {
  if (!entity.projectedAsyncFields || entity.projectedAsyncFields.length === 0) return [];
  const cursors = new Map                (
    db.prepare('SELECT field, lastSeq FROM _ProjectedCursor WHERE entity = :e')
      .all({ e: entity.name })
      .map((r) => [r.field          , r.lastSeq          ]),
  );
  return entity.projectedAsyncFields
    .filter(([fieldName]) => cursors.has(fieldName))
    .map(([fieldName]) => ({ field: fieldName, lastSeq: cursors.get(fieldName)           }));
}

export async function reconcileProjectedRecovery(db          , entities                                                             )                                                   {
  const CONSUMER = 'projected.async';
  // Only entities that declare projected.async fields have anything to recover.
  const projectedEntities = new Map                                    ();
  for (const entityRecord of entities?.values() ?? []) {
    if (entityRecord.projectedAsyncFields?.length) {
      projectedEntities.set(entityRecord.name, entityRecord);
    }
  }
  if (projectedEntities.size === 0) return { recomputed: 0, cleaned: 0 };

  let recomputed = 0;
  let cleaned = 0;
  // The recovery cursor is per-scope; _Log's head is per-scope. Compare the two
  // to find lagging scopes. Distinct scopes in _Log cover every row that has
  // ever had an event — including ones whose entity has no projected.async
  // fields (skipped below) and removed rows (cursor cleaned up).
  const scopes = db.prepare(
    'SELECT scope, MAX(seq) AS head FROM _Log GROUP BY scope',
  ).all()                                          ;
  const recoveryByScope = consumerCursorMap(db, CONSUMER);

  for (const { scope, head } of scopes) {
    const handle = tryParseScopeKey(scope);
    if (!handle) continue;
    const entityName = handle.entity;
    const rowId = handle.id;
    const entityRecord = projectedEntities.get(entityName);
    if (!entityRecord) continue; // no projected.async fields → nothing to recover
    const applied = recoveryByScope.get(scope) ?? 0;
    if (applied >= head) continue; // current — leave the row untouched

    const allFields                   = [...(entityRecord.projectedAsyncFields ?? [])].map(
      ([fieldName, desc]) => ({ fieldName, compute: desc.compute }),
    );
    const rowExists = !!db.prepare(`SELECT 1 FROM ${entityName} WHERE id = :id`).get({ id: rowId });
    if (!rowExists) {
      // The row was removed after the events that mark this scope lagging. Drop
      // the stale recovery cursor so it never resurfaces as a phantom lag.
      db.prepare(
        'DELETE FROM _ConsumerCursor WHERE consumer = :consumer AND scope = :scope',
      ).run({ consumer: CONSUMER, scope });
      cleaned++;
      continue;
    }

    const allSucceeded = await recomputeFields(
      entityRecord, entityName, rowId, db, allFields, { scope },
    );
    if (allSucceeded) {
      upsertConsumerCursor(db, { consumer: CONSUMER, scope, lastSeq: head });
      recomputed++;
    }
    // A still-failing compute leaves the cursor behind head; the scope surfaces
    // as lagging again on the next sweep (self-healing on restart). Full dead-
    // letter + retry is the later bottom half's job, deferred from this slice.
  }
  return { recomputed, cleaned };
}
