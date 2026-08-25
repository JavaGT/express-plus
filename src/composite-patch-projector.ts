// Recipient patch projector (#122 design §5–§7).
//
// Projects a composite-journal slice into one recipient's `snapshot-patch`
// operations through the SAME seam as full snapshots: capture → authorize →
// project (captureSnapshot / authorizeSnapshot / projectSnapshot). Every
// emitted value is recipient-projected state; raw _Log.eventData and action
// payload fields never enter a patch.
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
// grammar, design §4/§6).
//
// Any anomaly THROWS: callers convert every failure into full-snapshot
// recovery, never into a partial patch (fail closed, design §7).

import type { AnchorPatchPlan, PatchPlanRelation } from './composite-patch-plan.ts';
import type { CompositeCursorV1, SnapshotPatchOperationV1 } from './composite-patch-envelope.ts';

// Structural views over snapshot-projection's compiled shapes (the module
// keeps them package-private).
interface SnapshotNodeLike {
  raw: Record<string, unknown>;
  children: Map<unknown, SnapshotNodeLike[]>;
}
interface SnapshotDeclarationLike {
  anchor: { name: string };
  output: SnapshotBranchLike;
  tombstone: unknown;
  tombstones?: readonly unknown[];
}
interface SnapshotBranchLike {
  entity: { name: string };
  entries: ReadonlyArray<{ key: string; kind: string; fields?: readonly string[] }>;
}
import { captureSnapshot, authorizeSnapshot, projectSnapshot } from './snapshot-projection.ts';
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
 * Walk the captured candidate graph along a branch chain and resolve, for
 * every affected row id, its placement: the member-id chain of keyed ancestors
 * above it. Returns null when any affected row cannot be located (its
 * placement is unknowable — fail closed). Rows under `many` ancestors resolve
 * with the members collected so far; their addressing collapses upward onto
 * the whole many relation at emit time.
 */
function collectInstances(root: SnapshotNodeLike, chain: readonly PatchPlanRelation[], ids: ReadonlySet<string>): Map<string, string[]> | null {
  const found = new Map<string, string[]>();
  const walk = (node: SnapshotNodeLike, index: number, memberIds: readonly string[]): void => {
    if (index >= chain.length) return;
    const relation = chain[index];
    for (const [entry, children] of node.children) {
      if ((entry as { key?: string }).key !== keyOf(relation)) continue;
      for (const child of children) {
        const nextMembers = relation.kind === 'keyed' ? [...memberIds, String(child.raw.id)] : [...memberIds];
        if (index === chain.length - 1) {
          const id = String(child.raw.id);
          if (ids.has(id)) found.set(id, [...nextMembers]);
        } else {
          walk(child, index + 1, nextMembers);
        }
      }
    }
  };
  walk(root, 0, []);
  // An affected id absent from the captured graph was REMOVED or hidden: it
  // has no post-state placement, addressed instead through the collection path
  // with the keyed members it provably held before. Those arrive via the
  // prior-ledger scan below, not from the graph.
  for (const id of ids) if (!found.has(id)) found.set(id, []);
  return found;
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
 * fragment present in the recipient's fresh authorized projection. Derived in
 * ONE walk against the plan — never incrementally accumulated, so successor
 * ledger state always equals "what a fresh snapshot contains right now".
 */
export function deriveVisibility(plan: AnchorPatchPlan, projected: Record<string, unknown>): Map<string, Map<string, Set<string>>> {
  const visible = new Map<string, Map<string, Set<string>>>();
  const record = (branchId: string, entity: string, id: string): void => {
    let entities = visible.get(branchId);
    if (!entities) visible.set(branchId, entities = new Map());
    let ids = entities.get(entity);
    if (!ids) entities.set(entity, ids = new Set());
    ids.add(id);
  };
  const walkRelations = (relations: readonly PatchPlanRelation[], container: unknown): void => {
    for (const relation of relations) {
      if (!container || typeof container !== 'object') continue;
      const value: unknown = (container as Record<string, unknown>)[keyOf(relation)];
      if (relation.kind === 'count') continue; // counts expose no row identity
      if (relation.kind === 'one') {
        if (value && typeof value === 'object') {
          record(relation.branchId, relation.entity, String((value as Record<string, unknown>).id));
          walkRelations(relation.children, value);
        }
        continue;
      }
      if (relation.kind === 'many') {
        if (Array.isArray(value)) {
          for (const row of value) {
            record(relation.branchId, relation.entity, String(row.id));
            walkRelations(relation.children, row);
          }
        }
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [memberId, row] of Object.entries(value as Record<string, unknown>)) {
          record(relation.branchId, relation.entity, memberId);
          walkRelations(relation.children, row);
        }
      }
    }
  };
  walkRelations(plan.relations, projected);
  return visible;
}

