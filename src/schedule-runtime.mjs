// Schedule runtime — discovery, admission, clock dispatch, and receipt management.
// Constructor declarations (schedule.at/after, tick.hz/every, simulate) remain in
// schedule.mjs. Runtime functions extracted to keep the declaration surface clean.

import { randomUUID } from 'node:crypto';
import { principalFrom } from './principal.mjs';
import { getLog } from './log.mjs';
import { createClockRunner } from './clock-runner.mjs';
import { materializeStoredRow } from './entity/materialize-row.mjs';
import { triggerList, schedulerSource, tickSource } from './schedule.mjs';

const DEADLINE_SCAN_INTERVAL_MS = 1000;

function passesWhen(trigger, row) {
  if (trigger.when === undefined) return true;
  const result = trigger.when({ row });
  if (typeof result !== 'boolean') {
    throw new Error(`${trigger.kind}: when must return a boolean synchronously`);
  }
  return result;
}

function runtimeRow(entity, discoveredRow) {
  return materializeStoredRow(discoveredRow, entity.fields, { freeze: true });
}

function resolvePayload(trigger, row) {
  if (trigger.with === undefined || trigger.with === null) return {};
  if (typeof trigger.with === 'function') {
    const result = trigger.with({ row });
    if (result === null || typeof result !== 'object' || Array.isArray(result) || typeof result.then === 'function') {
      throw new Error(`${trigger.kind}: with must return an object synchronously`);
    }
    return result;
  }
  return { ...trigger.with };
}

function deadlineSources(entity, changedFields = null) {
  const sources = [];
  if (!entity?.schedule || typeof entity.name !== 'string') return sources;
  for (const [verb, triggerOrTriggers] of Object.entries(entity.schedule)) {
    for (const trigger of triggerList(triggerOrTriggers)) {
      if (trigger.kind !== 'schedule.at' && trigger.kind !== 'schedule.after') continue;
      if (!trigger.fieldName || !trigger.triggerId) continue;
      if (changedFields && !changedFields.has(trigger.fieldName)) continue;
      sources.push(schedulerSource(entity.name, verb, trigger.triggerId));
    }
  }
  return sources;
}

function normalizeEntityList(entities) {
  return entities instanceof Map ? [...entities.values()] : entities;
}

function computeIntervalFromTrigger(trigger) {
  if (trigger.kind === 'tick.every') return trigger.intervalMs;
  if (trigger.kind === 'tick.hz') return Math.max(1, Math.floor(1000 / trigger.hertz));
  return NaN;
}

function computeTickIntervals(entities) {
  const intervals = new Set();
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const triggerOrTriggers of Object.values(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (!trigger) continue;
        const iv = computeIntervalFromTrigger(trigger);
        if (Number.isFinite(iv) && iv > 0) intervals.add(iv);
      }
    }
  }
  return [...intervals].sort((a, b) => a - b);
}

function hasDeadlineTrigger(entities) {
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const triggerOrTriggers of Object.values(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (!trigger) continue;
        if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') return true;
      }
    }
  }
  return false;
}

