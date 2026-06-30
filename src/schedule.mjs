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

// The expected scheduler source for a declared schedule. DERIVED from declared
// shape (entity name + verb + field name) — never an author magic string. A
// reaper minting a scheduler principal MUST use this same derivation so the
// principal binds to exactly ONE declared schedule (a Blog.update source cannot
// admit a Doc.update dispatch). This is the binding that makes a system
// principal's authority equal to the entity's DECLARED will (not a free grant).
export function schedulerSource(entityName, verb, fieldName) {
  return `${entityName}.${verb}.${fieldName}`;
}

// admitScheduledMutation — IN-TXN admission for a scheduler system principal
// (Option A, DECISIONLOG #62). Called from the dispatch spine's in-txn hook
// (postHandlerAuthorize) ONLY for principals of kind system with attributes.source.
// The scheduler principal is NOT a user with a row grant: its authority is the
// entity's declared schedule. This re-checks, against the CURRENT in-txn row:
//   (1) the principal's source binds to a declared schedule on this entity/verb;
//   (2) the row is STILL due (TOCTOU: it was due at discovery, may not be now);
//   (3) the compiled `while` predicate STILL holds on the current row;
//   (4) the dispatched payload matches the `with` payload recomputed from the
//       CURRENT row — a scheduler principal may NEVER send an arbitrary payload
//       (else "due" = "system write-anything").
// Admits only when ALL hold; denies (returns false) on any mismatch — fail-closed.
// This is a SIBLING to postHandlerAuthorize's create row-grant, NOT a widened
// admitsEffects and NOT a second auth path (same dispatch spine, branch on kind).
export function admitScheduledMutation({ entity, verb, rowId, payload, principal, db, now }) {
  // Fail closed: only a bound scheduler system principal reaches this gate.
  if (!principal || typeof principal !== 'object') return false;
  if (principal.type !== 'system') return false;
  const source = principal.attributes?.source;
  if (typeof source !== 'string' || source === '') return false;

  // The entity must declare a schedule for this verb.
  const trigger = entity?.schedule?.[verb];
  if (!trigger || !trigger.fieldName) return false;

  // The principal's source must bind to THIS declared schedule (derived id).
  if (source !== schedulerSource(entity.name, verb, trigger.fieldName)) return false;

  // Re-read the CURRENT row (in-txn): it may have been deleted/mutated between
  // discovery and this dispatch. A missing row → deny (TOCTOU-safe).
  const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(rowId);
  if (!row) return false;

  // Re-check DUE against the current row value + the original delay semantics.
  // Date/number fields store epoch-ms integers (field-strategy.mjs serialize).
  const fieldVal = Number(row[trigger.fieldName]);
  if (!Number.isFinite(fieldVal)) return false;
  const dueAt = trigger.kind === 'schedule.after' ? fieldVal + (trigger.delay ?? 0) : fieldVal;
  if (dueAt > now) return false; // no longer due at dispatch time

  // Re-check the compiled `while` predicate against the current row, using the
  // t0 alias discoverDueSchedules/compileReadScope established. No row = while
  // no longer holds → deny (the declared will still governs).
  if (trigger.whileSql) {
    const params = { ...(trigger.whileParams ?? {}), __rowId: rowId };
    const held = db.prepare(
      `SELECT 1 FROM ${entity.name} AS t0 WHERE t0.id = :__rowId AND (${trigger.whileSql})`,
    ).get(params);
    if (!held) return false;
  }

  // Recompute the declared `with` payload from the CURRENT row, then COMPARE the
  // dispatched payload against it. The scheduler may send ONLY this payload.
  let declaredPayload;
  if (typeof trigger.with === 'function') {
    declaredPayload = trigger.with({ row });
  } else if (trigger.with && typeof trigger.with === 'object') {
    declaredPayload = { ...trigger.with };
  } else {
    declaredPayload = {};
  }
  // The dispatched payload carries the structural `id` (the row's primary key)
  // which the `update` handler REQUIRES to locate the row ('update requires an
  // id'); the declared `with` never includes it. The rowId is the TARGET, not a
  // field the schedule writes. Strip `id` from the dispatched payload before
  // comparing, so the write-anything guard matches on the DECLARED FIELD SET.
  const { id: _rowId, ...payloadFields } = payload ?? {};
  // Deep structural equality (values, nested objects/arrays) — a mismatched
  // payload (a field the schedule did not declare, or a stale recomputed value)
  // is a deny. JSON.stringify round-trip is sufficient for the payload grammar
  // (plain objects/values; functions are not valid payload members).
  try {
    if (JSON.stringify(payloadFields) !== JSON.stringify(declaredPayload)) return false;
  } catch {
    return false; // unserializable payload → fail closed
  }

  return true; // due + while + bound source + exact payload → admitted
}