function provenVisible(prior: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>, branchId: string, entity: string, id: string): boolean {
  return prior.get(branchId)?.get(entity)?.has(id) ?? false;
}

/**
 * Project one recipient's patch for a journal slice. Throws on any anomaly —
 * callers MUST convert throws into full-snapshot recovery (fail closed).
 */
export async function projectCompositePatch(input: PatchProjectorInput): Promise<PatchProjection> {
  const { principal, scope, plan, declaration, changes, from, to, priorVisible } = input;
  const handleId = scope.slice(scope.indexOf(':') + 1);

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
    return { operations: [], actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: false, visibleAfter: cloneVisible(priorVisible) };
  }

  // --- one capture → authorize → project pass for the WHOLE batch ----------
  // Dual-fence discipline (re-review GAP 4): the anchor fence is read BEFORE
  // capture begins and re-checked after projection. A commit landing between
  // the two reads means the candidate graph spans a commit boundary — the
  // throw routes through the caller's retry/snapshot recovery instead of
  // emitting a patch that would advance the recipient to an unearned anchor.
  const anchorFenceBeforeCapture = input.readAnchorSeq();
  const captured = captureSnapshot({
    db: input.db,
    principal,
    anchor: declaration.anchor as never,
    id: handleId,
    output: declaration.output as never,
    tombstones: (declaration.tombstones ?? null) as never,
  });
  if (!captured) {
    return { operations: [], actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: true, visibleAfter: new Map() };
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
  // relation branches round-trip unchanged (re-review GAP 3b).
  if (anchorTouched) {
    const selectEntry = declaration.output.entries.find((entry) => entry.kind === 'select');
    const fields = ['id', ...(selectEntry && selectEntry.kind === 'select' ? (selectEntry.fields ?? []) : [])];
    const relationKeys = declaration.output.entries.filter((entry) => entry.kind !== 'select').map((entry) => entry.key);
    const value: Record<string, unknown> = {};
    for (const field of [...fields, ...relationKeys]) value[field] = (projected as Record<string, unknown>)[field];
    operations.push({ op: 'replace-fields', path: [], value });
  }

  // --- relation branches -----------------------------------------------------
  interface KeyedEmit {
    readonly branchId: string;
    readonly relation: PatchPlanRelation;
    /** memberIds -> affected ids resolved at that addressing instance. */
    readonly instances: Map<string, Set<string>>;
  }
  const manyEmits = new Map<string, PatchPlanRelation>();
  const valueEmits = new Map<string, PatchPlanRelation>();
  const keyedEmits = new Map<string, KeyedEmit>();

  for (const [branchId, ids] of touched) {
    if (branchId === 'anchor') continue;
    const relation = findRelation(plan, branchId);
    if (!relation) throw new Error('journal names a branch outside the compiled plan');
    if (relation.kind === 'many') {
      manyEmits.set(branchId, relation);
      continue;
    }
    if (relation.kind === 'one' || relation.kind === 'count') {
      valueEmits.set(branchId, relation);
      continue;
    }
    // keyed: resolve each affected row's keyed-ancestor member chain from the
    // captured graph; rows absent from the captured graph (removed/hidden)
    // resolve to [] and are addressed below: a TOP-LEVEL keyed removal needs
    // no ancestor segments, so it is emitted directly when the ledger proves
    // prior receipt. Deeper keyed-in-keyed removals have no provable address —
    // throw → snapshot fallback.
    const chain = branchChain(plan, branchId);
    const resolved = collectInstances(captured, chain, ids);
    if (resolved === null) throw new Error('affected keyed member could not be located in the captured graph');
    const hasKeyedAncestor = chain.slice(0, -1).some((step) => step.kind === 'keyed');
    for (const [id, memberIds] of resolved) {
      if (memberIds.length === 0 && hasKeyedAncestor) {
        // Removed row under a keyed ancestor: its address is unknowable from
        // post-state alone. Fail closed — the caller falls back to a full
        // authorized snapshot, never to a guessed path.
        throw new Error('removed nested keyed member lacks a provable keyed address');
      }
      const key = memberIds.join('\u0000');
      let emit = keyedEmits.get(branchId);
      if (!emit) keyedEmits.set(branchId, emit = { branchId, relation, instances: new Map() });
      let bucket = emit.instances.get(key);
      if (!bucket) emit.instances.set(key, bucket = new Set());
      bucket.add(id);
    }
  }

  // one/count: authorized replacement at the relation-instance path.
  for (const [, relation] of valueEmits) {
    const chain = branchChain(plan, relation.branchId);
    const path = instancePath(chain, []);
    const value = navigate(projected, [...path, keyOf(relation)]);
    operations.push(relation.kind === 'count'
      ? { op: 'replace-value', path: [...path, keyOf(relation)], value }
      : { op: 'replace-one', path: [...path, keyOf(relation)], value: (value ?? null) as Record<string, unknown> | null });
  }

  // many: whole-relation replacement at the smallest affected instance.
  for (const [, relation] of manyEmits) {
    const chain = branchChain(plan, relation.branchId);
    const path = instancePath(chain, keyedAncestorsOf(captured, chain));
    const value = navigate(projected, [...path, keyOf(relation)]);
    if (!Array.isArray(value)) throw new Error('projected many relation is not an array');
    operations.push({ op: 'replace-many', path: [...path, keyOf(relation)], value: value.map((row) => ({ ...row })) });
  }

  // keyed: member-level put/remove; removals ledger-gated.
  for (const [, emit] of keyedEmits) {
    const chain = branchChain(plan, emit.branchId);
    const ancestorChain = chain.slice(0, -1);
    for (const [membersKey, ids] of emit.instances) {
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
        if (provenVisible(priorVisible, emit.branchId, emit.relation.entity, id)) {
          operations.push({ op: 'remove-keyed', path: collectionPath, id });
          continue;
        }
        // Not admitted now and never proven delivered: named by nothing.
      }
    }
  }

  const visibleAfter = deriveVisibility(plan, projected as Record<string, unknown>);
  return { operations, actionIds: [...actionIds], routedInvisibleActionIds: [...routedInvisible], revokedAnchor: false, visibleAfter };
}

