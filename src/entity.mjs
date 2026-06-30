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
import {
  serializeField, validateMutation, verifyHash, flattenStruct, structCellColumn,
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

// makeQueryBuilder({ name, predicate, hydrate }) — the awaitable, chainable
// query behind `findAll(predicate)`. It composes WHERE (the lowered predicate)
// + ORDER BY + LIMIT + column projection and executes ONE SELECT on await (a
// thenable, so `Promise.all([builder.sort().limit()])` and `await builder` both
// run it). `sort` takes a field handle (its declared fieldName — a safe column
// name, never client input) and a direction; `limit` is bound as a param. The
// builder mutates as it chains and is single-use (await consumes it).
function makeQueryBuilder({ name, predicate, hydrate }) {
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
        if (state.limit !== null) {
          sql += ` LIMIT :limit`;
          params.limit = state.limit;
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

export function entity(name, declaration = {}) {
  const { fields = {}, grant, checks: declaredChecks = {}, routes, create: createPolicy, effects = null, admitsEffects = null } = declaration;

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
    if (fieldName.includes('__')) {
      throw new Error(
        `entity('${name}') field '${fieldName}' contains the reserved '__' separator, ` +
          `which is used to generate structured-field columns. Rename the field.`,
      );
    }
    if (descriptor.kind === 'struct') {
      for (const cellName of Object.keys(descriptor.cells)) {
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
    for (const [triggerHandle, effect] of Object.entries(validatedEffects)) {
      validateEffectDeclaration(effect, { triggerHandle, sourceEntityName: name });
    }
    validatedEffects = Object.freeze(validatedEffects);
  }

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
  };

  // hash-kind fields hydrate from their stored `salt:digest` cell into a
  // `{ verify(plaintext) }` handle so a handler writes `user.password.verify(pw)`
  // (session.mjs). The plaintext digest never leaves the field — a hash cell is
  // not a comparable value, it is a one-way check. A null cell stays null.
  const hashFields = Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'hash')
    .map(([fieldName]) => fieldName);
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

    const requireDispatch = () => {
      if (!dispatch) {
        throw new Error(
          `cannot mutate ${entityName}.${fieldName} without a dispatch ref ` +
            `(hydrate with dispatch inside a handler/route)`,
        );
      }
    };

    return {
      // `.set(memberId, { role })` — a committed pipeline ACTION. A NEW member
      // dispatches `<Entity>.<field>.add` (emits `:added`, fires onAdded via the
      // compiler); an EXISTING member with a DIFFERENT role dispatches `.setRole`
      // (emits `:roleChanged`, does NOT re-fire onAdded — DECISIONLOG #57); the
      // SAME role is a no-op (no dispatch). The side-table is written by the
      // projection applying the emitted event, NOT by the handle.
      set: async (memberId, { role } = {}) => {
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const mid = String(memberId);
        const existing = probeRow(memberId);
        const actionType =
          !existing ? `${entityName}.${fieldName}.add`
          : hasRole && existing.role !== (role ?? null) ? `${entityName}.${fieldName}.setRole`
          : null;
        if (actionType === null) return; // same-role repeat share: no-op
        requireDispatch();
        const result = await dispatch({
          actionId: randomUUID(),
          type: actionType,
          payload: { owner: oid, member: mid, role },
          principal,
        });
        if (!result.granted) throw { status: 403, message: 'forbidden' };
      },
      remove: async (memberId) => {
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const mid = String(memberId);
        if (!probe(memberId)) return; // idempotent remove: nothing to dispatch
        requireDispatch();
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
        if (principal && !(await mayFieldOp(record, fieldName, read, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const db = getActiveDb();
        const selectCols = hasRole ? `${MEMBER_COLUMN} AS member_id, role` : `${MEMBER_COLUMN} AS member_id`;
        const rows = db
          .prepare(`SELECT ${selectCols} FROM ${table} WHERE ${ownerCol} = :owner`)
          .all({ owner: oid });
        const target = targetName ? getActiveEntity(targetName) : null;
        if (!target) return rows.map((r) => [null, hasRole ? r.role : null]);
        return rows.map((r) => [target.findById(r.member_id), hasRole ? r.role : null]);
      },
    };
  };

  // makeOrderedListHandle(entityName, fieldName, row, principal) — returns a
  // write handle for an `ordered`/`list` field over a fractional-index
  // side-table (owner, id, key, item). Order is derived by ORDER BY key, so a
  // between-insert or a move re-keys ONLY the affected row — siblings keep their
  // keys (no renumber, the hallmark of fractional indexing). `insertAt` mints a
  // stable `id` (returned to the caller) + a fractional key between the
  // neighbor keys; `move(id, i)` re-keys the one element; `reorder([ids])`
  // re-keys the lot to an evenly-spaced sequence (sugar over move). The element
  // value is stored as a JSON `item` cell (A2: scalar items; FK hydration of a
  // ref `of` is a later refinement).
  const makeOrderedListHandle = (entityName, fieldName, row, principal) => {
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
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const db = getActiveDb();
        const rows = rowsOrdered();
        const low = index > 0 ? rows[index - 1].key : null;
        const high = index < rows.length ? rows[index].key : null;
        const id = randomUUID();
        db.prepare(`INSERT INTO ${table} (${ownerCol}, id, key, item) VALUES (:owner, :id, :key, :item)`)
          .run({ owner: oid, id, key: keyBetween(low, high), item: JSON.stringify(value) });
        return id;
      },
      move: async (id, index) => {
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const db = getActiveDb();
        const sid = String(id);
        const others = rowsOrdered().filter((r) => r.id !== sid);
        const low = index > 0 ? others[index - 1].key : null;
        const high = index < others.length ? others[index].key : null;
        db.prepare(`UPDATE ${table} SET key = :key WHERE ${ownerCol} = :owner AND id = :id`)
          .run({ owner: oid, id: sid, key: keyBetween(low, high) });
      },
      reorder: async (ids) => {
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const db = getActiveDb();
        const stmt = db.prepare(`UPDATE ${table} SET key = :key WHERE ${ownerCol} = :owner AND id = :id`);
        // evenly-spaced keys so ORDER BY key matches the requested id sequence
        ids.forEach((id, i) => stmt.run({ owner: oid, id: String(id), key: i }));
      },
      remove: async (id) => {
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        const db = getActiveDb();
        db.prepare(`DELETE FROM ${table} WHERE ${ownerCol} = :owner AND id = :id`)
          .run({ owner: oid, id: String(id) });
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
        if (principal && !(await mayFieldOp(record, fieldName, read, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
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
        if (principal && !(await mayFieldOp(record, fieldName, write, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
        if (!dispatch) {
          throw new Error(
            `cannot append to ${entityName}.${fieldName} without a dispatch ref ` +
              `(hydrate with dispatch inside a handler/route)`,
          );
        }
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
        if (principal && !(await mayFieldOp(record, fieldName, read, row, principal))) {
          throw { status: 403, message: 'forbidden' };
        }
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

  // hydrate(row, principal, dispatch) — assemble hash{verify}, struct namespaces,
  // store handles, and derived fields onto a raw row. `dispatch` is OPTIONAL: a
  // store MUTATION handle (log .append) needs it to re-enter dispatch; it's null
  // for the trusted query API + reads (findOne/findAll/findById pass null; a
  // request path that wants in-handler store mutations threads the kernel's
  // dispatch fn — UNIT 2's concern for map/ordered). Default null = backward-
  // compatible (store query handles + all reads work without it).
  const hydrate = (row, principal = null, dispatch = null) => {
    if (!row) return row;
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
      row[fieldName] = makeOrderedListHandle(name, fieldName, row, principal);
    }
    for (const [fieldName] of logFields) {
      row[fieldName] = makeLogHandle(name, fieldName, row, principal, dispatch);
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
    return makeQueryBuilder({ name, predicate, hydrate });
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
        const cols = Object.keys(row);
        if (cols.length > 0) {
          db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
          ).run(row);
        }
      } else if (event.type === `${name}.updated`) {
        const { id, ...data } = event.data ?? {};
        if (!id) return;
        const updates = [];
        const params = { id };
        for (const [key, value] of Object.entries(data)) {
          const descriptor = fields[key];
          if (descriptor && descriptor.kind === 'store') continue;
          if (descriptor && descriptor.kind === 'struct') continue;
          const stored = descriptor ? serializeField(descriptor, value) : value;
          updates.push(`${key} = :${key}`);
          params[key] = stored;
        }
        if (updates.length > 0) {
          db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = :id`).run(params);
        }
      } else if (event.type === `${name}.removed`) {
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(event.data?.id);
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
        return fieldHandle(key, fields[key], name);
      }
      return undefined;
    },
  });
  setActiveEntity(name, proxy);
  return proxy;
}
