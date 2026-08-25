// Recipient patch projector (#122 design §5–§7, #157 targeted capture).
//
// Projects a composite-journal slice into one recipient's `snapshot-patch`
// operations through the SAME seam as full snapshots: capture → authorize →
// project. Every emitted value is recipient-projected state; raw _Log.eventData
// and action payload fields never enter a patch.
//
// #157 targeted branch capture: the candidate graph is SPARSE. It contains the
// anchor row, the affected fragments of every branch the slice touches (with
// their nested value subtrees and required-related rows), the keyed-ancestor
// rows needed for addressing, and the smallest affected `many` instance — plus,
// only when the anchor op must assemble complete branch values, the untouched
// branches, whose rows are flagged ledger-admitted so authorizeSnapshot skips
// their per-row admit call (the recipient's ledger proves prior delivery; grant
// or membership flips force a declaration-wide invalidation upstream, so a
// non-invalidating slice can never move the grant graph). authorizeSnapshot and
// projectSnapshot then run UNCHANGED on the sparse graph: identical per-row
// admission decisions and identical projection shapes, at O(affected) cost.
// The one honest residual: an anchor-touched batch still READS its related
// rows once, because the replace-fields grammar demands the node's complete
// retained key set — but those reads carry no authorization or admission work.
//
// Successor visibility is likewise incremental: the previous ledger content is
// patched with the captured post-state of affected fragments instead of
// re-derived from a full walk. Membership of untouched branches cannot have
// changed (a change would have routed affected entries), so clone-and-delta
// equals what a fresh derivation would produce.
//
// Removals are ledger-gated: an operation may name a row as REMOVED only when
// the recipient's visibility ledger proves that exact recipient previously
// received it (design §7). Rows absent from both the prior ledger and the
// fresh authorized projection are named by NOTHING — no id, no path, no
// ordering fact. Authorization loss on a previously delivered row is exactly
// such a proof (it was admitted at delivery time), so revocation REMOVES
// rather than discloses.
//
// Operation addressing: paths are absolute OUTPUT paths from the anchor root;
// a keyed ancestor contributes `<relationKey>, <memberId>` segment pairs, so
// a nested relation instance under keyed member c1 of `codes` reads like
// ["codes", "c1", "entries"]. `many` relations are replaced wholesale at the
// smallest affected relation instance (authoritative ordering, no index-move
// grammar, design §4/§6) — one operation PER affected instance. The
// keyed-ancestor address of every delivered fragment is recorded in the
// recipient's ledger (#157), so a later removal under a keyed ancestor patches
// exactly instead of falling back to a full snapshot: the prior address IS the
// provable pre-state placement.
//
// Any anomaly THROWS: callers convert every failure into full-snapshot
// recovery, never into a partial patch (fail closed, design §7).

import type { AnchorPatchPlan, PatchPlanRelation } from './composite-patch-plan.ts';
import { compositeFragmentAddressKey } from './composite-patch-plan.ts';
import type { CompositeCursorV1, SnapshotPatchOperationV1 } from './composite-patch-envelope.ts';

// Structural views over snapshot-projection's compiled shapes (the module
// keeps them package-private). Wide enough for targeted capture to read
// fk/inverse/order/require/nested straight off the declaration.
interface CompiledEntityLike {
  readonly name: string;
}
interface CompiledEntryLike {
  readonly key: string;
  readonly kind: 'select' | 'user' | 'one' | 'many' | 'keyed' | 'count';
  readonly entity?: CompiledEntityLike;
  readonly fk?: string;
  readonly inverse?: boolean;
  readonly fields?: readonly string[];
  readonly selected?: readonly string[] | null;
  readonly nested?: CompiledBranchLike | null;
  readonly order?: { readonly field: string; readonly direction: string } | null;
  readonly require?: { readonly entity: CompiledEntityLike; readonly childRef: string; readonly fk: string } | null;
}
interface CompiledBranchLike {
  readonly entity: CompiledEntityLike;
  readonly entries: ReadonlyArray<CompiledEntryLike>;
}
interface SnapshotNodeLike {
  raw: Record<string, unknown>;
  children: Map<unknown, SnapshotNodeLike[]>;
  /** Mirrors snapshot-projection's ledger-admission shortcut (#157). */
  ledgerAdmitted?: boolean;
  required?: unknown;
}
interface SnapshotDeclarationLike {
  anchor: { name: string };
  output: CompiledBranchLike;
  tombstone: unknown;
  tombstones?: readonly unknown[];
}
import { authorizeSnapshot, projectSnapshot, readRows, readRowsByIds, readUser } from './snapshot-projection.ts';
import type { StoredCompositeChange } from './composite-journal.ts';
import type { Principal } from './principal.ts';

