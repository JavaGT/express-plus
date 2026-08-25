// Composite change journal (#122 design §3).
//
// A durable, per-composite-scope record of which compiled snapshot branches a
// committed action may have changed, written transactionally with _Log,
// _ActionReceipt, and the private before/after facts inside the commit
// pipeline. The journal owns the composite cursor sequence: `composite` is a
// per-scope counter over these entries, never the global aggregate revision.
//
// Recipient safety: entries carry identities and ROUTING reasons only — never
// recipient-projected field values, never raw _Log.eventData. Routing derives
// exclusively from the compiled patch plan plus in-transaction before/after
// row evidence; when the evidence cannot identify the affected scope the entry
// is marked invalidating (declaration-wide resync), never guessed.

import { prepareCached, type DbHandle } from './driver.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import type { AnchorPatchPlan, PatchPlanRelation } from './composite-patch-plan.ts';

export function compositeChangeTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _CompositeChange (
  scope TEXT NOT NULL,
  seq INTEGER NOT NULL,
  declaration TEXT NOT NULL,
  actionId TEXT NOT NULL,
  eventRefs TEXT NOT NULL,
  affected TEXT NOT NULL,
  invalidating INTEGER NOT NULL DEFAULT 0,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (scope, seq)
);`;
}

export function compositeChangeCursorTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _CompositeChangeCursor (
  scope TEXT NOT NULL PRIMARY KEY,
  lastSeq INTEGER NOT NULL
);`;
}

export function compositeChangeIndexDDL() {
  return 'CREATE INDEX IF NOT EXISTS idx__CompositeChange_actionId ON _CompositeChange (actionId);';
}

export function compositeJournalDDL(): string[] {
  return [compositeChangeTableDDL(), compositeChangeCursorTableDDL(), compositeChangeIndexDDL()];
}

// ---- shapes ----

export type CompositeChangeReason = 'create' | 'update' | 'remove' | 'reparent' | 'order' | 'tombstone' | 'invalidate';

export interface CompositeAffected {
  /** Compiler-assigned stable branch identity ('anchor' or a dot-joined relation path). */
  readonly branch: string;
  readonly entity: string;
  readonly id: string;
  readonly reason: CompositeChangeReason;
}

export interface CompositeChangeInput {
  readonly scope: string;
  readonly declaration: string;
  readonly actionId: string;
  readonly eventRefs: readonly { readonly scope: string; readonly seq: number }[];
  readonly affected: readonly CompositeAffected[];
  /** true: the affected scopes cannot be proven — receivers must fully resync. */
  readonly invalidating?: boolean;
}

export interface StoredCompositeChange {
  readonly scope: string;
  readonly seq: number;
  readonly declaration: string;
  readonly actionId: string;
  readonly eventRefs: readonly { readonly scope: string; readonly seq: number }[];
  readonly affected: readonly CompositeAffected[];
  readonly invalidating: boolean;
}

interface RowEvidence {
  /** Pre-image rows by entity name and row id, captured in-txn before projection. */
  readonly before: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
  /** Post-image rows by entity name and row id, read in-txn after projection. */
  readonly after: ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;
}

function rowOf(evidence: RowEvidence, phase: 'before' | 'after', entity: string, id: unknown): Record<string, unknown> | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  const row = evidence[phase].get(entity)?.get(id);
  return row ?? null;
}

// The router classifies events by the event TYPE suffix — the same contract
// snapshotEventTouchesComposite already uses.
/** Entity name from an event type ('Code.updated' -> 'Code'), else null. */
function classifyEntityName(eventType: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(eventType);
  return match ? match[1] : null;
}

function classify(eventType: string): { phase: 'created' | 'updated' | 'removed' } | { phase: 'native'; field: string } | null {
  if (eventType.endsWith('.created')) return { phase: 'created' };
  if (eventType.endsWith('.updated')) return { phase: 'updated' };
  if (eventType.endsWith('.removed')) return { phase: 'removed' };
  const operated = /\.([A-Za-z_][A-Za-z0-9_]*)\.(operated|retired|restored)$/.exec(eventType);
  if (operated) return { phase: 'native', field: operated[1] };
  return null;
}

/** All plan branches (depth-first) whose child entity matches `entity`, including the synthetic anchor branch. */
function branchesForEntity(plan: AnchorPatchPlan, entity: string): PatchPlanRelation[] {
  const found: PatchPlanRelation[] = [];
  const visit = (relations: readonly PatchPlanRelation[]): void => {
    for (const relation of relations) {
      if (relation.entity === entity) found.push(relation);
      visit(relation.children);
    }
  };
  visit(plan.relations);
  return found;
}

