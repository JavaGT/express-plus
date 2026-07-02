// entity(name, { fields, grant, checks?, routes? }) — the entity compiler.
//
// Compiles a declared entity into a frozen, validated record. This is where the
// fail-closed load-time guards live (SPEC §6.1, §13; ADRs #7, #16):
//
//  - No grant is a LOAD-TIME ERROR (ADR #7): there is no zero-to-one default
//    grant; the smoothest path is still an explicit one.
//  - A `ref` field with `role: 'x'` auto-derives a check `is.x()` — the ONE
//    thing the FK derives (SPEC §6.2): the single source of truth for "who is
//    the x of this row". A developer-declared check of the same name is a
//    LOAD-TIME ERROR: a ref-role check cannot be redeclared (DECISIONLOG #54;
//    the one registry derives both the SQL filter face and the runtime boolean
//    face from the one field — a second hand-written body is the split-brain
//    the unified registry exists to forbid).
//  - Every `.can` body is statically guarded (assertGuarded, ADR #16). A `scope`
//    predicate is NOT guarded: it compiles to SQL and never runs as JS, so its
//    `is.*` calls are correctly un-awaited (SPEC §6.1).

import { randomBytes, randomUUID } from 'node:crypto';
import { compileReadScope, fieldHandle } from '../scope-sql.mjs';
import { getActiveDb } from '../db.mjs';
import { compileEntityAuthz } from '../authz.mjs';
import { getLog } from '../log.mjs';
import {
  serializeField, validateMutation, ValidationError, flattenStruct,
} from '../field-strategy.mjs';
import { action, event } from '../pipeline.mjs';
import * as eventHandle from '../event-handle.mjs';
import { created, updated, removed } from '../event-handle.mjs';
import { generateDDL } from '../ddl.mjs';
import { effectEntries, validateEffectDeclaration } from '../effect-compiler.mjs';
import { schedule as scheduleConstructors } from '../schedule.mjs';
import { collectSideTableStrategies } from '../side-table-strategy.mjs';
import { registerEntityHandle } from './handles.mjs';
import { createEntityHydrator } from './hydrate.mjs';
import { createEntityProjection } from './projection.mjs';
import { installEntityQueries } from './query.mjs';

// mintToken — a cryptographically random opaque session token. Handed to a
// create policy so a framework entity that mints session-like rows (Session)
// generates an unguessable token without reaching for node:crypto itself.
function mintToken() {
  return randomBytes(24).toString('hex');
}

// A declared name (entity, field, struct sub-cell) is interpolated verbatim into
// SQL identifiers — `FROM ${name}`, `CREATE TABLE ${entity.name}`, generated
// `<field>__<cell>` columns. Those names come from framework/app code at load
// time, never from a request, so this is not a runtime injection surface — but a
// name that is not a plain SQL identifier is a load-time FOOTGUN that would emit
// broken or dangerous DDL/DML. Fail closed at compile time: a name must be a
// bare identifier (letter or `_` first, then letters/digits/`_`).
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertSqlIdentifier(kind, value) {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(
      `${kind} name ${JSON.stringify(value)} is not a valid SQL identifier. A ` +
        `name is interpolated directly into SQL and must match ` +
        `/^[A-Za-z_][A-Za-z0-9_]*$/ (a letter or underscore, then letters, ` +
        `digits, or underscores). Rename it (fail closed).`,
    );
  }
}

function scheduleTriggersFor(triggerOrTriggers) {
  if (triggerOrTriggers == null) return [];
  return Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers];
}

