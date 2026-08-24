// Composite patch delivery (#122 design §8/§10/§12).
//
// Glue between the owned live-delivery seam and the composite patch
// machinery: capability parsing, bootstrap-with-ledger, catch-up over the
// journal, and per-recipient envelope assembly. Kept OUT of
// live-delivery-public.ts so that module stays the snapshot-only authority;
// this module composes it, never duplicates it.

import { tryParseScopeKey } from './scope-handle.ts';
import type { ScopeHandle } from './scope-handle.ts';
import { readSeq } from './committed-log.ts';
import { currentCompositeSeq, minCompositeSeq, readCompositeChangesSince } from './composite-journal.ts';
import { compilePatchPlans } from './composite-patch-plan.ts';
import type { AnchorPatchPlan } from './composite-patch-plan.ts';
import type { CompositeCursorV1, CompositePatchEnvelopeV1 } from './composite-patch-envelope.ts';import { createProjectionLedger } from './projection-token.ts';
import type { ProjectionLedger } from './projection-token.ts';
import { projectCompositePatch } from './composite-patch-projector.ts';
import type { PatchProjection } from './composite-patch-projector.ts';
import type { DbHandle } from './driver.ts';
import type { Principal } from './principal.ts';

/** The unadvertised capability string servers accept during rollout step 1. */
export const SNAPSHOT_PATCH_CAPABILITY = 'snapshot-patch/v1';

export interface CompositePatchDeliveryOptions {
  db: DbHandle;
  /** Compiled composite declarations (name -> declaration), as live-delivery-public holds them. */
  composites: ReadonlyMap<string, unknown>;
  mayVerb: unknown;
  authorization: unknown;
  includeActionId: boolean;
}

export interface PatchBootstrapResult {
  kind: 'snapshot' | 'revoked' | 'retry';
  snapshot?: unknown;
  cursor?: CompositeCursorV1 | number | Readonly<{ anchor: number; aggregate: number }>;
  projectionToken?: string;
  protocol?: typeof SNAPSHOT_PATCH_CAPABILITY;
  reason?: string;
}

export function parseRequestedCapabilities(capabilities: unknown): { patchCapable: boolean } {
  if (!Array.isArray(capabilities)) return { patchCapable: false };
  return { patchCapable: capabilities.includes(SNAPSHOT_PATCH_CAPABILITY) };
}

/**
 * Create the composite patch lane for one owned delivery. Returns null when no
 * composite declarations exist — hosts without snapshots keep today's exact
 * behavior with zero new state.
 */
export function createCompositePatchDelivery({ db, composites, mayVerb, authorization, includeActionId }: CompositePatchDeliveryOptions): CompositePatchDelivery | null {
  const compiled = [...composites.entries()] as Array<[string, unknown]>;
  if (compiled.length === 0) return null;
  // The public SnapshotDeclaration is structurally wider (looser) than the
  // compiled one; the plan compiler reads only the shared structural shape.
  const plans = compilePatchPlans(compiled as never);
  const ledger = createProjectionLedger();
  return new CompositePatchDelivery(db, compiled as never, plans, ledger, mayVerb, authorization, includeActionId);
}

export class CompositePatchDelivery {
  private readonly db: DbHandle;
  private readonly composites: ReadonlyMap<string, unknown>;
  private readonly plans: ReadonlyMap<string, AnchorPatchPlan>;
  private readonly ledger: ProjectionLedger;
  private readonly mayVerb: unknown;
  private readonly authorization: unknown;
  private readonly includeActionId: boolean;

  constructor(db: DbHandle, composites: ReadonlyMap<string, unknown>, plans: ReadonlyMap<string, AnchorPatchPlan>, ledger: ProjectionLedger, mayVerb: unknown, authorization: unknown, includeActionId: boolean) {
    this.db = db;
    this.composites = composites;
    this.plans = plans;
    this.ledger = ledger;
    this.mayVerb = mayVerb;
    this.authorization = authorization;
    this.includeActionId = includeActionId;
  }

  planFor(scopeHandle: ScopeHandle): AnchorPatchPlan | null {
    return this.plans.get(scopeHandle.entity) ?? null;
  }