/**
 * Resolve the owning composite scope(s) a member row belongs to, from one plan
 * branch. Inverse relations read the child's fk column directly; forward
 * ('one') relations require a bounded reverse lookup of parent ids. Returns
 * null when the parent linkage cannot be established from the supplied row.
 */
/**
 * Resolve the owning composite scope(s) a member row belongs to, from one plan
 * branch. Nested branches walk UP their parent chain: the child's fk names its
 * immediate parent row, the parent's own fk names ITS parent, and so on until
 * the anchor id is proven (design §3, "nested parent paths"). Returns null
 * when any hop lacks evidence — the caller invalidates rather than guesses.
 */
function parentScopesFor(db: DbHandle, plans: ReadonlyMap<string, AnchorPatchPlan>, plan: AnchorPatchPlan, relation: PatchPlanRelation, row: Record<string, unknown>): string[] | null {
  // Build the branch chain from root to this relation for upward walking.
  const chain: PatchPlanRelation[] = [];
  const segments = relation.branchId.split('.');
  for (let end = 1; end <= segments.length; end += 1) {
    const found = findBranch(plans.get(plan.declaration), segments.slice(0, end).join('.'));
    if (!found) return null;
    chain.push(found);
  }
  // The row's id at each chain level; start from the changed row itself.
  let currentRow = row;
  let currentEntity = relation.entity;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const step = chain[index];
    if (step.entity !== currentEntity) return null;
    if (step.inverse) {
      const parentId = currentRow[step.fk];
      if (typeof parentId !== 'string' || parentId.length === 0) return null;
      if (index === 0) return [`${plan.declaration}:${parentId}`];
      // Read the parent row to continue the walk.
      try {
        const parentRow = db.prepare(`SELECT * FROM ${step.parentEntity} WHERE id = ?`).get(parentId) as Record<string, unknown> | undefined;
        if (!parentRow) return null;
        const parentRelation = chain[index - 1];
        currentRow = parentRow;
        currentEntity = step.parentEntity;
        void parentRelation;
      } catch {
        return null;
      }
    } else {
      // Forward step: parent rows holding fk = this row's id. Bounded reverse
      // lookup; each match is one candidate scope path.
      const identifier = step.fk.replace(/[^A-Za-z0-9_]/g, '');
      if (!identifier || identifier !== step.fk || index !== 0) return null;
      const rows = db.prepare(`SELECT id FROM ${step.parentEntity} WHERE ${identifier} = ?`).all(currentRow.id);
      return rows.map((parent) => `${plan.declaration}:${String(parent.id)}`);
    }
  }
  return null;
}

/** Locate a plan branch by id within one plan (or across none). */
function findBranch(plan: AnchorPatchPlan | undefined, branchId: string): PatchPlanRelation | null {
  if (!plan) return null;
  const visit = (relations: readonly PatchPlanRelation[]): PatchPlanRelation | null => {
    for (const relation of relations) {
      if (relation.branchId === branchId) return relation;
      const nested = visit(relation.children);
      if (nested) return nested;
    }
    return null;
  };
  return visit(plan.relations);
}

interface RouterEvent {
  readonly type: string;
  readonly scope: string;
  readonly seq: number;
  readonly actionId: string;
}

/**
 * Route one finalized committed event into per-composite-scope change entries,
 * using the compiled plan and in-transaction before/after evidence only.
 * Returns [] when the provably touches nothing the declaration projects.
 */