function autoStateScheduleTrigger(entityName, fieldName, descriptor, fields) {
  const auto = descriptor.auto;
  if (!auto || typeof auto !== 'object' || Array.isArray(auto)) {
    throw new Error(`${entityName}.${fieldName}.auto must be an object`);
  }
  const { when, after, to, from } = auto;
  if (when === undefined || after === undefined || to === undefined || from === undefined) {
    throw new Error(`${entityName}.${fieldName}.auto requires when, after, to, and from`);
  }
  if (!descriptor.values.includes(when)) {
    throw new Error(`${entityName}.${fieldName}.auto.when must be one of the declared state values`);
  }
  if (!descriptor.values.includes(to)) {
    throw new Error(`${entityName}.${fieldName}.auto.to must be one of the declared state values`);
  }
  if (!(descriptor.transitions[when] ?? []).includes(to)) {
    throw new Error(`${entityName}.${fieldName}.auto transition ${when} -> ${to} is not declared`);
  }
  let anchorName = null;
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

function validateScheduleTrigger({ name, verbName, trigger, fields, registry }) {
  const isDeadline = trigger?.kind === 'schedule.at' || trigger?.kind === 'schedule.after';
  const isTick = trigger?.kind === 'tick.hz' || trigger?.kind === 'tick.every';
  if (!trigger || typeof trigger !== 'object' || !(isDeadline || isTick)) {
    throw new Error(`schedule.${verbName}: expected schedule.at(...), schedule.after(...), tick.hz(...), or tick.every(...), got ${JSON.stringify(trigger)}`);
  }

  let whileSql;
  let whileParams;
  let whileAst;
  let withValue;
  let fieldName = null;

  if (isDeadline) {
    if (trigger.when) {
      throw new Error(`schedule.${verbName}: 'when' lifecycle guard is not yet supported (ships with state runtime)`);
    }
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
    if (trigger.when) {
      throw new Error(`schedule.${verbName}: 'when' lifecycle guard is not yet supported (ships with state runtime)`);
    }
    if (trigger.while === undefined) {
      throw new Error(
        `schedule.${verbName}: a row-set tick requires a 'while' predicate ` +
          `(empty while would fire on every row forever)`,
      );
    }
    if (trigger.kind === 'tick.hz') {
      if (!Number.isFinite(trigger.hertz) || trigger.hertz <= 0) {
        throw new Error(`schedule.${verbName}: hertz must be a finite positive number (tick.hz should have validated)`);
      }
    } else if (!Number.isFinite(trigger.intervalMs) || trigger.intervalMs <= 0) {
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
    const compiled = compileReadScope(trigger.while, {
      fields,
      where: `schedule.${verbName} while on entity('${name}')`,
      registry,
    });
    whileSql = compiled.sql;
    whileParams = compiled.params;
    whileAst = compiled.ast;
  }

  const sourceName = trigger.sourceName ?? fieldName;
  if (isDeadline) {
    return Object.freeze({
      kind: trigger.kind,
      field: trigger.field,
      fieldName,
      delay: trigger.delay,
      whileSql,
      whileParams,
      whileAst,
      with: withValue,
      sourceName,
    });
  }
  return Object.freeze({
    kind: trigger.kind,
    hertz: trigger.hertz,
    intervalMs: trigger.intervalMs,
    whileSql,
    whileParams,
    whileAst,
    with: withValue,
    sourceName: trigger.sourceName ?? null,
  });
}

export function entity(name, declaration = {}) {
  const { fields = {}, grant, checks: declaredChecks = {}, routes, create: createPolicy, effects = null, admitsEffects = null, schedule = {} } = declaration;

  // The entity name becomes a table name interpolated into SQL — validate first.
  assertSqlIdentifier('entity', name);

  // Fail closed: an entity with no grant cannot be mounted (ADR #7).
  if (grant === undefined || grant === null) {
    throw new Error(
      `entity('${name}') has no grant. An entity with no grant is a load-time ` +
        `error (ADR #7): there is no default grant. Declare one explicitly, ` +
        `e.g. grant: () => [scope(...).can(...)].`,
    );
  }

  // A structured field generates `<field>__<cell>` columns; a declared field or
  // sub-cell name containing the `__` separator could collide with a generated
  // column, so it is a load-time error (fail closed — the generated namespace
  // and the declared namespace must never alias).
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    // A field name becomes a column (and, for a struct, a `<field>__<cell>`
    // column) interpolated into SQL — validate it is a bare identifier first,
    // then reject the reserved '__' separator that would alias the generated
    // struct-column namespace.
    assertSqlIdentifier(`entity('${name}') field`, fieldName);
    if (fieldName.includes('__')) {
      throw new Error(
        `entity('${name}') field '${fieldName}' contains the reserved '__' separator, ` +
          `which is used to generate structured-field columns. Rename the field.`,
      );
    }
    // Lifecycle event handles are reserved member names on the entity handle
    // (Doc.created / Doc.updated / Doc.removed — typed event handles). A declared
    // field of the same name would shadow the handle, so it is a load-time error.
    if (fieldName === 'created' || fieldName === 'updated' || fieldName === 'removed') {
      throw new Error(
        `entity('${name}') field '${fieldName}' collides with the reserved lifecycle ` +
          `event handle ${name}.${fieldName}. Rename the field — the lifecycle handle ` +
          `is the derived identifier for effects keyed on ${name}.${fieldName}.`,
      );
    }
    if (descriptor.kind === 'struct') {
      for (const cellName of Object.keys(descriptor.cells)) {
        assertSqlIdentifier(`entity('${name}') field '${fieldName}' sub-cell`, cellName);
        if (cellName.includes('__')) {
          throw new Error(
            `entity('${name}') field '${fieldName}' has a sub-cell '${cellName}' containing ` +
              `the reserved '__' separator. Rename the sub-cell.`,
          );
        }
      }
    }
  }

  const { registry, readScope, scopeAst, clauses } = compileEntityAuthz(name, {
    fields,
    grant,
    declaredChecks,
  });

  const selfHandle = new Proxy({
    name,
    fields,
    created: created(name),
    updated: updated(name),
    removed: removed(name),
  }, {
    get(target, key, receiver) {
      if (key in target || typeof key !== 'string') {
        return Reflect.get(target, key, receiver);
      }
      if (key === 'id') return { fieldName: 'id' };
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        return fieldHandle(key, fields[key], name);
      }
      return undefined;
    },
  });

  // Validate declared effects at load time (but not cycle detection — that runs
  // globally after all entities are defined). Each effect must have valid
  // { mutate, with, when? } shape. A non-compilable 'when' predicate is a
  // load-time error (ADR #22). Trigger handles resolve through the effect compiler;
  // map mutations use entity-specific typed handles such as
  // Doc.collaborators.added, not generic field-local aliases.
  const declaredEffectsArray = typeof effects === 'function' ? effects(selfHandle) : effects;
  const entries = effectEntries(declaredEffectsArray, { sourceEntityName: name });
  const validatedEffects = entries.length > 0 ? Object.freeze([...entries]) : null;
  for (const [triggerHandle, effect] of entries) {
    validateEffectDeclaration(effect, { triggerHandle, sourceEntityName: name });
  }

  const declaredSchedule = { ...schedule };
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'state' || descriptor.auto == null) continue;
    const trigger = autoStateScheduleTrigger(name, fieldName, descriptor, fields);
    declaredSchedule.update = [...scheduleTriggersFor(declaredSchedule.update), trigger];
  }

  let validatedSchedule = null;
  const scheduleKeys = Object.keys(declaredSchedule);
  if (scheduleKeys.length > 0) {
    validatedSchedule = {};
    for (const [verbName, triggerOrTriggers] of Object.entries(declaredSchedule)) {
      if (typeof verbName !== 'string' || verbName.length === 0) {
        throw new Error(`schedule: verb name must be a non-empty string, got ${verbName}`);
      }
      if (!['create', 'update', 'remove'].includes(verbName)) {
        throw new Error(`schedule verb '${verbName}' must be one of create | update | remove (entity '${name}')`);
      }
      const triggers = scheduleTriggersFor(triggerOrTriggers);
      if (triggers.length === 0) {
        throw new Error(`schedule.${verbName}: expected at least one schedule trigger`);
      }
      const validated = triggers.map((trigger) => validateScheduleTrigger({
        name,
        verbName,
        trigger,
        fields,
        registry,
      }));
      validatedSchedule[verbName] = triggers.length === 1 ? Object.freeze(validated[0]) : Object.freeze(validated);
    }
    validatedSchedule = Object.freeze(validatedSchedule);
  }

  // projected.async fields: each entry is [fieldName, { compute }] for the
  // post-commit consumer to iterate.
  const projectedAsyncFields = Object.entries(fields)
    .filter(([, d]) => d.kind === 'projected' && d.mode === 'async');
  // computed.stored fields: run in-transaction in the projection's apply handler.
  const storedComputedFields = Object.entries(fields)
    .filter(([, d]) => d.kind === 'computed' && d.mode === 'stored');

  const record = {
    name,
    fields: Object.freeze({ ...fields }),
    grant,
    registry,
    // Keep a `checks` object for tests that read entity.checks.<name>(...).
    // Each key is the RUN face — the canonical home is `registry`, but existing
    // tests expect `checks` to expose callable functions. Built eagerly so it
    // is a plain object (not a Proxy over a frozen target, which would throw
    // when a get trap returns a different value from a non-writable property).
    get checks() {
      const checksObj = {};
      for (const [name, entry] of Object.entries(registry)) {
        if (entry.run) checksObj[name] = entry.run;
      }
      return Object.freeze(checksObj);
    },
    routes,
    readScope: readScope ? Object.freeze({ sql: readScope.sql, params: readScope.params }) : undefined,
    scopeAst,
    effects: validatedEffects,
    admitsEffects,
    schedule: validatedSchedule,
    projectedAsyncFields: Object.freeze(projectedAsyncFields),
    storedComputedFields: Object.freeze(storedComputedFields),
  };

  const sideTableStrategyEntries = collectSideTableStrategies(fields);
  const { hydrate, deserializeStoredCells } = createEntityHydrator({
    record,
    entityName: name,
    fields,
    sideTableStrategyEntries,
  });

  installEntityQueries(record, { name, hydrate, deserializeStoredCells });


  // insert(cells) — the trusted low-level write core: serialize each declared
  // field's value to its stored cell, INSERT, and return the hydrated new row.
  // It does NOT run validateMutation — its caller has already decided the cells
  // are legitimate (the generic create validates an untrusted payload first; a
  // create POLICY mints server-side cells it owns). This is the ONE place the
  // INSERT/return-row mechanics live; both write paths compose it (singular
  // system, deletion test: the policy override adds intent, not a second insert).
  const insert = (cells) => {
    const id = cells.id ?? randomUUID();
    const stored = { id };
    for (const [key, value] of Object.entries(cells)) {
      if (key === 'id') continue;
      const descriptor = fields[key];
      if (descriptor && descriptor.kind === 'store' && descriptor.type === 'map') {
        continue;
      }
      if (descriptor && (descriptor.kind === 'projected' || descriptor.kind === 'computed')) {
        continue; // computed by the framework, never set by client
      }
      if (descriptor && descriptor.kind === 'struct') {
        Object.assign(stored, flattenStruct(key, descriptor, value));
        continue;
      }
      if (!descriptor) continue;
      stored[key] = serializeField(descriptor, value);
    }
    const cols = Object.keys(stored);
    getActiveDb()
      .prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
      .run(stored);
    return hydrate(
      getActiveDb()
        .prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`)
        .get({ id }),
    );
  };

  // create(payload). By default it validates an untrusted payload (fail closed:
  // undeclared keys, readonly fields, and required-clears are rejected) and
  // inserts. A framework entity may DECLARE a `create` policy that absorbs a
  // bespoke minting intent (Session mints token/principalType/principalId from a
  // closed set of session intents) — declaration absorbs the imperative wiring.
  // The policy receives the call payload and a trusted toolkit { insert, mintToken }
  // so it composes the same insert core rather than opening a second write path.
  record.create = (payload) => {
    if (typeof createPolicy === 'function') {
      return createPolicy(payload, { insert, mintToken });
    }
    validateMutation(record, payload);
    return insert(payload);
  };

  record.delete = (id) => {
    getActiveDb().prepare(`DELETE FROM ${name} WHERE id = :id`).run({ id });
  };

  record.verbs = Object.freeze({
    create: action(`${name}.create`),
    created: event(eventHandle.created(name), (state, { data }) => ({ ...state, ...data })),
    update: action(`${name}.update`),
    updated: event(eventHandle.updated(name), (state, { data }) => ({ ...state, ...data })),
    remove: action(`${name}.remove`),
    removed: event(eventHandle.removed(name), (state) => ({ ...state, _removed: true })),
  });

  record.projection = createEntityProjection({
    name,
    fields,
    verbs: record.verbs,
    storedComputedFields,
    sideTableStrategyEntries,
  });

  record.insert = (cells) => insert(cells);

  record.generateDDL = () => generateDDL(record);

  const ownerField = ownerFieldOf(record);
  record.crudHandlers = Object.freeze({
    [`${name}.create`]: ({ payload, principal }) => {
      validateMutation(record, payload);
      const id = randomUUID();
      const data = { ...payload, id };
      if (ownerField) data[ownerField] = principal?.id;
      return [{ handle: record.verbs.created.handle, type: record.verbs.created.type, scope: `${name}:${id}`, data }];
    },
    [`${name}.update`]: ({ payload, principal: _p }) => {
      const { id, ...rest } = payload;
      if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
      validateMutation(record, rest);
      // Transition guard: for every state field in the payload, pre-read the
      // current row and verify the move is in the declared transition graph.
      // Runs after structural validation so invalid targets report as domain
      // errors before transition errors (clearer diagnostic order).
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.kind !== 'state') continue;
        if (!(fieldName in rest)) continue;
        let current;
        try {
          current = record.findById(id);
        } catch (e) {
          throw Object.assign(
            new ValidationError(
              `Illegal transition check requires a durable database ` +
              `(in-memory kernel cannot verify state transitions for ${name}.${fieldName})`,
            ),
            { status: 400 },
          );
        }
        if (!current || current[fieldName] == null) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition (no current state) -> ${rest[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        const currentValue = current[fieldName];
        if (currentValue === rest[fieldName]) continue; // no-op, skip check
        const legalTargets = descriptor.transitions[currentValue];
        if (!legalTargets || !legalTargets.includes(rest[fieldName])) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition ${currentValue} -> ${rest[fieldName]}`,
            ),
            { status: 400 },
          );
        }
      }
      const data = { ...rest, id };
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.touch) data[fieldName] = new Date();
      }
      return [{ handle: record.verbs.updated.handle, type: record.verbs.updated.type, scope: `${name}:${id}`, data }];
    },
    [`${name}.remove`]: ({ payload, principal: _p }) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      return [{ handle: record.verbs.removed.handle, type: record.verbs.removed.type, scope: `${name}:${payload.id}`, data: { id: payload.id } }];
    },
    ...Object.assign({}, ...sideTableStrategyEntries.map(({ strategy, fields: strategyFields }) =>
      strategy.mutateHandlers(name, strategyFields))),
  });

  function ownerFieldOf(entity) {
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) {
        return fieldName;
      }
    }
    return null;
  }

  return registerEntityHandle({ record, fields, name });
}