  /**
   * Bootstrap for a patch-capable recipient: run the host's ordinary snapshot
   * result through the SAME capture/authorize/project seam (the caller supplies
   * its already-authorized snapshot value), then register the visibility
   * ledger and mint the first token.
   */
  async bootstrapFromSnapshot({ principal, scope, snapshotValue, anchor }: {
    principal: Principal;
    scope: string;
    /** The authorized+projected snapshot object the ordinary path produced. */
    snapshotValue: Record<string, unknown>;
    anchor: unknown;
  }): Promise<PatchBootstrapResult> {
    const handle = tryParseScopeKey(scope);
    const plan = this.plans.get(handle!.entity);
    const declaration = this.composites.get(handle!.entity);
    if (!plan || !declaration) return { kind: 'revoked' };
    // Derive visibility from the projected value itself — one walk against the
    // plan; identical semantics to the projector's post-patch derivation.
    const visible = deriveVisibilityExport(plan, snapshotValue);
    const cursor: CompositeCursorV1 = Object.freeze({ anchor: readSeq(this.db, scope), composite: currentCompositeSeq(this.db, scope) });
    const { projectionToken } = this.ledger.register({ principal, scope, planVersion: plan.version, cursor, visible });
    void anchor;
    return {
      kind: 'snapshot',
      snapshot: snapshotValue,
      cursor,
      projectionToken,
      protocol: SNAPSHOT_PATCH_CAPABILITY,
    };
  }

  /**
   * Catch-up for a patch-capable recipient: validate token + cursor, replay
   * the journal slice into ONE coalesced patch envelope, rotate the token.
   * Any anomaly returns a full-snapshot fallback marker.
   */
  async catchupWithPatches(input: { principal: Principal; scope: string; after: CompositeCursorV1; projectionToken: string; document?: unknown }): Promise<
    | { kind: 'catchup'; envelopes: CompositePatchEnvelopeV1[]; cursor: CompositeCursorV1 }
    | { kind: 'snapshot-fallback'; reason: string }
    | { kind: 'revoked' }
  > {
    const handle = tryParseScopeKey(input.scope);
    const plan = handle ? this.plans.get(handle.entity) : null;
    if (!handle || !plan) return { kind: 'revoked' };
    const entry = this.ledger.resolve({
      token: input.projectionToken,
      principal: input.principal,
      scope: input.scope,
      planVersion: plan.version,
      cursor: input.after,
    });
    if (!entry) return { kind: 'snapshot-fallback', reason: 'projection-token-missing-or-mismatched' };

    const toComposite = currentCompositeSeq(this.db, input.scope);
    if (input.after.composite > toComposite) return { kind: 'snapshot-fallback', reason: 'cursor-ahead-of-journal' };
    if (input.after.composite === toComposite) {
      return { kind: 'catchup', envelopes: [], cursor: input.after };
    }
    const min = minCompositeSeq(this.db, input.scope);
    const changes = readCompositeChangesSince(this.db, input.scope, input.after.composite);
    // Journal retention must fall back together with _Log retention (design §14):
    // a gap below the oldest retained change is unfillable.
    if (min !== null && min > input.after.composite + 1 && changes.some((change) => change.invalidating)) {
      return { kind: 'snapshot-fallback', reason: 'journal-invalidating-change' };
    }
    if (changes.length === 0 || (min !== null && min > input.after.composite + 1)) {
      return { kind: 'snapshot-fallback', reason: 'journal-gap' };
    }

    try {
      const declaration = this.composites.get(handle.entity)!;
      const projection: PatchProjection = await projectCompositePatch({
        db: this.db,
        principal: input.principal,
        scope: input.scope,
        plan,
        declaration: declaration as never,
        mayVerb: this.mayVerb,
        authorization: this.authorization,
        from: input.after,
        to: { anchor: input.after.anchor, composite: toComposite },
        changes,
        includeActionId: this.includeActionId,
        priorVisible: entry.visible,
        readCompositeSeq: () => currentCompositeSeq(this.db, input.scope),
      });
      if (projection.revokedAnchor) return { kind: 'revoked' };
      const cursorAfter: CompositeCursorV1 = Object.freeze({ anchor: readSeq(this.db, input.scope), composite: toComposite });
      const { projectionToken } = this.ledger.register({
        principal: input.principal,
        scope: input.scope,
        planVersion: plan.version,
        cursor: cursorAfter,
        visible: projection.visibleAfter,
      });
      const envelope: CompositePatchEnvelopeV1 = {
        type: 'snapshot-patch',
        protocol: 'snapshot-patch/v1',
        declaration: plan.declaration,
        from: input.after,
        to: cursorAfter,
        seqSpan: [input.after, cursorAfter],
        ...(this.includeActionId && projection.actionIds.length > 0 ? { actionIds: projection.actionIds } : {}),
        operations: projection.operations,
        projectionToken,
      };
      return { kind: 'catchup', envelopes: [envelope], cursor: cursorAfter };
    } catch (error) {
      return { kind: 'snapshot-fallback', reason: error instanceof Error ? error.message : 'patch-projection-failed' };
    }
  }

  close(): void {
    this.ledger.clear();
  }
}

// One shared visibility walk (kept out of the projector's export surface to
// avoid a public API beyond what tests consume; both call sites use this).
import { deriveVisibility } from './composite-patch-projector.ts';
function deriveVisibilityExport(plan: AnchorPatchPlan, projected: Record<string, unknown>): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> {
  return deriveVisibility(plan, projected);
}