export function routeCompositeEvent(db: DbHandle, plans: ReadonlyMap<string, AnchorPatchPlan>, event: RouterEvent, evidence: RowEvidence): CompositeChangeInput[] {
  const handle = tryParseScopeKey(event.scope);
  if (!handle) return [];
  const classified = classify(event.type);
  if (!classified) return [];
  const entries = new Map<string, CompositeChangeInput>();

  const add = (input: Omit<CompositeChangeInput, 'eventRefs'>): void => {
    const existing = entries.get(input.scope);
    if (!existing) {
      entries.set(input.scope, { ...input, eventRefs: [{ scope: event.scope, seq: event.seq }] });
      return;
    }
    const merged = [...existing.affected];
    for (const affected of input.affected) {
      if (!merged.some((candidate) => candidate.branch === affected.branch && candidate.id === affected.id && candidate.reason === affected.reason)) merged.push(affected);
    }
    entries.set(input.scope, { ...existing, affected: merged, invalidating: existing.invalidating || Boolean(input.invalidating) });
  };

  // --- anchor events -------------------------------------------------------
  // The event TYPE names the changed row's entity; the event SCOPE only names
  // the owning composite scope (member rows inherit it). Route as an anchor
  // change only when the type's entity IS the declaration anchor.
  const eventTypeEntity = classifyEntityName(event.type);
  const anchorPlan = plans.get(handle.entity);
  const isAnchorEvent = anchorPlan !== undefined && eventTypeEntity === handle.entity;
  if (anchorPlan && isAnchorEvent) {
    if (classified.phase === 'created') {
      add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: handle.entity, id: handle.id, reason: 'create' }] });
    } else if (classified.phase === 'removed') {
      // Terminal anchor deletion: existing revoke/deleted handling consumes the
      // tombstone; the journal still records the terminal change so catch-up
      // chains stay continuous.
      add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: handle.entity, id: handle.id, reason: 'remove' }] });
    } else {
      const changed = Object.keys((event as { data?: Record<string, unknown> }).data ?? {}).filter((field) => field !== 'id');
      const selectedChanged = changed.filter((field) => anchorPlan.anchorSelect.includes(field));
      if (selectedChanged.length > 0) {
        add({ scope: event.scope, declaration: anchorPlan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: handle.entity, id: handle.id, reason: 'update' }] });
      }
      // An unselected anchor-field update produces no entry: nothing the
      // declaration projects changed (generalizes snapshotEventTouchesComposite).
    }
  }

  // --- tombstone-rule events ----------------------------------------------
  for (const plan of plans.values()) {
    const rule = plan.tombstone;
    if (!rule || rule.entity !== handle.entity) continue;
    if (classified.phase === 'native') continue;
    const afterRow = rowOf(evidence, 'after', rule.entity, (event as { data?: { id?: unknown } }).data?.id)
      ?? rowOf(evidence, 'before', rule.entity, (event as { data?: { id?: unknown } }).data?.id);
    if (!afterRow || typeof afterRow[rule.entityId] !== 'string') {
      // Tombstone identity without a readable row: the target scope is unknowable.
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }
    const targetScopeValue = rule.scopeId ? afterRow[rule.scopeId] : null;
    if (rule.scopeId && (typeof targetScopeValue !== 'string' || targetScopeValue.length === 0)) {
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }
    const scope = rule.scopeId ? `${plan.declaration}:${targetScopeValue as string}` : `${plan.declaration}:${String(afterRow[rule.entityId])}`;
    const beforeRow = rowOf(evidence, 'before', rule.entity, afterRow.id);
    const hiddenStates = rule.hidden as readonly string[];
    const stateOf = (row: Record<string, unknown> | null): boolean | null => row == null ? null : hiddenStates.includes(String(row[rule.state]));
    const hiddenBefore = stateOf(beforeRow);
    const hiddenAfter = stateOf(afterRow);
    if (classified.phase === 'created' || hiddenBefore === false && hiddenAfter === true) {
      // Entering a hidden state.
      add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: String(afterRow[rule.entityId]), id: String(afterRow[rule.entityId]), reason: 'tombstone' }] });
    } else if (classified.phase === 'removed' || hiddenBefore === true && hiddenAfter === false) {
      // Leaving a hidden state (restore) or physical tombstone deletion.
      add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: 'anchor', entity: String(afterRow[rule.entityId]), id: String(afterRow[rule.entityId]), reason: 'tombstone' }] });
    } else {
      // Visibility unchanged (e.g. GC of a visible-era row): an empty entry
      // still advances the composite cursor (design §6, tombstone GC row).
      add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [] });
    }
  }

  // --- member events -------------------------------------------------------
  for (const plan of plans.values()) {
    if (isAnchorEvent) break; // this event IS the anchor of its own declaration
    const branches = branchesForEntity(plan, eventTypeEntity ?? '');
    if (branches.length === 0) continue;
    // The changed MEMBER row's identity: the event type names its entity and
    // the payload names its id — NOT the scope handle's id (which is the
    // anchor's for inherited scopes).
    const memberId = typeof (event as { data?: { id?: unknown } }).data?.id === 'string' ? (event as { data: { id: string } }).data.id : null;
    const id = memberId ?? handle.id;

    if (classified.phase === 'removed') {
      // Removal routing needs the pre-image to locate the owning scope; the
      // public event payload ({id}) deliberately cannot provide it.
      const beforeRow = rowOf(evidence, 'before', eventTypeEntity ?? '', id);
      if (!beforeRow) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      for (const branch of branches) {
        const scopes = parentScopesFor(db, plans, plan, branch, beforeRow);
        if (!scopes) {
          add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
          continue;
        }
        for (const scope of scopes) {
          add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'remove' }] });
        }
      }
      continue;
    }

    const afterRow = rowOf(evidence, 'after', eventTypeEntity ?? '', id);
    if (!afterRow) {
      // An upsert/lifecycle mutation whose projected row cannot be read is
      // indistinguishable from a broken projection: invalidate rather than guess.
      const beforeFallback = rowOf(evidence, 'before', handle.entity, id);
      if (beforeFallback) {
        for (const branch of branches) {
          const scopes = parentScopesFor(db, plans, plan, branch, beforeFallback);
          for (const scope of scopes ?? []) {
            add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'invalidate' }], invalidating: true });
          }
        }
      }
      add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
      continue;
    }

    for (const branch of branches) {
      const scopes = parentScopesFor(db, plans, plan, branch, afterRow);
      if (!scopes) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      const changed = Object.keys((event as { data?: Record<string, unknown> }).data ?? {}).filter((field) => field !== 'id');
      const relevant = new Set<string>([...branch.selected, ...branch.nestedSelect]);
      if (branch.order) relevant.add(branch.order.field);
      if (branch.require) relevant.add(branch.require.childRef);

      for (const scope of scopes) {
        if (classified.phase === 'created') {
          add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'create' }] });
          continue;
        }
        // updated / native
        const touched = changed.filter((field) => relevant.has(field));
        const beforeRowForCompare = rowOf(evidence, 'before', eventTypeEntity ?? '', id);
        const reparenting = branch.inverse
          && changed.includes(branch.fk)
          && beforeRowForCompare !== null
          && beforeRowForCompare[branch.fk] !== afterRow[branch.fk];
        if (reparenting) {
          const beforeRow = beforeRowForCompare;
          const previousParent = beforeRow ? beforeRow[branch.fk] : undefined;
          if (typeof previousParent !== 'string' || previousParent.length === 0) {
            // The old placement is unknowable from private evidence: the old
            // scope's removal cannot be proven — declaration-wide resync.
            add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
            continue;
          }
          const oldScope = `${plan.declaration}:${previousParent}`;
          add({ scope: oldScope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'reparent' }] });
          if (oldScope !== scope) {
            add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'reparent' }] });
          } else {
            // Same-parent fk rewrite still replaces branch membership ordering.
            add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason: 'order' }] });
          }
          continue;
        }
        if (touched.length > 0) {
          const reason = branch.order && touched.includes(branch.order.field) ? 'order' : 'update';
          add({ scope, declaration: plan.declaration, actionId: event.actionId, affected: [{ branch: branch.branchId, entity: eventTypeEntity ?? plan.declaration, id, reason }] });
        }
        // Native annotated-text edits touch no selected field of any branch:
        // they produce no entry (the exact gate snapshotEventTouchesComposite
        // implements today, derived from the plan instead).
      }
    }
  }

  // Required-relation exposure changes: a related row appearing or disappearing
  // admits/denies every child pointing at it through the branch requirement.
  for (const plan of plans.values()) {
    if (classified.phase === 'native') continue;
    const relatedBranches = branchesForRelatedEntity(plan, handle.entity);
    for (const { branch } of relatedBranches) {
      const require = branch.require!;
      const row = rowOf(evidence, 'after', handle.entity, handle.id) ?? rowOf(evidence, 'before', handle.entity, handle.id);
      if (!row) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      // Children admitted through this related row live in its parent's scope.
      const parentId = row[require.fk];
      if (typeof parentId !== 'string' || parentId.length === 0) {
        add({ scope: '', declaration: plan.declaration, actionId: event.actionId, affected: [], invalidating: true });
        continue;
      }
      const scope = `${plan.declaration}:${parentId}`;
      const childRows = db.prepare(`SELECT id FROM ${branch.entity} WHERE ${require.childRef.replace(/[^A-Za-z0-9_]/g, '')} = ?`).all(row.id);
      for (const child of childRows) {
        add({
          scope, declaration: plan.declaration, actionId: event.actionId,
          affected: [{ branch: branch.branchId, entity: branch.entity, id: String(child.id), reason: classified.phase === 'removed' ? 'remove' : 'update' }],
        });
      }
    }
  }

  return [...entries.values()];
}

