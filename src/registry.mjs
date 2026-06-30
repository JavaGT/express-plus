// The unified check registry — the ONE source of truth for every named check
// on an entity, consulted by BOTH the scope→SQL compiler (harvest face) AND the
// per-row runtime evaluator (run face).
//
// A check named in a grant — is.owner(), is.collaborator(), is.editor() — is
// resolved through this registry alone. There is no second roleFieldMap or
// deriveRoleChecks path. The registry retires both old paths in the same change
// (AGENTS: "a new general mechanism retires the special-case it generalizes").
//
// THREE sources populate the registry. Source order determines face presence:
//
// 1. REF-ROLE FIELD — for each field where descriptor.type === 'ref' && descriptor.role,
//    the entry keyed by descriptor.role gets BOTH faces derived from the field name.
//
// 2. DECLARED CHECK — for each [name, fn] in declaredChecks, the entry gets BOTH
//    faces. The harvest face invokes fn with a compile self-handle (fieldHandle
//    per field, keyed by entityName) and requires an AST return. The run face
//    invokes fn with a runtime self-handle (row-based object that exposes .has()
//    for map fields) and the concrete principal.
//
// 3. MAP-ROLE NAMES — for each map field with descriptor.roles, each role name
//    gets a RUNTIME-ONLY entry (NO harvest face). Using is.editor() in scope
//    is a load-time error — fail closed.
//
// Collision rule (fail closed): a ref field carrying a `role` IS the single
// source of truth for that name — both faces are mechanically derived from the
// one field, so they cannot disagree. A declared `checks` entry that REDECLARES
// a ref-role-derived name is a LOAD-TIME ERROR ("ref-role checks cannot be
// redeclared"). Keeping the ref-role harvest face while letting a declared body
// supply the run face would fuse TWO independent definitions into one entry —
// exactly the split-brain (SQL filter says one thing, runtime says another) this
// registry exists to abolish. If a developer wants different behavior, they give
// it a DIFFERENT name. A map-role name that collides with a ref-role or declared
// name is the weaker (runtime-only) entry and is silently skipped.

import { fieldHandle } from './scope-sql.mjs';
import {
  PRINCIPAL_ID_PARAM,
  PRINCIPAL_ID_TOKEN,
  PRINCIPAL_ATTR_TOKEN,
  makeNode,
  isNode,
  NonCompilableError,
  membershipTable,
  membershipOwnerCol,
  MEMBER_COLUMN,
} from './scope-sql.mjs';
import { getActiveDb } from './db.mjs';

