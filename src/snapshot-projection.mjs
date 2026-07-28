import { mayRow } from './row-grant.mjs';

function entityOf(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.fields) throw new TypeError('snapshot relation requires a declared entity');
  return value;
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
    entries.push(Object.freeze({ key, kind: value.kind, entity: child, fk, inverse, selected, nested: nestedCompiled, order: order ?? null }));
  }
  ancestors.delete(entity);
  return Object.freeze({ entity, entries: Object.freeze(entries) });
}

function physicalForeignKey(db, from, field, target) {
  if (!db) return;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${identifier(from.name, 'snapshot entity')})`).all();
  const matching = foreignKeys.filter((row) => row.from === field && row.table === target.name && row.to === 'id');
  if (matching.length !== 1 || foreignKeys.filter((row) => row.from === field).length !== 1) throw new TypeError(`snapshot relation ${from.name}.${field} requires exactly one physical FOREIGN KEY to ${target.name}.id`);
}

export function compileSnapshots(declarations, resolveEntity, db = null) {
  if (declarations === undefined) return new Map();
  if (!Array.isArray(declarations)) throw new TypeError('snapshots must be an array');
  const compiled = new Map();
  for (const declaration of declarations) {
    if (declaration?.kind !== 'snapshot') throw new TypeError('snapshots accepts only snapshot(...) declarations');
    const anchor = entityOf(declaration.anchor);
    if (resolveEntity(anchor.name) !== anchor) throw new TypeError(`snapshot anchor '${anchor.name}' must be registered`);
    if (compiled.has(anchor.name)) throw new TypeError(`snapshot anchor '${anchor.name}' is declared more than once`);
    const output = compileOutput(anchor, declaration.output);
    // Every relation target must be registered, not merely structurally similar.
    const check = (branch) => branch.entries.forEach((entry) => {
      if (entry.kind === 'user') {
        const User = resolveEntity('User');
        if (!User) throw new TypeError('snapshot user requires registered User entity');
        physicalForeignKey(db, branch.entity, entry.fk, User);
        return;
      }
      if (entry.entity && resolveEntity(entry.entity.name) !== entry.entity) throw new TypeError(`snapshot entity '${entry.entity.name}' must be registered`);
      if (entry.entity) physicalForeignKey(db, entry.inverse ? entry.entity : branch.entity, entry.fk, entry.inverse ? branch.entity : entry.entity);
      if (entry.nested) check(entry.nested);
    });
    check(output);
    compiled.set(anchor.name, Object.freeze({ anchor, output }));
  }
  return compiled;
}

function detached(raw) {
  return Object.freeze({ ...raw });
}

function readRows(db, entity, principal, fk, value, inverse, order) {
  const filter = entity.scopeFilter(principal);
  const sql = inverse
    ? `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.${identifier(fk, 'snapshot foreign key')} = :snapshot_parent`
    : `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.id = :snapshot_parent`;
  const suffix = order ? ` ORDER BY t0.${identifier(order.field, 'snapshot order field')} ${order.direction.toUpperCase()}, t0.id ASC` : ' ORDER BY t0.id ASC';
  return db.prepare(sql + suffix).all({ ...filter.params, snapshot_parent: value }).map(detached);
}

function readUser(db, id) {
  try {
    const columns = db.prepare('PRAGMA table_info(User)').all().map((column) => column.name);
    for (const required of ['id', 'name', 'displayName', 'image']) {
      if (!columns.includes(required)) throw new TypeError('malformed User table');
    }
    const deleted = columns.includes('deletedAt') ? ' AND deletedAt IS NULL' : '';
    const rows = db.prepare(`SELECT id, name, displayName, image FROM User WHERE id = :snapshot_user${deleted}`).all({ snapshot_user: id });
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
export function captureSnapshot({ db, principal, anchor, id, output }) {
  function capture(entity, raw, branch) {
    const children = new Map();
    for (const entry of branch.entries) {
      if (entry.kind === 'select') continue;
      if (entry.kind === 'user') {
        const user = raw[entry.fk] == null ? null : readUser(db, raw[entry.fk]);
        children.set(entry, user ? [Object.freeze({ raw: user, children: new Map() })] : []);
        continue;
      }
      const rows = readRows(db, entry.entity, principal, entry.fk, entry.inverse ? raw.id : raw[entry.fk], entry.inverse, entry.order);
      children.set(entry, rows.map((child) => Object.freeze({ raw: child, children: entry.nested ? capture(entry.entity, child, entry.nested).children : new Map() })));
    }
    return Object.freeze({ raw, children });
  }
  const rows = readRows(db, anchor, principal, 'id', id, false, null);
  return rows.length === 1 ? capture(anchor, rows[0], output) : null;
}

export async function authorizeSnapshot({ principal, anchor, candidate, mayVerb }) {
  const authorized = new WeakMap();
  async function authorize(entity, node) {
    try {
      if ('hydrate' in entity && typeof entity.hydrate !== 'function') return false;
      const row = typeof entity.hydrate === 'function' ? entity.hydrate(node.raw, principal) : node.raw;
      const allowed = row != null && await mayRow(entity, 'subscribe', row, principal, mayVerb);
      if (allowed) authorized.set(node, row);
      for (const [entry, children] of node.children) {
        if (entry.kind === 'user') continue;
        for (const child of children) await authorize(entry.entity, child);
      }
      return allowed;
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