export interface PatchProjectorInput {
  db: import('./driver.ts').DbHandle;
  principal: Principal;
  /** Owning composite scope, e.g. `Project:p1`. */
  scope: string;
  plan: AnchorPatchPlan;
  /** The compiled declaration behind `plan`; capture/authorize/project consume its runtime branches. */
  declaration: SnapshotDeclarationLike;
  mayVerb: unknown;
  authorization: unknown;
  from: CompositeCursorV1;
  to: CompositeCursorV1;
  /** Journal slice (from, to]: the routing evidence for this batch. */
  changes: readonly StoredCompositeChange[];
  includeActionId: boolean;
  /** Proven visibility of THIS recipient before this batch (from the projection ledger). */
  priorVisible: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Keyed-ancestor addresses the ledger proved for THIS recipient before this
   * batch (#157): addressKey -> keyed member ids above the fragment's own
   * relation. Removals under keyed ancestors address through this map.
   */
  priorAddresses: ReadonlyMap<string, readonly string[]>;
  /** Re-reads the composite cursor for the stable-read fence check. */
  readCompositeSeq: () => number;
  /**
   * Re-reads the owning scope's _Cursor (anchor fence, FIX 6): a patch
   * projected from an older snapshot must never advance a recipient to a
   * newer anchor — BOTH fences are captured and re-checked before emitting,
   * matching aggregateSnapshot's stable-read discipline.
   */
  readAnchorSeq: () => number;
}

export interface PatchProjection {
  readonly operations: readonly SnapshotPatchOperationV1[];
  /** Actions whose effect is VISIBLE in this patch (put/remove/replace ops). */
  readonly actionIds: readonly string[];
  /**
   * Actions routed through the journal whose committed effect is provably
   * INVISIBLE here (empty-affected entries — cross-exam 6). These, and only
   * these, may settle optimistic state on an empty patch.
   */
  readonly routedInvisibleActionIds: readonly string[];
  /** true: the anchor row is gone — callers run revoke/deleted handling, never a normal patch. */
  readonly revokedAnchor: boolean;
  /** Visibility AFTER this batch, per branch — the successor ledger content. */
  readonly visibleAfter: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /**
   * Keyed-ancestor addresses AFTER this batch (#157) — the successor ledger
   * addressing content. Untouched fragments keep their prior addresses.
   */
  readonly addressesAfter: ReadonlyMap<string, readonly string[]>;
}

// ---- plan navigation ----

function findRelation(plan: AnchorPatchPlan, branchId: string): PatchPlanRelation | null {
  const visit = (relations: readonly PatchPlanRelation[]): PatchPlanRelation | null => {
    for (const relation of relations) {
      if (relation.branchId === branchId) return relation;
      const nested = visit(relation.children);
      if (nested) return nested;
    }
    return null;
  };
  return branchId === 'anchor' ? null : visit(plan.relations);
}

function branchChain(plan: AnchorPatchPlan, branchId: string): PatchPlanRelation[] {
  const segments = branchId.split('.');
  const chain: PatchPlanRelation[] = [];
  for (let end = 1; end <= segments.length; end += 1) {
    const relation = findRelation(plan, segments.slice(0, end).join('.'));
    if (!relation) throw new Error('journal names a branch outside the compiled plan');
    chain.push(relation);
  }
  return chain;
}

function keyOf(relation: PatchPlanRelation): string {
  return relation.branchId.slice(relation.branchId.lastIndexOf('.') + 1);
}

/** Output-path prefix of a branch instance: relation keys plus supplied keyed member ids. */
function instancePath(chain: readonly PatchPlanRelation[], keyedMembers: readonly string[]): string[] {
  const segments: string[] = [];
  let memberCursor = 0;
  for (const relation of chain) {
    segments.push(keyOf(relation));
    if (relation.kind === 'keyed') {
      const memberId = keyedMembers[memberCursor];
      if (typeof memberId !== 'string') throw new Error('keyed ancestor member id missing for patch path');
      segments.push(memberId);
      memberCursor += 1;
    }
  }
  return segments;
}

/**
 * Compiled declaration entry for a plan relation, via the relation's declared
 * output path. The compiled entry carries the bound runtime entity (scope
 * filter, hydrate), physical fk direction, ordering, and requirement that
 * targeted capture must reproduce exactly.
 */
function compiledEntryAt(output: CompiledBranchLike, path: readonly string[]): CompiledEntryLike {
  let branch = output;
  let entry: CompiledEntryLike | null = null;
  for (const key of path) {
    entry = branch.entries.find((candidate) => candidate.key === key) ?? null;
    if (!entry || !entry.nested) continue;
    branch = entry.nested;
  }
  if (!entry) throw new Error('plan names an output path outside the compiled declaration');
  return entry;
}

// ---- affected-fragment resolution -------------------------------------------

/**
 * One affected row's placement evidence, resolved BEFORE capture from scoped
 * post-state reads alone (never a full-graph walk). `row` is null when the
 * row no longer exists (removed or hidden) — its address then comes from the
 * recipient's ledger, or the removal is unnamed (never delivered here).
 */
interface AffectedFragment {
  readonly row: Record<string, unknown> | null;
  /** Keyed-ancestor member ids above the touched relation (outermost first). */
  readonly members: readonly string[];
  /** Captured raw rows for each keyed ancestor level (aligned with `members`). */
  readonly ancestors: readonly Record<string, unknown>[];
}

/**
 * Resolve every affected id of one touched branch: a scoped by-ids read for
 * the rows themselves, then an upward fk-walk (one scoped read per ancestor
 * level) for the keyed-ancestor chain. O(affected × depth) reads — the
 * smallest evidence set that addresses the fragments. Throws (fail closed,
 * snapshot recovery upstream) when a chain step is not an inverse relation,
 * an intermediate step is not keyed, or an ancestor row cannot be read:
 * placement is then unknowable cheaply.
 */
function resolveFragments(db: import('./driver.ts').DbHandle, principal: Principal, declaration: SnapshotDeclarationLike, plan: AnchorPatchPlan, branchId: string, ids: ReadonlySet<string>, tombstones: readonly unknown[] | null): Map<string, AffectedFragment> {
  const chain = branchChain(plan, branchId);
  const finalEntry = compiledEntryAt(declaration.output, chain[chain.length - 1].path);
  if (!finalEntry.entity) throw new Error('touched branch lacks a compiled entity');
  const found = new Map<string, AffectedFragment>();
  if (ids.size === 0) return found;
  const rows = readRowsByIds(db, finalEntry.entity as never, principal, [...ids], null, tombstones as never);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      found.set(id, { row: null, members: [], ancestors: [] });
      continue;
    }
    const members: string[] = [];
    const ancestors: Record<string, unknown>[] = [];
    let current: Record<string, unknown> = row;
    for (let index = chain.length - 1; index >= 1; index -= 1) {
      const step = chain[index];
      if (step.inverse !== true) throw new Error('targeted capture supports inverse relation chains only');
      const parentId = current[step.fk];
      if (typeof parentId !== 'string' || parentId.length === 0) throw new Error('affected fragment lacks a readable ancestor reference');
      const parentRelation = chain[index - 1];
      if (index > 1 && parentRelation.kind !== 'keyed') {
        // Only keyed ancestors contribute path segments; anything else in the
        // middle of a chain cannot be addressed sparsely — fail closed.
        throw new Error('targeted capture supports keyed-ancestor chains only');
      }
      const parentEntry = compiledEntryAt(declaration.output, parentRelation.path);
      if (!parentEntry.entity) throw new Error('ancestor branch lacks a compiled entity');
      const parentRows = readRowsByIds(db, parentEntry.entity as never, principal, [parentId], null, tombstones as never);
      if (parentRows.length !== 1) throw new Error('affected fragment ancestor could not be read');
      const parentRow = parentRows[0];
      if (parentRelation.kind === 'keyed') {
        members.unshift(parentId);
        ancestors.unshift(parentRow);
      }
      current = parentRow;
    }
    found.set(id, { row, members, ancestors });
  }
  return found;
}