/**
 * Member-id chain for the FIRST keyed instance above a many/count touch,
 * resolved from the captured graph. Nested many-under-keyed addressing uses
 * the first located instance; multiple simultaneous instances collapse to a
 * coarser replace (safe: replacement is idempotent per instance).
 */
/**
 * Member-id chain for the FIRST keyed instance above a many/count touch,
 * resolved from the captured graph. Nested many-under-keyed addressing uses
 * the first located instance; multiple simultaneous instances collapse to a
 * coarser replace (safe: replacement is idempotent per instance). The chain
 * EXCLUDES the final relation itself — only ancestors contribute segments.
 */
function keyedAncestorsOf(root: SnapshotNodeLike, chain: readonly PatchPlanRelation[]): string[] {
  const memberIds: string[] = [];
  const walk = (node: SnapshotNodeLike, index: number): boolean => {
    if (index >= chain.length - 1) return true; // stop BEFORE the final relation
    const relation = chain[index];
    for (const [entry, children] of node.children) {
      if ((entry as { key?: string }).key !== keyOf(relation)) continue;
      for (const child of children) {
        if (relation.kind === 'keyed') memberIds.push(String(child.raw.id));
        if (walk(child, index + 1)) return true;
        if (relation.kind === 'keyed') memberIds.pop();
      }
    }
    return false;
  };
  walk(root, 0);
  return memberIds;
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
