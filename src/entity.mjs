// entity(name, { fields, grant, checks?, routes? }) — the entity compiler.
//
// Compiles a declared entity into a frozen, validated record. This is where the
// fail-closed load-time guards live (SPEC §6.1, §13; ADRs #7, #16):
//
//  - No grant is a LOAD-TIME ERROR (ADR #7): there is no zero-to-one default
//    grant; the smoothest path is still an explicit one.
//  - A `ref` field with `role: 'x'` auto-derives a check `is.x()` — the ONE
//    thing the FK derives (SPEC §6.2): the single source of truth for "who is
//    the x of this row". A developer-declared check of the same name wins.
//  - Every `.can` body is statically guarded (assertGuarded, ADR #16). A `scope`
//    predicate is NOT guarded: it compiles to SQL and never runs as JS, so its
//    `is.*` calls are correctly un-awaited (SPEC §6.1).

import { assertGuarded } from './guard/static.mjs';
import { compileReadScope, compileInheritScope, lowerToSql, fieldHandle } from './scope-sql.mjs';
import { getActiveDb } from './db.mjs';
import { serializeField, validateMutation, verifyHash } from './field-strategy.mjs';

// Derive a role check from a ref field carrying `role`. The check is a plain
// per-row fact comparing the principal's id against the FK column value — the
// same shape a developer would hand-write, but derived from the one declaration.
function deriveRoleChecks(fields) {
  const derived = {};
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor.type === 'ref' && descriptor.role) {
      derived[descriptor.role] = ({ entity: row, principal }) =>
        row[fieldName] === principal.id;
    }
  }
  return derived;
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
  const { fields = {}, grant, checks: declaredChecks = {}, routes } = declaration;

  // Fail closed: an entity with no grant cannot be mounted (ADR #7).
  if (grant === undefined || grant === null) {
    throw new Error(
      `entity('${name}') has no grant. An entity with no grant is a load-time ` +
        `error (ADR #7): there is no default grant. Declare one explicitly, ` +
        `e.g. grant: () => [scope(...).can(...)].`,
    );
  }

  // Derived role checks first, then developer-declared checks override them
  // (an explicit check of the same name is the single source of truth).
  const checks = Object.freeze({ ...deriveRoleChecks(fields), ...declaredChecks });

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
    checks,
    routes,
    readScope: readScope ? Object.freeze({ sql: readScope.sql, params: readScope.params }) : undefined,
    scopeAst,
  };

  // hash-kind fields hydrate from their stored `salt:digest` cell into a
  // `{ verify(plaintext) }` handle so a handler writes `user.password.verify(pw)`
  // (session.mjs). The plaintext digest never leaves the field — a hash cell is
  // not a comparable value, it is a one-way check. A null cell stays null.
  const hashFields = Object.entries(fields)
    .filter(([, descriptor]) => descriptor.kind === 'hash')
    .map(([fieldName]) => fieldName);
  const hydrate = (row) => {
    if (!row) return row;
    for (const fieldName of hashFields) {
      const stored = row[fieldName];
      if (stored === null || stored === undefined) continue;
      row[fieldName] = { verify: (plaintext) => verifyHash(plaintext, stored) };
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

  record.create = (payload) => {
    validateMutation(record, payload);
    const cells = {};
    for (const [key, value] of Object.entries(payload)) {
      cells[key] = serializeField(fields[key], value);
    }
    const cols = Object.keys(cells);
    const info = getActiveDb()
      .prepare(`INSERT INTO ${name} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`)
      .run(cells);
    return hydrate(
      getActiveDb()
        .prepare(`SELECT * FROM ${name} AS t0 WHERE t0.id = :id`)
        .get({ id: info.lastInsertRowid }),
    );
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
        return fieldHandle(key, fields[key]);
      }
      return undefined;
    },
  });
}