// ---- sparse candidate graph --------------------------------------------------

interface CaptureContext {
  db: import('./driver.ts').DbHandle;
  principal: Principal;
  declaration: SnapshotDeclarationLike;
  plan: AnchorPatchPlan;
  tombstones: readonly unknown[] | null;
  touched: Map<string, Set<string>>;
  anchorTouched: boolean;
  resolution: Map<string, Map<string, AffectedFragment>>;
}

function newNode(raw: Record<string, unknown>, ledgerAdmitted: boolean): SnapshotNodeLike {
  const node: SnapshotNodeLike = { raw, children: new Map() };
  if (ledgerAdmitted) node.ledgerAdmitted = true;
  return node;
}

/** Requirement side-capture shared by every capture mode (see captureSnapshot). */
function attachRequirement(ctx: CaptureContext, entry: CompiledEntryLike, child: Record<string, unknown>, holderRaw: Record<string, unknown>, node: SnapshotNodeLike, ledgerAdmitted: boolean): void {
  if (!entry.require) return;
  const { db, principal, tombstones } = ctx;
  node.required = false;
  const related = readRows(db, entry.require.entity as never, principal, 'id', child[entry.require.childRef], false, null, tombstones as never);
  // The related row must be co-owned by this exact branch parent.
  if (related.length === 1 && related[0][entry.require.fk] === holderRaw.id) {
    node.required = Object.freeze(newNode(related[0], ledgerAdmitted));
  }
}

/**
 * Capture the COMPLETE value subtree of one compiled entry under one row —
 * every relation level below it, required-related rows included. Used for
 * affected fragments (fresh admission) and for untouched branches when the
 * anchor op must assemble complete values (ledger-admitted). Mirrors
 * captureSnapshot's per-entry behavior exactly, plus the admission flag.
 */
function fillCompleteEntry(ctx: CaptureContext, parentRaw: Record<string, unknown>, entry: CompiledEntryLike, ledgerAdmitted: boolean): SnapshotNodeLike[] {
  const { db, principal, tombstones } = ctx;
  if (entry.kind === 'user') {
    const user = parentRaw[entry.fk as string] == null ? null : readUser(db, parentRaw[entry.fk as string], tombstones as never);
    return user ? [Object.freeze({ raw: user, children: new Map() })] : [];
  }
  if (!entry.entity) throw new Error('captured branch lacks a compiled entity');
  const rows = readRows(db, entry.entity as never, principal, entry.fk as string, entry.inverse ? parentRaw.id : parentRaw[entry.fk as string], entry.inverse === true, entry.order as never, tombstones as never);
  return rows.map((child) => {
    const node = newNode(child, ledgerAdmitted);
    attachRequirement(ctx, entry, child, parentRaw, node, ledgerAdmitted);
    if (entry.nested) {
      for (const nestedEntry of entry.nested.entries) {
        if (nestedEntry.kind === 'select') continue;
        node.children.set(nestedEntry, fillCompleteEntry(ctx, child, nestedEntry, ledgerAdmitted));
      }
    }
    return Object.freeze(node);
  });
}

