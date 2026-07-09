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
function validateWith(withValue, context) {
  if (withValue === undefined) return undefined;
  if (withValue === null) return null;
  if (typeof withValue === 'function') return withValue;
  if (typeof withValue === 'object' && !Array.isArray(withValue)) return withValue;
  throw new Error(`schedule ${context}: 'with' must be an object or a function ({row}) => obj`);
}

function resolvePayload(trigger, db, entityName, rowId) {
  if (trigger.with === undefined || trigger.with === null) return {};
  if (typeof trigger.with === 'function') {
    const fullRow = db.prepare(`SELECT * FROM ${entityName} WHERE id = :id`).get({ id: rowId });
    return trigger.with({ row: fullRow });
  }
  return { ...trigger.with };
}

export const schedule = Object.freeze({
  at(field, options = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.at: field must be a field descriptor');
    const { while: whilePredicate, with: withPayload } = options;
    if (whilePredicate !== undefined && typeof whilePredicate !== 'function') {
      throw new Error('schedule.at: while must be a function');
    }
    const validatedWith = validateWith(withPayload, '.at');
    return Object.freeze({ kind: 'schedule.at', field, while: whilePredicate ?? undefined, with: validatedWith });
  },
  after(field, delay, options = {}) {
    if (!field || typeof field !== 'object') throw new Error('schedule.after: field must be a field descriptor');
    const { while: whilePredicate, with: withPayload } = options;
    if (whilePredicate !== undefined && typeof whilePredicate !== 'function') {
      throw new Error('schedule.after: while must be a function');
    }
    const validatedWith = validateWith(withPayload, '.after');
    // Deferral note: Spine A step 5 (tick) implements the runtime-guard fallback
    // for non-compilable while predicates (SPEC §10), the 'when' lifecycle guard
    // (Spine C8 state runtime), and the "empty while forbidden for row-set ticks"
    // guard. For schedule.at/after, strict compile of 'while' is fail-closed;
    // absent 'while' is valid (the date field IS the discovery).
    return Object.freeze({ kind: 'schedule.after', field, delay: parseDelay(delay), while: whilePredicate ?? undefined, with: validatedWith });
  },
});

// A verb's schedule slot accepts one trigger or an array; normalize to an array.
export function triggerList(triggerOrTriggers) {
  if (triggerOrTriggers == null) return [];
  return Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers];
}

// discoverDueSchedules — private discovery for deadline triggers.
// Returns { entity, verb, rowId, payload, sourceName }[]; does not dispatch.
function discoverDueSchedules(db, entities, now) {
  const results = [];
  for (const record of entities) {
    if (!record || !record.schedule) continue;
    for (const [verb, triggerOrTriggers] of Object.entries(record.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        const fieldName = trigger.fieldName;
        if (!fieldName) continue; // should not happen if entity validation ran

        let sql, params;
        if (trigger.kind === 'schedule.at') {
          // Date fields store epoch-ms integers (field-strategy.mjs serialize).
          // Direct integer comparison: row is due when field <= now.
          // Table alias 't0' matches the scope-sql.mjs convention for while predicates.
          sql = `SELECT id FROM ${record.name} AS t0 WHERE t0.${fieldName} <= :now`;
          params = { now };
        } else if (trigger.kind === 'schedule.after') {
          // Due when field + delay <= now. CAST ensures string-stored epochs still add.
          sql = `SELECT id, t0.${fieldName} FROM ${record.name} AS t0 WHERE CAST(t0.${fieldName} AS INTEGER) + :delay <= :now`;
          params = { now, delay: trigger.delay };
        } else {
          continue;
        }

        const rows = db.prepare(sql).all(params);
        for (const row of rows) {
          if (!trigger.matches(db, row)) continue;
          const payload = resolvePayload(trigger, db, record.name, row.id);
          results.push({ entity: record.name, verb, rowId: row.id, payload, sourceName: trigger.sourceName ?? fieldName });
        }
      }
    }
  }
  return results;
}

// The expected scheduler source for a declared schedule. DERIVED from declared
// shape (entity name + verb + field name) — never an author magic string. A
// reaper minting a scheduler principal MUST use this same derivation so the
// principal binds to exactly ONE declared schedule (a Blog.update source cannot
// admit a Doc.update dispatch). This is the binding that makes a system
// principal's authority equal to the entity's DECLARED will (not a free grant).
export function schedulerSource(entityName, verb, fieldName) {
  return `${entityName}.${verb}.${fieldName}`;
}


