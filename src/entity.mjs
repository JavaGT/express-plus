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
import { assertGuarded } from './guard/static.mjs';
import { compileReadScope, compileInheritScope, lowerToSql, fieldHandle, membershipTable, membershipOwnerCol, MEMBER_COLUMN } from './scope-sql.mjs';
import { getActiveDb, getActiveEntity, setActiveEntity } from './db.mjs';
import { buildCheckRegistry } from './registry.mjs';
import { mayFieldOp } from './row-grant.mjs';
import { read, write } from './grant.mjs';
import { getLog } from './log.mjs';
import {
  serializeField, deserializeField, validateMutation, ValidationError, verifyHash, flattenStruct, structCellColumn, resolveStrategy,
} from './field-strategy.mjs';
import { action, event } from './pipeline.mjs';
import { generateDDL } from './ddl.mjs';
import { validateEffectDeclaration } from './effect-compiler.mjs';

// mintToken — a cryptographically random opaque session token. Handed to a
// create policy so a framework entity that mints session-like rows (Session)
// generates an unguessable token without reaching for node:crypto itself.
function mintToken() {
  return randomBytes(24).toString('hex');
}

// authorizeFieldOp — the ONE field-op authorization check, shared by every
// field-handle read and write (11 sites). It is the field-level face of the
// no-second-auth-path invariant: a single gate, run before the mechanics, that
// a principal present (the request path) must pass; bypassed when null (the
// trusted query API). Reads call it with `read`; writes with `write`. Extracted
// so the guard and the `{ status: 403, message: 'forbidden' }` verdict live in
// one place rather than 11 (the deletion test: one concept absorbs the copies).
async function authorizeFieldOp(record, fieldName, capability, row, principal) {
  if (principal && !(await mayFieldOp(record, fieldName, capability, row, principal))) {
    throw { status: 403, message: 'forbidden' };
  }
}

// requireFieldDispatch — the no-direct-write-path guard, hoisted from four
// byte-identical inline copies (one per field-handle factory). A store mutation
// is a committed pipeline ACTION, never a direct side-table write; a handle
// hydrated without a `dispatch` ref (the trusted query API) throws here rather
// than falling back to SQL. The message names the field so the failure is
// self-locating.
function requireFieldDispatch(entityName, fieldName, dispatch) {
  if (!dispatch) {
    throw new Error(
      `cannot mutate ${entityName}.${fieldName} without a dispatch ref ` +
        `(hydrate with dispatch inside a handler/route)`,
    );
  }
}