/** Index of a chain level among the KEYED steps only (members[] alignment). */
function spineKeyIndex(chain: readonly PatchPlanRelation[], level: number): number {
  let keyed = 0;
  for (let index = 0; index < level; index += 1) if (chain[index].kind === 'keyed') keyed += 1;
  return keyed;
}

/** One captured affected row: fresh admission, complete value subtree, requirement honored. */
function finishFragmentNode(ctx: CaptureContext, entry: CompiledEntryLike, raw: Record<string, unknown>, holderRaw: Record<string, unknown>): SnapshotNodeLike {
  const node = newNode(raw, false);
  attachRequirement(ctx, entry, raw, holderRaw, node, false);
  if (entry.nested) {
    for (const nestedEntry of entry.nested.entries) {
      if (nestedEntry.kind === 'select') continue;
      node.children.set(nestedEntry, fillCompleteEntry(ctx, raw, nestedEntry, false));
    }
  }
  return Object.freeze(node);
}

/**
 * Targeted capture of ONE touched top-level-or-deeper branch: only the
 * affected fragments (plus their value subtrees), the keyed-ancestor nodes
 * needed for addressing, and — for wholesale kinds — the smallest affected
 * instance. Fresh admission for every captured row (nothing here is assumed
 * from the ledger: these rows' content or existence just changed).
 */
function fillAffected(ctx: CaptureContext, rootRaw: Record<string, unknown>, entry: CompiledEntryLike, branchId: string, into: Map<unknown, SnapshotNodeLike[]>): void {
  const { db, principal, tombstones } = ctx;
  const chain = branchChain(ctx.plan, branchId);
  const fragments = ctx.resolution.get(branchId);
  if (!fragments) throw new Error('affected fragments unresolved for a touched branch');
  const present = [...fragments.values()].filter((fragment) => fragment.row !== null);

  if (chain.length === 1) {
    // Top-level branch directly under the anchor.
    if (!entry.entity) throw new Error('touched branch lacks a compiled entity');
    const prefixPath = [entry.key];
    if (entry.kind === 'keyed') {
      into.set(entry, present.map((fragment) => Object.freeze(finishFragmentNode(ctx, entry, fragment.row as Record<string, unknown>, rootRaw))));
      return;
    }
    if (entry.kind === 'many' || entry.kind === 'count') {
      // Wholesale kinds: the smallest affected instance is the whole
      // anchor-level collection (authoritative ordering).
      const rows = readRows(db, entry.entity as never, principal, entry.fk as string, rootRaw.id, true, entry.order as never, tombstones as never);
      into.set(entry, rows.map((child) => Object.freeze(finishFragmentNode(ctx, entry, child, rootRaw))));
      return;
    }
    if (entry.kind === 'one') {
      const rows = readRows(db, entry.entity as never, principal, entry.fk as string, rootRaw[entry.fk as string], false, entry.order as never, tombstones as never);
      into.set(entry, rows.map((child) => Object.freeze(finishFragmentNode(ctx, entry, child, rootRaw))));
      return;
    }
    throw new Error(`unsupported top-level touched branch kind '${entry.kind}'`);
  }

  // Deeper branch: rebuild only the keyed ancestor spine the fragments sit
  // under (shared across fragments of the same instance), then attach the
  // smallest affected instance at the final relation.
  const spineNodes = new Map<string, SnapshotNodeLike>();
  for (const fragment of present) {
    const keyedLevels = chain.slice(0, -1).filter((step) => step.kind === 'keyed').length;
    if (fragment.members.length !== keyedLevels) {
      throw new Error('affected fragment ancestor chain does not match the branch shape');
    }
    let parentNode: SnapshotNodeLike = { raw: rootRaw, children: into };
    for (let level = 0; level < chain.length - 1; level += 1) {
      const relation = chain[level];
      if (relation.kind !== 'keyed') continue; // only keyed ancestors contribute spine nodes
      const levelEntry = compiledEntryAt(ctx.declaration.output, relation.path);
      const memberId = fragment.members[spineKeyIndex(chain, level)];
      const spineKey = `${relation.branchId}\u0000${memberId}`;
      let node = spineNodes.get(spineKey);
      if (!node) {
        const raw = fragment.ancestors[spineKeyIndex(chain, level)];
        if (!raw) throw new Error('affected fragment lacks a captured ancestor row');
        node = newNode(raw, false);
        spineNodes.set(spineKey, node);
        const existing = (parentNode.children.get(levelEntry) ?? []) as SnapshotNodeLike[];
        existing.push(Object.freeze(node));
        parentNode.children.set(levelEntry, existing);
      }
      parentNode = node;
    }
    // Attach the final relation's content under the innermost spine node.
    const finalRelation = chain[chain.length - 1];
    const finalEntry = compiledEntryAt(ctx.declaration.output, finalRelation.path);
    if (!finalEntry.entity) throw new Error('touched branch lacks a compiled entity');
    if (finalRelation.kind === 'keyed') {
      const existing = (parentNode.children.get(finalEntry) ?? []) as SnapshotNodeLike[];
      if (!existing.some((candidate) => String(candidate.raw.id) === String(fragment.row!.id))) {
        existing.push(Object.freeze(finishFragmentNode(ctx, finalEntry, fragment.row as Record<string, unknown>, parentNode.raw)));
        parentNode.children.set(finalEntry, existing);
      }
      continue;
    }
    // many/count/one under the spine: the smallest affected instance is the
    // innermost spine node's own instance — replace it wholesale.
    const rows = finalRelation.inverse
      ? readRows(db, finalEntry.entity as never, principal, finalEntry.fk as string, parentNode.raw.id, true, finalEntry.order as never, tombstones as never)
      : readRows(db, finalEntry.entity as never, principal, finalEntry.fk as string, parentNode.raw[finalEntry.fk as string], false, finalEntry.order as never, tombstones as never);
    parentNode.children.set(finalEntry, rows.map((child) => Object.freeze(finishFragmentNode(ctx, finalEntry, child, parentNode.raw))));
  }
}