export function buildCheckRegistry({ fields = {}, declaredChecks = {}, entityName }) {
  const registry = {};

  // ---- Source 1: ref-role fields ----
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor?.type === 'ref' && descriptor.role) {
      registry[descriptor.role] = {
        harvest: () => makeNode({ node: 'eq', field: fieldName, param: PRINCIPAL_ID_PARAM }),
        run: ({ entity: row, principal }) => row[fieldName] === principal.id,
      };
    }
  }

  // ---- Source 2: declared checks ----
  // Build the compile self-handle once (same shape makeIsProxy built today:
  // one fieldHandle per field, keyed by entityName).
  const compileSelfHandle = {};
  if (entityName) {
    for (const [fName, desc] of Object.entries(fields)) {
      compileSelfHandle[fName] = fieldHandle(fName, desc, entityName);
    }
  }

  for (const [checkName, fn] of Object.entries(declaredChecks)) {
    // Collision with a ref-role-derived name is a load error: the ref field is
    // the single source of truth and cannot be redeclared (fail closed).
    if (registry[checkName]) {
      throw new NonCompilableError(
        `check '${checkName}' is already derived from a ref(..., { role: '${checkName}' }) field and cannot be redeclared in checks`,
        { where: `entity '${entityName}'` },
      );
    }

    // Run face: invoke fn per-row with a runtime self-handle.
    const run = ({ entity: row, principal }) => {
      const runtimeSelf = {};
      if (entityName) {
        for (const [fName, desc] of Object.entries(fields)) {
          // For map fields, expose `.has(memberId)` and `.get(memberId)` that
          // query the membership table. `.get` returns the raw side-table row
          // (or undefined) so checks can inspect a member's role.
          if (desc?.kind === 'store' && desc.type === 'map') {
            const table = membershipTable(entityName, fName);
            const ownerCol = membershipOwnerCol(entityName);
            const db = getActiveDb();
            runtimeSelf[fName] = {
              has: (memberId) => {
                return db.prepare(
                  `SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`,
                ).get({ owner: row.id, member: memberId }) !== undefined;
              },
              get: (memberId) => {
                return db.prepare(
                  `SELECT * FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member`,
                ).get({ owner: row.id, member: memberId }) ?? undefined;
              },
            };
          }
          // For struct fields (the `link` kind), expose each sub-cell as a value
          // handle with a runtime `.is(v)` — the run-time mirror of the harvest
          // value `.is()`. A check like `Doc.linkShare.token.is(principal.attributes.token)`
          // resolves here: the hydrated namespace (`row.linkShare = {token, tier}`)
          // supplies the stored value; `.is(undefined)` is false (fail-closed for
          // a non-link principal, mirroring the harvest FALSE + SQL NULL bind).
          else if (desc?.kind === 'struct') {
            const handle = {};
            for (const [cellName] of Object.entries(desc.cells)) {
              handle[cellName] = {
                is: (v) => v == null ? false : row[fName]?.[cellName] === v,
              };
            }
            runtimeSelf[fName] = handle;
          }
          // For value/ref fields, expose the raw column value so a check can read
          // other columns if it needs to (the check destructures the entity).
          else {
            runtimeSelf[fName] = row[fName];
          }
        }
      }
      const entityContext = entityName ? { [entityName]: runtimeSelf } : {};
      return fn({
        ...entityContext,
        principal,
      });
    };

    // Harvest face: built from the declared check body under the compile
    // self-handle. The body composes framework field handles (e.g.
    // `Entity.collaborators.has(principal.id)`) that return AST nodes; a body
    // that returns a non-AST value (a raw boolean from a runtime-shaped check)
    // is rejected at load (fail closed — never silently dropped from the SQL
    // filter, which would widen row visibility).
    const harvest = () => {
      const entityContext = entityName ? { [entityName]: compileSelfHandle } : {};
      const result = fn({
        ...entityContext,
        principal: { id: PRINCIPAL_ID_TOKEN, attributes: { token: PRINCIPAL_ATTR_TOKEN } },
      });
      if (!isNode(result)) {
        throw new NonCompilableError(
          `declared check '${checkName}' returned a non-AST value`,
          { where: `entity '${entityName}'` },
        );
      }
      return result;
    };
    registry[checkName] = { harvest, run };
  }

  // ---- Source 3: map-role names (runtime-only) ----
  // For each map field with `roles`, add a runtime-only entry per role name.
  // These entries have NO harvest face — using them in scope must fail.
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (descriptor?.kind === 'store' && descriptor.type === 'map' && descriptor.roles?.length > 0) {
      const table = membershipTable(entityName, fieldName);
      const ownerCol = membershipOwnerCol(entityName);

      for (const roleName of descriptor.roles) {
        // If the name already exists from a ref-role or declared check, skip it.
        // Declared/ref-role entries carry both faces and are the canonical source;
        // a map-role with the same name would be a weaker runtime-only shadow.
        if (registry[roleName]) continue;

        registry[roleName] = {
          // NO harvest face — runtime-only. Calling is.editor() in scope must throw.
          harvest: undefined,
          run: ({ entity: row, principal }) => {
            const db = getActiveDb();
            const stmt = db.prepare(
              `SELECT 1 FROM ${table} WHERE ${ownerCol} = :owner AND ${MEMBER_COLUMN} = :member AND role = :role`,
            );
            return (
              stmt.get({ owner: row.id, member: principal.id, role: roleName }) !== undefined
            );
          },
        };
      }
    }
  }

  return Object.freeze(registry);
}