interface RelatedHit {
  branch: PatchPlanRelation;
}

function branchesForRelatedEntity(plan: AnchorPatchPlan, entity: string): RelatedHit[] {
  const hits: RelatedHit[] = [];
  const visit = (relations: readonly PatchPlanRelation[]): void => {
    for (const relation of relations) {
      if (relation.require && relation.require.entity === entity) hits.push({ branch: relation });
      visit(relation.children);
    }
  };
  visit(plan.relations);
  return hits;
}

// ---- write ----

/**
 * Record composite change entries inside the caller's open transaction,
 * immediately after the action's events are appended. Atomic with _Log and
 * _ActionReceipt: the per-scope counter bump and every entry commit together
 * or not at all (design §3).
 */
export function recordCompositeChanges(db: DbHandle, inputs: readonly CompositeChangeInput[], committedAt: string): void {
  if (inputs.length === 0) return;
  const insertCounter = prepareCached(db,
    'INSERT INTO _CompositeChangeCursor (scope, lastSeq) VALUES (:scope, 0) ON CONFLICT(scope) DO NOTHING',
  );
  const readCounter = prepareCached(db, 'SELECT lastSeq AS last FROM _CompositeChangeCursor WHERE scope = :scope');
  const bumpCounter = prepareCached(db, 'UPDATE _CompositeChangeCursor SET lastSeq = :next WHERE scope = :scope');
  const insertChange = prepareCached(db,
    `INSERT INTO _CompositeChange (scope, seq, declaration, actionId, eventRefs, affected, invalidating, committedAt)
     VALUES (:scope, :seq, :declaration, :actionId, :eventRefs, :affected, :invalidating, :committedAt)`,
  );
  for (const input of inputs) {
    insertCounter.run({ scope: input.scope });
    const next = (readCounter.get({ scope: input.scope }) as { last: number }).last + 1;
    bumpCounter.run({ scope: input.scope, next });
    insertChange.run({
      scope: input.scope,
      seq: next,
      declaration: input.declaration,
      actionId: input.actionId,
      eventRefs: JSON.stringify(input.eventRefs),
      affected: JSON.stringify(input.affected),
      invalidating: input.invalidating ? 1 : 0,
      committedAt,
    });
  }
}