/**
 * Build the sparse candidate graph for this batch (#157). Returns null when
 * the anchor row is gone (revoked-anchor handling upstream, identical to
 * captureSnapshot's contract).
 */
function captureAffectedGraph(ctx: CaptureContext, handleId: string): SnapshotNodeLike | null {
  const { db, principal, declaration, tombstones } = ctx;
  const anchorRows = readRows(db, declaration.anchor as never, principal, 'id', handleId, false, null, tombstones as never);
  if (anchorRows.length !== 1) return null;
  const root = newNode(anchorRows[0], false);
  const output = declaration.output;
  for (const entry of output.entries) {
    if (entry.kind === 'select') continue;
    const touchedIds = ctx.touched.get(entry.key);
    if (!touchedIds && !ctx.anchorTouched) {
      // Sparse absence: this branch is untouched and no anchor op is emitted,
      // so nobody reads its value. Nothing is captured, admitted, hydrated,
      // or projected for it.
      root.children.set(entry, []);
      continue;
    }
    if (!touchedIds) {
      // Anchor-op value assembly: the replace-fields value must carry every
      // branch's current value, so this untouched branch is captured whole —
      // ledger-admitted (no per-row admit calls) but fully hydrated so the
      // values stay byte-identical to a fresh snapshot.
      root.children.set(entry, fillCompleteEntry(ctx, root.raw, entry, true));
      continue;
    }
    fillAffected(ctx, root.raw, entry, entry.key, root.children);
  }
  return root;
}

// ---- projected-shape navigation ----

function navigate(projected: unknown, segments: readonly string[]): unknown {
  let current: unknown = projected;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Full post-projection visibility, per plan branch: every (branch, entity, id)
 * fragment present in the recipient's fresh authorized projection, PLUS the
 * keyed-ancestor address of every fragment (#157). Derived in ONE walk against
 * the plan — never incrementally accumulated, so bootstrap ledger state always
 * equals "what a fresh snapshot contains right now". Steady-state patches
 * update both maps incrementally instead (no walk).
 */
export function deriveVisibilityExtended(plan: AnchorPatchPlan, projected: Record<string, unknown>): { visible: Map<string, Map<string, Set<string>>>; addresses: Map<string, readonly string[]> } {
  const visible = new Map<string, Map<string, Set<string>>>();
  const addresses = new Map<string, readonly string[]>();
  const record = (branchId: string, entity: string, id: string, members: readonly string[]): void => {
    let entities = visible.get(branchId);
    if (!entities) visible.set(branchId, entities = new Map());
    let ids = entities.get(entity);
    if (!ids) entities.set(entity, ids = new Set());
    ids.add(id);
    addresses.set(compositeFragmentAddressKey(branchId, entity, id), Object.freeze([...members]));
  };
  const walkRelations = (relations: readonly PatchPlanRelation[], container: unknown, members: readonly string[]): void => {
    for (const relation of relations) {
      if (!container || typeof container !== 'object') continue;
      const value: unknown = (container as Record<string, unknown>)[keyOf(relation)];
      if (relation.kind === 'count') continue; // counts expose no row identity
      if (relation.kind === 'one') {
        if (value && typeof value === 'object') {
          record(relation.branchId, relation.entity, String((value as Record<string, unknown>).id), members);
          walkRelations(relation.children, value, members);
        }
        continue;
      }
      if (relation.kind === 'many') {
        if (Array.isArray(value)) {
          for (const row of value) {
            record(relation.branchId, relation.entity, String(row.id), members);
            walkRelations(relation.children, row, members);
          }
        }
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [memberId, row] of Object.entries(value as Record<string, unknown>)) {
          record(relation.branchId, relation.entity, memberId, members);
          walkRelations(relation.children, row, [...members, memberId]);
        }
      }
    }
  };
  walkRelations(plan.relations, projected, []);
  return { visible, addresses };
}

/**
 * Compatibility wrapper: bootstrap and legacy callers that only need the
 * visibility map. See deriveVisibilityExtended for the addressed form (#157).
 */
export function deriveVisibility(plan: AnchorPatchPlan, projected: Record<string, unknown>): Map<string, Map<string, Set<string>>> {
  return deriveVisibilityExtended(plan, projected).visible;
}

function provenVisible(prior: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>, branchId: string, entity: string, id: string): boolean {
  return prior.get(branchId)?.get(entity)?.has(id) ?? false;
}

function cloneVisible(source: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const [branch, entities] of source) {
    const entityCopy = new Map<string, Set<string>>();
    for (const [entity, ids] of entities) entityCopy.set(entity, new Set(ids));
    out.set(branch, entityCopy);
  }
  return out;
}

