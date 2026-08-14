// Schedule / state validation helpers extracted from compile.mjs.
//
// Pure extraction — zero behavioral change. These functions validate schedule
// triggers, auto-state transitions, state effect entries, SQL identifiers,
// and mint tokens at entity compile time.

import { randomBytes } from 'node:crypto';
import { compileReadScope } from '../scope-sql.mjs';
import { updated } from '../event-handle.mjs';
import { self } from '../effect-runtime.mjs';
import { schedule as scheduleConstructors } from '../schedule.mjs';

// mintToken — a cryptographically random opaque session token. Handed to a
// create policy so a framework entity that mints session-like rows (Session)
// generates an unguessable token without reaching for node:crypto itself.
export function mintToken() {
  return randomBytes(24).toString('hex');
}


































export function stateEffectEntries(entityName        , fieldName        , descriptor                      ) {
  const declared = descriptor.effects;
  if (declared == null || Object.keys(declared).length === 0) return [];

  const legalTransitions = new Map                                      ();
  for (const [from, targets] of Object.entries(descriptor.transitions ?? {})) {
    for (const to of targets ?? []) {
      const key = `transition:${from}->${to}`;
      const existing = legalTransitions.get(key);
      if (existing && (existing.from !== from || existing.to !== to)) {
        throw new Error(
          `state effects on ${entityName}.${fieldName} contain ambiguous transition values ` +
          `'${existing.from}' -> '${existing.to}' and '${from}' -> '${to}'.`,
        );
      }
      legalTransitions.set(key, { from, to });
    }
  }

  return Object.entries(declared).map(([key, declaredEffect]) => {
    const transition = legalTransitions.get(key);
    if (!transition) {
      throw new Error(
        `state effect '${key}' on ${entityName}.${fieldName} must name a declared legal transition. ` +
        `Use [state.transition(from, to)] as the key.`,
      );
    }
    if (declaredEffect?.durable !== undefined) {
      throw new Error(
        `state effect '${key}' on ${entityName}.${fieldName} cannot be durable because ` +
        'transition preimages are transaction-local.',
      );
    }
    const mutate = Object.hasOwn(declaredEffect ?? {}, 'mutate') ? (declaredEffect                    ).mutate : self;
    const effect = Object.freeze({
      ...declaredEffect,
      mutate,
      _stateTransition: Object.freeze({ fieldName, ...transition }),
    });
    return [updated(entityName), effect];
  });
}

// A declared name (entity, field, struct sub-cell) is interpolated verbatim into
// SQL identifiers — `FROM ${name}`, `CREATE TABLE ${entity.name}`, generated
// `<field>__<cell>` columns. Those names come from framework/app code at load
// time, never from a request, so this is not a runtime injection surface — but a
// name that is not a plain SQL identifier is a load-time FOOTGUN that would emit
// broken or dangerous DDL/DML. Fail closed at compile time: a name must be a
// bare identifier (letter or `_` first, then letters/digits/`_`).
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSqlIdentifier(kind        , value         ) {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(
      `${kind} name ${JSON.stringify(value)} is not a valid SQL identifier. A ` +
        `name is interpolated directly into SQL and must match ` +
        `/^[A-Za-z_][A-Za-z0-9_]*$/ (a letter or underscore, then letters, ` +
        `digits, or underscores). Rename it (fail closed).`,
    );
  }
}

export function autoStateScheduleTrigger(entityName        , fieldName        , descriptor                      , fields        ) {
  const auto = descriptor.auto;
  if (!auto || typeof auto !== 'object' || Array.isArray(auto)) {
    throw new Error(`${entityName}.${fieldName}.auto must be an object`);
  }
  const { when, after, to, from } = auto;
  if (when === undefined || after === undefined || to === undefined || from === undefined) {
    throw new Error(`${entityName}.${fieldName}.auto requires when, after, to, and from`);
  }
  if (!descriptor.values .includes(when)) {
    throw new Error(`${entityName}.${fieldName}.auto.when must be one of the declared state values`);
  }
  if (!descriptor.values .includes(to)) {
    throw new Error(`${entityName}.${fieldName}.auto.to must be one of the declared state values`);
  }
  if (!(descriptor.transitions [when] ?? []).includes(to)) {
    throw new Error(`${entityName}.${fieldName}.auto transition ${when} -> ${to} is not declared`);
  }
  let anchorName                = null;
  for (const [candidateName, candidate] of Object.entries(fields)) {
    if (candidate === from) {
      anchorName = candidateName;
      break;
    }
  }
  if (!anchorName) {
    throw new Error(`${entityName}.${fieldName}.auto.from must be a declared date or number field descriptor`);
  }
  const anchor = fields[anchorName];
  if (anchor.kind !== 'value' || (anchor.type !== 'date' && anchor.type !== 'number')) {
    throw new Error(`${entityName}.${fieldName}.auto.from must reference a date or number field`);
  }
  return Object.freeze({
    ...scheduleConstructors.after(from, after, { with: { [fieldName]: to } }),
    autoState: Object.freeze({ fieldName, when }),
    sourceName: `${anchorName}.${fieldName}.auto`,
  });
}