// discoverDueSchedules — private discovery for deadline triggers.
// Returns { entity, verb, rowId, payload, triggerId }[]; does not dispatch.
export function discoverDueSchedules(db, entities, now) {
  const results = [];
  for (const record of entities) {
    if (!record || !record.schedule) continue;
    for (const [verb, triggerOrTriggers] of Object.entries(record.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        const fieldName = trigger.fieldName;
        if (!fieldName) continue; // should not happen if entity validation ran

        const select = trigger.when !== undefined || typeof trigger.with === 'function' ? 't0.*' : 't0.id';
        let sql, params, dueExpression;
        if (trigger.kind === 'schedule.at') {
          // Date fields store epoch-ms integers (field-strategy.mjs serialize).
          // Direct integer comparison: row is due when field <= now.
          // Table alias 't0' matches the scope-sql.mjs convention for while predicates.
          sql = `SELECT ${select} FROM ${record.name} AS t0 WHERE t0.${fieldName} <= :now`;
          dueExpression = `t0.${fieldName}`;
          params = { now, __scheduleSource: schedulerSource(record.name, verb, trigger.triggerId), ...(trigger.whileParams ?? {}) };
        } else if (trigger.kind === 'schedule.after') {
          // Keep the indexed field bare on the left: field + delay <= now is
          // equivalent to field <= now - delay, and SQLite can range-search it.
          sql = `SELECT ${select} FROM ${record.name} AS t0 WHERE t0.${fieldName} <= :cutoff`;
          dueExpression = `t0.${fieldName} + :delay`;
          params = { cutoff: now - trigger.delay, delay: trigger.delay, __scheduleSource: schedulerSource(record.name, verb, trigger.triggerId), ...(trigger.whileParams ?? {}) };
        } else {
          continue;
        }

        if (trigger.whileSql) sql += ` AND (${trigger.whileSql})`;
        sql += ` AND NOT EXISTS (
          SELECT 1 FROM _ScheduleReceipt AS receipt
          WHERE receipt.source = :__scheduleSource
            AND receipt.rowId = t0.id
            AND receipt.dueAt = ${dueExpression}
        )`;
        const rows = db.prepare(sql).all(params);
        for (const row of rows) {
          try {
            const fullRow = runtimeRow(record, row);
            if (!fullRow || !passesWhen(trigger, fullRow)) continue;
            const payload = resolvePayload(trigger, fullRow);
            results.push({ entity: record.name, verb, rowId: row.id, payload, triggerId: trigger.triggerId });
          } catch (err) {
            getLog().warn('system', 'schedule deadline callback failed', {
              err, entity: record.name, verb, rowId: row.id,
            });
          }
        }
      }
    }
  }
  return results;
}

// discoverTickedRows — private discovery for tick triggers.
// Yields { entity, verb, rowId, payload, triggerId }. `now` is unused (ticks
// have no due-time).
export function discoverTickedRows(db, entities, now, intervalMs = null) {
  const results = [];
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const [verb, triggerOrTriggers] of Object.entries(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (trigger.kind !== 'tick.hz' && trigger.kind !== 'tick.every') continue;
        if (intervalMs !== null && computeIntervalFromTrigger(trigger) !== intervalMs) continue;

        const select = trigger.when !== undefined || typeof trigger.with === 'function' ? 't0.*' : 't0.id';
        const sql = `SELECT ${select} FROM ${entity.name} AS t0 WHERE (${trigger.whileSql})`;
        const rows = db.prepare(sql).all(trigger.whileParams ?? {});

        for (const row of rows) {
          try {
            const fullRow = runtimeRow(entity, row);
            if (!fullRow || !passesWhen(trigger, fullRow)) continue;
            const payload = resolvePayload(trigger, fullRow);
            results.push({ entity: entity.name, verb, rowId: row.id, payload, triggerId: trigger.triggerId });
          } catch (err) {
            getLog().warn('system', 'schedule tick callback failed', {
              err, entity: entity.name, verb, rowId: row.id,
            });
          }
        }
      }
    }
  }
  return results;
}

// rearmChangedScheduleReceipts — clears one-shot schedule receipts when a
// deadline field changes, so a row whose timestamp changes away and later
// back to the same value can fire again. Scheduler-originated mutations are
// skipped (admission just created the receipt we'd otherwise delete).
export function rearmChangedScheduleReceipts({ entity, event, principal, db }) {
  const data = event?.data;
  if (!data || typeof data !== 'object' || data.id == null || !db) return 0;
  const changedFields = new Set(Object.keys(data));
  const consumingSource = principal?.type === 'system'
    ? principal.attributes?.source
    : null;
  let changes = 0;
  for (const source of deadlineSources(entity, changedFields)) {
    if (source === consumingSource) continue;
    changes += db.prepare(
      'DELETE FROM _ScheduleReceipt WHERE source = ? AND rowId = ?',
    ).run(source, String(data.id)).changes;
  }
  return changes;
}

