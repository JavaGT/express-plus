// Schedule module — time-driven sources (ADR #10, ADR-0002) and the singular
// clock-dispatch seam. Constructors (schedule.at/after, tick.hz/every) declare
// triggers; admitSystemMutation re-admits in-txn; startClockTriggers owns the
// discover → principal → dispatch loop for both deadline and tick kinds.
//
// Tick triggers (tick.hz / tick.every) are row-set intervals: fire `update`
// against EVERY row matching `while` per interval. An EMPTY `while` is
// forbidden (the "run on ALL rows forever" foot-gun) — enforced at
// entity-load-time in entity compile.

import { randomUUID } from 'node:crypto';
import { principalFrom } from './principal.mjs';
import { getLog } from './log.mjs';
import { createClockRunner } from './clock-runner.mjs';
import { materializeStoredRow } from './entity/materialize-row.mjs';

const MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
const DEADLINE_SCAN_INTERVAL_MS = 1000;

function parseDelay(delay) {
  if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) return delay;
  if (typeof delay === 'string') {
    const m = /^(\d+)([dhms])$/.exec(delay.trim());
    if (m) return Number(m[1]) * MS[m[2]];
  }
  throw new Error(`schedule.after: invalid delay ${JSON.stringify(delay)} (expected a non-negative number ms or a '<n><d|h|m|s>' string)`);
}

// validateWith — fail-closed guard for the 'with' payload option.
// with must be absent (undefined), an object literal, or a function ({row}) => obj.
// Booleans, arrays, strings, numbers (other than omitted) are rejected.
function isDeclaredAsync(value) {
  return typeof value === 'function' && value.constructor?.name === 'AsyncFunction';
}

function validateWith(withValue, context) {
  if (withValue === undefined) return undefined;
  if (withValue === null) return null;
  if (typeof withValue === 'function') {
    if (isDeclaredAsync(withValue)) throw new Error(`${context}: with must be synchronous`);
    return withValue;
  }
  if (typeof withValue === 'object' && !Array.isArray(withValue)) return withValue;
  throw new Error(`${context}: 'with' must be an object or a function ({row}) => obj`);
}

function validateOptionalFunction(value, context, option, signature) {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') {
    throw new Error(`${context}: ${option} must be a function ${signature}`);
  }
  if (isDeclaredAsync(value)) throw new Error(`${context}: ${option} must be synchronous`);
  return value;
}

function validateTriggerKey(value, context) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `${context}: key must be a non-empty string containing only letters, numbers, '.', '_' or '-'`,
    );
  }
  return value;
}

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

export const schedule = Object.freeze({
  at(field, options = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.at: field must be a field descriptor');
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'schedule.at');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'schedule.at', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'schedule.at');
    const validatedWhen = validateOptionalFunction(when, 'schedule.at', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'schedule.at', key: validatedKey, field, when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
  after(field, delay, options = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.after: field must be a field descriptor');
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'schedule.after');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'schedule.after', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'schedule.after');
    const validatedWhen = validateOptionalFunction(when, 'schedule.after', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'schedule.after', key: validatedKey, field, delay: parseDelay(delay), when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
});

// A verb's schedule slot accepts one trigger or an array; normalize to an array.
export function triggerList(triggerOrTriggers) {
  if (triggerOrTriggers == null) return [];
  return Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers];
}

// discoverDueSchedules — private discovery for deadline triggers.
// Returns { entity, verb, rowId, payload, triggerId }[]; does not dispatch.
function discoverDueSchedules(db, entities, now) {
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

// The expected scheduler source for a declared schedule. DERIVED from declared
// shape (entity name + verb + trigger identity) — never an author magic string. A
// reaper minting a scheduler principal MUST use this same derivation so the
// principal binds to exactly ONE declared schedule (a Blog.update source cannot
// admit a Doc.update dispatch). This is the binding that makes a system
// principal's authority equal to the entity's DECLARED will (not a free grant).
export function schedulerSource(entityName, verb, triggerId) {
  if (typeof triggerId !== 'string' || triggerId === '') {
    throw new Error('schedulerSource: triggerId must be a non-empty string');
  }
  return `${entityName}.${verb}.${triggerId}`;
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

// A canonical update to a deadline field starts a new schedule generation. Clear
// the previous one-shot receipt before projection so changing away and later
// back to the same timestamp can fire again. Scheduler-owned mutations must not
// erase the receipt they just created during admission.
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

// Once the projected row is gone, no deadline receipt for it can be useful.
// This runs in the same dispatch transaction as the removal.
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

// Trigger keys are allowed to evolve between releases. Prune receipts whose
// source no longer exists in the compiled application so renamed/removed
// declarations do not leave unreachable rows forever.
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


// tick — interval trigger constructors for row-set ticks.
// A tick fires `update` against EVERY row matching `while` per interval.
// No singleton/cron shape. An EMPTY `while` is FORBIDDEN at load-time.
export const tick = Object.freeze({
  hz(n, options = {}) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new Error('tick.hz: n must be a finite positive number');
    }
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'tick.hz');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'tick.hz', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'tick.hz');
    const validatedWhen = validateOptionalFunction(when, 'tick.hz', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'tick.hz', key: validatedKey, hertz: n, when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
  every(duration, options = {}) {
    const { key, while: whilePredicate, with: withPayload, when } = options;
    const validatedKey = validateTriggerKey(key, 'tick.every');
    const validatedWhile = validateOptionalFunction(whilePredicate, 'tick.every', 'while', '({fields}) => predicate');
    const validatedWith = validateWith(withPayload, 'tick.every');
    const validatedWhen = validateOptionalFunction(when, 'tick.every', 'when', '({row}) => boolean');
    return Object.freeze({ kind: 'tick.every', key: validatedKey, intervalMs: parseDelay(duration), when: validatedWhen, while: validatedWhile, with: validatedWith });
  },
});

// simulate — simulation declaration. A simulation runs an `hz`-rate loop
// holding ephemeral working state in memory (never per-tick DB writes).
// `step({state, dt, row})` → {state, events} returns the next working state
// plus optional events to persist. Events are dispatched through the normal
// pipeline (in-transaction), so checkpoint writes are framework-owned.
// `when` is an optional lifecycle guard — the simulation only runs while it
// returns true per scope.
export function simulate({ hz, step, when } = {}) {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0) {
    throw new Error('simulate: hz must be a finite positive number');
  }
  if (typeof step !== 'function') {
    throw new Error('simulate: step must be a function ({state, dt, row}) => ({state, events})');
  }
  return Object.freeze({ kind: 'simulate', hz, step, when: when ?? undefined });
}

// tickSource — derives the identity for a tick principal, mirroring the
// schedulerSource pattern (entity + verb + trigger identity). No fieldName —
// a tick has no field; the identity is derived, never a magic authority string.
export function tickSource(entityName, verb, triggerId = 'tick') {
  if (typeof triggerId !== 'string' || triggerId === '') {
    throw new Error('tickSource: triggerId must be a non-empty string');
  }
  return `${entityName}.${verb}.${triggerId}`;
}

// discoverTickedRows — private discovery for tick triggers.
// Yields { entity, verb, rowId, payload, triggerId }. `now` is unused (ticks
// have no due-time).
function discoverTickedRows(db, entities, now, intervalMs = null) {
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
