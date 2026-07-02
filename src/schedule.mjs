// P6d Spine A: time-driven sources (ADR #10). Import-surface only —
// constructuring + entity-slot acceptance. Firing/dispatch/reaper wiring
// lands in step 4; while/when discovery in step 2; tick in step 5.
//
// Tick triggers (tick.hz / tick.every) are row-set intervals: fire `update`
// against EVERY row matching `while` per interval. An EMPTY `while` is
// forbidden (the "run on ALL rows forever" foot-gun) — enforced at
// entity-load-time in entity.mjs.

const MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

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

// discoverDueSchedules — PURE discovery function for P6d step 4a.
// Returns an array of { entity, verb, rowId, payload } for all due schedule triggers.
// Does NOT dispatch, write, or mutate — only reads.
export function discoverDueSchedules(db, entities, now) {
  const results = [];
  for (const record of entities) {
    if (!record || !record.schedule) continue;
    for (const [verb, trigger] of Object.entries(record.schedule)) {
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

      // Add while clause if present (scope SQL already uses t0. prefix)
      if (trigger.whileSql) {
        sql += ` AND (${trigger.whileSql})`;
        Object.assign(params, trigger.whileParams);
      }

      const rows = db.prepare(sql).all(params);
      for (const row of rows) {
        // Resolve payload from 'with'
        let payload = {};
        if (trigger.with !== undefined && trigger.with !== null) {
          if (typeof trigger.with === 'function') {
            // Re-fetch the full row for the function
            const fullRow = db.prepare(`SELECT * FROM ${record.name} WHERE id = :id`).get({ id: row.id });
            payload = trigger.with({ row: fullRow });
          } else {
            // Object literal: shallow copy per row
            payload = { ...trigger.with };
          }
        }
        results.push({ entity: record.name, verb, rowId: row.id, payload });
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

// tickSource — derives the identity for a tick principal, mirroring the
// schedulerSource pattern (entity + verb). No fieldName — a tick has no
// field; derived id, never magic string.
export function tickSource(entityName, verb) {
  return `${entityName}.${verb}`;
}

// discoverTickedRows — PURE read-only discovery for tick triggers (parallel to
// discoverDueSchedules). For each row-set tick (tick.hz / tick.every), finds
// every row matching `while` and yields { entity, verb, rowId, payload }.
// `now` is accepted for signature parity but unused — ticks have no due-time.
export function discoverTickedRows(db, entities, now) {
  const results = [];
  for (const entity of entities) {
    if (!entity || !entity.schedule) continue;
    for (const [verb, trigger] of Object.entries(entity.schedule)) {
      if (trigger.kind !== 'tick.hz' && trigger.kind !== 'tick.every') continue;

      // Defensive: skip rows without a compiled while predicate (the empty-while
      // guard at entity-load-time guarantees this, but guard here too).
      if (!trigger.whileSql) continue;

      // Build: SELECT id FROM <name> AS t0 WHERE <whileSql>
      const sql = `SELECT id FROM ${entity.name} AS t0 WHERE ${trigger.whileSql}`;
      const params = { ...(trigger.whileParams ?? {}) };
      const rows = db.prepare(sql).all(params);

      for (const row of rows) {
        // Resolve payload from `with` (IDENTICAL to discoverDueSchedules)
        let payload = {};
        if (trigger.with !== undefined && trigger.with !== null) {
          if (typeof trigger.with === 'function') {
            // Re-fetch the full row for the function
            const fullRow = db.prepare(`SELECT * FROM ${entity.name} WHERE id = :id`).get({ id: row.id });
            payload = trigger.with({ row: fullRow });
          } else {
            // Object literal: shallow copy per row
            payload = { ...trigger.with };
          }
        }
        results.push({ entity: entity.name, verb, rowId: row.id, payload });
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

  const trigger = entity?.schedule?.[verb];
  if (!trigger) return false;

  if (trigger.kind === 'tick.hz' || trigger.kind === 'tick.every') {
    if (source !== tickSource(entity.name, verb)) return false;
    if (!trigger.whileSql) return false;
  } else if (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after') {
    if (!trigger.fieldName) return false;
    if (source !== schedulerSource(entity.name, verb, trigger.fieldName)) return false;
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