export function validateScheduleTrigger({ name, verbName, trigger, fields, registry }





 ) {
  const isDeadline = trigger?.kind === 'schedule.at' || trigger?.kind === 'schedule.after';
  const isTick = trigger?.kind === 'tick.hz' || trigger?.kind === 'tick.every';
  if (!trigger || typeof trigger !== 'object' || !(isDeadline || isTick)) {
    throw new Error(`schedule.${verbName}: expected schedule.at(...), schedule.after(...), tick.hz(...), or tick.every(...), got ${JSON.stringify(trigger)}`);
  }

  let whileSql                    ;
  let whileParams                                     ;
  let whileAst         ;
  let withValue         ;
  let fieldName                = null;

  if (trigger.when !== undefined && typeof trigger.when !== 'function') {
    throw new Error(`schedule.${verbName}: 'when' must be a function ({row}) => boolean`);
  }

  if (isDeadline) {
    if (!trigger.field || typeof trigger.field !== 'object') {
      throw new Error(`schedule.${verbName}: field must be a field descriptor (no bare strings)`);
    }
    for (const [fname, fdesc] of Object.entries(fields)) {
      if (fdesc === trigger.field) {
        fieldName = fname;
        break;
      }
    }
    if (!fieldName) {
      throw new Error(`schedule '${verbName}': field descriptor is not a declared field on entity '${name}'`);
    }
    const fieldKind = fields[fieldName].kind;
    const fieldType = fields[fieldName].type;
    if (fieldKind !== 'value' || (fieldType !== 'date' && fieldType !== 'number')) {
      throw new Error(`schedule '${verbName}': field '${fieldName}' must be a date or number field (kind 'value', comparable via <=)`);
    }
    if (trigger.kind === 'schedule.after' && !Number.isFinite(trigger.delay)) {
      throw new Error(`schedule.${verbName}: delay must be a finite number (parseDelay should have validated)`);
    }
    withValue = trigger.with;
  } else {
    if (trigger.while === undefined) {
      throw new Error(
        `schedule.${verbName}: a row-set tick requires a 'while' predicate ` +
          `(empty while would fire on every row forever)`,
      );
    }
    if (trigger.kind === 'tick.hz') {
      if (!Number.isFinite(trigger.hertz) || trigger.hertz  <= 0) {
        throw new Error(`schedule.${verbName}: hertz must be a finite positive number (tick.hz should have validated)`);
      }
    } else if (!Number.isFinite(trigger.intervalMs) || trigger.intervalMs  <= 0) {
      throw new Error(`schedule.${verbName}: intervalMs must be a finite positive number (tick.every should have validated)`);
    }
    withValue = trigger.with;
  }

  if (withValue !== undefined && withValue !== null) {
    if (typeof withValue !== 'function' && (typeof withValue !== 'object' || Array.isArray(withValue))) {
      throw new Error(`schedule '${verbName}': 'with' must be an object or a function ({row}) => obj`);
    }
  }

  if (trigger.autoState) {
    const paramName = `__auto_${trigger.autoState.fieldName}`;
    whileSql = `t0.${trigger.autoState.fieldName} = :${paramName}`;
    whileParams = { [paramName]: trigger.autoState.when };
    whileAst = Object.freeze({ node: 'autoState', field: trigger.autoState.fieldName, value: trigger.autoState.when });
  } else if (trigger.while !== undefined) {
    const compiled = compileReadScope(trigger.while                                                      , {
      fields,
      where: `schedule.${verbName} while on entity('${name}')`,
      registry: registry                           ,
      entityName: name,
    });
    whileSql = compiled.sql;
    whileParams = compiled.params;
    whileAst = compiled.ast;
  }

  const sourceName = trigger.sourceName ?? fieldName;
  const triggerId = trigger.key ?? (
    trigger.sourceName ?? (
      trigger.kind === 'schedule.at' ? fieldName
        : trigger.kind === 'schedule.after' ? `${fieldName}.after.${trigger.delay}`
          : 'tick'
    )
  );

  // matches(db, row) — run the while predicate against one row after discovery.
  // The whileSql is still compiled (used in discovery queries), but callers that
  // need to verify a single row use this instead of recomposing the SQL inline.
  const matches = (db    , row     ) => {
    if (!whileSql) return true;
    const params = { ...(whileParams ?? {}), __rowId: row.id };
    const result = db.prepare(
      `SELECT 1 FROM ${name} AS t0 WHERE t0.id = :__rowId AND (${whileSql})`
    ).get(params);
    return !!result;
  };

  if (isDeadline) {
    return Object.freeze({
      kind: trigger.kind,
      field: trigger.field,
      fieldName,
      delay: trigger.delay,
      whileSql,
      whileParams,
      whileAst,
      when: trigger.when,
      with: withValue,
      autoState: trigger.autoState,
      sourceName,
      triggerId,
      matches,
    });
  }
  return Object.freeze({
    kind: trigger.kind,
    hertz: trigger.hertz ,
    intervalMs: trigger.intervalMs ,
    whileSql,
    whileParams,
    whileAst,
    when: trigger.when,
    with: withValue,
    sourceName: trigger.sourceName ?? null,
    triggerId,
    matches,
  });
}
