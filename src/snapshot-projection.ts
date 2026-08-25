import type { DbHandle } from './driver.ts';
import { mayRow } from './row-grant.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';

// A field descriptor as snapshot projection reads it: kind, value type, and the
// ref target (entity name or declared entity object). Kept loose — the
// descriptor is built by field.mjs and consumed by many layers.
interface SnapshotFieldDescriptor {
  kind?: string;
  type?: string;
  target?: { name?: string } | string | null;
  access?: unknown;
  [key: string]: unknown;
}

// The snapshot entity shape: name, declared fields, and the bound facets used
// by the runtime half (scope visibility filter and row hydration). The declared
// anchor may lack the bound facets until bindOutput/boundEntity resolve them.
interface SnapshotEntity {
  name: string;
  fields: Record<string, SnapshotFieldDescriptor>;
  scopeFilter?(principal: unknown): { sql: string; params: Record<string, unknown> };
  hydrate?(row: Record<string, unknown>, principal?: unknown): Record<string, unknown> | null | undefined;
}

type ResolveEntity = (name: string, declaration?: unknown) => unknown;

function entityOf(value: unknown): SnapshotEntity {
  if (!value || typeof value !== 'object' || typeof (value as { name?: unknown }).name !== 'string' || !(value as { fields?: unknown }).fields) throw new TypeError('snapshot relation requires a declared entity');
  return value as SnapshotEntity;
}

function isRegisteredEntity(entity: SnapshotEntity, resolveEntity: ResolveEntity): boolean {
  const registered = resolveEntity(entity.name, entity);
  return registered === entity || (registered as { declaration?: unknown } | null | undefined)?.declaration === entity;
}

/** Prefer the application-bound entity (runtime db + hydrate) over the unbound declaration. */
function boundEntity(entity: SnapshotEntity, resolveEntity: ResolveEntity): SnapshotEntity {
  const registered = resolveEntity(entity.name, entity);
  if (registered === entity || (registered as { declaration?: unknown } | null | undefined)?.declaration === entity) return registered as SnapshotEntity;
  throw new TypeError(`snapshot entity '${entity.name}' must be registered`);
}

function identifier(name: string, label: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`${label} must be a SQL identifier`);
  return name;
}

function scalar(entity: SnapshotEntity, field: unknown): void {
  if (field === 'id') return;
  const descriptor = entity.fields[field as string];
  if (!descriptor || descriptor.kind !== 'value' || !['text', 'boolean', 'date', 'number', 'ref', 'json'].includes(descriptor.type ?? '')) {
    throw new TypeError(`snapshot field '${entity.name}.${String(field)}' is not a supported scalar codec`);
  }
}

function targetName(descriptor: SnapshotFieldDescriptor | null | undefined): string | undefined {
  const target = descriptor?.target;
  return typeof target === 'string' ? target : target?.name;
}

function relation(from: SnapshotEntity, to: SnapshotEntity, inverse: boolean, via: unknown): string {
  const owner = inverse ? to : from;
  const target = inverse ? from : to;
  const descriptor = owner.fields[via as string];
  if (descriptor?.kind !== 'value' || descriptor.type !== 'ref' || targetName(descriptor) !== target.name) {
    throw new TypeError(`snapshot relation ${from.name} -> ${to.name} via '${String(via)}' must be a declared ref(${target.name})`);
  }
  return via as string;
}

// ---- compiled output branches ----

interface RequireRule {
  entity: SnapshotEntity;
  childRef: string;
  fk: string;
}

interface RelationSnapshotEntry {
  key: string;
  kind: 'one' | 'many' | 'keyed' | 'count';
  entity: SnapshotEntity;
  fk: string;
  inverse: boolean;
  selected: readonly string[] | null;
  nested: SnapshotBranch | null;
  order: { field: string; direction: string } | null;
  require: RequireRule | null;
}

type SnapshotEntry =
  | RelationSnapshotEntry
  | { key: string; kind: 'select'; fields: readonly string[]; entity?: undefined; nested?: undefined; fk?: undefined; inverse?: undefined; selected?: undefined; order?: undefined; require?: undefined }
  | { key: string; kind: 'user'; fk: string; entity?: undefined; nested?: undefined; require?: undefined };

interface SnapshotBranch {
  entity: SnapshotEntity;
  entries: readonly SnapshotEntry[];
}

interface SnapshotOutputLike {
  kind: 'object';
  shape: Record<string, unknown>;
}

function outputFor(node: unknown): SnapshotOutputLike | null {
  const candidate = node as { kind?: unknown } | null | undefined;
  return candidate?.kind === 'object' ? (node as SnapshotOutputLike) : null;
}

