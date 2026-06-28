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
import { compileReadScope, compileInheritScope } from './scope-sql.mjs';

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

  return Object.freeze({
    name,
    fields: Object.freeze({ ...fields }),
    grant,
    checks,
    routes,
    readScope: readScope ? Object.freeze({ sql: readScope.sql, params: readScope.params }) : undefined,
    scopeAst,
  });
}