// ---- read ----

/**
 * Retained composite changes for one scope with seq > after, ordered by seq.
 * Catch-up replays THESE rows — never raw _Log rows (design §10).
 */
export function readCompositeChangesSince(db: DbHandle, scope: string, after: number): StoredCompositeChange[] {
  const rows = prepareCached(db,
    'SELECT * FROM _CompositeChange WHERE scope = :scope AND seq > :after ORDER BY seq',
  ).all({ scope, after }) as Array<Record<string, unknown>>;
  return rows.map(parseChangeRow);
}

/** Oldest retained composite seq for a scope, or null when none exist. */
export function minCompositeSeq(db: DbHandle, scope: string): number | null {
  const row = db.prepare('SELECT MIN(seq) AS min FROM _CompositeChange WHERE scope = :scope').get({ scope }) as { min: number | null };
  return row?.min ?? null;
}

/** Current composite sequence for a scope (the `composite` cursor component). */
export function currentCompositeSeq(db: DbHandle, scope: string): number {
  const row = db.prepare('SELECT lastSeq AS last FROM _CompositeChangeCursor WHERE scope = :scope').get({ scope }) as { last: number } | undefined;
  return row?.last ?? 0;
}

function parseChangeRow(row: Record<string, unknown>): StoredCompositeChange {
  return Object.freeze({
    scope: row.scope as string,
    seq: row.seq as number,
    declaration: row.declaration as string,
    actionId: row.actionId as string,
    eventRefs: JSON.parse(row.eventRefs as string),
    affected: JSON.parse(row.affected as string),
    invalidating: row.invalidating === 1,
  });
}

/**
 * Journal retention follows _Log retention exactly: receipts may reference
 * either journal, so both must fall back to snapshot recovery together
 * (design §14, Retention).
 */
export function pruneCompositeChanges(db: DbHandle, cutoffIso: string): void {
  db.prepare('DELETE FROM _CompositeChange WHERE committedAt < :cutoff').run({ cutoff: cutoffIso });
}