function cloneAddresses(source: ReadonlyMap<string, readonly string[]>): Map<string, readonly string[]> {
  return new Map(source);
}

/** Per-branch entity->ids bucket in the successor visibility map. */
function visibleBucket(visible: Map<string, Map<string, Set<string>>>, branchId: string, entity: string): Set<string> {
  let entities = visible.get(branchId);
  if (!entities) visible.set(branchId, entities = new Map());
  let ids = entities.get(entity);
  if (!ids) entities.set(entity, ids = new Set());
  return ids;
}

/**
 * Project one recipient's patch for a journal slice. Throws on any anomaly —
 * callers MUST convert throws into full-snapshot recovery (fail closed).
 */
export async function projectCompositePatch(input: PatchProjectorInput): Promise<PatchProjection> {
  const { principal, scope, plan, declaration, changes, from, to, priorVisible, priorAddresses } = input;
  const handleId = scope.slice(scope.indexOf(':') + 1);
  const tombstones = (declaration.tombstones ?? null) as readonly unknown[] | null;

  const actionIds = new Set<string>();
  const routedInvisible = new Set<string>();
  const touched = new Map<string, Set<string>>();
  let anchorTouched = false;
  for (const change of changes) {
    if (change.actionId && change.affected.length === 0) {
      // Routed but provably invisible to this declaration/recipient: the ONLY
      // disposition that may settle an optimistic op on an empty patch
      // (cross-exam 6).
      routedInvisible.add(change.actionId);
    } else if (change.actionId) {
      actionIds.add(change.actionId);
    }
    if (change.invalidating) throw new Error('journal slice contains an invalidating change');
    if (change.scope !== scope) throw new Error('journal slice spans foreign scopes');
    for (const affected of change.affected) {
      if (affected.branch === 'anchor') anchorTouched = true;
      let ids = touched.get(affected.branch);
      if (!ids) touched.set(affected.branch, ids = new Set());
      ids.add(affected.id);
    }
  }

  // Empty slice: an empty patch still advances the cursor (design §6).
  if (touched.size === 0 && !anchorTouched) {
    return { operations: [], actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: false, visibleAfter: cloneVisible(priorVisible), addressesAfter: cloneAddresses(priorAddresses) };
  }

  // --- resolve affected placements BEFORE capture (O(affected × depth)) -----
  const resolution = new Map<string, Map<string, AffectedFragment>>();
  for (const [branchId, ids] of touched) {
    if (branchId === 'anchor') continue;
    if (!findRelation(plan, branchId)) throw new Error('journal names a branch outside the compiled plan');
    resolution.set(branchId, resolveFragments(input.db, principal, declaration, plan, branchId, ids, tombstones));
  }

  // Dual-fence discipline (re-review GAP 4): the anchor fence is read BEFORE
  // capture begins and re-checked after projection. A commit landing between
  // the two reads means the candidate graph spans a commit boundary — the
  // throw routes through the caller's retry/snapshot recovery instead of
  // emitting a patch that would advance the recipient to an unearned anchor.
  const anchorFenceBeforeCapture = input.readAnchorSeq();

  // --- one TARGETED capture → authorize → project pass for the WHOLE batch --
  const captured = captureAffectedGraph({ db: input.db, principal, declaration, plan, tombstones, touched, anchorTouched, resolution }, handleId);
  if (!captured) {
    return { operations: [], actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: true, visibleAfter: new Map(), addressesAfter: new Map() };
  }
  const auth = await authorizeSnapshot({
    principal,
    anchor: declaration.anchor as never,
    candidate: captured as never,
    mayVerb: input.mayVerb as never,
    authorization: input.authorization as never,
  });
  if (!auth.anchorAllowed) throw new Error('composite patch anchor reauthorization denied');
  const projected = projectSnapshot({ anchor: declaration.anchor as never, candidate: captured as never, output: declaration.output as never, authorized: auth.authorized }) as Record<string, unknown> | null;
  if (!projected) throw new Error('composite patch projection failed');
  // Dual-fence check (FIX 6): the anchor _Cursor must be UNCHANGED between
  // capture and emission — movement means the candidate graph was captured
  // across a commit (retry/fallback upstream). The delivered to.anchor is the
  // CURRENT head, so the patch leaves the recipient exactly at the anchor its
  // new state was projected from — never past it, never behind it.
  if (input.readAnchorSeq() !== anchorFenceBeforeCapture) throw new Error('anchor cursor moved during patch capture');
  if (anchorFenceBeforeCapture < from.anchor) throw new Error('anchor cursor moved backwards during patch projection');
  if (input.readCompositeSeq() !== to.composite) throw new Error('composite journal moved during patch projection');

  const operations: SnapshotPatchOperationV1[] = [];

  // --- anchor selected-field replacement ------------------------------------
  // The value carries the COMPLETE retained key set of the node — selected
  // fields AND every current relation-branch value — so the client's
  // exact-set replacement deletes only genuinely removed keys and untouched
  // relation branches round-trip unchanged (re-review GAP 3b). Untouched
  // branch values came from the ledger-admitted capture above.
  if (anchorTouched) {
    const selectEntry = declaration.output.entries.find((entry) => entry.kind === 'select');
    const fields = ['id', ...(selectEntry && selectEntry.kind === 'select' ? (selectEntry.fields ?? []) : [])];
    const relationKeys = declaration.output.entries.filter((entry) => entry.kind !== 'select').map((entry) => entry.key);
    const value: Record<string, unknown> = {};
    for (const field of [...fields, ...relationKeys]) value[field] = (projected as Record<string, unknown>)[field];
    operations.push({ op: 'replace-fields', path: [], value });
  }

  // --- successor ledger state (incremental, #157) ----------------------------
  // Untouched branches cannot have changed membership (a change would have
  // routed affected entries), so cloning the prior maps and applying the
  // captured post-state of affected fragments equals a fresh derivation.
  const visibleAfter = cloneVisible(priorVisible);
  const addressesAfter = cloneAddresses(priorAddresses);

  // --- relation branches -----------------------------------------------------
  interface InstanceEmit {
    readonly relation: PatchPlanRelation;
    /** membersKey -> keyed member ids above the relation (addressing). */
    readonly instances: Map<string, readonly string[]>;
    /** membersKey -> affected ids resolved at that addressing instance. */
    readonly ids: Map<string, Set<string>>;
  }
  const manyEmits = new Map<string, InstanceEmit>();
  const valueEmits = new Map<string, InstanceEmit>();
  const keyedEmits = new Map<string, InstanceEmit>();

  const instanceEmitOf = (store: Map<string, InstanceEmit>, relation: PatchPlanRelation): InstanceEmit => {
    let emit = store.get(relation.branchId);
    if (!emit) store.set(relation.branchId, emit = { relation, instances: new Map(), ids: new Map() });
    return emit;
  };

  /**
   * Addressing members for one affected id: post-state fk-walk when the row
   * survives; otherwise the LEDGER's provable pre-state address. A removed id
   * the ledger proves delivered but never addressed cannot be placed — fail
   * closed. An id that was never delivered here is simply not ours to name.
   */
  const addressOf = (relation: PatchPlanRelation, id: string, fragment: AffectedFragment): readonly string[] | null => {
    if (fragment.row) return fragment.members;
    const addressed = priorAddresses.get(compositeFragmentAddressKey(relation.branchId, relation.entity, id));
    if (addressed) return addressed;
    if (provenVisible(priorVisible, relation.branchId, relation.entity, id)) {
      throw new Error('removed fragment lacks a provable keyed address');
    }
    return null; // never delivered to this recipient: named by nothing
  };

  // A count/many instance whose own affected row vanished can still be
  // addressed through a SIBLING touched branch of the same entity (routing
  // fans one event out onto every branch projecting that entity).
  const siblingAddress = (entity: string, excludeBranchId: string): readonly string[] | null => {
    for (const [otherBranchId, fragments] of resolution) {
      if (otherBranchId === excludeBranchId) continue;
      const relation = findRelation(plan, otherBranchId);
      if (!relation || relation.entity !== entity) continue;
      for (const fragment of fragments.values()) {
        if (fragment.row) return fragment.members;
      }
    }
    return null;
  };

  for (const [branchId, ids] of touched) {
    if (branchId === 'anchor') continue;
    const relation = findRelation(plan, branchId);
    if (!relation) throw new Error('journal names a branch outside the compiled plan');
    const fragments = resolution.get(branchId);
    if (!fragments) throw new Error('affected fragments unresolved for a touched branch');

    if (relation.kind === 'many') {
      const emit = instanceEmitOf(manyEmits, relation);
      for (const id of ids) {
        const fragment = fragments.get(id);
        if (!fragment) throw new Error('affected fragment unresolved');
        const members = addressOf(relation, id, fragment) ?? siblingAddress(relation.entity, branchId);
        if (!members) continue;
        const key = members.join('\u0000');
        emit.instances.set(key, members);
        let bucket = emit.ids.get(key);
        if (!bucket) emit.ids.set(key, bucket = new Set());
        bucket.add(id);
      }
      continue;
    }

    if (relation.kind === 'one' || relation.kind === 'count') {
      const emit = instanceEmitOf(valueEmits, relation);
      for (const id of ids) {
        const fragment = fragments.get(id);
        if (!fragment) throw new Error('affected fragment unresolved');
        const members = addressOf(relation, id, fragment)
          ?? (relation.kind === 'count' ? siblingAddress(relation.entity, branchId) : null);
        if (!members) continue;
        const key = members.join('\u0000');
        emit.instances.set(key, members);
        let bucket = emit.ids.get(key);
        if (!bucket) emit.ids.set(key, bucket = new Set());
        bucket.add(id);
        // Successor visibility for one-relations: the row itself (or none).
        if (relation.kind === 'one') {
          const idSet = visibleBucket(visibleAfter, branchId, relation.entity);
          if (fragment.row) idSet.add(id);
          else idSet.delete(id);
        }
      }
      continue;
    }

    // keyed: member-level put/remove; removals ledger-gated.
    const emit = instanceEmitOf(keyedEmits, relation);
    for (const id of ids) {
      const fragment = fragments.get(id);
      if (!fragment) throw new Error('affected fragment unresolved');
      const members = addressOf(relation, id, fragment);
      if (!members) continue;
      const key = members.join('\u0000');
      emit.instances.set(key, members);
      let bucket = emit.ids.get(key);
      if (!bucket) emit.ids.set(key, bucket = new Set());
      bucket.add(id);
      const idSet = visibleBucket(visibleAfter, branchId, relation.entity);
      if (fragment.row) {
        addressesAfter.set(compositeFragmentAddressKey(branchId, relation.entity, id), Object.freeze([...members]));
        idSet.add(id);
      } else {
        addressesAfter.delete(compositeFragmentAddressKey(branchId, relation.entity, id));
        idSet.delete(id);
      }
    }
  }

  // one/count: authorized replacement at the relation-instance path.
  for (const [, emit] of valueEmits) {
    const chain = branchChain(plan, emit.relation.branchId);
    const ancestorChain = chain.slice(0, -1);
    for (const [membersKey, members] of emit.instances) {
      const path = instancePath(ancestorChain, membersKey.length === 0 ? [] : members.split('\u0000'));
      const value = navigate(projected, [...path, keyOf(emit.relation)]);
      operations.push(emit.relation.kind === 'count'
        ? { op: 'replace-value', path: [...path, keyOf(emit.relation)], value }
        : { op: 'replace-one', path: [...path, keyOf(emit.relation)], value: (value ?? null) as Record<string, unknown> | null });
    }
  }

  // many: whole-relation replacement at the smallest affected instance — one
  // op PER affected instance (multi-instance batches no longer collapse into
  // one coarser replace).
  for (const [, emit] of manyEmits) {
    const chain = branchChain(plan, emit.relation.branchId);
    const ancestorChain = chain.slice(0, -1);
    for (const [membersKey, members] of emit.instances) {
      const path = instancePath(ancestorChain, membersKey.length === 0 ? [] : members.split('\u0000'));
      const value = navigate(projected, [...path, keyOf(emit.relation)]);
      if (!Array.isArray(value)) throw new Error('projected many relation is not an array');
      operations.push({ op: 'replace-many', path: [...path, keyOf(emit.relation)], value: value.map((row) => ({ ...row })) });
      // Successor visibility + addresses for the replaced instance's rows.
      const idSet = visibleBucket(visibleAfter, emit.relation.branchId, emit.relation.entity);
      const surviving = new Set<string>();
      for (const row of value) {
        const rowId = String((row as Record<string, unknown>).id);
        surviving.add(rowId);
        idSet.add(rowId);
        addressesAfter.set(compositeFragmentAddressKey(emit.relation.branchId, emit.relation.entity, rowId), Object.freeze([...members]));
      }
      for (const id of emit.ids.get(membersKey) ?? []) {
        // An affected row that vanished from this instance is gone — but only
        // if THIS recipient was ever proven to see it.
        if (!surviving.has(id) && idSet.has(id)) idSet.delete(id);
      }
    }
  }

  // keyed: member-level put/remove; removals ledger-gated.
  for (const [, emit] of keyedEmits) {
    const chain = branchChain(plan, emit.relation.branchId);
    const ancestorChain = chain.slice(0, -1);
    for (const [membersKey, ids] of emit.ids) {
      const memberIds = membersKey.length === 0 ? [] : membersKey.split('\u0000');
      const collectionPath = [...instancePath(ancestorChain, memberIds), keyOf(emit.relation)];
      for (const id of ids) {
        const collection = navigate(projected, collectionPath);
        const current = collection && typeof collection === 'object' && !Array.isArray(collection)
          ? (collection as Record<string, unknown>)[id]
          : undefined;
        if (current && typeof current === 'object') {
          operations.push({ op: 'put-keyed', path: collectionPath, id, value: { ...(current as Record<string, unknown>) } });
          continue;
        }
        if (provenVisible(priorVisible, emit.relation.branchId, emit.relation.entity, id)) {
          operations.push({ op: 'remove-keyed', path: collectionPath, id });
          continue;
        }
        // Not admitted now and never proven delivered: named by nothing.
      }
    }
  }

  return { operations, actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: false, visibleAfter, addressesAfter };
}
