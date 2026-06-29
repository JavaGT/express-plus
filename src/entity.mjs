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

import { randomBytes } from 'node:crypto';
import { assertGuarded } from './guard/static.mjs';
import { compileReadScope, compileInheritScope, lowerToSql, fieldHandle, membershipTable, membershipOwnerCol, MEMBER_COLUMN } from './scope-sql.mjs';
import { getActiveDb } from './db.mjs';
import { buildCheckRegistry } from './registry.mjs';
import {
  serializeField, validateMutation, verifyHash, flattenStruct, structCellColumn,
} from './field-strategy.mjs';

// mintToken — a cryptographically random opaque session token. Handed to a
// create policy so a framework entity that mints session-like rows (Session)
// generates an unguessable token without reaching for node:crypto itself.
function mintToken() {
  return randomBytes(24).toString('hex');
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
  const { fields = {}, grant, checks: declaredChecks = {}, routes, create: createPolicy, effects = null } = declaration;

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
    effects,
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

  // makeMapHandle(entityName, fieldName, ownerId) — returns a write handle
  // for a map field, using the ambient db for all queries.
  const makeMapHandle = (entityName, fieldName, ownerId) => {
    const table = membershipTable(entityName, fieldName);
    const ownerCol = membershipOwnerCol(entityName);

    return {
      add: (memberId, role) => {
        const db = getActiveDb();
        db
          .prepare(`INSERT INTO ${table} (${ownerCol}, ${MEMBER_COLUMN}, role) VALUES (:owner, :member, :role)`)
          .run({ owner: ownerId, member: memberId, role: role ?? null });
      },
      remove: (memberId) => {
        const db = getActiveDb();
        db
          .prepare(`DELETE FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
          .run({ owner: ownerId, member: memberId });
      },
      has: (memberId) => {
        const db = getActiveDb();
        const row = db
          .prepare(`SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
          .get({ owner: ownerId, member: memberId });
        return row !== undefined;
      },
      get: (memberId) => {
        const db = getActiveDb();
        return db
          .prepare(`SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`)
          .get({ owner: ownerId, member: memberId }) ?? undefined;
      },
    };
  };

  const hydrate = (row) => {
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
      row[fieldName] = makeMapHandle(name, fieldName, row.id);
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

  // findAll() returns the rows as an array that also carries a .select(...) so
  // both `findAll()` (all columns) and `findAll().select(a, b)` (projection) read
  // naturally off one call. select lowers its handles to a column list.
  record.findAll = () => {
    const rows = getActiveDb().prepare(`SELECT * FROM ${name} AS t0`).all().map(hydrate);
    rows.select = (...handles) => {
      const cols = handles.map((h) => h.fieldName);
      return getActiveDb().prepare(`SELECT ${cols.join(', ')} FROM ${name} AS t0`).all().map(hydrate);
    };
    return rows;
  };

  // getOrFail throws a 404-status error so renderError renders it through the
  // deliberate-client-error path (a numeric status), not as an opaque 500.
  record.getOrFail = (id) => {
    const row = getActiveDb().prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`).get({ id });
    if (!row) {
      const err = new Error(`${name} ${id} not found`);
      err.status = 404;
      throw err;
    }
    return hydrate(row);
  };

  // insert(cells) — the trusted low-level write core: serialize each declared
  // field's value to its stored cell, INSERT, and return the hydrated new row.
  // It does NOT run validateMutation — its caller has already decided the cells
  // are legitimate (the generic create validates an untrusted payload first; a
  // create POLICY mints server-side cells it owns). This is the ONE place the
  // INSERT/return-row mechanics live; both write paths compose it (singular
  // system, deletion test: the policy override adds intent, not a second insert).
  const insert = (cells) => {
    const stored = {};
    for (const [key, value] of Object.entries(cells)) {
      const descriptor = fields[key];
      // a map field has no main-table column — it lives in a side-table.
      // skip it on insert; the row handle's .add() writes there directly.
      if (descriptor && descriptor.kind === 'store' && descriptor.type === 'map') {
        continue;
      }
      // a structured field expands into its per-cell flat columns; every other
      // field is one serialized cell named by the field key.
      if (descriptor && descriptor.kind === 'struct') {
        Object.assign(stored, flattenStruct(key, descriptor, value));
        continue;
      }
      stored[key] = serializeField(descriptor, value);
    }
    const cols = Object.keys(stored);
    const info = getActiveDb()
      .prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
      .run(stored);
    return hydrate(
      getActiveDb()
        .prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`)
        .get({ id: info.lastInsertRowid }),
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

  const frozen = Object.freeze(record);

  // A declared field becomes a typed handle reached as `Entity.<field>`, so a
  // handler writes a predicate as `User.username.is(value)` and a projection as
  // `.select(User.id, User.username)`. The handle is minted on access through a
  // Proxy rather than attached as an own property, so the entity's reserved
  // metadata (name, fields, grant, checks, routes, readScope, scopeAst) and the
  // query methods — all own properties — keep their meaning unshadowed: a field
  // literally named `name` does not corrupt `entity.name`. The OPEN field
  // namespace and the FIXED reserved set never collide because reserved keys are
  // own properties (the Proxy passes them through) and only a NON-own string key
  // resolves to a field handle. `id` is the synthetic primary-key handle
  // (projection-only). An unknown key returns undefined (a non-field access).
  return new Proxy(frozen, {
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
}