// tick — interval trigger constructors for row-set ticks.
// A tick fires `update` against EVERY row matching `while` per interval.
// No singleton/cron shape. An EMPTY `while` is FORBIDDEN at load-time.
export const tick = Object.freeze({
  hz(n, options = {}) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      throw new Error('tick.hz: n must be a finite positive number');
    }
    const { while: whilePredicate, with: withPayload, when } = options;
    if (whilePredicate !== undefined && typeof whilePredicate !== 'function') {
      throw new Error('tick.hz: while must be a function');
    }
    const validatedWith = validateWith(withPayload, '.tick.hz');
    return Object.freeze({ kind: 'tick.hz', hertz: n, when, while: whilePredicate ?? undefined, with: validatedWith });
  },
  every(duration, options = {}) {
    const { while: whilePredicate, with: withPayload, when } = options;
    if (whilePredicate !== undefined && typeof whilePredicate !== 'function') {
      throw new Error('tick.every: while must be a function');
    }
    const validatedWith = validateWith(withPayload, '.tick.every');
    return Object.freeze({ kind: 'tick.every', intervalMs: parseDelay(duration), when, while: whilePredicate ?? undefined, with: validatedWith });
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
// schedulerSource pattern (entity + verb). No fieldName — a tick has no
// field; derived id, never magic string.
export function tickSource(entityName, verb) {
  return `${entityName}.${verb}`;
}

// discoverTickedRows — private discovery for tick triggers.
// Yields { entity, verb, rowId, payload }. `now` is unused (ticks have no due-time).
function discoverTickedRows(db, entities, now) {
  const results = [];
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const [verb, triggerOrTriggers] of Object.entries(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (trigger.kind !== 'tick.hz' && trigger.kind !== 'tick.every') continue;

        const sql = `SELECT id FROM ${entity.name} AS t0`;
        const rows = db.prepare(sql).all();

        for (const row of rows) {
          if (!trigger.matches(db, row)) continue;
          const payload = resolvePayload(trigger, db, entity.name, row.id);
          results.push({ entity: entity.name, verb, rowId: row.id, payload });
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
    if (t.kind === 'tick.hz' || t.kind === 'tick.every') return source === tickSource(entity.name, verb);
    const sourceName = t.sourceName ?? t.fieldName;
    return sourceName != null && source === schedulerSource(entity.name, verb, sourceName);
  });
  if (!trigger) return false;

  if (trigger.kind === 'tick.hz' || trigger.kind === 'tick.every') {
    if (!trigger.whileSql) return false;
  } else if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
    if (!trigger.fieldName) return false;
  } else {
    return false;
  }

  const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(rowId);
  if (!row) return false;

  if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
    const fieldVal = Number(row[trigger.fieldName]);
    if (!Number.isFinite(fieldVal)) return false;
    const dueAt = trigger.kind === 'schedule.after' ? fieldVal + (trigger.delay ?? 0) : fieldVal;
    if (dueAt > now) return false;
  }

  if (trigger.whileSql) {
    const params = { ...(trigger.whileParams ?? {}), __rowId: rowId };
    const held = db.prepare(
      `SELECT 1 FROM ${entity.name} AS t0 WHERE t0.id = :__rowId AND (${trigger.whileSql})`,
    ).get(params);
    if (!held) return false;
  }

  let declaredPayload;
  if (typeof trigger.with === 'function') {
    declaredPayload = trigger.with({ row });
  } else if (trigger.with && typeof trigger.with === 'object') {
    declaredPayload = { ...trigger.with };
  } else {
    declaredPayload = {};
  }
  const { id: _id, ...payloadFields } = payload ?? {};
  try {
    if (JSON.stringify(payloadFields) !== JSON.stringify(declaredPayload)) return false;
  } catch {
    return false;
  }

  return true;
}

function normalizeEntityList(entities) {
  return entities instanceof Map ? [...entities.values()] : entities;
}

function computeIntervalFromTrigger(trigger) {
  if (trigger.kind === 'tick.every') return trigger.intervalMs;
  if (trigger.kind === 'tick.hz') return Math.floor(1000 / trigger.hertz);
  return NaN;
}

function computeTickInterval(entities) {
  let min = Infinity;
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const triggerOrTriggers of Object.values(entity.schedule)) {
      for (const trigger of triggerList(triggerOrTriggers)) {
        if (!trigger) continue;
        const iv = computeIntervalFromTrigger(trigger);
        if (Number.isFinite(iv) && iv < min) min = iv;
      }
    }
  }
  return min === Infinity ? 0 : min;
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
  for (const { entity: entityName, verb, rowId, payload, sourceName } of rows) {
    try {
      const entity = entityMap.get(entityName);
      if (!entity) continue;
      const trigger = triggerList(entity.schedule?.[verb]).find((t) => (t.sourceName ?? t.fieldName) === sourceName);
      if (!trigger?.fieldName) continue;
      const source = schedulerSource(entityName, verb, sourceName ?? trigger.fieldName);
      const principal = principalFrom(source);
      dispatch({ actionId: randomUUID(), type: `${entityName}.${verb}`, principal, payload: { id: rowId, ...payload } });
    } catch (err) {
      getLog().warn('system', 'schedule clock-dispatch (deadline) failed', { err, entity: entityName, verb, rowId });
    }
  }
}

function scanTicks({ db, entityList, dispatch, now }) {
  const rows = discoverTickedRows(db, entityList, now());
  for (const { entity: entityName, verb, rowId, payload } of rows) {
    try {
      const source = tickSource(entityName, verb);
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

  const tickInterval = computeTickInterval(entityList);
  if (tickInterval > 0) {
    try {
      scanTicks({ db, entityList, dispatch, now });
    } catch (err) {
      getLog().warn('system', 'schedule clock-dispatch (tick) scan failed', { err });
    }
    runners.push(createClockRunner({
      clock,
      intervalMs: tickInterval,
      name: 'schedule-tick',
      fn: () => scanTicks({ db, entityList, dispatch, now }),
    }));
  }

  if (runners.length === 0) return { stop() {} };

  return {
    stop() {
      for (const runner of runners) runner.stop();
    },
  };
}