interface DeclaredSnapshotNode {
  kind?: string;
  fields?: readonly unknown[];
  via?: unknown;
  entity?: unknown;
  require?: unknown;
  orderBy?: unknown;
  select?: unknown;
  output?: unknown;
  include?: unknown;
  [key: string]: unknown;
}

function compileOutput(entity: SnapshotEntity, output: unknown, ancestors = new Set<SnapshotEntity>()): SnapshotBranch {
  const object = outputFor(output);
  if (!object) throw new TypeError(`snapshot output for '${entity.name}' must be object(...)`);
  if (ancestors.has(entity)) throw new TypeError(`snapshot output is cyclic at '${entity.name}'`);
  ancestors.add(entity);
  const entries: SnapshotEntry[] = [];
  let hasSelect = false;
  for (const [key, value] of Object.entries(object.shape)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`snapshot output key '${key}' is invalid`);
    const node = value as DeclaredSnapshotNode | null | undefined;
    if (node?.kind === 'select') {
      if (hasSelect) throw new TypeError(`snapshot output for '${entity.name}' declares select(...) more than once`);
      hasSelect = true;
      for (const field of node.fields as readonly unknown[]) scalar(entity, field);
      entries.push(Object.freeze({ key, kind: 'select', fields: node.fields as readonly string[] }));
      continue;
    }
    if (node?.kind === 'user') {
      const descriptor = entity.fields[node.via as string];
      if (descriptor?.kind !== 'value' || descriptor.type !== 'ref' || targetName(descriptor) !== 'User') throw new TypeError(`snapshot user '${key}' via '${node?.via}' must be a declared ref(User)`);
      entries.push(Object.freeze({ key, kind: 'user', fk: node.via as string }));
      continue;
    }
    if (!node || !['one', 'many', 'keyed', 'count'].includes(node?.kind ?? '')) throw new TypeError(`snapshot output '${key}' must use select, one, many, keyed, count, or user`);
    if (node.kind === 'one' && node.require !== undefined) throw new TypeError(`snapshot relation '${key}' cannot use require on one`);
    const child = entityOf(node.entity);
    const inverse = node.kind !== 'one';
    const fk = relation(entity, child, inverse, node.via);
    const selectNode = (node.select ?? node.output) as { kind?: string; fields?: readonly string[] } | null | undefined;
    const nested = (node.include ?? node.output) as SnapshotOutputLike | null | undefined;
    const selected = selectNode?.kind === 'select' ? (selectNode.fields as readonly string[]) : null;
    if (selected) for (const field of selected) scalar(child, field);
    const nestedCompiled = nested?.kind === 'object' ? compileOutput(child, nested, ancestors) : null;
    if (!selected && !nestedCompiled && node.kind !== 'count') throw new TypeError(`snapshot relation '${key}' requires select(...) or include(...)`);
    const order = node.orderBy as { kind?: string; field?: unknown; direction?: unknown } | null | undefined;
    if (order !== undefined) {
      if (order?.kind !== 'orderBy') throw new TypeError(`snapshot relation '${key}' orderBy must use orderBy(...)`);
      scalar(child, order.field);
    }
    const required = node.require;
    let require: RequireRule | null = null;
    if (required !== undefined) {
      const declared = required as { kind?: string; childRef?: unknown; via?: unknown; childEntity?: unknown; parentEntity?: unknown } | null | undefined;
      if (!declared || declared.kind !== 'related' || Object.keys(declared).length !== 5
        || typeof declared.childRef !== 'string' || typeof declared.via !== 'string') {
        throw new TypeError(`snapshot relation '${key}' require must use related(childRef, { via })`);
      }
      const childRef = child.fields[declared.childRef as string];
      if (declared.childEntity !== child.name) {
        throw new TypeError(`snapshot relation '${key}' related childRef must belong to ${child.name}`);
      }
      if (childRef?.kind !== 'value' || childRef.type !== 'ref') {
        throw new TypeError(`snapshot relation '${key}' related childRef must belong to ${child.name} and be a declared ref`);
      }
      const relatedTarget = typeof childRef.target === 'string' ? null : (childRef.target as { name?: string; fields?: unknown } | null | undefined);
      if (!relatedTarget || typeof relatedTarget.name !== 'string' || !relatedTarget.fields) {
        throw new TypeError(`snapshot relation '${key}' related childRef must target a declared entity`);
      }
      const related = relatedTarget as SnapshotEntity;
      const parentRef = related.fields[declared.via as string];
      if (declared.parentEntity !== related.name) {
        throw new TypeError(`snapshot relation '${key}' related via must belong to ${related.name}`);
      }
      if (parentRef?.kind !== 'value' || parentRef.type !== 'ref' || targetName(parentRef) !== entity.name) {
        throw new TypeError(`snapshot relation '${key}' related via must belong to ${related.name} and be a declared ref(${entity.name})`);
      }
      require = Object.freeze({ entity: related, childRef: declared.childRef, fk: declared.via });
    }
    entries.push(Object.freeze({
      key,
      kind: node.kind as 'one' | 'many' | 'keyed' | 'count',
      entity: child,
      fk,
      inverse,
      selected,
      nested: nestedCompiled,
      order: (order ?? null) as { field: string; direction: string } | null,
      require,
    }));
  }
  ancestors.delete(entity);
  return Object.freeze({ entity, entries: Object.freeze(entries) });
}