// clearRemovedScheduleReceipts — once the projected row is gone, no deadline
// receipt for it can be useful. Runs in the same dispatch transaction.
export function clearRemovedScheduleReceipts({ entity, rowId, db }) {
  if (rowId == null || !db) return 0;
  let changes = 0;
  for (const source of deadlineSources(entity)) {
    changes += db.prepare(
      'DELETE FROM _ScheduleReceipt WHERE source = ? AND rowId = ?',
    ).run(source, String(rowId)).changes;
  }
  return changes;
}

// pruneInactiveScheduleReceipts — removes receipts whose source no longer
// exists in the compiled application (renamed/removed declarations).
export function pruneInactiveScheduleReceipts({ db, entities }) {
  if (!db) return 0;
  const entityList = normalizeEntityList(entities ?? []);
  const activeSources = new Set(
    entityList.flatMap((entity) => deadlineSources(entity)),
  );
  let changes = 0;
  const storedSources = db.prepare(
    'SELECT DISTINCT source FROM _ScheduleReceipt',
  ).all();
  for (const { source } of storedSources) {
    if (activeSources.has(source)) continue;
    changes += db.prepare(
      'DELETE FROM _ScheduleReceipt WHERE source = ?',
    ).run(source).changes;
  }
  return changes;
}

// admitSystemMutation — IN-TXN admission for scheduled/ticked system principals.
// Called from the dispatch spine's in-txn hook after a declared clock trigger
// fired. The trigger's declared kind decides the source binding and checks:
// tick.hz/tick.every require while and skip due; schedule.at/schedule.after bind
// to fieldName, re-check due, and allow while to be absent. Fail-closed on every
// mismatch.
export function admitSystemMutation({ entity, verb, rowId, payload, principal, db, now }) {
  if (!principal || typeof principal !== 'object') return false;
  if (principal.type !== 'system') return false;
  const source = principal.attributes?.source;
  if (typeof source !== 'string' || source === '') return false;

  const trigger = triggerList(entity?.schedule?.[verb]).find((t) => {
    if (typeof t.triggerId !== 'string' || t.triggerId === '') return false;
    if (t.kind === 'tick.hz' || t.kind === 'tick.every') {
      return source === tickSource(entity.name, verb, t.triggerId);
    }
    return source === schedulerSource(entity.name, verb, t.triggerId);
  });
  if (!trigger) return false;

  if (trigger.kind === 'tick.hz' || trigger.kind === 'tick.every') {
    if (!trigger.whileSql) return false;
  } else if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
    if (!trigger.fieldName) return false;
  } else {
    return false;
  }

  const storedRow = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(rowId);
  if (!storedRow) return false;
  const row = materializeStoredRow(storedRow, entity.fields, { freeze: true });

  let dueAt = null;
  if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
    const nowMs = typeof now === 'number'
      ? now
      : now instanceof Date
        ? now.getTime()
        : typeof now === 'string'
          ? Date.parse(now)
          : NaN;
    if (!Number.isFinite(nowMs)) return false;
    const fieldVal = Number(row[trigger.fieldName]);
    if (!Number.isFinite(fieldVal)) return false;
    dueAt = trigger.kind === 'schedule.after' ? fieldVal + (trigger.delay ?? 0) : fieldVal;
    if (dueAt > nowMs) return false;
  }

  if (trigger.whileSql) {
    const params = { ...(trigger.whileParams ?? {}), __rowId: rowId };
    const held = db.prepare(
      `SELECT 1 FROM ${entity.name} AS t0 WHERE t0.id = :__rowId AND (${trigger.whileSql})`,
    ).get(params);
    if (!held) return false;
  }

  if (!passesWhen(trigger, row)) return false;

  const declaredPayload = resolvePayload(trigger, row);
  const { id: _id, ...payloadFields } = payload ?? {};
  try {
    if (JSON.stringify(payloadFields) !== JSON.stringify(declaredPayload)) return false;
  } catch {
    return false;
  }

  if (dueAt !== null) {
    const result = db.prepare(
      'INSERT OR IGNORE INTO _ScheduleReceipt (source, rowId, dueAt) VALUES (?, ?, ?)',
    ).run(source, rowId, dueAt);
    if (result.changes !== 1) return false;
    // Admission acquired the current generation. Prune its obsolete siblings
    // only after that succeeds, so a denied duplicate call has no side effect.
    db.prepare(
      'DELETE FROM _ScheduleReceipt WHERE source = ? AND rowId = ? AND dueAt <> ?',
    ).run(source, rowId, dueAt);
    return true;
  }

  return true;
}

