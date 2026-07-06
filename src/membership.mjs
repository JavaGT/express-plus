// membership — concentrates the two-plane membership pattern into a single declaration.
//
// Before (15 lines of boilerplate per entity):
//   checks: { member: ({ Project, principal: p }) => Project.members.has(p.id) },
//   grant: () => [scope(({ is }) => anyOf(is.owner(), is.member())).can(async ({ is }) => {
//     if (await is.owner()) return grant(read, write, subscribe, admin);
//     if (await is.member()) return grant(read, subscribe);
//     return deny('not authorized');
//   })],
//
// After (inside the entity declaration):
//   membership: { member: { can: [read, subscribe] } }
//
// Or standalone (on an already-compiled entity):
//   membership(Project, { member: { can: [read, subscribe] } })
//
// The function generates checks (harvest + run faces), builds a scope predicate
// using anyOf, and produces a grant thunk. Uses ONLY existing primitives
// (map, checks, scope, grant, deny, anyOf — no new engine).

import {
  compileReadScope,
  bindReadScope,
  makeNode,
  PRINCIPAL_ID_PARAM,
  membershipTable,
  membershipOwnerCol,
  MEMBER_COLUMN,
  anyOf,
} from './scope-sql.mjs';
import { scope } from './scope.mjs';
import { grant, deny, read, write, subscribe, admin } from './grant.mjs';
import { setActiveEntity } from './db.mjs';
import { getActiveDb } from './db.mjs';

// Owner always receives the full capability set.
const OWNER_CAPABILITIES = Object.freeze([read, write, subscribe, admin]);

// ---- Core: compile a membership declaration into { grant, checks } ----
// Called by the entity compiler when `membership:` is present in the declaration.
// Also called by the standalone `membership()` wrapper function.
//
// Returns:
//   { grant: () => [clause], checks: { [role]: registryEntry, ... }, fieldMappings }
// The `checks` values are registry-style entries { harvest, run }.
export function compileMembershipAuthz(entityName, fields, config) {
  if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
    throw new Error(
      `compileMembershipAuthz('${entityName}'): config must be a non-empty object`,
    );
  }

  const roleNames = Object.keys(config);
  const fieldMappings = new Map(); // roleName -> { fieldName, dbRoles, capabilities }
  const checks = {};

  for (const roleName of roleNames) {
    const roleConfig = config[roleName];
    if (!roleConfig || typeof roleConfig !== 'object') {
      throw new Error(
        `membership role '${roleName}' config must be an object with { can: [...] }`,
      );
    }
    if (!roleConfig.can || !Array.isArray(roleConfig.can)) {
      throw new Error(
        `membership role '${roleName}' must declare { can: [read, ...] }`,
      );
    }

    const { field: fieldSpec, can: capabilities } = roleConfig;

    // Find the matching map field
    const fieldName = resolveFieldName(fields, roleName, fieldSpec);
    const descriptor = fields[fieldName];

    // Determine DB role values for runtime filtering.
    const dbRoles = fieldSpec?.role
      ? (Array.isArray(fieldSpec.role) ? [...fieldSpec.role] : [fieldSpec.role])
      : resolveDescriptorRoles(descriptor);

    fieldMappings.set(roleName, { fieldName, dbRoles, capabilities });

    // Build the check entry (harvest + run faces)
    checks[roleName] = buildCheckEntry(entityName, fieldName, dbRoles);
  }

  // Check if owner role exists (auto-derived from ref-role field)
  const hasOwner = Object.values(fields).some(
    (f) => f?.type === 'ref' && f.role === 'owner',
  );

  // Build scope predicate: anyOf(is.owner(), is.<role>(), ...)
  const scopePredicate = ({ is }) => {
    const predicateChecks = [];
    if (hasOwner) predicateChecks.push(is.owner());
    for (const roleName of roleNames) predicateChecks.push(is[roleName]());
    if (predicateChecks.length === 0) {
      throw new Error(
        `membership: no checks to include in scope predicate (no owner, no roles) on entity '${entityName}'`,
      );
    }
    return anyOf(...predicateChecks);
  };

  // Build .can body
  const canBody = async ({ is }) => {
    if (hasOwner && (await is.owner())) return grant(...OWNER_CAPABILITIES);
    for (const roleName of roleNames) {
      if (await is[roleName]()) {
        const caps = fieldMappings.get(roleName).capabilities;
        return grant(...caps);
      }
    }
    return deny('not authorized');
  };

  // Build grant thunk
  const grantThunk = () => [scope(scopePredicate).can(canBody)];

  return { grant: grantThunk, checks, fieldMappings, scopePredicate, canBody, hasOwner };
}

