// entity(name, { <fields>, grant, checks?, routes?, ... }) — the entity compiler.
//
// The declaration is fields-less: every top-level key that is not a reserved
// framework slot IS a field descriptor. Reserved slots are grant, checks, routes,
// create, effects, admitsEffects, schedule, gate, on. (The old `fields:` wrapper
// is retired — one way to declare a field, not two.)
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
import { compileReadScope, fieldHandle, bindReadScope } from '../scope-sql.mjs';
import { compileEntityAuthz } from '../authz.mjs';
import { getLog } from '../log.mjs';
import {
  serializeField, validateMutation, ValidationError, flattenStruct,
  structCellColumn,
} from '../field-strategy.mjs';
import { materializeStoredRow } from './materialize-row.mjs';
import { action, event } from '../pipeline.mjs';
import * as eventHandle from '../event-handle.mjs';
import { created, updated, removed } from '../event-handle.mjs';
import { generateDDL } from '../ddl.mjs';
import { resolveRouteGate } from '../route-gate.mjs';
import { effectEntries, self, validateEffectDeclaration } from '../effect-compiler.mjs';
import { schedule as scheduleConstructors, triggerList } from '../schedule.mjs';
import { compileMembershipAuthz } from '../auth/membership.mjs';
import { collectSideTableStrategies } from '../side-table-strategy.mjs';
import { createEntityProjection } from './projection.mjs';
import { createCrudHandlers } from './crud.mjs';
import { installEntityQueries } from './query.mjs';

// mintToken — a cryptographically random opaque session token. Handed to a
// create policy so a framework entity that mints session-like rows (Session)
// generates an unguessable token without reaching for node:crypto itself.
function mintToken() {
  return randomBytes(24).toString('hex');
}

