import { mayRow } from './row-grant.mjs';

function entityOf(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.fields) throw new TypeError('snapshot relation requires a declared entity');
  return value;
}

function isRegisteredEntity(entity, resolveEntity) {
  const registered = resolveEntity(entity.name, entity);
  return registered === entity || registered?.declaration === entity;
}

/** Prefer the application-bound entity (runtime db + hydrate) over the unbound declaration. */
function boundEntity(entity, resolveEntity) {
  const registered = resolveEntity(entity.name, entity);
  if (registered === entity || registered?.declaration === entity) return registered;
  throw new TypeError(`snapshot entity '${entity.name}' must be registered`);
}

function identifier(name, label) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`${label} must be a SQL identifier`);
  return name;
}

function scalar(entity, field) {
  if (field === 'id') return;
  const descriptor = entity.fields[field];
  if (!descriptor || descriptor.kind !== 'value' || !['text', 'boolean', 'date', 'number', 'ref', 'json'].includes(descriptor.type)) {
    throw new TypeError(`snapshot field '${entity.name}.${field}' is not a supported scalar codec`);
  }
}

function targetName(descriptor) {
  const target = descriptor?.target;
  return typeof target === 'string' ? target : target?.name;
}

function relation(from, to, inverse, via) {
  const owner = inverse ? to : from;
  const target = inverse ? from : to;
  const descriptor = owner.fields[via];
  if (descriptor?.kind !== 'value' || descriptor.type !== 'ref' || targetName(descriptor) !== target.name) {
    throw new TypeError(`snapshot relation ${from.name} -> ${to.name} via '${via}' must be a declared ref(${target.name})`);
  }
  return via;
}

function outputFor(node) {
  return node?.kind === 'object' ? node : null;
}

function compileOutput(entity, output, ancestors = new Set()) {
  const object = outputFor(output);
  if (!object) throw new TypeError(`snapshot output for '${entity.name}' must be object(...)`);
  if (ancestors.has(entity)) throw new TypeError(`snapshot output is cyclic at '${entity.name}'`);
  ancestors.add(entity);
  const entries = [];
  let hasSelect = false;
  for (const [key, value] of Object.entries(object.shape)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`snapshot output key '${key}' is invalid`);
    if (value?.kind === 'select') {
      if (hasSelect) throw new TypeError(`snapshot output for '${entity.name}' declares select(...) more than once`);
      hasSelect = true;
      for (const field of value.fields) scalar(entity, field);
      entries.push(Object.freeze({ key, kind: 'select', fields: value.fields }));
      continue;
    }
    if (value?.kind === 'user') {
      const descriptor = entity.fields[value.via];
      if (descriptor?.kind !== 'value' || descriptor.type !== 'ref' || targetName(descriptor) !== 'User') throw new TypeError(`snapshot user '${key}' via '${value?.via}' must be a declared ref(User)`);
      entries.push(Object.freeze({ key, kind: 'user', fk: value.via }));
      continue;
    }
    if (!['one', 'many', 'keyed', 'count'].includes(value?.kind)) throw new TypeError(`snapshot output '${key}' must use select, one, many, keyed, count, or user`);
    if (value.kind === 'one' && value.require !== undefined) throw new TypeError(`snapshot relation '${key}' cannot use require on one`);
    const child = entityOf(value.entity);
    const inverse = value.kind !== 'one';
    const fk = relation(entity, child, inverse, value.via);
    const selectNode = value.select ?? value.output;
    const nested = value.include ?? value.output;
    const selected = selectNode?.kind === 'select' ? selectNode.fields : null;
    if (selected) for (const field of selected) scalar(child, field);
    const nestedCompiled = nested?.kind === 'object' ? compileOutput(child, nested, ancestors) : null;
    if (!selected && !nestedCompiled && value.kind !== 'count') throw new TypeError(`snapshot relation '${key}' requires select(...) or include(...)`);
    const order = value.orderBy;
    if (order !== undefined) {
      if (order?.kind !== 'orderBy') throw new TypeError(`snapshot relation '${key}' orderBy must use orderBy(...)`);
      scalar(child, order.field);
    }
    const required = value.require;
    let require = null;
    if (required !== undefined) {
      if (!required || required.kind !== 'related' || Object.keys(required).length !== 5
        || typeof required.childRef !== 'string' || typeof required.via !== 'string') {
        throw new TypeError(`snapshot relation '${key}' require must use related(childRef, { via })`);
      }
      const childRef = child.fields[required.childRef];
      if (required.childEntity !== child.name) {
        throw new TypeError(`snapshot relation '${key}' related childRef must belong to ${child.name}`);
      }
      if (childRef?.kind !== 'value' || childRef.type !== 'ref') {
        throw new TypeError(`snapshot relation '${key}' related childRef must belong to ${child.name} and be a declared ref`);
      }
      const related = typeof childRef.target === 'string' ? null : childRef.target;
      if (!related || typeof related.name !== 'string' || !related.fields) {
        throw new TypeError(`snapshot relation '${key}' related childRef must target a declared entity`);
      }
      const parentRef = related.fields[required.via];
      if (required.parentEntity !== related.name) {
        throw new TypeError(`snapshot relation '${key}' related via must belong to ${related.name}`);
      }
      if (parentRef?.kind !== 'value' || parentRef.type !== 'ref' || targetName(parentRef) !== entity.name) {
        throw new TypeError(`snapshot relation '${key}' related via must belong to ${related.name} and be a declared ref(${entity.name})`);
      }
      require = Object.freeze({ entity: related, childRef: required.childRef, fk: required.via });
    }
    entries.push(Object.freeze({ key, kind: value.kind, entity: child, fk, inverse, selected, nested: nestedCompiled, order: order ?? null, require }));
  }
  ancestors.delete(entity);
  return Object.freeze({ entity, entries: Object.freeze(entries) });
}