// ---- Standalone: augment a compiled entity record in place ----
// Sets entity.grant, entity.registry, entity.readScope, entity.checks, and
// entity.scopeFilter directly on the entity proxy. The entity proxy's set trap
// stores overrides; subsequent reads get the overridden values. Re-registers
// in the active entity registry so ref('Entity') resolves to the augmented entity.
export function membership(entityRecord, config) {
  if (!entityRecord || typeof entityRecord !== 'object' || !entityRecord.name) {
    throw new Error(
      'membership(entity, config): first argument must be a compiled entity record (from entity())',
    );
  }

  const entityName = entityRecord.name;
  const fields = entityRecord.fields;

  const { grant: grantThunk, checks: newChecks, scopePredicate } =
    compileMembershipAuthz(entityName, fields, config);

  // Read the existing registry before overriding
  const existingRegistry = entityRecord.registry ?? {};
  const newRegistry = Object.freeze({ ...existingRegistry, ...newChecks });

  // Compile the read-scope from the scope predicate (uses the new registry)
  const readScopeResult = compileReadScope(scopePredicate, {
    fields,
    where: `membership scope on entity('${entityName}')`,
    registry: newRegistry,
  });

  const newReadScope = readScopeResult
    ? Object.freeze({ sql: readScopeResult.sql, params: readScopeResult.params })
    : undefined;
  const newScopeAst = readScopeResult ? readScopeResult.ast : undefined;

  // Build scopeFilter function (re-bound to new readScope)
  const scopeFilterFn = (principal) => {
    if (!newReadScope) return { sql: '1=1', params: {} };
    const bound = bindReadScope(newReadScope, principal);
    return bound ? { sql: bound.sql, params: bound.params } : { sql: '1=1', params: {} };
  };

  // In-place mutation: set properties on the entity proxy. The proxy's set trap
  // stores these on the record. `checks` is NOT set here — it's a getter on the
  // record that dynamically computes from `this.registry`, so setting `registry`
  // alone is sufficient.
  entityRecord.grant = grantThunk;
  entityRecord.registry = newRegistry;
  entityRecord.readScope = newReadScope;
  entityRecord.scopeAst = newScopeAst;
  entityRecord.scopeFilter = scopeFilterFn;

  // Re-register in the active entity registry so ref('Entity') resolves to the
  // augmented entity (the proxy is the same object, just with overrides set).
  setActiveEntity(entityName, entityRecord);

  return entityRecord;
}

// ---- Internal helpers ----

// Find which map field on the entity to use for a given role name.
function resolveFieldName(fields, roleName, fieldSpec) {
  // Explicit field name in config
  if (fieldSpec?.name) {
    const name = fieldSpec.name;
    if (!fields[name]) {
      throw new Error(
        `membership: field '${name}' not found on entity (for role '${roleName}')`,
      );
    }
    if (fields[name].kind !== 'store' || fields[name].type !== 'map') {
      throw new Error(
        `membership: field '${name}' is not a map field (kind=${fields[name].kind}, type=${fields[name].type})`,
      );
    }
    return name;
  }

  // Find all map fields
  const mapFields = Object.entries(fields).filter(
    ([, d]) => d?.kind === 'store' && d.type === 'map',
  );

  if (mapFields.length === 0) {
    throw new Error(
      `membership: no map field found on entity for role '${roleName}'. ` +
        `Declare a map field (e.g. members: map(ref('User'), { role: [...] })).`,
    );
  }

  // Try to match by role name in the descriptor's role array
  for (const [fName, desc] of mapFields) {
    const roles = resolveDescriptorRoles(desc);
    if (roles.includes(roleName)) return fName;
  }

  // Try singular → plural convention: roleName + 's'
  const pluralName = roleName + 's';
  if (mapFields.some(([n]) => n === pluralName)) return pluralName;

  // If only one map field, use it
  if (mapFields.length === 1) return mapFields[0][0];

  // Ambiguous — ask for explicit field name
  throw new Error(
    `membership: cannot determine which map field to use for role '${roleName}'. ` +
      `Found map fields: ${mapFields.map(([n]) => `'${n}'`).join(', ')}. ` +
      `Specify the field name explicitly with field: { name: 'fieldName' }.`,
  );
}

// Extract role values from a field descriptor, normalized to an array.
function resolveDescriptorRoles(descriptor) {
  if (!descriptor) return [];
  if (Array.isArray(descriptor.role)) return [...descriptor.role];
  if (descriptor.role) return [descriptor.role];
  return [];
}

// Build a check entry with harvest (SQL-compilable) and run (runtime) faces.
function buildCheckEntry(entityName, fieldName, dbRoles) {
  const table = membershipTable(entityName, fieldName);
  const ownerCol = membershipOwnerCol(entityName);

  // Harvest face: returns an existsMembership AST node for scope→SQL lowering.
  const harvest = () => {
    return makeNode({
      node: 'existsMembership',
      table,
      ownerCol,
      param: PRINCIPAL_ID_PARAM,
    });
  };

  // Run face: queries the membership side-table at runtime.
  const run = ({ entity: row, principal }) => {
    const db = getActiveDb();
    if (dbRoles.length > 0) {
      const roleParams = {};
      const conditions = dbRoles.map((role, i) => {
        const key = `__role_${i}`;
        roleParams[key] = role;
        return `:${key}`;
      });
      const stmt = db.prepare(
        `SELECT 1 FROM ${table} WHERE ${ownerCol} = :__owner AND ${MEMBER_COLUMN} = :__member AND role IN (${conditions.join(', ')})`,
      );
      return (
        stmt.get({ __owner: row.id, __member: principal.id, ...roleParams }) !== undefined
      );
    }
    const stmt = db.prepare(
      `SELECT 1 FROM ${table} WHERE ${ownerCol} = :__owner AND ${MEMBER_COLUMN} = :__member`,
    );
    return stmt.get({ __owner: row.id, __member: principal.id }) !== undefined;
  };

  return { harvest, run };
}