function stateEffectEntries(entityName, fieldName, descriptor) {
  const declared = descriptor.effects;
  if (declared == null || Object.keys(declared).length === 0) return [];

  const legalTransitions = new Map();
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
    const mutate = Object.hasOwn(declaredEffect ?? {}, 'mutate') ? declaredEffect.mutate : self;
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
  const matches = (db, row) => {
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
    hertz: trigger.hertz,
    intervalMs: trigger.intervalMs,
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

// Reserved top-level declaration slots. Every other key on the declaration is a
// field descriptor. A field name that collides with a reserved slot is a
// load-time error: the developer would have written a field whose name the
// compiler owns, which silently drops the field (fail closed).
const RESERVED_DECLARATION_SLOTS = new Set([
  'fields', 'grant', 'checks', 'routes', 'create', 'effects', 'admitsEffects',
  'schedule', 'simulation', 'gate', 'on', 'membership', 'field',
]);

function looksLikeFieldDescriptor(value) {
  return value !== null && typeof value === 'object' && typeof value.kind === 'string';
}

export function entity(name, declaration = {}) {
  if (Object.hasOwn(declaration, 'fields')) {
    throw new Error(
      `entity('${name}') uses the retired fields wrapper. Declare fields directly on ` +
        `the entity object; 'fields' is a reserved declaration slot.`,
    );
  }
  for (const key of RESERVED_DECLARATION_SLOTS) {
    const value = declaration[key];
    const isDeclaredSimulation = key === 'simulation' && value?.kind === 'simulate';
    if (Object.hasOwn(declaration, key) && looksLikeFieldDescriptor(value) && !isDeclaredSimulation) {
      throw new Error(
        `entity('${name}') field '${key}' collides with a reserved declaration slot. ` +
          `Rename the field.`,
      );
    }
  }

  const { grant, checks: declaredChecksIn = {}, membership: membershipDecl, routes, create: createPolicy, effects = null, admitsEffects = null, schedule = {}, simulation = null, gate: declaredGate = {} } = declaration;

  // The entity name becomes a table name interpolated into SQL — validate first.
  assertSqlIdentifier('entity', name);

  // Fields-less declaration: every non-reserved top-level key is a field
  // descriptor. A reserved-slot name used as a field is a load-time error (the
  // developer intended a field, the compiler owns the slot — fail closed rather
  // than silently drop the field).
  const fields = {};
  for (const [key, value] of Object.entries(declaration)) {
    if (RESERVED_DECLARATION_SLOTS.has(key)) continue;
    fields[key] = value;
  }

  // membership: augments/replaces grant and checks from a declarative role→capability map.
  // If the developer wrote both `grant:` and `membership:`, the explicit `grant:` takes
  // precedence (the membership entry is a convenience shortcut, not a second path).
  let effectiveGrant = grant;
  let declaredChecks = { ...declaredChecksIn };
  if (membershipDecl && (grant === undefined || grant === null)) {
    const membershipResult = compileMembershipAuthz(name, fields, membershipDecl);
    effectiveGrant = membershipResult.grant;
    declaredChecks = { ...declaredChecks, ...membershipResult.checks };
  }

  // ADR #7: an entity must declare a grant (explicitly via `grant:` or `membership:`,
  // or later via the standalone `membership()` call). No grant is allowed at compile
  // time for the standalone path — the entity has no readScope, so scopeFilter
  // returns '1=1' (the route gate is the first auth layer). The standalone
  // membership() call then sets a proper scope.
  if (effectiveGrant === undefined || effectiveGrant === null) {
    getLog().warn(
      'entity',
      `entity('${name}') has no grant at compile time — all access will be denied ` +
        `until a grant is set via membership() or an equivalent mechanism.`,
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
    grant: effectiveGrant,
    declaredChecks,
  });

  // Self-handle for effects thunk resolution. The effects thunk receives a
  // handle that resolves field names to their typed handles — a minimal proxy
  // distinct from registerEntityHandle (which also sets runtime active-entity
  // state). Kept minimal so the two handles can't drift (same resolving logic,
  // different lifecycle purpose).
  const selfHandle = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === 'id') return { fieldName: 'id' };
      if (key === 'name') return name;
      if (key === 'created') return created(name);
      if (key === 'updated') return updated(name);
      if (key === 'removed') return removed(name);
      if (Object.prototype.hasOwnProperty.call(fields, key)) return fieldHandle(key, fields[key], name);
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
  const entries = [
    ...effectEntries(declaredEffectsArray, { sourceEntityName: name }),
    ...Object.entries(fields).flatMap(([fieldName, descriptor]) =>
      descriptor.kind === 'state' ? stateEffectEntries(name, fieldName, descriptor) : []),
  ];
  const validatedEffects = entries.length > 0 ? Object.freeze([...entries]) : null;
  for (const [triggerHandle, effect] of entries) {
    if (effect && typeof effect === 'object' && typeof effect.durable === 'string') continue;
    validateEffectDeclaration(effect, { triggerHandle, sourceEntityName: name });
  }

  const declaredSchedule = { ...schedule };
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.kind !== 'state' || descriptor.auto == null) continue;
    const trigger = autoStateScheduleTrigger(name, fieldName, descriptor, fields);
    declaredSchedule.update = [...triggerList(declaredSchedule.update), trigger];
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
      const triggers = triggerList(triggerOrTriggers);
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
      const triggerIds = new Set();
      for (const trigger of validated) {
        if (
          verbName === 'update'
          && (trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after')
          && !trigger.autoState
          && fields[trigger.fieldName]?.touch === true
        ) {
          throw new Error(
            `schedule.${verbName} on entity '${name}': deadline field '${trigger.fieldName}' ` +
              'cannot be a touch field because the scheduled update would move its own deadline and fire repeatedly',
          );
        }
        if (triggerIds.has(trigger.triggerId)) {
          throw new Error(
            `schedule.${verbName}: duplicate trigger identity '${trigger.triggerId}' on entity '${name}'; ` +
              `give each trigger a distinct { key }`,
          );
        }
        triggerIds.add(trigger.triggerId);
      }
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

  // The route gate is the FIRST default-on auth layer (SPEC §6.2, ADR #20). It
  // lives ON the entity declaration next to `grant` — one authorization story —
  // and is resolved once at compile time through the same resolveRouteGate the
  // router used to run: unknown verbs / non-function gates fail closed, and
  // every unlisted verb defaults to requireUser() (the default-on gate). The row
  // grant stays a separate layer and is untouched here.
  const gate = resolveRouteGate(declaredGate);

  const record = {
    name,
    fields: Object.freeze({ ...fields }),
    // Only put grant on the record when it's defined, so the set trap can
    // store a later override (via membership()) without violating the Proxy
    // invariant (non-writable, non-configurable property with a different value).
    ...(effectiveGrant !== undefined && effectiveGrant !== null ? { grant: effectiveGrant } : {}),
    registry,
    // Keep a `checks` object for tests that read entity.checks.<name>(...).
    // Each key is the RUN face — the canonical home is `registry`, but existing
    // tests expect `checks` to expose callable functions. Uses `this.registry`
    // so it dynamically picks up overrides set by membership().
    get checks() {
      const checksObj = {};
      for (const [name, entry] of Object.entries(this.registry ?? {})) {
        if (entry.run) checksObj[name] = entry.run;
      }
      return Object.freeze(checksObj);
    },
    routes,
    gate,
    readScope: readScope ? Object.freeze({ sql: readScope.sql, params: readScope.params }) : undefined,
    scopeAst,
    scopeFilter(principal) {
      if (this.grant == null) return { sql: '1=0', params: {} };
      if (!readScope) return { sql: '1=1', params: {} };
      const bound = bindReadScope(readScope, principal);
      return bound ? { sql: bound.sql, params: bound.params } : { sql: '1=1', params: {} };
    },
    effects: validatedEffects,
    admitsEffects,
    schedule: validatedSchedule,
    simulation,
    projectedAsyncFields: Object.freeze(projectedAsyncFields),
    storedComputedFields: Object.freeze(storedComputedFields),
  };

  const sideTableStrategyEntries = collectSideTableStrategies(fields);

  function createEntityHydrator({ record, entityName, fields, sideTableStrategyEntries, runtime }) {
    // Keep the long-standing public contract: callers may ignore this return
    // value and still observe the row deserialized in place. Lifecycle code
    // uses materializeStoredRow directly when it needs a detached snapshot.
    const deserializeStoredCells = (row) => {
      if (!row) return row;
      const materialized = materializeStoredRow(row, fields);
      for (const key of Object.keys(row)) {
        if (!Object.prototype.hasOwnProperty.call(materialized, key)) delete row[key];
      }
      Object.assign(row, materialized);
      return row;
    };

    const hydrate = (row, principal = null, dispatch = null) => {
      if (!row) return row;
      row = deserializeStoredCells(row);
      for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
        for (const [fieldName, descriptor] of strategyFields) {
          if (typeof strategy.handle === 'function') {
            row[fieldName] = strategy.handle({
              record,
              entityName,
              fieldName,
              descriptor,
              row,
              principal,
              dispatch,
              db: runtime.db,
              entityOf: runtime.entityOf,
            });
          }
        }
      }
      return row;
    };

    return { hydrate, deserializeStoredCells };
  }

  // insert(cells) — the trusted low-level write core: serialize each declared
  // field's value to its stored cell, INSERT, and return the hydrated new row.
  // It does NOT run validateMutation — its caller has already decided the cells
  // are legitimate (the generic create validates an untrusted payload first; a
  // create POLICY mints server-side cells it owns). This is the ONE place the
  // INSERT/return-row mechanics live; both write paths compose it (singular
  // system, deletion test: the policy override adds intent, not a second insert).
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

  record.generateDDL = () => generateDDL(record);

  const LIFECYCLE_HANDLES = Object.freeze({
    created: (name) => created(name),
    updated: (name) => updated(name),
    removed: (name) => removed(name),
  });

  // Don't freeze the entire record — only `fields` is frozen (above). Auth-related
  // properties (grant, registry, readScope, scopeAst) are mutable so membership()
  // and similar post-compilation augmentations can set them in place.
  function handleProxy(target, resolveEntity, { mutableAuth = false } = {}) {
    const fieldNamespace = new Proxy(Object.create(null), {
      get(_namespace, key) {
        if (key === 'id') return { fieldName: 'id' };
        if (typeof key === 'string' && Object.hasOwn(fields, key)) {
          return fieldHandle(key, fields[key], name, resolveEntity);
        }
        return undefined;
      },
      set() { return false; },
    });
    return new Proxy(target, {
      get(target, key, receiver) {
        if (key === 'field') return fieldNamespace;
        // Lifecycle handles and legacy direct field handles are resolved only
        // for string keys not owned by the record. `.field` is the unambiguous
        // path when a field name collides with entity metadata such as `name`.
        if (key in target || typeof key !== 'string') {
          return Reflect.get(target, key, receiver);
        }
        if (key === 'id') return { fieldName: 'id' };
        if (LIFECYCLE_HANDLES[key]) return LIFECYCLE_HANDLES[key](name);
        if (Object.hasOwn(fields, key)) {
          return fieldHandle(key, fields[key], name, resolveEntity);
        }
        return undefined;
      },
      set(target, key, value, _receiver) {
        if (mutableAuth && (key === 'grant' || key === 'registry' || key === 'readScope' || key === 'scopeAst' || key === 'scopeFilter')) {
          target[key] = value;
          return true;
        }
        return false;
      },
    });
  }

  // A declaration owns schema, policy, events, projection and DDL. It owns no
  // database operations. Binding is deliberately app-scoped so the same
  // declaration can be mounted by several applications without ambient state.
  Object.defineProperty(record, 'bind', {
    enumerable: false,
    value(runtime) {
      if (!runtime || typeof runtime.entityOf !== 'function') {
        throw new Error(`cannot bind entity '${name}' without an application runtime`);
      }
      const requireDb = () => {
        if (!runtime.db) {
          throw new Error(`entity '${name}' database operation requires an application database`);
        }
        return runtime.db;
      };
      // A database-less app can still resolve and inspect routes. Database
      // operations remain present but fail loudly when invoked, preserving one
      // facade shape across construction and startup.
      const queryDb = Object.freeze({
        prepare(...args) {
          return requireDb().prepare(...args);
        },
      });

      const boundRecord = Object.create(record);
      Object.defineProperties(boundRecord, {
        declaration: { value: proxy, enumerable: false },
        runtime: { value: runtime, enumerable: false },
      });
      const bound = handleProxy(boundRecord, runtime.entityOf, { mutableAuth: true });
      const { hydrate, deserializeStoredCells } = createEntityHydrator({
        record: bound,
        entityName: name,
        fields,
        sideTableStrategyEntries,
        runtime,
      });

      installEntityQueries(boundRecord, {
        name,
        hydrate,
        deserializeStoredCells,
        db: queryDb,
      });

      const insert = (cells) => {
        const id = cells.id ?? randomUUID();
        const stored = { id };
        for (const [key, value] of Object.entries(cells)) {
          if (key === 'id') continue;
          const descriptor = fields[key];
          if (descriptor?.kind === 'store' && descriptor.type === 'map') continue;
          if (descriptor && (descriptor.kind === 'projected' || descriptor.kind === 'computed')) continue;
          if (descriptor?.kind === 'struct') {
            Object.assign(stored, flattenStruct(key, descriptor, value));
            continue;
          }
          if (descriptor) stored[key] = serializeField(descriptor, value);
        }
        const cols = Object.keys(stored);
        const db = requireDb();
        db
          .prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
          .run(stored);
        return hydrate(db.prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id }));
      };

      boundRecord.create = (payload) => {
        if (typeof createPolicy === 'function') {
          return createPolicy(payload, { insert, mintToken });
        }
        validateMutation(bound, payload);
        return insert(payload);
      };
      boundRecord.insert = insert;
      boundRecord.delete = (id) => {
        requireDb().prepare(`DELETE FROM ${name} WHERE id = :id`).run({ id });
      };
      boundRecord.crudHandlers = createCrudHandlers({ record: bound, sideTableStrategyEntries });
      return bound;
    },
  });

  const proxy = handleProxy(
    record,
    (target) => typeof target === 'object' ? target : null,
    { mutableAuth: true },
  );
  return proxy;
}
