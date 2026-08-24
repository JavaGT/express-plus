// Composite patch delivery (#122 design §8/§10/§12).
//
// Glue between the owned live-delivery seam and the composite patch
// machinery: capability parsing, bootstrap-with-ledger, catch-up over the
// journal, and per-recipient envelope assembly. Kept OUT of
// live-delivery-public.ts so that module stays the snapshot-only authority;
// this module composes it, never duplicates it.

import { tryParseScopeKey } from './scope-handle.mjs';

import { readSeq } from './committed-log.mjs';
import { currentCompositeSeq, minCompositeSeq, readCompositeChangesSince } from './composite-journal.mjs';
import { compilePatchPlans } from './composite-patch-plan.mjs';

                                                                                                 import { createProjectionLedger } from './projection-token.mjs';

import { projectCompositePatch } from './composite-patch-projector.mjs';




/** The unadvertised capability string servers accept during rollout step 1. */
export const SNAPSHOT_PATCH_CAPABILITY = 'snapshot-patch/v1';



















export function parseRequestedCapabilities(capabilities         )                            {
  if (!Array.isArray(capabilities)) return { patchCapable: false };
  return { patchCapable: capabilities.includes(SNAPSHOT_PATCH_CAPABILITY) };
}

/**
 * Create the composite patch lane for one owned delivery. Returns null when no
 * composite declarations exist — hosts without snapshots keep today's exact
 * behavior with zero new state.
 */
export function createCompositePatchDelivery({ db, composites, mayVerb, authorization, includeActionId }                               )                                {
  const compiled = [...composites.entries()]                            ;
  if (compiled.length === 0) return null;
  // The public SnapshotDeclaration is structurally wider (looser) than the
  // compiled one; the plan compiler reads only the shared structural shape.
  const plans = compilePatchPlans(compiled         );
  const ledger = createProjectionLedger();
  return new CompositePatchDelivery(db, compiled         , plans, ledger, mayVerb, authorization, includeActionId);
}

export class CompositePatchDelivery {
                   db          ;
                   composites                              ;
                   plans                                      ;
                   ledger                  ;
                   mayVerb         ;
                   authorization         ;
                   includeActionId         ;

  constructor(db          , composites                              , plans                                      , ledger                  , mayVerb         , authorization         , includeActionId         ) {
    this.db = db;
    this.composites = composites;
    this.plans = plans;
    this.ledger = ledger;
    this.mayVerb = mayVerb;
    this.authorization = authorization;
    this.includeActionId = includeActionId;
  }

  planFor(scopeHandle             )                         {
    return this.plans.get(scopeHandle.entity) ?? null;
  }

  /**
   * Bootstrap for a patch-capable recipient: run the host's ordinary snapshot
   * result through the SAME capture/authorize/project seam (the caller supplies
   * its already-authorized snapshot value), then register the visibility
   * ledger and mint the first token.
   */
  async bootstrapFromSnapshot({ principal, scope, snapshotValue, anchorCursor }






   )                                {
    const handle = tryParseScopeKey(scope);
    const plan = handle ? this.plans.get(handle.entity) : null;
    const declaration = handle ? this.composites.get(handle.entity         ) : undefined;
    if (!handle || !plan || !declaration) return { kind: 'revoked' };
    // Derive visibility from the projected value itself — one walk against the
    // plan; identical semantics to the projector's post-patch derivation.
    const visible = deriveVisibilityExport(plan, snapshotValue);
    const cursor                    = Object.freeze({ anchor: anchorCursor, composite: currentCompositeSeq(this.db, scope) });
    const { projectionToken } = this.ledger.register({ principal, scope, planVersion: plan.version, cursor, visible });
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
  async catchupWithPatches(input                                                                                                                )



    {
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
      const declaration = this.composites.get(handle.entity) ;
      const projection                  = await projectCompositePatch({
        db: this.db,
        principal: input.principal,
        scope: input.scope,
        plan,
        declaration: declaration         ,
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
      const cursorAfter                    = Object.freeze({ anchor: readSeq(this.db, input.scope), composite: toComposite });
      const { projectionToken } = this.ledger.register({
        principal: input.principal,
        scope: input.scope,
        planVersion: plan.version,
        cursor: cursorAfter,
        visible: projection.visibleAfter,
      });
      const envelope                           = {
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

  close()       {
    this.ledger.clear();
  }
}

// One shared visibility walk (kept out of the projector's export surface to
// avoid a public API beyond what tests consume; both call sites use this).
import { deriveVisibility } from './composite-patch-projector.mjs';
function deriveVisibilityExport(plan                 , projected                         )                                                                {
  return deriveVisibility(plan, projected);
}