// ---- tombstones ----

interface DeclaredTombstonesRule {
  kind?: string;
  target?: unknown;
  entity?: unknown;
  entityId?: unknown;
  scopeId?: unknown;
  terminalScope?: unknown;
  targetScope?: unknown;
  targetScopeId?: unknown;
  targetScopeEntity?: unknown;
  kindField?: unknown;
  state?: unknown;
  kindValue?: unknown;
  hidden?: unknown;
  [key: string]: unknown;
}

interface DeclaredSnapshotDeclaration {
  kind?: string;
  anchor?: unknown;
  output?: unknown;
  tombstones?: unknown;
  [key: string]: unknown;
}

interface TombstoneRule {
  target: SnapshotEntity;
  entity: SnapshotEntity;
  entityId: string;
  scopeId: string | null;
  scopeTarget: SnapshotEntity | null;
  targetScopeId: string | null;
  terminalScope: SnapshotEntity | null;
  kind: string;
  state: string;
  kindValue: string;
  hidden: readonly string[];
}

function compileTombstones(declaration: DeclaredSnapshotDeclaration, resolveEntity: ResolveEntity): TombstoneRule | null {
  const rule = declaration.tombstones;
  if (rule === undefined) return null;
  const declared = rule as DeclaredTombstonesRule | null | undefined;
  if (declared?.kind !== 'tombstones') throw new TypeError('snapshot tombstones must use tombstones(...)');
  const target = entityOf(declared.target);
  if (target !== declaration.anchor) throw new TypeError(`snapshot tombstones target must be anchor '${(declaration.anchor as { name?: unknown } | null)?.name}'`);
  if (!isRegisteredEntity(target, resolveEntity)) throw new TypeError(`snapshot tombstones target '${target.name}' must be registered`);
  const entity = entityOf(declared.entity);
  if (!isRegisteredEntity(entity, resolveEntity)) throw new TypeError(`snapshot tombstone entity '${entity.name}' must be registered`);
  const entityId = entity.fields[declared.entityId as string];
  const terminalScope = declared.terminalScope === undefined ? null : entityOf(declared.terminalScope);
  if (declared.targetScope !== undefined && declared.targetScopeId === undefined) {
    throw new TypeError('snapshot tombstone targetScope requires targetScopeId');
  }
  if (declared.targetScopeId !== undefined && declared.targetScope === undefined) {
    throw new TypeError('snapshot tombstone targetScopeId requires targetScope');
  }
  let scopeTarget: SnapshotEntity | null = null;
  let targetScopeId: string | null = null;
  if (terminalScope) {
    if (!isRegisteredEntity(terminalScope, resolveEntity)) throw new TypeError(`snapshot terminal tombstone scope '${terminalScope.name}' must be registered`);
    if (Object.keys(terminalScope.fields).length !== 0) throw new TypeError('snapshot terminal tombstone scope must be an identity-only entity');
    if (declared.scopeId === undefined) throw new TypeError('snapshot terminal tombstone scope requires scopeId');
  }
  if (declared.scopeId === undefined) {
    if (entityId?.kind !== 'value' || entityId.type !== 'ref' || targetName(entityId) !== target.name) {
      throw new TypeError(`snapshot tombstones entityId must be a declared ref(${target.name})`);
    }
  } else {
    if (entityId?.kind !== 'value' || entityId.type !== 'text') throw new TypeError('snapshot polymorphic tombstones entityId must be a declared text field');
    const scopeId = entity.fields[declared.scopeId as string];
    if (scopeId?.kind !== 'value' || scopeId.type !== 'ref') throw new TypeError(`snapshot polymorphic tombstones scopeId must be a declared ref(${terminalScope?.name ?? target.name})`);
    if (terminalScope && targetName(scopeId) !== terminalScope.name) throw new TypeError(`snapshot polymorphic tombstones scopeId must be a declared ref(${terminalScope.name})`);
    scopeTarget = terminalScope ?? entityOf(scopeId.target);
    if (!isRegisteredEntity(scopeTarget, resolveEntity)) throw new TypeError(`snapshot tombstone scope '${scopeTarget.name}' must be registered`);
    // Terminal roots use their identity. Owned targets must name their owner
    // reference explicitly; a coincidentally same-named scalar is not authority.
    const sameNamedOwner = target.fields[declared.scopeId as string];
    const compatibleOwner = terminalScope && sameNamedOwner?.kind === 'value' && sameNamedOwner.type === 'ref'
      ? declared.scopeId
      : undefined;
    const explicitOwner = declared.targetScopeId ?? compatibleOwner;
    if (declared.targetScopeId !== undefined && !terminalScope) {
      throw new TypeError('snapshot tombstone targetScopeId is only valid with terminalScope');
    }
    if (explicitOwner !== undefined) {
      const owner = target.fields[explicitOwner as string];
      if (declared.targetScopeEntity !== target.name) {
        throw new TypeError(`snapshot tombstone target owner scope must belong to ${target.name}`);
      }
      if (owner?.kind !== 'value' || owner.type !== 'ref') {
        throw new TypeError(`snapshot tombstone target '${target.name}' owner scope '${explicitOwner}' must be a declared ref`);
      }
      const declaredOwnerScope = declared.targetScope === undefined ? null : entityOf(declared.targetScope);
      if (declaredOwnerScope && (!isRegisteredEntity(declaredOwnerScope, resolveEntity) || targetName(owner) !== declaredOwnerScope.name)) {
        throw new TypeError(`snapshot tombstone target '${target.name}' owner scope '${explicitOwner}' must reference registered ${declaredOwnerScope.name}`);
      }
    }
    const ownerFields = explicitOwner ? [explicitOwner as string] : terminalScope || scopeTarget === target ? ['id'] : Object.entries(target.fields)
      .filter(([, field]) => field?.kind === 'value' && field.type === 'ref' && targetName(field) === scopeTarget!.name)
      .map(([name]) => name);
    if (ownerFields.length !== 1) throw new TypeError(`snapshot tombstone target '${target.name}' must have exactly one declared ref(${scopeTarget!.name}) owner scope`);
    targetScopeId = ownerFields[0];
  }
  for (const field of [declared.kindField, declared.state]) {
    const descriptor = entity.fields[field as string];
    if (descriptor?.kind !== 'value' || descriptor.type !== 'text') throw new TypeError(`snapshot tombstones field '${field}' must be a declared text field`);
  }
  if (typeof declared.kindValue !== 'string' || declared.kindValue.length === 0) throw new TypeError('snapshot tombstones kindValue must be a non-empty literal');
  if (!Array.isArray(declared.hidden) || declared.hidden.length === 0 || declared.hidden.some((value) => typeof value !== 'string' || value.length === 0) || new Set(declared.hidden).size !== declared.hidden.length) {
    throw new TypeError('snapshot tombstones hidden must contain non-empty string literals');
  }
  return Object.freeze({ target, entity, entityId: declared.entityId as string, scopeId: declared.scopeId as string | null, scopeTarget, targetScopeId, terminalScope, kind: declared.kindField as string, state: declared.state as string, kindValue: declared.kindValue, hidden: Object.freeze([...(declared.hidden as string[])]) });
}