function physicalForeignKey(db, from, field, target, { retainTarget = false } = {}) {
  if (!db) return;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${identifier(from.name, 'snapshot entity')})`).all();
  const matching = foreignKeys.filter((row) => row.from === field && row.table === target.name && row.to === 'id');
  if (matching.length !== 1 || foreignKeys.filter((row) => row.from === field).length !== 1) throw new TypeError(`snapshot relation ${from.name}.${field} requires exactly one physical FOREIGN KEY to ${target.name}.id`);
  if (retainTarget && !['RESTRICT', 'NO ACTION'].includes(matching[0].on_delete)) throw new TypeError(`snapshot terminal tombstone scope ${from.name}.${field} FOREIGN KEY must use ON DELETE RESTRICT or NO ACTION`);
}

function compileTombstones(declaration, resolveEntity) {
  const rule = declaration.tombstones;
  if (rule === undefined) return null;
  if (rule?.kind !== 'tombstones') throw new TypeError('snapshot tombstones must use tombstones(...)');
  const target = entityOf(rule.target);
  if (target !== declaration.anchor) throw new TypeError(`snapshot tombstones target must be anchor '${declaration.anchor.name}'`);
  if (!isRegisteredEntity(target, resolveEntity)) throw new TypeError(`snapshot tombstones target '${target.name}' must be registered`);
  const entity = entityOf(rule.entity);
  if (!isRegisteredEntity(entity, resolveEntity)) throw new TypeError(`snapshot tombstone entity '${entity.name}' must be registered`);
  const entityId = entity.fields[rule.entityId];
  const terminalScope = rule.terminalScope === undefined ? null : entityOf(rule.terminalScope);
  if (rule.targetScope !== undefined && rule.targetScopeId === undefined) {
    throw new TypeError('snapshot tombstone targetScope requires targetScopeId');
  }
  if (rule.targetScopeId !== undefined && rule.targetScope === undefined) {
    throw new TypeError('snapshot tombstone targetScopeId requires targetScope');
  }
  let scopeTarget = null;
  let targetScopeId = null;
  if (terminalScope) {
    if (!isRegisteredEntity(terminalScope, resolveEntity)) throw new TypeError(`snapshot terminal tombstone scope '${terminalScope.name}' must be registered`);
    if (Object.keys(terminalScope.fields).length !== 0) throw new TypeError('snapshot terminal tombstone scope must be an identity-only entity');
    if (rule.scopeId === undefined) throw new TypeError('snapshot terminal tombstone scope requires scopeId');
  }
  if (rule.scopeId === undefined) {
    if (entityId?.kind !== 'value' || entityId.type !== 'ref' || targetName(entityId) !== target.name) {
      throw new TypeError(`snapshot tombstones entityId must be a declared ref(${target.name})`);
    }
  } else {
    if (entityId?.kind !== 'value' || entityId.type !== 'text') throw new TypeError('snapshot polymorphic tombstones entityId must be a declared text field');
    const scopeId = entity.fields[rule.scopeId];
    if (scopeId?.kind !== 'value' || scopeId.type !== 'ref') throw new TypeError(`snapshot polymorphic tombstones scopeId must be a declared ref(${terminalScope?.name ?? target.name})`);
    if (terminalScope && targetName(scopeId) !== terminalScope.name) throw new TypeError(`snapshot polymorphic tombstones scopeId must be a declared ref(${terminalScope.name})`);
    scopeTarget = terminalScope ?? entityOf(scopeId.target);
    if (!isRegisteredEntity(scopeTarget, resolveEntity)) throw new TypeError(`snapshot tombstone scope '${scopeTarget.name}' must be registered`);
    // Terminal roots use their identity. Owned targets must name their owner
    // reference explicitly; a coincidentally same-named scalar is not authority.
    const sameNamedOwner = target.fields[rule.scopeId];
    const compatibleOwner = terminalScope && sameNamedOwner?.kind === 'value' && sameNamedOwner.type === 'ref'
      ? rule.scopeId
      : undefined;
    const explicitOwner = rule.targetScopeId ?? compatibleOwner;
    if (rule.targetScopeId !== undefined && !terminalScope) {
      throw new TypeError('snapshot tombstone targetScopeId is only valid with terminalScope');
    }
    if (explicitOwner !== undefined) {
      const owner = target.fields[explicitOwner];
      if (rule.targetScopeEntity !== target.name) {
        throw new TypeError(`snapshot tombstone target owner scope must belong to ${target.name}`);
      }
      if (owner?.kind !== 'value' || owner.type !== 'ref') {
        throw new TypeError(`snapshot tombstone target '${target.name}' owner scope '${explicitOwner}' must be a declared ref`);
      }
      const declaredOwnerScope = rule.targetScope === undefined ? null : entityOf(rule.targetScope);
      if (declaredOwnerScope && (!isRegisteredEntity(declaredOwnerScope, resolveEntity) || targetName(owner) !== declaredOwnerScope.name)) {
        throw new TypeError(`snapshot tombstone target '${target.name}' owner scope '${explicitOwner}' must reference registered ${declaredOwnerScope.name}`);
      }
    }
    const ownerFields = explicitOwner ? [explicitOwner] : terminalScope || scopeTarget === target ? ['id'] : Object.entries(target.fields)
      .filter(([, field]) => field?.kind === 'value' && field.type === 'ref' && targetName(field) === scopeTarget.name)
      .map(([name]) => name);
    if (ownerFields.length !== 1) throw new TypeError(`snapshot tombstone target '${target.name}' must have exactly one declared ref(${scopeTarget.name}) owner scope`);
    targetScopeId = ownerFields[0];
  }
  for (const field of [rule.kindField, rule.state]) {
    const descriptor = entity.fields[field];
    if (descriptor?.kind !== 'value' || descriptor.type !== 'text') throw new TypeError(`snapshot tombstones field '${field}' must be a declared text field`);
  }
  if (typeof rule.kindValue !== 'string' || rule.kindValue.length === 0) throw new TypeError('snapshot tombstones kindValue must be a non-empty literal');
  if (!Array.isArray(rule.hidden) || rule.hidden.length === 0 || rule.hidden.some((value) => typeof value !== 'string' || value.length === 0) || new Set(rule.hidden).size !== rule.hidden.length) {
    throw new TypeError('snapshot tombstones hidden must contain non-empty string literals');
  }
  return Object.freeze({ target, entity, entityId: rule.entityId, scopeId: rule.scopeId ?? null, scopeTarget, targetScopeId, terminalScope, kind: rule.kindField, state: rule.state, kindValue: rule.kindValue, hidden: Object.freeze([...rule.hidden]) });
}

function bindOutput(branch, resolveEntity) {
  return Object.freeze({
    entity: boundEntity(branch.entity, resolveEntity),
    entries: Object.freeze(branch.entries.map((entry) => {
      if (entry.kind === 'select' || entry.kind === 'user') return entry;
      return Object.freeze({
        ...entry,
        entity: boundEntity(entry.entity, resolveEntity),
        require: entry.require ? Object.freeze({ ...entry.require, entity: boundEntity(entry.require.entity, resolveEntity) }) : null,
        nested: entry.nested ? bindOutput(entry.nested, resolveEntity) : null,
      });
    })),
  });
}

function bindTombstone(rule, resolveEntity) {
  if (!rule) return null;
  return Object.freeze({
    ...rule,
    target: boundEntity(rule.target, resolveEntity),
    entity: boundEntity(rule.entity, resolveEntity),
    terminalScope: rule.terminalScope ? boundEntity(rule.terminalScope, resolveEntity) : null,
    scopeTarget: rule.scopeTarget ? boundEntity(rule.scopeTarget, resolveEntity) : null,
  });
}

export function compileSnapshots(declarations, resolveEntity, db = null) {
  if (declarations === undefined) return new Map();
  if (!Array.isArray(declarations)) throw new TypeError('snapshots must be an array');
  const internalEntities = new Set(declarations.flatMap((declaration) => [declaration?.tombstones?.entity?.name, declaration?.tombstones?.terminalScope?.name]).filter((name) => typeof name === 'string'));
  const compiled = new Map();
  for (const declaration of declarations) {
    if (declaration?.kind !== 'snapshot') throw new TypeError('snapshots accepts only snapshot(...) declarations');
    const declaredAnchor = entityOf(declaration.anchor);
    if (internalEntities.has(declaredAnchor.name)) throw new TypeError(`snapshot tombstone entity '${declaredAnchor.name}' is read-internal and cannot be an anchor`);
    if (!isRegisteredEntity(declaredAnchor, resolveEntity)) throw new TypeError(`snapshot anchor '${declaredAnchor.name}' must be registered`);
    if (compiled.has(declaredAnchor.name)) throw new TypeError(`snapshot anchor '${declaredAnchor.name}' is declared more than once`);
    // Authorization and hydrate need the application-bound entity (runtime.db),
    // not the unbound declaration the app author wrote. Resolve once at compile.
    const anchor = boundEntity(declaredAnchor, resolveEntity);
    const output = bindOutput(compileOutput(declaredAnchor, declaration.output), resolveEntity);
    const tombstones = bindTombstone(compileTombstones(declaration, resolveEntity), resolveEntity);
    const forbidTombstoneOutput = (branch) => branch.entries.forEach((entry) => {
      if (entry.entity && internalEntities.has(entry.entity.name)) throw new TypeError(`snapshot tombstone entity '${entry.entity.name}' is read-internal and cannot be output`);
      if (entry.nested) forbidTombstoneOutput(entry.nested);
    });
    forbidTombstoneOutput(output);
    // Every relation target must be registered, not merely structurally similar.
    const check = (branch) => branch.entries.forEach((entry) => {
      if (entry.kind === 'user') {
        const User = resolveEntity('User');
        if (!User) throw new TypeError('snapshot user requires registered User entity');
        physicalForeignKey(db, branch.entity, entry.fk, User);
        return;
      }
      if (entry.entity && !isRegisteredEntity(entry.entity, resolveEntity)) throw new TypeError(`snapshot entity '${entry.entity.name}' must be registered`);
      if (entry.entity) physicalForeignKey(db, entry.inverse ? entry.entity : branch.entity, entry.fk, entry.inverse ? branch.entity : entry.entity);
      if (entry.require) {
        if (!isRegisteredEntity(entry.require.entity, resolveEntity)) throw new TypeError(`snapshot related entity '${entry.require.entity.name}' must be registered`);
        physicalForeignKey(db, entry.entity, entry.require.childRef, entry.require.entity);
        physicalForeignKey(db, entry.require.entity, entry.require.fk, branch.entity);
      }
      if (entry.nested) check(entry.nested);
    });
    check(output);
    if (tombstones) physicalForeignKey(db, tombstones.entity, tombstones.scopeId ?? tombstones.entityId, tombstones.scopeTarget ?? tombstones.target, { retainTarget: Boolean(tombstones.terminalScope) });
    compiled.set(anchor.name, Object.freeze({ anchor, output, tombstone: tombstones }));
  }
  // A related-row requirement is an entity exposure invariant, not a property
  // of one convenient aggregate path. Once declared for an entity, every
  // projection path must carry the identical requirement and that entity cannot
  // be requested as a standalone anchor (where no trusted parent exists).
  const requiredEntities = new Map();
  const requirementKey = (entry) => entry.require
    ? `${entry.fk}\u0000${entry.require.entity.name}\u0000${entry.require.childRef}\u0000${entry.require.fk}`
    : null;
  const visitEntries = (branch, visit) => branch.entries.forEach((entry) => {
    if (entry.entity) visit(entry);
    if (entry.nested) visitEntries(entry.nested, visit);
  });
  for (const declaration of compiled.values()) visitEntries(declaration.output, (entry) => {
    if (!entry.require) return;
    const key = requirementKey(entry);
    const prior = requiredEntities.get(entry.entity.name);
    if (prior && prior !== key) throw new TypeError(`snapshot entity '${entry.entity.name}' declares conflicting required relations`);
    requiredEntities.set(entry.entity.name, key);
  });
  for (const [name, declaration] of compiled) {
    if (requiredEntities.has(name)) throw new TypeError(`snapshot entity '${name}' has a required relation and cannot be a standalone anchor`);
    visitEntries(declaration.output, (entry) => {
      const required = requiredEntities.get(entry.entity.name);
      if (required && requirementKey(entry) !== required) {
        throw new TypeError(`snapshot entity '${entry.entity.name}' must use its declared required relation on every exposure path`);
      }
    });
    const rejectRequiredUsers = (branch) => branch.entries.forEach((entry) => {
      if (entry.kind === 'user' && requiredEntities.has('User')) {
        throw new TypeError("snapshot entity 'User' must use its declared required relation on every exposure path");
      }
      if (entry.nested) rejectRequiredUsers(entry.nested);
    });
    rejectRequiredUsers(declaration.output);
  }
  Object.defineProperty(compiled, 'requiredEntities', {
    value: Object.freeze(new Set(requiredEntities.keys())), enumerable: false,
  });
  const tombstones = Object.freeze([...compiled.values()].map((declaration) => declaration.tombstone).filter(Boolean));
  for (const [name, declaration] of compiled) compiled.set(name, Object.freeze({ ...declaration, tombstones }));
  return compiled;
}

function detached(raw) {
  return Object.freeze({ ...raw });
}

function readRows(db, entity, principal, fk, value, inverse, order, tombstones) {
  const filter = entity.scopeFilter(principal);
  const rule = tombstones?.find((candidate) => entity === candidate.target);
  const scopeVisibility = rule?.scopeId ? ` AND tombstone.${identifier(rule.scopeId, 'snapshot tombstone scopeId')} = t0.${identifier(rule.targetScopeId, 'snapshot tombstone target scope')}` : '';
  const visibility = rule
    ? ` AND NOT EXISTS (SELECT 1 FROM ${identifier(rule.entity.name, 'snapshot tombstone entity')} AS tombstone WHERE tombstone.${identifier(rule.entityId, 'snapshot tombstone entityId')} = t0.id${scopeVisibility} AND tombstone.${identifier(rule.kind, 'snapshot tombstone kind')} = :snapshot_tombstone_kind AND tombstone.${identifier(rule.state, 'snapshot tombstone state')} IN (${rule.hidden.map((_, index) => `:snapshot_tombstone_hidden_${index}`).join(', ')}))`
    : '';
  const sql = inverse
    ? `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.${identifier(fk, 'snapshot foreign key')} = :snapshot_parent${visibility}`
    : `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.id = :snapshot_parent${visibility}`;
  const suffix = order ? ` ORDER BY t0.${identifier(order.field, 'snapshot order field')} ${order.direction.toUpperCase()}, t0.id ASC` : ' ORDER BY t0.id ASC';
  const params = { ...filter.params, snapshot_parent: value };
  if (visibility) {
    params.snapshot_tombstone_kind = rule.kindValue;
    rule.hidden.forEach((state, index) => { params[`snapshot_tombstone_hidden_${index}`] = state; });
  }
  return db.prepare(sql + suffix).all(params).map(detached);
}

function readUser(db, id, tombstones) {
  try {
    const columns = db.prepare('PRAGMA table_info(User)').all().map((column) => column.name);
    for (const required of ['id', 'name', 'displayName', 'image']) {
      if (!columns.includes(required)) throw new TypeError('malformed User table');
    }
    const deleted = columns.includes('deletedAt') ? ' AND deletedAt IS NULL' : '';
    const rule = tombstones?.find((candidate) => candidate.target.name === 'User');
    const scopeVisibility = rule?.scopeId ? ` AND tombstone.${identifier(rule.scopeId, 'snapshot tombstone scopeId')} = User.${identifier(rule.targetScopeId, 'snapshot tombstone target scope')}` : '';
    const visibility = rule
      ? ` AND NOT EXISTS (SELECT 1 FROM ${identifier(rule.entity.name, 'snapshot tombstone entity')} AS tombstone WHERE tombstone.${identifier(rule.entityId, 'snapshot tombstone entityId')} = User.id${scopeVisibility} AND tombstone.${identifier(rule.kind, 'snapshot tombstone kind')} = :snapshot_tombstone_kind AND tombstone.${identifier(rule.state, 'snapshot tombstone state')} IN (${rule.hidden.map((_, index) => `:snapshot_tombstone_hidden_${index}`).join(', ')}))`
      : '';
    const params = { snapshot_user: id };
    if (rule) {
      params.snapshot_tombstone_kind = rule.kindValue;
      rule.hidden.forEach((state, index) => { params[`snapshot_tombstone_hidden_${index}`] = state; });
    }
    const rows = db.prepare(`SELECT id, name, displayName, image FROM User WHERE id = :snapshot_user${deleted}${visibility}`).all(params);
    if (rows.length === 0) return null;
    if (typeof rows[0].id !== 'string' || rows[0].id.length === 0) throw new TypeError('malformed User id');
    return detached(rows[0]);
  } catch {
    // A malformed User table makes the entire recipient snapshot unsafe.
    throw new TypeError('snapshot User table must provide id, name, displayName, and image');
  }
}

// Capture only raw, scope-filtered candidates while SQLite is synchronous. No
// authorization may await inside this read boundary.
export function captureSnapshot({ db, principal, anchor, id, output, tombstones = null }) {
  function capture(entity, raw, branch) {
    const children = new Map();
    for (const entry of branch.entries) {
      if (entry.kind === 'select') continue;
      if (entry.kind === 'user') {
        const user = raw[entry.fk] == null ? null : readUser(db, raw[entry.fk], tombstones);
        children.set(entry, user ? [Object.freeze({ raw: user, children: new Map() })] : []);
        continue;
      }
      const rows = readRows(db, entry.entity, principal, entry.fk, entry.inverse ? raw.id : raw[entry.fk], entry.inverse, entry.order, tombstones);
      children.set(entry, rows.map((child) => {
        let required = null;
        if (entry.require) {
          required = false;
          const related = readRows(db, entry.require.entity, principal, 'id', child[entry.require.childRef], false, null, tombstones);
          // The related row must be co-owned by this exact branch parent.
          if (related.length === 1 && related[0][entry.require.fk] === raw.id) {
            required = Object.freeze({ entity: entry.require.entity, raw: related[0], children: new Map() });
          }
        }
        return Object.freeze({ raw: child, required, children: entry.nested ? capture(entry.entity, child, entry.nested).children : new Map() });
      }));
    }
    return Object.freeze({ raw, children });
  }
  const rows = readRows(db, anchor, principal, 'id', id, false, null, tombstones);
  return rows.length === 1 ? capture(anchor, rows[0], output) : null;
}

export async function authorizeSnapshot({ principal, anchor, candidate, mayVerb }) {
  const authorized = new WeakMap();
  const rowAuthorization = new Map();
  async function authorize(entity, node) {
    try {
      let entityRows = rowAuthorization.get(entity);
      if (!entityRows) rowAuthorization.set(entity, entityRows = new Map());
      let decision = entityRows.get(node.raw.id);
      if (!decision) {
        if ('hydrate' in entity && typeof entity.hydrate !== 'function') return false;
        // Capture freezes detached SQL rows so the authorization fence cannot
        // mutate the candidate graph. Entity hydrate still deserializes in place
        // (members handles, stored codecs), so hand it a mutable copy.
        const row = typeof entity.hydrate === 'function' ? entity.hydrate({ ...node.raw }, principal) : node.raw;
        decision = Object.freeze({ row, allowed: row != null && await mayRow(entity, 'subscribe', row, principal, mayVerb) });
        entityRows.set(node.raw.id, decision);
      }
      let requiredAllowed = node.required !== false;
      if (node.required && requiredAllowed) requiredAllowed = await authorize(node.required.entity, node.required);
      if (decision.allowed && requiredAllowed) authorized.set(node, decision.row);
      for (const [entry, children] of node.children) {
        if (entry.kind === 'user') continue;
        for (const child of children) await authorize(entry.entity, child);
      }
      return decision.allowed && requiredAllowed;
    } catch {
      return false;
    }
  }
  const anchorAllowed = await authorize(anchor, candidate);
  return Object.freeze({ anchorAllowed, authorized });
}

export function projectSnapshot({ anchor, candidate, output, authorized }) {
  function project(entity, node, branch) {
    const current = authorized.get(node);
    if (!current) return null;
    const result = { id: current.id };
    const selected = branch.entries.find((entry) => entry.kind === 'select');
    if (selected) Object.assign(result, Object.fromEntries(selected.fields.map((field) => [field, current[field]])));
    for (const entry of branch.entries) {
      if (entry.kind === 'select') continue;
      if (entry.kind === 'user') {
        const user = node.children.get(entry)?.[0]?.raw;
        result[entry.key] = user ? Object.freeze({
          id: user.id,
          name: typeof user.name === 'string' ? user.name : typeof user.displayName === 'string' ? user.displayName : null,
          image: typeof user.image === 'string' ? user.image : null,
        }) : null;
        continue;
      }
      const rows = [];
      for (const child of node.children.get(entry) ?? []) {
        const projected = project(entry.entity, child, entry.nested ?? { entries: entry.selected ? [{ kind: 'select', fields: entry.selected }] : [] });
        if (projected) rows.push(projected);
      }
      if (entry.kind === 'count') result[entry.key] = rows.length;
      else if (entry.kind === 'one') result[entry.key] = rows[0] ?? null;
      else if (entry.kind === 'keyed') result[entry.key] = Object.freeze(Object.fromEntries(rows.map((child) => [String(child.id), child])));
      else result[entry.key] = Object.freeze(rows);
    }
    return Object.freeze(result);
  }
  return project(anchor, candidate, output);
}
