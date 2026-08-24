// Erasure prerequisite infrastructure (#134, delete-undo design §5/§11 Phase B).
//
// A stored private fact may encode the ability to RESURRECT work whose
// restoration depends on other entities (a v3 annotated-text delete fact can
// restore annotation edges only while the referenced Comment/Code/profile rows
// are live). `_PrivateActionFactDependency` is the identities-only index of
// those dependencies; this module is its singular owner:
//
// - `factDependencies` derives the canonical dependency set of one VALIDATED
//   canonical fact (identities only — never field values);
// - `recordFactDependencies` joins fact storage inside the commit transaction;
// - `invalidateDependencies` runs at directive time: it deletes the dependent
//   private facts (their dependency rows cascade) and returns their action ids
//   so the erasure path can prune history-session cursor frames that would
//   otherwise resurrect the invalidated contribution;
// - `sweepFactDependencies` keeps the index exactly aligned when a caller
//   deletes private facts outside a cascade-capable connection.
//
// Invalidation permanently removes resurrection capability. It is NOT an
// expansion of the erasure census target set: census receipts/log rows stay
// untouched, and an unrelated fact remains undoable.

import type { DbHandle } from './driver.ts';
import { parseDeleteFact } from './annotated-text-delete-history.ts';
import { compoundKindOf, parseCompoundContributionFact } from './compound-contribution-fact.ts';

export interface FactDependency {
  readonly entity: string;
  readonly entityId: string;
}

function fail(message: string): never {
  throw new TypeError(`private action fact dependency: ${message}`);
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

/**
 * Canonical dependency set of one validated private fact. Only validated v3
 * `annotated-text.delete-contribution` facts carry dependencies today, plus
 * compound envelopes whose nested annotated contributions carry them: every
 * captured annotation prerequisite (the ref rows Undo must find live), plus
 * the owning document itself — transcript retirement must invalidate every
 * delete fact for that document even when the capture carried no ref.
 * Anything else (v2 contributions, barriers, compensations, before/after
 * application facts) depends on nothing.
 */
export function factDependencies(canonicalFact: unknown): readonly FactDependency[] {
  if (!canonicalFact || typeof canonicalFact !== 'object' || Array.isArray(canonicalFact)) return [];
  const record = canonicalFact as Record<string, unknown>;
  const byKey = new Map<string, FactDependency>();
  // scope#992 rev 4: a compound envelope's nested annotated contributions feed
  // the existing delete-contribution dispatcher; the application half contributes
  // no dependency rows. Unknown nested kinds already fail compound parsing.
  if (compoundKindOf(record) !== null) {
    let parsed: ReturnType<typeof parseCompoundContributionFact>;
    try {
      parsed = parseCompoundContributionFact(record);
    } catch (error) {
      throw new TypeError(`compound contribution dependency is malformed: ${(error as Error).message}`);
    }
    for (const contribution of parsed.contributions) {
      const fact = parseDeleteFact(contribution);
      for (const image of fact.contribution.annotations) {
        for (const prerequisite of image.prerequisites) {
          byKey.set(`${prerequisite.entity}\u0000${prerequisite.id}`, { entity: prerequisite.entity, entityId: prerequisite.id });
        }
      }
      byKey.set(`document\u0000${fact.documentId}`, { entity: 'document', entityId: fact.documentId });
    }
    return [...byKey.values()].sort(dependencyOrder);
  }
  // Only delete-contribution facts carry dependencies; anything CLAIMING that
  // kind must fully validate (fail closed on forged or malformed shapes).
  if (record.kind !== 'annotated-text.delete-contribution') return [];
  const fact = parseDeleteFact(record);
  for (const image of fact.contribution.annotations) {
    for (const prerequisite of image.prerequisites) {
      byKey.set(`${prerequisite.entity}\u0000${prerequisite.id}`, { entity: prerequisite.entity, entityId: prerequisite.id });
    }
  }
  // The document itself is a restoration prerequisite of its own delete fact:
  // erasing/retiring the document invalidates every captured deletion for it,
  // prerequisite-bearing or not (design §5).
  byKey.set(`document\u0000${fact.documentId}`, { entity: 'document', entityId: fact.documentId });
  return [...byKey.values()].sort(dependencyOrder);
}

function dependencyOrder(left: FactDependency, right: FactDependency): number {
  return left.entity < right.entity ? -1 : left.entity > right.entity ? 1
    : left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0;
}

/**
 * Persist one fact's derived dependency rows. Must run in the same
 * transaction that inserts the `_PrivateActionFact` row; rows cascade with
 * the fact's originOrder.
 */
export function recordFactDependencies(db: DbHandle, { scope, actionId, canonicalFact }: {
  scope: string;
  actionId: string;
  canonicalFact: unknown;
}): number {
  const dependencies = factDependencies(canonicalFact);
  if (dependencies.length === 0) return 0;
  const owner = db.prepare('SELECT originOrder FROM _PrivateActionFact WHERE scope = ? AND actionId = ?')
    .get(scope, actionId) as { originOrder: number } | undefined;
  if (!owner) fail('dependency rows require the stored private fact');
  const insert = db.prepare(
    'INSERT INTO _PrivateActionFactDependency (scope, actionId, entity, entityId, originOrder) VALUES (?, ?, ?, ?, ?)',
  );
  let recorded = 0;
  for (const { entity, entityId } of dependencies) {
    recorded += Number(insert.run(scope, actionId, entity, entityId, owner.originOrder).changes);
  }
  return recorded;
}

/**
 * Directive-time invalidation: delete every stored private fact that declares
 * a dependency on `{ entity, id }` and return the invalidated (scope,
 * actionId) rows. Dependency rows die through the FK cascade; callers prune
 * history-session cursors from the returned rows so no session frame — in ANY
 * affected scope — can still reference an unrestorable contribution.
 */
export function invalidateDependencies(db: DbHandle, subject: FactDependency): ReadonlyArray<Readonly<{ scope: string; actionId: string }>> {
  requireText(subject.entity, 'subject.entity');
  requireText(subject.entityId, 'subject.entityId');
  const dependent = db.prepare(
    'SELECT DISTINCT scope, actionId FROM _PrivateActionFactDependency WHERE entity = ? AND entityId = ?',
  ).all(subject.entity, subject.entityId) as Array<{ scope: string; actionId: string }>;
  if (dependent.length === 0) return [];
  const deleteDependency = db.prepare('DELETE FROM _PrivateActionFactDependency WHERE scope = ? AND actionId = ?');
  const deleteFact = db.prepare('DELETE FROM _PrivateActionFact WHERE scope = ? AND actionId = ?');
  const invalidated: Array<Readonly<{ scope: string; actionId: string }>> = [];
  for (const row of dependent) {
    invalidated.push(Object.freeze({ scope: row.scope, actionId: row.actionId }));
    deleteDependency.run(row.scope, row.actionId);
    deleteFact.run(row.scope, row.actionId);
  }
  return Object.freeze(invalidated);
}

/**
 * Explicit sweep keeping the dependency index exactly aligned with
 * `_PrivateActionFact` after a caller deletes fact rows on a connection where
 * the FK pragma cannot be relied upon to cascade. Returns the removed rows.
 */
export function sweepFactDependencies(db: DbHandle): number {
  return db.prepare(
    'DELETE FROM _PrivateActionFactDependency WHERE NOT EXISTS ('
    + 'SELECT 1 FROM _PrivateActionFact WHERE _PrivateActionFact.originOrder = _PrivateActionFactDependency.originOrder)',
  ).run().changes;
}