function bindOutput(branch: SnapshotBranch, resolveEntity: ResolveEntity): SnapshotBranch {
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

function bindTombstone(rule: TombstoneRule | null, resolveEntity: ResolveEntity): TombstoneRule | null {
  if (!rule) return null;
  return Object.freeze({
    ...rule,
    target: boundEntity(rule.target, resolveEntity),
    entity: boundEntity(rule.entity, resolveEntity),
    terminalScope: rule.terminalScope ? boundEntity(rule.terminalScope, resolveEntity) : null,
    scopeTarget: rule.scopeTarget ? boundEntity(rule.scopeTarget, resolveEntity) : null,
  });
}

function physicalForeignKey(db: DbHandle | null, from: SnapshotEntity, field: string, target: SnapshotEntity, { retainTarget = false }: { retainTarget?: boolean } = {}): void {
  if (!db) return;
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${identifier(from.name, 'snapshot entity')})`).all();
  const matching = foreignKeys.filter((row) => row.from === field && row.table === target.name && row.to === 'id');
  if (matching.length !== 1 || foreignKeys.filter((row) => row.from === field).length !== 1) throw new TypeError(`snapshot relation ${from.name}.${field} requires exactly one physical FOREIGN KEY to ${target.name}.id`);
  if (retainTarget && !['RESTRICT', 'NO ACTION'].includes(matching[0].on_delete as string)) throw new TypeError(`snapshot terminal tombstone scope ${from.name}.${field} FOREIGN KEY must use ON DELETE RESTRICT or NO ACTION`);
}

export interface SnapshotDeclaration {
  anchor: SnapshotEntity;
  output: SnapshotBranch;
  tombstone: TombstoneRule | null;
  tombstones: readonly TombstoneRule[];
}

export function compileSnapshots(declarations: unknown, resolveEntity: ResolveEntity, db: DbHandle | null = null): Map<string, SnapshotDeclaration> {
  if (declarations === undefined) return new Map();
  if (!Array.isArray(declarations)) throw new TypeError('snapshots must be an array');
  const internalEntities = new Set<string>(
    declarations.flatMap((declaration) => {
      const rule = (declaration as DeclaredSnapshotDeclaration | null | undefined)?.tombstones as { entity?: { name?: string }; terminalScope?: { name?: string } } | null | undefined;
      return [rule?.entity?.name, rule?.terminalScope?.name].filter((name): name is string => typeof name === 'string');
    }),
  );
  const compiled = new Map<string, SnapshotDeclaration>();
  for (const declaration of declarations) {
    const declared = declaration as DeclaredSnapshotDeclaration | null | undefined;
    if (declared?.kind !== 'snapshot') throw new TypeError('snapshots accepts only snapshot(...) declarations');
    const declaredAnchor = entityOf(declared.anchor);
    if (internalEntities.has(declaredAnchor.name)) throw new TypeError(`snapshot tombstone entity '${declaredAnchor.name}' is read-internal and cannot be an anchor`);
    if (!isRegisteredEntity(declaredAnchor, resolveEntity)) throw new TypeError(`snapshot anchor '${declaredAnchor.name}' must be registered`);
    if (compiled.has(declaredAnchor.name)) throw new TypeError(`snapshot anchor '${declaredAnchor.name}' is declared more than once`);
    // Authorization and hydrate need the application-bound entity (runtime.db),
    // not the unbound declaration the app author wrote. Resolve once at compile.
    const anchor = boundEntity(declaredAnchor, resolveEntity);
    const output = bindOutput(compileOutput(declaredAnchor, declared.output), resolveEntity);
    const tombstones = bindTombstone(compileTombstones(declared, resolveEntity), resolveEntity);
    const forbidTombstoneOutput = (branch: SnapshotBranch): void => branch.entries.forEach((entry) => {
      if (entry.entity && internalEntities.has(entry.entity.name)) throw new TypeError(`snapshot tombstone entity '${entry.entity.name}' is read-internal and cannot be output`);
      if (entry.nested) forbidTombstoneOutput(entry.nested);
    });
    forbidTombstoneOutput(output);
    // Every relation target must be registered, not merely structurally similar.
    const check = (branch: SnapshotBranch): void => branch.entries.forEach((entry) => {
      if (entry.kind === 'user') {
        const User = resolveEntity('User');
        if (!User) throw new TypeError('snapshot user requires registered User entity');
        physicalForeignKey(db, branch.entity, entry.fk, User as SnapshotEntity);
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
    compiled.set(declaredAnchor.name, Object.freeze({ anchor, output, tombstone: tombstones }) as unknown as SnapshotDeclaration);
  }
  // A related-row requirement is an entity exposure invariant, not a property
  // of one convenient aggregate path. Once declared for an entity, every
  // projection path must carry the identical requirement and that entity cannot
  // be requested as a standalone anchor (where no trusted parent exists).
  const requiredEntities = new Map<string, string>();
  const requirementKey = (entry: RelationSnapshotEntry): string | null => entry.require
    ? `${entry.fk}\u0000${entry.require.entity.name}\u0000${entry.require.childRef}\u0000${entry.require.fk}`
    : null;
  const visitEntries = (branch: SnapshotBranch, visit: (entry: RelationSnapshotEntry) => void): void => branch.entries.forEach((entry) => {
    if (entry.kind === 'select' || entry.kind === 'user') return;
    visit(entry);
    if (entry.nested) visitEntries(entry.nested, visit);
  });
  for (const declaration of compiled.values()) visitEntries(declaration.output, (entry) => {
    if (!entry.require) return;
    const key = requirementKey(entry);
    const prior = requiredEntities.get(entry.entity.name);
    if (prior && prior !== key) throw new TypeError(`snapshot entity '${entry.entity.name}' declares conflicting required relations`);
    requiredEntities.set(entry.entity.name, key as string);
  });
  for (const [name, declaration] of compiled) {
    if (requiredEntities.has(name)) throw new TypeError(`snapshot entity '${name}' has a required relation and cannot be a standalone anchor`);
    visitEntries(declaration.output, (entry) => {
      const required = requiredEntities.get(entry.entity.name);
      if (required && requirementKey(entry) !== required) {
        throw new TypeError(`snapshot entity '${entry.entity.name}' must use its declared required relation on every exposure path`);
      }
    });
    const rejectRequiredUsers = (branch: SnapshotBranch): void => branch.entries.forEach((entry) => {
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
  const tombstones = Object.freeze([...compiled.values()].map((declaration) => declaration.tombstone).filter(Boolean)) as readonly TombstoneRule[];
  for (const [name, declaration] of compiled) compiled.set(name, Object.freeze({ ...declaration, tombstones }));
  return compiled;
}

function detached(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.freeze({ ...raw });
}

interface SnapshotOrder {
  field: string;
  direction: string;
}

// #157: exported as the targeted-capture read primitives. captureAffected
// (composite-patch-projector) issues the SAME scope-filtered, tombstone-aware,
// ordered reads per affected fragment instead of walking every collection.
export function readRows(db: DbHandle, entity: SnapshotEntity, principal: unknown, fk: string, value: unknown, inverse: boolean, order: SnapshotOrder | null, tombstones: readonly TombstoneRule[] | null | undefined): Record<string, unknown>[] {
  const filter = entity.scopeFilter!(principal);
  const rule = tombstones?.find((candidate) => entity === candidate.target);
  const scopeVisibility = rule?.scopeId ? ` AND tombstone.${identifier(rule.scopeId, 'snapshot tombstone scopeId')} = t0.${identifier(rule.targetScopeId as string, 'snapshot tombstone target scope')}` : '';
  const visibility = rule
    ? ` AND NOT EXISTS (SELECT 1 FROM ${identifier(rule.entity.name, 'snapshot tombstone entity')} AS tombstone WHERE tombstone.${identifier(rule.entityId, 'snapshot tombstone entityId')} = t0.id${scopeVisibility} AND tombstone.${identifier(rule.kind, 'snapshot tombstone kind')} = :snapshot_tombstone_kind AND tombstone.${identifier(rule.state, 'snapshot tombstone state')} IN (${rule.hidden.map((_, index) => `:snapshot_tombstone_hidden_${index}`).join(', ')}))`
    : '';
  const sql = inverse
    ? `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.${identifier(fk, 'snapshot foreign key')} = :snapshot_parent${visibility}`
    : `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.id = :snapshot_parent${visibility}`;
  const suffix = order ? ` ORDER BY t0.${identifier(order.field, 'snapshot order field')} ${order.direction.toUpperCase()}, t0.id ASC` : ' ORDER BY t0.id ASC';
  const params: Record<string, unknown> = { ...filter.params, snapshot_parent: value };
  if (visibility && rule) {
    params.snapshot_tombstone_kind = rule.kindValue;
    rule.hidden.forEach((state, index) => { params[`snapshot_tombstone_hidden_${index}`] = state; });
  }
  return db.prepare(sql + suffix).all(params).map(detached);
}

/**
 * #157 targeted branch capture: the same scope-filtered, tombstone-aware,
 * deterministically ordered read as readRows, restricted to explicit row ids —
 * the smallest possible affected-member set. Never reads rows outside the ids.
 */
export function readRowsByIds(db: DbHandle, entity: SnapshotEntity, principal: unknown, ids: readonly string[], order: SnapshotOrder | null, tombstones: readonly TombstoneRule[] | null | undefined): Record<string, unknown>[] {
  if (ids.length === 0) return [];
  const filter = entity.scopeFilter!(principal);
  const rule = tombstones?.find((candidate) => entity === candidate.target);
  const scopeVisibility = rule?.scopeId ? ` AND tombstone.${identifier(rule.scopeId, 'snapshot tombstone scopeId')} = t0.${identifier(rule.targetScopeId as string, 'snapshot tombstone target scope')}` : '';
  const visibility = rule
    ? ` AND NOT EXISTS (SELECT 1 FROM ${identifier(rule.entity.name, 'snapshot tombstone entity')} AS tombstone WHERE tombstone.${identifier(rule.entityId, 'snapshot tombstone entityId')} = t0.id${scopeVisibility} AND tombstone.${identifier(rule.kind, 'snapshot tombstone kind')} = :snapshot_tombstone_kind AND tombstone.${identifier(rule.state, 'snapshot tombstone state')} IN (${rule.hidden.map((_, index) => `:snapshot_tombstone_hidden_${index}`).join(', ')}))`
    : '';
  const placeholders = ids.map((_, index) => `:snapshot_target_${index}`).join(', ');
  const sql = `SELECT * FROM ${identifier(entity.name, 'snapshot entity')} AS t0 WHERE (${filter.sql}) AND t0.id IN (${placeholders})${visibility}`;
  const suffix = order ? ` ORDER BY t0.${identifier(order.field, 'snapshot order field')} ${order.direction.toUpperCase()}, t0.id ASC` : ' ORDER BY t0.id ASC';
  const params: Record<string, unknown> = { ...filter.params };
  ids.forEach((id, index) => { params[`snapshot_target_${index}`] = id; });
  if (visibility && rule) {
    params.snapshot_tombstone_kind = rule.kindValue;
    rule.hidden.forEach((state, index) => { params[`snapshot_tombstone_hidden_${index}`] = state; });
  }
  return db.prepare(sql + suffix).all(params).map(detached);
}

export function readUser(db: DbHandle, id: unknown, tombstones: readonly TombstoneRule[] | null | undefined): Record<string, unknown> | null {
  try {
    const columns = db.prepare('PRAGMA table_info(User)').all().map((column) => column.name);
    for (const required of ['id', 'name', 'displayName', 'image']) {
      if (!columns.includes(required)) throw new TypeError('malformed User table');
    }
    const deleted = columns.includes('deletedAt') ? ' AND deletedAt IS NULL' : '';
    const rule = tombstones?.find((candidate) => candidate.target.name === 'User');
    const scopeVisibility = rule?.scopeId ? ` AND tombstone.${identifier(rule.scopeId, 'snapshot tombstone scopeId')} = User.${identifier(rule.targetScopeId as string, 'snapshot tombstone target scope')}` : '';
    const visibility = rule
      ? ` AND NOT EXISTS (SELECT 1 FROM ${identifier(rule.entity.name, 'snapshot tombstone entity')} AS tombstone WHERE tombstone.${identifier(rule.entityId, 'snapshot tombstone entityId')} = User.id${scopeVisibility} AND tombstone.${identifier(rule.kind, 'snapshot tombstone kind')} = :snapshot_tombstone_kind AND tombstone.${identifier(rule.state, 'snapshot tombstone state')} IN (${rule.hidden.map((_, index) => `:snapshot_tombstone_hidden_${index}`).join(', ')}))`
      : '';
    const params: Record<string, unknown> = { snapshot_user: id };
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
interface SnapshotNode {
  raw: Record<string, unknown>;
  required?: RequireNode | false | null;
  children: Map<SnapshotEntry, SnapshotNode[]>;
  /**
   * #157 targeted branch capture: true when the recipient's visibility ledger
   * PROVES this exact fragment was delivered before the current journal slice,
   * and nothing in the slice could flip its admission (grant/membership
   * changes force declaration-wide invalidation upstream, so a non-invalidating
   * slice cannot move the grant graph). authorizeSnapshot then skips the
   * per-row admit call but STILL hydrates — projected values must remain
   * byte-identical to a fresh snapshot. Absent on every full-snapshot path.
   */
  ledgerAdmitted?: boolean;
}

interface RequireNode {
  entity: SnapshotEntity;
  raw: Record<string, unknown>;
  children: Map<SnapshotEntry, SnapshotNode[]>;
  /** Same ledger-proven-admission shortcut as SnapshotNode (#157). */
  ledgerAdmitted?: boolean;
}

export function captureSnapshot({ db, principal, anchor, id, output, tombstones = null }: {
  db: DbHandle;
  principal: unknown;
  anchor: SnapshotEntity;
  id: string;
  output: SnapshotBranch;
  tombstones?: readonly TombstoneRule[] | null;
}): SnapshotNode | null {
  function capture(_entity: SnapshotEntity, raw: Record<string, unknown>, branch: SnapshotBranch): SnapshotNode {
    const children = new Map<SnapshotEntry, SnapshotNode[]>();
    for (const entry of branch.entries) {
      if (entry.kind === 'select') continue;
      if (entry.kind === 'user') {
        const user = raw[entry.fk] == null ? null : readUser(db, raw[entry.fk], tombstones);
        children.set(entry, user ? [Object.freeze({ raw: user, children: new Map<SnapshotEntry, SnapshotNode[]>() })] : []);
        continue;
      }
      const rows = readRows(db, entry.entity, principal, entry.fk, entry.inverse ? raw.id : raw[entry.fk], entry.inverse, entry.order, tombstones);
      children.set(entry, rows.map((child) => {
        let required: RequireNode | false | null = null;
        if (entry.require) {
          required = false;
          const related = readRows(db, entry.require.entity, principal, 'id', child[entry.require.childRef], false, null, tombstones);
          // The related row must be co-owned by this exact branch parent.
          if (related.length === 1 && related[0][entry.require.fk] === raw.id) {
            required = Object.freeze({ entity: entry.require.entity, raw: related[0], children: new Map<SnapshotEntry, SnapshotNode[]>() });
          }
        }
        return Object.freeze({ raw: child, required, children: entry.nested ? capture(entry.entity, child, entry.nested).children : new Map<SnapshotEntry, SnapshotNode[]>() });
      }));
    }
    return Object.freeze({ raw, children });
  }
  const rows = readRows(db, anchor, principal, 'id', id, false, null, tombstones);
  return rows.length === 1 ? capture(anchor, rows[0], output) : null;
}

type SnapshotMayVerb = (entity: unknown, verb: string, row: unknown, principal: unknown) => Promise<boolean>;

interface SnapshotRowDecision {
  row: Record<string, unknown> | null | undefined;
  allowed: boolean;
}

export async function authorizeSnapshot({ principal, anchor, candidate, mayVerb, authorization }: {
  principal: unknown;
  anchor: SnapshotEntity;
  candidate: SnapshotNode;
  mayVerb: SnapshotMayVerb;
  authorization?: AuthorizationAdapter | null;
}): Promise<{ anchorAllowed: boolean; authorized: WeakMap<SnapshotNode, Record<string, unknown>> }> {
  const authorized = new WeakMap<SnapshotNode, Record<string, unknown>>();
  const rowAuthorization = new Map<SnapshotEntity, Map<unknown, SnapshotRowDecision>>();
  async function authorize(entity: SnapshotEntity, node: SnapshotNode): Promise<boolean> {
    try {
      let entityRows = rowAuthorization.get(entity);
      if (!entityRows) rowAuthorization.set(entity, entityRows = new Map());
      let decision = entityRows.get(node.raw.id);
      if (!decision) {
        // #157: ledger-proven fragments skip the admit call (the decision the
        // recipient already received), never the hydrate — projected values
        // must equal what a fresh snapshot projects for the same row.
        const ledgerAdmitted = node.ledgerAdmitted === true;
        if (!ledgerAdmitted && 'hydrate' in entity && typeof entity.hydrate !== 'function') return false;
        // Capture freezes detached SQL rows so the authorization fence cannot
        // mutate the candidate graph. Entity hydrate still deserializes in place
        // (members handles, stored codecs), so hand it a mutable copy.
        const row = typeof entity.hydrate === 'function' ? entity.hydrate({ ...node.raw }, principal) : node.raw;
        // A composite snapshot admission is a per-row subscribe admission. An
        // injected adapter is THE authority (S5/A2 single path); without one the
        // framework mayVerb engine runs, unchanged. A hydrate that yields or
        // throws nothing admits nothing, exactly as before (#157 keeps this).
        const allowed = row != null && (ledgerAdmitted || await admitSnapshotRow(authorization, entity, row, principal, mayVerb));
        decision = Object.freeze({ row, allowed });
        entityRows.set(node.raw.id, decision);
      }
      let requiredAllowed = node.required !== false;
      if (node.required && requiredAllowed) requiredAllowed = await authorize(node.required.entity, node.required);
      if (decision.allowed && requiredAllowed) authorized.set(node, decision.row as Record<string, unknown>);
      for (const [entry, children] of node.children) {
        if (entry.kind === 'user') continue;
        for (const child of children) await authorize(entry.entity!, child);
      }
      return decision.allowed && requiredAllowed;
    } catch {
      return false;
    }
  }
  const anchorAllowed = await authorize(anchor, candidate);
  return Object.freeze({ anchorAllowed, authorized });
}

async function admitSnapshotRow(adapter: AuthorizationAdapter | null | undefined, entity: SnapshotEntity, row: unknown, principal: unknown, mayVerb: SnapshotMayVerb): Promise<boolean> {
  if (adapter) {
    const decision = await adapter.admit({
      category: 'entity',
      verb: 'subscribe',
      operation: 'subscribe',
      principal: principal as import('./principal.ts').Principal,
      entity,
      row,
      resourceId: (row as { id?: unknown } | null | undefined)?.id as string | null | undefined,
    });
    return decision.admitted;
  }
  return mayRow(entity, 'subscribe', row, principal, mayVerb);
}

export function projectSnapshot({ anchor, candidate, output, authorized }: {
  anchor: SnapshotEntity;
  candidate: SnapshotNode;
  output: SnapshotBranch;
  authorized: WeakMap<SnapshotNode, Record<string, unknown>>;
}): Record<string, unknown> | null {
  function project(_entity: SnapshotEntity, node: SnapshotNode, branch: SnapshotBranch): Record<string, unknown> | null {
    const current = authorized.get(node);
    if (!current) return null;
    const result: Record<string, unknown> = { id: current.id };
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
      const rows: Record<string, unknown>[] = [];
      for (const child of node.children.get(entry) ?? []) {
        const projected = project(entry.entity, child, entry.nested ?? { entity: entry.entity, entries: entry.selected ? [Object.freeze({ key: 'select', kind: 'select' as const, fields: entry.selected })] : [] });
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