// makeQueryBuilder({ name, predicate, hydrate }) — the awaitable, chainable
// query behind `findAll(predicate)`. It composes WHERE (the lowered predicate)
// + ORDER BY + LIMIT + column projection and executes ONE SELECT on await (a
// thenable, so `Promise.all([builder.sort().limit()])` and `await builder` both
// run it). `sort` takes a field handle (its declared fieldName — a safe column
// name, never client input) and a direction; `limit` is bound as a param. The
// builder mutates as it chains and is single-use (await consumes it).
function makeQueryBuilder({ name, predicate, hydrate, defaultLimit = null }) {
  const where = lowerToSql(predicate);
  const state = { orderBy: null, limit: null, selectCols: null };
  const builder = {
    sort(field, dir = 'asc') {
      const direction = String(dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      state.orderBy = `${field.fieldName} ${direction}`;
      return builder;
    },
    limit(n) {
      state.limit = Number(n);
      return builder;
    },
    select(...handles) {
      state.selectCols = handles.map((h) => h.fieldName);
      return builder;
    },
    then(resolve, reject) {
      try {
        const cols = state.selectCols ? state.selectCols.join(', ') : '*';
        let sql = `SELECT ${cols} FROM ${name} AS t0 WHERE ${where.sql}`;
        const params = { ...where.params };
        if (state.orderBy) sql += ` ORDER BY ${state.orderBy}`;
        const limit = state.limit !== null ? state.limit : defaultLimit;
        if (limit !== null) {
          sql += ` LIMIT :limit`;
          params.limit = limit;
        }
        const rows = getActiveDb().prepare(sql).all(params).map(hydrate);
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    },
  };
  return builder;
}

// Normalize the grant declaration into an array of clauses. A grant is either a
// thunk returning an array of `scope().can()` clauses (note.mjs) or — Phase 1
// reserved — an `inherit(Parent, { via })` directive (comment.mjs). The thunk
// form is resolved here so its `.can` bodies can be statically guarded at load.
function resolveGrantClauses(grant) {
  if (typeof grant === 'function') return grant();
  // an inherit directive (object) is carried through untouched for the authz
  // compiler to expand; Phase 1 lands the thunk form first.
  return grant;
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

  // Build the unified check registry — the ONE source of truth for every named
  // check, consulted by BOTH the scope→SQL compiler (harvest face) and the
  // per-row runtime evaluator (run face). Derived role checks (ref-role),
  // declared checks, and map-role names all land here; no second path.
  const registry = buildCheckRegistry({ fields, declaredChecks, entityName: name });

  // Statically guard every runtime `.can` body (not scope predicates — those
  // compile to SQL and never run as JS). At the same time, lower the entity's
  // READ half to its SQL template — a non-compilable scope is a load-time error
  // here, never a silent runtime fallback (SPEC §6.1). The read half is one of
  // two shapes: a thunk of `scope().can()` clauses (own scope), or an
  // `inherit(Parent, { via })` directive (the child inherits the parent's scope
  // through a typed FK, lowered to a correlated EXISTS).
  const clauses = resolveGrantClauses(grant);
  let readScope;
  if (Array.isArray(clauses)) {
    // Every clause's runtime .can body is statically guarded.
    for (const clause of clauses) {
      if (clause && typeof clause.can === 'function') {
        assertGuarded(clause.can, { where: `entity('${name}') grant .can` });
      }
    }
    // The row-filtering read-scope is derived from exactly ONE scope predicate.
    // Two scope clauses is a load-time error, never a silent first-wins: dropping
    // a second predicate from the SQL filter would fail OPEN if it was meant to
    // restrict reads. There is no union/intersection-of-scopes semantics in
    // Phase 1; an additive read scope, if ever needed, arrives as an explicit
    // named construct — not inferred from a second array element (fail-closed).
    const scoped = clauses.filter((c) => c && typeof c.predicate === 'function');
    if (scoped.length > 1) {
      throw new Error(
        `entity('${name}') declares ${scoped.length} scope clauses in one grant. ` +
          `A grant derives exactly one read-scope (one scope().can() clause); a ` +
          `second scope predicate would be silently dropped from the row filter — ` +
          `a fail-open hole. Phase 1 has no union-of-scopes semantics. Combine the ` +
          `conditions inside a single scope predicate (anyOf(...)/.and(...)), or ` +
          `inherit a parent's scope with inherit(Parent, { via }).`,
      );
    }
    if (scoped.length === 1) {
      readScope = compileReadScope(scoped[0].predicate, {
        fields,
        where: `scope on entity('${name}')`,
        registry,
      });
    }
  } else if (clauses && clauses.inherit) {
    readScope = compileInheritScope(clauses, { where: `inherit on entity('${name}')` });
  }

  // The harvested scope AST is retained (not just the SQL) so a child entity's
  // inherit directive can re-lower this scope under a join alias. The SQL is one
  // rendering of the AST; the AST is the durable artifact.
  const scopeAst = readScope ? readScope.ast : undefined;

  // Validate declared effects at load time (but not cycle detection — that runs
  // globally after all entities are defined). Each effect must have valid
  // { mutate, with, when? } shape. A non-compilable 'when' predicate is a load-
  // time error (ADR #22).
  // Bind store/map effect handles to entity+field-specific event types. An effect
  // keyed by the GENERIC map handle (`collaborators.onAdded` → 'map:onAdded') is
  // RE-KEYED to the specific event the `.set` handle EMITS (`Doc.collaborators.
  // added`) — otherwise the general compiler (effect-compiler.mjs buildEffectsRegistry)
  // keys the effect under 'map:onAdded' while the handle dispatches
  // 'Doc.collaborators.added', so the effect would never fire (consult #19/#23,
  // UNIT 2). CRUD string-key triggers ('Note.created') + already-specific string
  // keys pass through unchanged. The field's own onAdded/onRemoved handle is dead
  // below (fireMapEffects retired); only the re-keyed effects object carries the
  // binding. Each effect still validates its declared { mutate, with, when? } shape
  // at load time (cycle/admission detection runs globally after all entities).
  let validatedEffects = effects ? { ...effects } : null;
  if (validatedEffects) {
    for (const [fieldName, descriptor] of Object.entries(fields)) {
      if (descriptor.kind === 'store' && descriptor.type === 'map') {
        const addedKey = `${name}.${fieldName}.added`;
        const removedKey = `${name}.${fieldName}.removed`;
        const oldAdded = descriptor.onAdded ? String(descriptor.onAdded) : null;
        const oldRemoved = descriptor.onRemoved ? String(descriptor.onRemoved) : null;
        if (oldAdded && Object.prototype.hasOwnProperty.call(validatedEffects, oldAdded)) {
          validatedEffects[addedKey] = validatedEffects[oldAdded];
          delete validatedEffects[oldAdded];
        }
        if (oldRemoved && Object.prototype.hasOwnProperty.call(validatedEffects, oldRemoved)) {
          validatedEffects[removedKey] = validatedEffects[oldRemoved];
          delete validatedEffects[oldRemoved];
        }
      }
    }
    // Validate string-keyed effects (existing path)
    for (const [triggerHandle, effect] of Object.entries(validatedEffects)) {
      validateEffectDeclaration(effect, { triggerHandle, sourceEntityName: name });
    }
    // P6c-C step 3: validate symbol-keyed effects (anyOf) in a second pass
    for (const triggerHandle of Object.getOwnPropertySymbols(validatedEffects)) {
      const effect = validatedEffects[triggerHandle];
      validateEffectDeclaration(effect, { triggerHandle, sourceEntityName: name });
    }
    validatedEffects = Object.freeze(validatedEffects);
  }

  // Validate schedule declarations at load time (P6d Spine A step 1 → step 4a).
  // Each [verbName, trigger] must be a valid schedule.at(), schedule.after(), tick.hz(),
  // or tick.every() call. Step 2 compiles the optional `while` predicate.
  // Deadline triggers (schedule.at/after): field identity resolution + while + with.
  // Row-set ticks (tick.hz/tick.every): empty-while guard + hertz/intervalMs + while + with.
  let validatedSchedule = null;
  const scheduleKeys = Object.keys(schedule);
  if (scheduleKeys.length > 0) {
    validatedSchedule = {};
    for (const [verbName, trigger] of Object.entries(schedule)) {
      // CRUD verb restriction (fail-closed): only create/update/remove are dispatchable
      // (handlers[type] lookup at pipeline.mjs:325 throws for unknown types — no custom verbs).
      if (typeof verbName !== 'string' || verbName.length === 0) {
        throw new Error(`schedule: verb name must be a non-empty string, got ${verbName}`);
      }
      if (!['create', 'update', 'remove'].includes(verbName)) {
        throw new Error(`schedule verb '${verbName}' must be one of create | update | remove (entity '${name}')`);
      }
      // Accept deadline (schedule.at/after) and tick (tick.hz/tick.every) triggers.
      const isDeadline = trigger.kind === 'schedule.at' || trigger.kind === 'schedule.after';
      const isTick = trigger.kind === 'tick.hz' || trigger.kind === 'tick.every';
      if (!trigger || typeof trigger !== 'object' || !(isDeadline || isTick)) {
        throw new Error(`schedule.${verbName}: expected schedule.at(...), schedule.after(...), tick.hz(...), or tick.every(...), got ${JSON.stringify(trigger)}`);
      }

      let whileSql, whileParams, whileAst, withValue;
      let fieldName = null;

      if (isDeadline) {
        // ---- Deadline trigger path (schedule.at / schedule.after) ----
        // Reject 'when' lifecycle guard FIRST (accepting it unenforced would be a
        // silent no-op foot-gun; fail-closed forbids. Ships with state runtime).
        if (trigger.when) {
          throw new Error(`schedule.${verbName}: 'when' lifecycle guard is not yet supported (ships with state runtime)`);
        }
        if (!trigger.field || typeof trigger.field !== 'object') {
          throw new Error(`schedule.${verbName}: field must be a field descriptor (no bare strings)`);
        }
        // Identity-resolve the field descriptor to a field NAME (same pattern `many`'s `over` uses).
        fieldName = null;
        for (const [fname, fdesc] of Object.entries(fields)) {
          if (fdesc === trigger.field) {
            fieldName = fname;
            break;
          }
        }
        if (!fieldName) {
          throw new Error(`schedule '${verbName}': field descriptor is not a declared field on entity '${name}'`);
        }
        // Verify the resolved field's kind is comparable as a date/value.
        const fieldKind = fields[fieldName].kind;
        const fieldType = fields[fieldName].type;
        if (fieldKind !== 'value' || (fieldType !== 'date' && fieldType !== 'number')) {
          throw new Error(`schedule '${verbName}': field '${fieldName}' must be a date or number field (kind 'value', comparable via <=)`);
        }
        if (trigger.kind === 'schedule.after' && !Number.isFinite(trigger.delay)) {
          throw new Error(`schedule.${verbName}: delay must be a finite number (parseDelay should have validated)`);
        }
        withValue = trigger.with;
        if (withValue !== undefined && withValue !== null) {
          if (typeof withValue !== 'function' && (typeof withValue !== 'object' || Array.isArray(withValue))) {
            throw new Error(`schedule '${verbName}': 'with' must be an object or a function ({row}) => obj`);
          }
        }
      } else {
        // ---- Tick trigger path (tick.hz / tick.every) ----
        // Reject 'when' lifecycle guard (fires before empty-while guard so the
        // 'when' error is reported rather than swallowing it behind the while check).
        if (trigger.when) {
          throw new Error(`schedule.${verbName}: 'when' lifecycle guard is not yet supported (ships with state runtime)`);
        }
        // Empty-while FORBIDDEN: a row-set tick requires a 'while' predicate
        // (an empty while would fire on every row forever — the foot-gun guard).
        if (trigger.while === undefined) {
          throw new Error(
            `schedule.${verbName}: a row-set tick requires a 'while' predicate ` +
              `(empty while would fire on every row forever)`,
          );
        }
        // Validate hertz/intervalMs finite + positive (match schedule.after's delay-finite guard).
        if (trigger.kind === 'tick.hz') {
          if (!Number.isFinite(trigger.hertz) || trigger.hertz <= 0) {
            throw new Error(`schedule.${verbName}: hertz must be a finite positive number (tick.hz should have validated)`);
          }
        } else {
          if (!Number.isFinite(trigger.intervalMs) || trigger.intervalMs <= 0) {
            throw new Error(`schedule.${verbName}: intervalMs must be a finite positive number (tick.every should have validated)`);
          }
        }
        withValue = trigger.with;
        if (withValue !== undefined && withValue !== null) {
          if (typeof withValue !== 'function' && (typeof withValue !== 'object' || Array.isArray(withValue))) {
            throw new Error(`schedule '${verbName}': 'with' must be an object or a function ({row}) => obj`);
          }
        }
      }

      // Compile the 'while' predicate (strict fail-closed; NonCompilableError propagates).
      // For ticks this is mandatory (checked above); for deadline triggers it's optional
      // because the field value alone serves as the discovery condition.
      if (trigger.while !== undefined) {
        const compiled = compileReadScope(trigger.while, {
          fields,
          where: `schedule.${verbName} while on entity('${name}')`,
          registry,
        });
        whileSql = compiled.sql;
        whileParams = compiled.params;
        whileAst = compiled.ast;
      }

      // Build the frozen per-verb trigger stored on validatedSchedule.
      if (isDeadline) {
        validatedSchedule[verbName] = Object.freeze({
          kind: trigger.kind,
          field: trigger.field,
          fieldName,
          delay: trigger.delay,
          whileSql,
          whileParams,
          whileAst,
          with: withValue,
        });
      } else {
        // Ticks carry NO field/fieldName/delay — distinguish from deadline triggers.
        validatedSchedule[verbName] = Object.freeze({
          kind: trigger.kind,
          hertz: trigger.hertz,
          intervalMs: trigger.intervalMs,
          whileSql,
          whileParams,
          whileAst,
          with: withValue,
        });
      }
    }
    validatedSchedule = Object.freeze(validatedSchedule);
  }

  // projected.async fields: each entry is [fieldName, { compute }] for the
  // post-commit consumer to iterate.
  const projectedAsyncFields = Object.entries(fields)
    .filter(([, d]) => d.kind === 'projected' && d.mode === 'async');
  // projected.inline fields: run in-transaction in the projection's apply handler.
  const projectedInlineFields = Object.entries(fields)
    .filter(([, d]) => d.kind === 'projected' && d.mode === 'inline');

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
    projectedInlineFields: Object.freeze(projectedInlineFields),
  };

  // hash-kind fields hydrate from their stored `salt:digest` cell into a
  // `{ verify(plaintext) }` handle so a handler writes `user.password.verify(pw)`
  // (session.mjs). The plaintext digest never leaves the field — a hash cell is
  // not a comparable value, it is a one-way check. A null cell stays null.
  const hashFields = Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'hash')
    .map(([fieldName]) => fieldName);
  const storedValueFields = Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'value' || descriptor.kind === 'projected');
  // struct fields store one flat `<field>__<cell>` column per sub-cell; on read
  // they reconstruct a namespace object (row.linkShare = { token, tier }) and the
  // raw generated columns are removed, so a handler sees the declared shape, not
  // the storage shape (doc.mjs reads entity.linkShare.tier).
  const structFields = Object.entries(fields).filter(([, d]) => d.kind === 'struct');
  // map fields (store/map) hydrate from a side-table into a write handle that
  // exposes add/remove/has. The main-table has no column for them — they live
  // entirely in the membership side-table named <Entity>_<field>.
  const mapFields = Object.entries(fields).filter(([, d]) => d.kind === 'store' && d.type === 'map');
  // ordered (list) fields hydrate from a fractional-index side-table into a write
  // handle exposing .insertAt/.move/.reorder/.remove/.toArray. Like map, the main
  // table has no column for them — they live entirely in the <Entity>_<field>
  // side-table (ddl.mjs orderedTableDDL), ordered by a fractional REAL `key`.
  const orderedFields = Object.entries(fields).filter(([, d]) => d.kind === 'ordered');
  // ephemeral (non-persisting) fields hydrate a per-connection write handle exposing
  // .set(cells). Like map/ordered/log, the main table has no column for them — they
  // live entirely in the <Entity>_<field> side-table keyed ({Entity}_id, client_id)
  // (ddl.mjs ephemeralTableDDL). A .set is a committed pipeline ACTION (consult
  // #19): it RE-ENTERS dispatch as `<Entity>.<field>.set` → handler emits
  // `<Entity>.<field>.set` → the projection upserts the per-connection cells row.
  // The handle needs a `dispatch` ref; without one it throws (fail closed). This is
  // P6e-1a's raw verbatim pathway — P6e-1b's pace/coalescer retires it into the
  // paced path (one mechanism, not a parallel permanent path).
  const ephemeralFields = Object.entries(fields).filter(([, d]) => d.kind === 'ephemeral');
  // log (store/log) fields hydrate from an append-only side-table into a write
  // handle exposing .append(entry)/.entries(). Like map/ordered, the main table
  // has no column for them — they live entirely in the <Entity>_<field> side-table
  // (ddl.mjs logTableDDL), ordered by rowid (append order). A log append is a
  // committed pipeline ACTION (consult #19): `.append()` re-enters dispatch as
  // `<Entity>.<field>.append` (a fresh txn) → handler emits `:appended` → the
  // projection writes the side-table. The handle needs a `dispatch` ref to
  // re-enter; without one it throws (fail closed, no silent direct-SQL fallback).
  const logFields = Object.entries(fields).filter(([, d]) => d.kind === 'store' && d.type === 'log');

  // makeMapHandle(entityName, fieldName, row, principal, dispatch) — returns a
  // write handle for a map field. The canonical mutation `.set(memberId,
  // { role })` is a committed pipeline ACTION (consult #19, UNIT 2): it RE-ENTERS
  // dispatch as `<Entity>.<field>.add` (a new member) or `.setRole` (a role
  // change — DECISIONLOG #57: idempotent re-share is roleChanged, NOT a fresh
  // add, so onAdded does not re-fire); `.remove` dispatches `.remove`. The
  // projection applies the `:added`/`:roleChanged`/`:removed` event to the
  // side-table — the handle does NOT write the side-table directly (no second
  // reconciliation path). A repeat share with the SAME role is a no-op (no
  // dispatch). READS (`has`/`get`/`toArray`) stay direct-SQL (the trusted query
  // API; a read is not a mutation, DECISIONLOG #41); `.toArray()` populates each
  // member through `of: ref(Target)` so a share list returns hydrated member
  // rows (a hash password stays a {verify} handle, not a raw digest) as
  // `[member, role]` pairs.
  //
  // The 5th `dispatch` arg is REQUIRED for mutations (a handle hydrated without
  // one — the trusted query API — throws on `.set`/`.remove` rather than falling
  // back to direct SQL, which would recreate a forbidden dual path). Field-level
  // `.can()` authorization runs BEFORE the mechanics when `principal` is present
  // (the request path); bypassed when null (trusted query API). No second auth
  // path: the field `.can` body receives the SAME check registry as the row
  // grant; `has`/`get` are read primitives used inside check evaluation and stay
  // synchronous + unguarded.
  const makeMapHandle = (entityName, fieldName, row, principal, dispatch) => {
    const table = membershipTable(entityName, fieldName);
    const ownerCol = membershipOwnerCol(entityName);
    // The side-table's owner/member columns are TEXT (ddl.mjs mapTableDDL),
    // and an owner id is a numeric SQLite PK. A ref field stores String(value)
    // for the same reason; the map handle does the same so a row reloaded by id
    // matches its membership (a numeric 10 stored as text '10', not '10.0',
    // and the upsert existence probe finds the prior row).
    const oid = String(row.id);
    const ofDescriptor = fields[fieldName].of;
    const targetName = ofDescriptor && ofDescriptor.kind === 'value' && ofDescriptor.type === 'ref'
      ? ofDescriptor.target
      : null;
    // The side-table has a `role` column only when roles are declared on the
    // map (ddl.mjs mapTableDDL). Branch the mutation SQL on that so a role-less
    // map stores just (owner, member) and a role update never references a
    // column that does not exist.
    const hasRole = Array.isArray(fields[fieldName].roles) && fields[fieldName].roles.length > 0;

    const probe = (memberId) =>
      getActiveDb()
        .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .get({ owner: oid, member: String(memberId) });

    const probeRow = (memberId) =>
      getActiveDb()
        .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
        .get({ owner: oid, member: String(memberId) });

    return {
      // `.set(memberId, { role })` — a committed pipeline ACTION. A NEW member
      // dispatches `<Entity>.<field>.add` (emits `:added`, fires onAdded via the
      // compiler); an EXISTING member with a DIFFERENT role dispatches `.setRole`
      // (emits `:roleChanged`, does NOT re-fire onAdded — DECISIONLOG #57); the
      // SAME role is a no-op (no dispatch). The side-table is written by the
      // projection applying the emitted event, NOT by the handle.
      set: async (memberId, { role } = {}) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const mid = String(memberId);
        const existing = probeRow(memberId);
        const actionType =
          !existing ? `${entityName}.${fieldName}.add`
          : hasRole && existing.role !== (role ?? null) ? `${entityName}.${fieldName}.setRole`
          : null;
        if (actionType === null) return; // same-role repeat share: no-op
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: actionType,
          payload: { owner: oid, member: mid, role },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      remove: async (memberId) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const mid = String(memberId);
        if (!probe(memberId)) return; // idempotent remove: nothing to dispatch
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.remove`,
          payload: { owner: oid, member: mid },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      has: (memberId) => probe(memberId) !== undefined,
      get: (memberId) => {
        const mid = String(memberId);
        return getActiveDb()
          .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
          .get({ owner: oid, member: mid }) ?? undefined;
      },
      toArray: async () => {
        await authorizeFieldOp(record, fieldName, read, row, principal);
        const db = getActiveDb();
        const selectCols = hasRole ? `${MEMBER_COLUMN} AS member_id, role` : `${MEMBER_COLUMN} AS member_id`;
        const rows = db
          .prepare(`SELECT ${selectCols} FROM ${table} WHERE ${ownerCol} = :owner`)
          .all({ owner: oid });
        const target = targetName ? getActiveEntity(targetName) : null;
        if (!target) return rows.map((r) => [null, hasRole ? r.role : null]);
        // Batch-load all members in one query to avoid N+1.
        const memberIds = rows.map((r) => r.member_id);
        const members = [];
        for (let i = 0; i < memberIds.length; i += 500) {
          const batch = memberIds.slice(i, i + 500);
          const placeholders = batch.map(() => '?').join(',');
          members.push(...db.prepare(
            `SELECT * FROM ${targetName} WHERE id IN (${placeholders})`,
          ).all(...batch));
        }
        for (const m of members) target.hydrate(m, principal);
        const memberMap = Object.fromEntries(members.map((m) => [m.id, m]));
        return rows.map((r) => [memberMap[r.member_id] ?? null, hasRole ? r.role : null]);
      },
    };
  };

  // makeOrderedListHandle(entityName, fieldName, row, principal, dispatch) —
  // returns a write handle for an `ordered`/`list` field over a fractional-index
  // side-table (owner, id, key, item). Order is derived by ORDER BY key, so a
  // between-insert or a move re-keys ONLY the affected row — siblings keep their
  // keys (no renumber, the hallmark of fractional indexing). `insertAt` mints a
  // stable `id` (returned to the caller) + a fractional key between the
  // neighbor keys; `move(id, i)` re-keys the one element; `reorder([ids])`
  // re-keys the lot to an evenly-spaced sequence (sugar over move). The element
  // value is stored as a JSON `item` cell (A2: scalar items; FK hydration of a
  // ref `of` is a later refinement).
  // Mutations re-enter dispatch as `<Entity>.<field>.insert`/`.move`/`.reorder`/
  // `.remove`; the projection applies the event to the side-table (one
  // reconciliation path — no direct writes from the handle).
  const makeOrderedListHandle = (entityName, fieldName, row, principal, dispatch) => {
    const table = membershipTable(entityName, fieldName);
    const ownerCol = membershipOwnerCol(entityName);
    const oid = String(row.id);

    const rowsOrdered = () =>
      getActiveDb()
        .prepare(`SELECT id, key, item FROM ${table} WHERE ${ownerCol} = :owner ORDER BY key`)
        .all({ owner: oid });

    // Mint a fractional key between two neighbor keys (or before-first /
    // after-last when a side is absent). Float keys are bounded-but-sufficient
    // for A2 (production-grade string fractional indexing avoids float-precision
    // limits after ~52 levels; the contract + no-renumber semantics are what ship).
    const keyBetween = (low, high) => {
      if (low == null && high == null) return 0;
      if (low == null) return high - 1;
      if (high == null) return low + 1;
      return (low + high) / 2;
    };

    return {
      insertAt: async (index, value) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const rows = rowsOrdered();
        const low = index > 0 ? rows[index - 1].key : null;
        const high = index < rows.length ? rows[index].key : null;
        const key = keyBetween(low, high);
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.insert`,
          payload: { owner: oid, key, value },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
        return result.events?.find((e) => e.type === `${entityName}.${fieldName}.inserted`)?.data?.id;
      },
      move: async (id, index) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const sid = String(id);
        const others = rowsOrdered().filter((r) => r.id !== sid);
        const low = index > 0 ? others[index - 1].key : null;
        const high = index < others.length ? others[index].key : null;
        const key = keyBetween(low, high);
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.move`,
          payload: { owner: oid, id: sid, key },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      reorder: async (ids) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        const entries = ids.map((entryId, i) => ({ id: String(entryId), key: i }));
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.reorder`,
          payload: { owner: oid, entries },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      remove: async (id) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.remove`,
          payload: { owner: oid, id: String(id) },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      has: (id) =>
        getActiveDb()
          .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
          .get({ owner: oid, id: String(id) }) !== undefined,
      get: (id) => {
        const r = getActiveDb()
          .prepare(`SELECT item FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
          .get({ owner: oid, id: String(id) });
        return r ? JSON.parse(r.item) : undefined;
      },
      toArray: async () => {
        await authorizeFieldOp(record, fieldName, read, row, principal);
        return rowsOrdered().map((r) => JSON.parse(r.item));
      },
    };
  };

  // makeLogHandle(entityName, fieldName, row, principal, dispatch) — returns a
  // write handle for a `store/log` field. An `.append(entry)` RE-ENTERS dispatch
  // as `<Entity>.<field>.append` (own actionId, own txn) rather than writing the
  // side-table directly — store mutations are committed pipeline actions (consult
  // #19), so the append is atomic + replayable, not a second unlogged write path.
  // `.entries()` is the owning-entity query (side-table rows for this owner, in
  // append order). The 5th `dispatch` arg is REQUIRED for `.append` (a handle
  // hydrated without one — the trusted query API — throws on mutation rather
  // than falling back to direct SQL, which would recreate a forbidden dual path).
  const makeLogHandle = (entityName, fieldName, row, principal, dispatch) => {
    const table = membershipTable(entityName, fieldName);
    const ownerCol = membershipOwnerCol(entityName);
    const oid = String(row.id);
    const entryDescriptor = fields[fieldName].entry ?? {};
    return {
      append: async (entry) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.append`,
          payload: { owner: oid, ...(entry ?? {}) },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
        const appended = result.events?.find((e) => e.type === `${entityName}.${fieldName}.appended`);
        return appended?.data?.id;
      },
      entries: async () => {
        await authorizeFieldOp(record, fieldName, read, row, principal);
        const rows = getActiveDb()
          .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner ORDER BY rowid`)
          .all({ owner: oid });
        return rows.map((r) => {
          const rest = { ...r };
          delete rest[ownerCol];
          return rest;
        });
      },
    };
  };

  // makeEphemeralHandle(entityName, fieldName, row, principal, dispatch) — a write
  // handle for an `ephemeral` field. `.set(cells)` RE-ENTERS dispatch as
  // `<Entity>.<field>.set` (own actionId, own txn) like the store handles — ephemeral
  // mutations are committed pipeline actions, so the .set is atomic + replayable,
  // not a direct unlogged side-table write (no second path). client_id resolves from
  // the principal (dispatch is principal-keyed; the side-table keys per-connection).
  // The handle needs a `dispatch` ref; without one it throws on mutation (fail
  // closed, no silent direct-SQL fallback). P6e-1a delivers every .set verbatim
  // through the post-commit fan-out — P6e-1b retires this raw path into the paced
  // pipeline (the same change that introduces pace absorbs the special-case).
  const makeEphemeralHandle = (entityName, fieldName, row, principal, dispatch) => {
    const table = membershipTable(entityName, fieldName);
    const ownerCol = membershipOwnerCol(entityName);
    const oid = String(row.id);
    const clientId = String(principal?.id ?? 'anonymous');

    return {
      set: async (cells) => {
        await authorizeFieldOp(record, fieldName, write, row, principal);
        requireFieldDispatch(entityName, fieldName, dispatch);
        const result = await dispatch({
          actionId: randomUUID(),
          type: `${entityName}.${fieldName}.set`,
          payload: { owner: oid, client: clientId, cells: cells ?? {} },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      get: () => {
        const r = getActiveDb()
          .prepare(`SELECT cells FROM ${table} WHERE ${ownerCol} = :owner AND client_id = :client`)
          .get({ owner: oid, client: clientId });
        return r ? JSON.parse(r.cells ?? '{}') : {};
      },
    };
  };

  // hydrate(row, principal, dispatch) — assemble hash{verify}, struct namespaces,
  // store handles, and derived fields onto a raw row. `dispatch` is OPTIONAL: a
  // store MUTATION handle (log .append) needs it to re-enter dispatch; it's null
  // for the trusted query API + reads (findOne/findAll/findById pass null; a
  // request path that wants in-handler store mutations threads the kernel's
  // dispatch fn — UNIT 2's concern for map/ordered). Default null = backward-
  // compatible (store query handles + all reads work without it).
  const hydrate = (row, principal = null, dispatch = null) => {
    if (!row) return row;
    deserializeStoredCells(row);
    for (const fieldName of hashFields) {
      const stored = row[fieldName];
      if (stored === null || stored === undefined) continue;
      row[fieldName] = { verify: (plaintext) => verifyHash(plaintext, stored) };
    }
    for (const [fieldName, descriptor] of structFields) {
      const namespace = {};
      let any = false;
      for (const cellName of Object.keys(descriptor.cells)) {
        const column = structCellColumn(fieldName, cellName);
        if (column in row) {
          namespace[cellName] = row[column];
          delete row[column];
          if (row[column] !== null) any = true;
        }
      }
      row[fieldName] = any || Object.keys(namespace).length > 0 ? namespace : null;
    }
    for (const [fieldName] of mapFields) {
      row[fieldName] = makeMapHandle(name, fieldName, row, principal, dispatch);
    }
    for (const [fieldName] of orderedFields) {
      row[fieldName] = makeOrderedListHandle(name, fieldName, row, principal, dispatch);
    }
    for (const [fieldName] of logFields) {
      row[fieldName] = makeLogHandle(name, fieldName, row, principal, dispatch);
    }
    for (const [fieldName] of ephemeralFields) {
      row[fieldName] = makeEphemeralHandle(name, fieldName, row, principal, dispatch);
    }
    // Derived fields compute on read from the hydrated row. The `derived` function
    // receives the row (with all stored columns + hydrated handles) and returns the
    // computed value. If the function throws, the field stays absent from the row
    // (fail-not-open: a broken derivation doesn't block the read).
    for (const [fieldName, descriptor] of Object.entries(fields)) {
      if (descriptor.derived && typeof descriptor.derived === 'function') {
        try { row[fieldName] = descriptor.derived(row); } catch { /* skip */ }
      }
    }
    return row;
  };

  // The runtime query API — the server's own trusted data-access primitive. A
  // hand-written handler (the imperative-router surface) reads and writes the
  // entity directly: User.findOne(User.username.is(name)), User.create(...),
  // User.findAll().select(...), User.getOrFail(id), User.delete(id). These run
  // UNSCOPED/PRIVILEGED: they do NOT thread a principal's read-scope, because a
  // login lookup is inherently pre-principal and an admitted handler is trusted
  // server code (like Express + an ORM), not a request path — so this is not a
  // second auth path (DECISIONLOG #41). The db handle is ambient (getActiveDb),
  // bound once by expressPlus({ db }); the same app.db handle, one shared db.
  //
  record.findOne = (predicate) => {
    const { sql, params } = lowerToSql(predicate);
    const row = getActiveDb()
      .prepare(`SELECT * FROM ${name} AS t0 WHERE ${sql} LIMIT 1`)
      .get(params);
    return row ? hydrate(row) : null;
  };

  // findAll() has two call shapes:
  //   findAll()              — every row, synchronously, as a plain array that
  //                            also carries a .select(...) projection (the
  //                            pre-authorized bulk read).
  //   findAll(predicate)     — a chainable, awaitable QUERY BUILDER composing
  //                            WHERE (the lowered predicate) + .sort(field, dir)
  //                            + .limit(n) + .select(...). It executes on await
  //                            (or Promise.all), so the exemplar composes
  //                            `Doc.findAll(Doc.owner.is(me)).sort(...).limit(10)`
  //                            inside a Promise.all and reads the rows out.
  // The predicate form is a THENABLE, not a plain array: it carries the query
  // state until something awaits it, then runs one composed SELECT.
  record.findAll = (predicate) => {
    if (predicate === undefined) {
      const rows = getActiveDb().prepare(`SELECT * FROM ${name} AS t0`).all().map(hydrate);
      rows.select = (...handles) => {
        const cols = handles.map((h) => h.fieldName);
        return getActiveDb().prepare(`SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
      };
      return rows;
    }
    // Query builder with a safety cap: when no explicit .limit() is set, the
    // builder defaults to 1000 rows to prevent unbounded in-memory collection.
    return makeQueryBuilder({ name, predicate, hydrate, defaultLimit: 1000 });
  };

  // getOrFail throws a 404-status error so renderError renders it through the
  // deliberate-client-error path (a numeric status), not as an opaque 500. It
  // composes findById — the non-throwing hydrated-by-id lookup — so there is one
  // lookup mechanic, two call shapes (null on miss vs. a 404 throw).
  record.findById = (id, principal = null) => {
    const row = getActiveDb().prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
    return row ? hydrate(row, principal) : null;
  };

  // Hydrate an already-fetched raw row (assembled struct namespaces, principal-
  // aware map handles, derived fields). The server's authorized read-admission
  // path (serve.mjs authorizeRead) does a scoped SELECT + mayVerb and hands back
  // the RAW row; the call site that needs a live `req.<entity>` hydrates here so
  // there is ONE admission path and hydration stays the entity's own concern
  // (not a second authz path). findById stays the unscoped trusted primitive.
  record.hydrate = (row, principal = null, dispatch = null) => hydrate(row, principal, dispatch);

  // Deserialize raw main-table cells without attaching handles. HTTP CRUD and
  // snapshot routes return plain JSON rows; store/map/log handles are server-only
  // affordances and must not leak into those response bodies.
  function deserializeStoredCells(row) {
    if (!row) return row;
    for (const [fieldName, descriptor] of storedValueFields) {
      if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
        row[fieldName] = deserializeField(descriptor, row[fieldName]);
      }
    }
    return row;
  }

  function buildProjectedComputeRow(storedRow, fields) {
    const row = { ...storedRow };
    for (const [fName, desc] of Object.entries(fields)) {
      if (Object.prototype.hasOwnProperty.call(row, fName)) {
        try {
          row[fName] = resolveStrategy(desc.kind).deserialize?.(row[fName], desc) ?? row[fName];
        } catch {
          // leave as stored value
        }
      }
    }
    return row;
  }

  record.deserializeRow = (row) => deserializeStoredCells(row);

  record.getOrFail = (id) => {
    const row = record.findById(id);
    if (!row) {
      const err = new Error(`${name} ${id} not found`);
      err.status = 404;
      throw err;
    }
    return row;
  };

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
      if (descriptor && descriptor.kind === 'projected') {
        continue; // computed by the projection, never set by client
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
    created: event(`${name}.created`, (state, { data }) => ({ ...state, ...data })),
    update: action(`${name}.update`),
    updated: event(`${name}.updated`, (state, { data }) => ({ ...state, ...data })),
    remove: action(`${name}.remove`),
    removed: event(`${name}.removed`, (state) => ({ ...state, _removed: true })),
  });

  record.projection = Object.freeze({
    eventTypes: [
      `${name}.created`,
      `${name}.updated`,
      `${name}.removed`,
      // each log field's append event → side-table INSERT (consult #19)
      ...logFields.map(([fieldName]) => `${name}.${fieldName}.appended`),
      // each map field's store events → side-table INSERT/UPDATE/DELETE (consult
      // #19, UNIT 2: store mutations are committed pipeline actions; the handle
      // dispatches, the projection applies — one reconciliation path).
      ...mapFields.flatMap(([fieldName]) => [
        `${name}.${fieldName}.added`,
        `${name}.${fieldName}.roleChanged`,
        `${name}.${fieldName}.removed`,
      ]),
      // each ordered field's store events → side-table INSERT/UPDATE/DELETE
      ...orderedFields.flatMap(([fieldName]) => [
        `${name}.${fieldName}.inserted`,
        `${name}.${fieldName}.moved`,
        `${name}.${fieldName}.reordered`,
        `${name}.${fieldName}.removed`,
      ]),
      // each ephemeral field's per-connection .set → side-table upsert (P6e-1a).
      ...ephemeralFields.map(([fieldName]) => `${name}.${fieldName}.set`),
    ],
    apply: (event, db) => {
      const table = name;
      // map store events: the owning entity's membership side-table is mutated
      // by the projection applying the `:added`/`:roleChanged`/`:removed` event
      // the `.set`/`.remove` handle dispatched.
      for (const [mapField, descriptor] of mapFields) {
        const sideTable = membershipTable(name, mapField);
        const ownerCol = membershipOwnerCol(name);
        const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;
        if (event.type === `${name}.${mapField}.added`) {
          const cols = [ownerCol, MEMBER_COLUMN];
          const vals = [':owner', ':member'];
          const params = { owner: String(event.data?.owner), member: String(event.data?.member) };
          if (hasRole) { cols.push('role'); vals.push(':role'); params.role = event.data?.role ?? null; }
          db.prepare(`INSERT INTO ${sideTable} (${cols.join(', ')}) VALUES (${vals.join(', ')})`).run(params);
          return;
        }
        if (event.type === `${name}.${mapField}.roleChanged` && hasRole) {
          db.prepare(`UPDATE ${sideTable} SET role = :role WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
            .run({ owner: String(event.data?.owner), member: String(event.data?.member), role: event.data?.role ?? null });
          return;
        }
        if (event.type === `${name}.${mapField}.removed`) {
          db.prepare(`DELETE FROM ${sideTable} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
            .run({ owner: String(event.data?.owner), member: String(event.data?.member) });
          return;
        }
      }
      // ordered field events: each ordered field's store events → side-table
      // INSERT/UPDATE/DELETE. The handle computes fractional keys and dispatches;
      // the projection applies the event to the side-table (one reconciliation path).
      for (const [ordField] of orderedFields) {
        const sideTable = membershipTable(name, ordField);
        const ownerCol = membershipOwnerCol(name);
        if (event.type === `${name}.${ordField}.inserted`) {
          db.prepare(`INSERT INTO ${sideTable} (${ownerCol}, id, key, item) VALUES (:owner, :id, :key, :item)`)
            .run({ owner: String(event.data?.owner), id: event.data?.id, key: event.data?.key, item: JSON.stringify(event.data?.value) });
          return;
        }
        if (event.type === `${name}.${ordField}.moved`) {
          db.prepare(`UPDATE ${sideTable} SET key = :key WHERE ${ownerCol} = :owner AND id = :id`)
            .run({ owner: String(event.data?.owner), id: event.data?.id, key: event.data?.key });
          return;
        }
        if (event.type === `${name}.${ordField}.reordered`) {
          const stmt = db.prepare(`UPDATE ${sideTable} SET key = :key WHERE ${ownerCol} = :owner AND id = :id`);
          for (const e of (event.data?.entries ?? [])) {
            stmt.run({ owner: String(event.data?.owner), id: e.id, key: e.key });
          }
          return;
        }
        if (event.type === `${name}.${ordField}.removed`) {
          db.prepare(`DELETE FROM ${sideTable} WHERE ${ownerCol} = :owner AND id = :id`)
            .run({ owner: String(event.data?.owner), id: event.data?.id });
          return;
        }
      }
      // ephemeral per-connection .set → upsert the latest cells snapshot for the
      // writing client_id (P6e-1a: latest snapshot wins — P6e-1b's pace will retire
      // the verbatim delivery into coalesced delivery, not change this projection).
      for (const [ephField] of ephemeralFields) {
        if (event.type === `${name}.${ephField}.set`) {
          const sideTable = membershipTable(name, ephField);
          const ownerCol = membershipOwnerCol(name);
          db.prepare(`INSERT OR REPLACE INTO ${sideTable} (${ownerCol}, client_id, cells) VALUES (:owner, :client, :cells)`)
            .run({
              owner: String(event.data?.owner),
              client: String(event.data?.client),
              cells: JSON.stringify(event.data?.cells ?? {}),
            });
          return;
        }
      }
      // log append: `<Entity>.<field>.appended` → INSERT a side-table row for
      // the minted entry id + the declared entry sub-fields (serialized). The
      // owner becomes the owning entity's FK (the row the log hangs off of).
      for (const [logField] of logFields) {
        if (event.type === `${name}.${logField}.appended`) {
          const entryDescriptor = fields[logField].entry ?? {};
          const sideTable = membershipTable(name, logField);
          const ownerCol = membershipOwnerCol(name);
          const cols = [ownerCol, 'id'];
          const vals = [':owner', ':id'];
          const params = { owner: event.data?.owner != null ? String(event.data.owner) : null, id: event.data?.id };
          for (const [subField, descriptor] of Object.entries(entryDescriptor)) {
            if (Object.prototype.hasOwnProperty.call(event.data ?? {}, subField)) {
              cols.push(subField);
              vals.push(`:${subField}`);
              params[subField] = serializeField(descriptor, event.data[subField]);
            }
          }
          db.prepare(
            `INSERT INTO ${sideTable} (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
          ).run(params);
          return;
        }
      }
      if (event.type === `${name}.created`) {
        const row = {};
        for (const [key, value] of Object.entries(event.data ?? {})) {
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') {
            Object.assign(row, flattenStruct(key, descriptor, value));
            continue;
          }
          if (descriptor) {
            row[key] = serializeField(descriptor, value);
          } else {
            row[key] = value;
          }
        }
        // projected.inline: compute in-transaction and include in INSERT
        for (const [pfName, { compute }] of projectedInlineFields) {
          try {
            const computeRow = buildProjectedComputeRow(row, fields);
            const result = compute(computeRow);
            row[pfName] = resolveStrategy('projected').serialize(result);
          } catch {
            // compute failure aborts — fail closed in-txn
            throw new Error(`${name}.${pfName} projected.inline compute failed`);
          }
        }
        const cols = Object.keys(row);
        if (cols.length > 0) {
          db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
          ).run(row);
          getLog().debug('dispatch', `${name}.created`, { id: row.id ?? event.data?.id });
        }
      } else if (event.type === `${name}.updated`) {
        const { id, ...data } = event.data ?? {};
        if (!id) return;
        const updates = [];
        const params = { id };
        for (const [key, value] of Object.entries(data)) {
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') {
            for (const [column, cell] of Object.entries(flattenStruct(key, descriptor, value))) {
              updates.push(`${column} = :${column}`);
              params[column] = cell;
            }
            continue;
          }
          const stored = descriptor ? serializeField(descriptor, value) : value;
          updates.push(`${key} = :${key}`);
          params[key] = stored;
        }
        // projected.inline: read existing row, merge changes, compute, update
        if (projectedInlineFields.length > 0) {
          const existing = db.prepare(`SELECT * FROM ${table} WHERE id = :id`).get({ id });
          if (existing) {
            const merged = { ...existing };
            for (const [key] of Object.entries(data)) {
              if (Object.prototype.hasOwnProperty.call(fields, key)) {
                merged[key] = Object.prototype.hasOwnProperty.call(params, key) ? params[key] : data[key];
              }
            }
            for (const [pfName, { compute }] of projectedInlineFields) {
              try {
                const computeRow = buildProjectedComputeRow(merged, fields);
                const result = compute(computeRow);
                const stored = resolveStrategy('projected').serialize(result);
                updates.push(`${pfName} = :${pfName}`);
                params[pfName] = stored;
              } catch {
                throw new Error(`${name}.${pfName} projected.inline compute failed`);
              }
            }
          }
        }
        if (updates.length > 0) {
          db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = :id`).run(params);
          getLog().debug('dispatch', `${name}.updated`, { id: params.id });
        }
      } else if (event.type === `${name}.removed`) {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(event.data?.id);
        getLog().debug('dispatch', `${name}.removed`, { id: event.data?.id });
      }
    },
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
      return [{ type: record.verbs.created.type, scope: `${name}:${id}`, data }];
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
      return [{ type: record.verbs.updated.type, scope: `${name}:${id}`, data }];
    },
    [`${name}.remove`]: ({ payload, principal: _p }) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      return [{ type: record.verbs.removed.type, scope: `${name}:${payload.id}`, data: { id: payload.id } }];
    },
    // log append: `<Entity>.<field>.append` → validate the entry shape (fail
    // closed on an unknown sub-field), mint a stable entry id, emit `:appended`.
    // The payload's `owner` is the owning entity id (the row the log hangs off
    // of). Field-level `.can()` authz runs in the HANDLE (the convenient-API
    // path); a direct dispatch is trusted server code (parity with create).
    ...appendLogHandlers(name, fields, logFields),
    // map mutations: `<Entity>.<field>.add`/`.setRole`/`.remove` → emit
    // `:added`/`:roleChanged`/`:removed`. The handle's existence probe has
    // already decided which action to dispatch (add vs roleChanged vs no-op),
    // so the handler trusts that + emits (consult #19, UNIT 2).
    ...mapMutateHandlers(name, fields, mapFields),
    // ordered mutations: `<Entity>.<field>.insert`/`.move`/`.reorder`/`.remove` →
    // emit `:inserted`/`:moved`/`:reordered`/`:removed`. The handle computes the
    // fractional key(s) and dispatches the action; the handler validates payload
    // (fail closed) and emits (consult #19, UNIT 3).
    ...orderedMutateHandlers(name, fields, orderedFields),
    // ephemeral mutations: `<Entity>.<field>.set` → emit `<Entity>.<field>.set`
    // (per-connection cells snapshot). The handle has already resolved client_id
    // + done the write-grant check; the handler trusts that + emits (P6e-1a).
    ...ephemeralMutateHandlers(name, fields, ephemeralFields),
  });

  function ownerFieldOf(entity) {
    for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
      if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) {
        return fieldName;
      }
    }
    return null;
  }

  // Append handlers for each log field. A log append is a committed pipeline
  // action (consult #19): validate the entry shape (fail closed — an unknown
  // sub-field is rejected), mint a stable entry id, emit `<Entity>.<field>.
  // appended` carrying the owner + id + declared entry cells. Spread into
  // crudHandlers so a dispatched `<Entity>.<field>.append` lands in one handler
  // map alongside create/update/remove.
  function appendLogHandlers(entityName, fields, logFieldEntries) {
    const handlers = {};
    for (const [logField] of logFieldEntries) {
      const entryDescriptor = fields[logField].entry ?? {};
      handlers[`${entityName}.${logField}.append`] = ({ payload }) => {
        const { owner, ...entry } = payload ?? {};
        if (owner == null) {
          throw Object.assign(new Error(`${entityName}.${logField}.append requires an owner`), { status: 400 });
        }
        // fail closed: every supplied key must be a declared entry sub-field
        for (const key of Object.keys(entry)) {
          if (!Object.prototype.hasOwnProperty.call(entryDescriptor, key)) {
            throw Object.assign(new Error(`unknown entry field: ${key}`), { status: 400 });
          }
        }
        const id = randomUUID();
        return [{
          type: `${entityName}.${logField}.appended`,
          scope: `${entityName}:${owner}`,
          data: { owner, id, ...entry },
        }];
      };
    }
    return handlers;
  }

  // Map mutation handlers. A map `.set`/`.remove` is a committed pipeline action
  // (consult #19, UNIT 2): the handle's existence probe decides add vs roleChanged
  // vs no-op, then dispatches `${entityName}.${field}.add`/`.setRole`/`.remove`.
  // The handler validates owner + member are present (fail closed) and emits
  // `${entityName}.${field}.added`/`.roleChanged`/`.removed`; the projection
  // applies the event to the side-table. Spread into crudHandlers so a dispatched
  // map action lands in one handler map alongside create/update/remove/log-append.
  function mapMutateHandlers(entityName, fields, mapFieldEntries) {
    const handlers = {};
    for (const [mapField, descriptor] of mapFieldEntries) {
      const hasRole = Array.isArray(descriptor.roles) && descriptor.roles.length > 0;
      const requireOwnerMember = (payload) => {
        const { owner, member } = payload ?? {};
        if (owner == null || member == null) {
          throw Object.assign(
            new Error(`${entityName}.${mapField} action requires owner + member`),
            { status: 400 },
          );
        }
        return { owner: String(owner), member: String(member) };
      };
      handlers[`${entityName}.${mapField}.add`] = ({ payload }) => {
        const { owner, member } = requireOwnerMember(payload);
        return [{
          type: `${entityName}.${mapField}.added`,
          scope: `${entityName}:${owner}`,
          data: { owner, member, role: hasRole ? (payload.role ?? null) : undefined },
        }];
      };
      handlers[`${entityName}.${mapField}.setRole`] = ({ payload }) => {
        const { owner, member } = requireOwnerMember(payload);
        if (!hasRole) {
          throw Object.assign(new Error(`${entityName}.${mapField}.setRole on a role-less map`), { status: 400 });
        }
        return [{
          type: `${entityName}.${mapField}.roleChanged`,
          scope: `${entityName}:${owner}`,
          data: { owner, member, role: payload.role ?? null },
        }];
      };
      handlers[`${entityName}.${mapField}.remove`] = ({ payload }) => {
        const { owner, member } = requireOwnerMember(payload);
        return [{
          type: `${entityName}.${mapField}.removed`,
          scope: `${entityName}:${owner}`,
          data: { owner, member },
        }];
      };
    }
    return handlers;
  }

  // Ordered field mutation handlers. An ordered `.insertAt`/`.move`/`.reorder`/
  // `.remove` is a committed pipeline action (consult #19, UNIT 3): the handle
  // computes the key (fractional-index math) and dispatches
  // `${entityName}.${field}.insert`/`.move`/`.reorder`/`.remove`. The handler
  // validates payload (fail closed) and emits the corresponding `:inserted`/
  // `:moved`/`:reordered`/`:removed` event; the projection applies the event to
  // the side-table. Spread into crudHandlers so a dispatched ordered action
  // lands in one handler map alongside create/update/remove/log-append/map.
  function orderedMutateHandlers(entityName, fields, orderedFieldEntries) {
    const handlers = {};
    for (const [ordField] of orderedFieldEntries) {
      const requireOwner = (payload) => {
        const { owner } = payload ?? {};
        if (owner == null) {
          throw Object.assign(new Error(`${entityName}.${ordField} action requires an owner`), { status: 400 });
        }
        return String(owner);
      };
      handlers[`${entityName}.${ordField}.insert`] = ({ payload }) => {
        const owner = requireOwner(payload);
        if (payload.key == null) {
          throw Object.assign(new Error(`${entityName}.${ordField}.insert requires a key`), { status: 400 });
        }
        const id = randomUUID();
        return [{
          type: `${entityName}.${ordField}.inserted`,
          scope: `${entityName}:${owner}`,
          data: { owner, id, key: payload.key, value: payload.value },
        }];
      };
      handlers[`${entityName}.${ordField}.move`] = ({ payload }) => {
        const owner = requireOwner(payload);
        if (payload.id == null || payload.key == null) {
          throw Object.assign(new Error(`${entityName}.${ordField}.move requires an id + key`), { status: 400 });
        }
        return [{
          type: `${entityName}.${ordField}.moved`,
          scope: `${entityName}:${owner}`,
          data: { owner, id: String(payload.id), key: payload.key },
        }];
      };
      handlers[`${entityName}.${ordField}.reorder`] = ({ payload }) => {
        const owner = requireOwner(payload);
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        return [{
          type: `${entityName}.${ordField}.reordered`,
          scope: `${entityName}:${owner}`,
          data: { owner, entries: entries.map((e) => ({ id: String(e.id), key: e.key })) },
        }];
      };
      handlers[`${entityName}.${ordField}.remove`] = ({ payload }) => {
        const owner = requireOwner(payload);
        if (payload.id == null) {
          throw Object.assign(new Error(`${entityName}.${ordField}.remove requires an id`), { status: 400 });
        }
        return [{
          type: `${entityName}.${ordField}.removed`,
          scope: `${entityName}:${owner}`,
          data: { owner, id: String(payload.id) },
        }];
      };
    }
    return handlers;
  }

  // Ephemeral mutation handlers (P6e-1a). An ephemeral `.set(cells)` is a committed
  // pipeline action: the handle resolved client_id (principal.id) + did the
  // write-grant check, then dispatched `${entityName}.${field}.set`. The handler
  // trusts that + emits `${entityName}.${field}.set` carrying owner + client +
  // cells; the projection upserts the per-connection side-table row. One emission
  // type (no per-op split — ephemeral is whole-cells-snapshot replace). Spread into
  // crudHandlers so a dispatched ephemeral action lands in one handler map.
  function ephemeralMutateHandlers(entityName, fields, ephemeralFieldEntries) {
    const handlers = {};
    for (const [ephField] of ephemeralFieldEntries) {
      const requireOwnerClient = (payload) => {
        const { owner, client } = payload ?? {};
        if (owner == null || client == null) {
          throw Object.assign(
            new Error(`${entityName}.${ephField}.set requires an owner + client`),
            { status: 400 },
          );
        }
        return { owner: String(owner), client: String(client) };
      };
      handlers[`${entityName}.${ephField}.set`] = ({ payload }) => {
        const { owner, client } = requireOwnerClient(payload);
        return [{
          type: `${entityName}.${ephField}.set`,
          scope: `${entityName}:${owner}`,
          data: { owner, client, cells: payload.cells ?? {} },
        }];
      };
    }
    return handlers;
  }

  const frozen = Object.freeze(record);

  // A declared field becomes a typed handle reached as `Entity.<field>`. The
  // handle is minted on access through a Proxy rather than attached as an own
  // property, so the entity's reserved metadata (name, fields, grant, checks,
  // routes, readScope, scopeAst) and the query methods — all own properties —
  // keep their meaning unshadowed: a field literally named `name` does not
  // corrupt `entity.name`. Reserved keys are own properties (the Proxy passes
  // them through); only a NON-own string key resolves to a field handle. `id`
  // is the synthetic primary-key handle (projection-only); an unknown key
  // returns undefined.
  //
  // A new entity also registers itself by name so a `map(ref('User'))` field
  // can resolve 'User' to this record and hydrate members on read. The ambient
  // registry mirrors the ambient db — one name → one module-cached entity.
  const proxy = new Proxy(frozen, {
    get(target, key, receiver) {
      if (key in target || typeof key !== 'string') {
        return Reflect.get(target, key, receiver);
      }
      if (key === 'id') return { fieldName: 'id' };
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        return fieldHandle(key, fields[key], name, getActiveEntity);
      }
      return undefined;
    },
  });
  setActiveEntity(name, proxy);
  return proxy;
}
