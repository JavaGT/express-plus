// P6d Spine A: time-driven sources (ADR #10). Import-surface only —
// constructuring + entity-slot acceptance. Firing/dispatch/reaper wiring
// lands in step 4; while/when discovery in step 2; tick in step 5.

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