function scanDeadlines({ db, entityList, entityMap, dispatch, now }) {
  const rows = discoverDueSchedules(db, entityList, now());
  for (const { entity: entityName, verb, rowId, payload, triggerId } of rows) {
    try {
      const entity = entityMap.get(entityName);
      if (!entity) continue;
      const trigger = triggerList(entity.schedule?.[verb]).find((t) => t.triggerId === triggerId);
      if (!trigger?.fieldName) continue;
      const source = schedulerSource(entityName, verb, triggerId);
      const principal = principalFrom(source);
      dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
    } catch (err) {
      getLog().warn('system', 'schedule clock-dispatch (deadline) failed', { err, entity: entityName, verb, rowId });
    }
  }
}

function scanTicks({ db, entityList, dispatch, now, intervalMs = null }) {
  const rows = discoverTickedRows(db, entityList, now(), intervalMs);
  for (const { entity: entityName, verb, rowId, payload, triggerId } of rows) {
    try {
      const source = tickSource(entityName, verb, triggerId);
      const principal = principalFrom(source);
      dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
    } catch (err) {
      getLog().warn('system', 'schedule clock-dispatch (tick) failed', { err, entity: entityName, verb, rowId });
    }
  }
}

/**
 * startClockTriggers — singular Schedule clock-dispatch seam.
 *
 * Owns discover → principal → dispatch for both deadline (schedule.at/after)
 * and tick (tick.hz/every) triggers. Returns a no-op `{stop(){}}` when no
 * triggers of either kind exist. Per-row deny/throw logs and continues —
 * never aborts the sweep. Admission stays on the durable variant's
 * beforeProjection seam (ADR-0002); this starter is a clock trigger only.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {Map<string, object>|object[]} opts.entities
 * @param {function} opts.dispatch
 * @param {function} [opts.now=Date.now]
 * @param {object} [opts.clock]
 * @returns {{stop(): void}}
 */
export function startClockTriggers({ db, entities, dispatch, now = Date.now, clock }) {
  const entityList = normalizeEntityList(entities);
  const entityMap = new Map(entityList.map((e) => [e.name, e]));
  const runners = [];

  // One synchronous scan at start so due rows / matching ticks fire without
  // waiting a full interval (boot catch-up; also the fire-path test surface).
  // Discovery-phase throws are swallowed here the same way createClockRunner
  // swallows interval failures — one bad table must not abort startup.
  if (hasDeadlineTrigger(entityList)) {
    try {
      scanDeadlines({ db, entityList, entityMap, dispatch, now });
    } catch (err) {
      getLog().warn('system', 'schedule clock-dispatch (deadline) scan failed', { err });
    }
    runners.push(createClockRunner({
      clock,
      intervalMs: DEADLINE_SCAN_INTERVAL_MS,
      name: 'schedule-deadline',
      fn: () => scanDeadlines({ db, entityList, entityMap, dispatch, now }),
    }));
  }

  const tickIntervals = computeTickIntervals(entityList);
  if (tickIntervals.length > 0) {
    try {
      scanTicks({ db, entityList, dispatch, now });
    } catch (err) {
      getLog().warn('system', 'schedule clock-dispatch (tick) scan failed', { err });
    }
    for (const intervalMs of tickIntervals) {
      runners.push(createClockRunner({
        clock,
        intervalMs,
        name: `schedule-tick-${intervalMs}`,
        fn: () => scanTicks({ db, entityList, dispatch, now, intervalMs }),
      }));
    }
  }

  if (runners.length === 0) return { stop() {} };

  return {
    stop() {
      for (const runner of runners) runner.stop();
    },
  };
}
