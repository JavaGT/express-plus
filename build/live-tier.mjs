// Live data tier vocabulary (S3, JavaGT/workbench#99).
//
// Every entity mutation used to be indistinguishable: the pipeline wrote `_Log`
// via durableMutationVariant → appendEvents, and the only nuance was the
// `history: { create, update }` conditional flag read by the projection layer.
// S3 makes the four data tiers explicit package vocabulary BEFORE delivery
// (S3/A4) and mutation (S3/A2) work builds on them. This module owns the
// vocabulary, the declaration normalization, and the validation rules — the
// foundation of the S3 lane.
//
// The four tiers (closed descriptions):
//   - history: authoritative current rows + committed event history, receipts,
//     undo policy, catch-up, recipient projection.
//   - live: authoritative current rows + live synchronization, no domain event
//     history or undo.
//   - derived: rebuildable state notified by authoritative source changes (not
//     an entity mutation path).
//   - operational: app-owned runtime state exposed live where useful, never
//     collaborative history.
//
// Entity declarations are restricted to the `history` | `live` tiers.
// `derived` and `operational` are RESOURCE categories (declared via their own
// producer + staleness contract — S4's search plugin and S2's derived-resource
// lifecycle), not entity mutation tiers: declaring one on an entity is a
// declaration compile error, never a query-time surprise.
//
// Contract notes for downstream S3 lanes:
//   - `history: { create/update: 'none' }` is RESERVED vocabulary for the
//     no-history mutation variant (S3/A2, JavaGT/workbench#100). A1's decision:
//     reject `'none'` at declaration compile and redirect to `live: true`
//     (today's spelling of "no durable history"). A2 owns implementing real
//     no-log semantics via the tier resolution (the `live` tier), superseding
//     the redirect.
//   - The resource completeness contract (a derived/operational resource must
//     carry explicit `producer` + `staleness` declarations) is validated by the
//     owning lanes — S2/A6 derived-resource lifecycle (JavaGT/workbench#92) and
//     S4 search plugin contract (JavaGT/workbench#110) — not here: `tierOf`
//     only classifies a resource to its category.











export const DATA_TIERS                      = Object.freeze(['history', 'live', 'derived', 'operational']);

export const ENTITY_TIERS                        = Object.freeze(['history', 'live']);

export const TIER_DESCRIPTIONS                                     = Object.freeze({
  history: 'authoritative current rows + committed event history, receipts, undo policy, catch-up, recipient projection',
  live: 'authoritative current rows + live synchronization, no domain event history or undo',
  derived: 'rebuildable state notified by authoritative source changes (not an entity mutation path)',
  operational: 'app-owned runtime state exposed live where useful, never collaborative history',
});

export function isDataTier(value         )                    {
  return typeof value === 'string' && (DATA_TIERS                     ).includes(value);
}

export function isEntityTier(value         )                      {
  return value === 'history' || value === 'live';
}

// The entity-level tier declaration surface. `history` is the existing
// conditional-history declaration (now with an explicit `full` spelling of the
// default full-log mode); `live: true` and `tier: 'live'` mark the live tier.






// The resolved tier for a declaration: `history` tiers carry a `historyMode`
// sub-flag (`full` — every mutation is logged — or `conditional` — the existing
// undo/redo conditional flags); `live` tiers carry no history at all.





// Normalize a tier declaration into a resolved tier. Validation fails HERE at
// declaration compile, never at query time. `label` names the declaring site in
// error messages (e.g. `entity('Note')`).
export function normalizeTierDeclaration(declaration                  = {}, label = 'entity')               {
  const { history, live, tier } = declaration;
  const prefix = `${label} tier declaration`;
  const historyPrefix = `${label} history`;

  if (history !== undefined && (history === null || typeof history !== 'object' || Array.isArray(history))) {
    throw new Error(`${historyPrefix} must be an object { create?, update? }`);
  }
  if (history !== undefined) {
    for (const [verb, mode] of Object.entries(history)) {
      if (verb !== 'create' && verb !== 'update') {
        throw new Error(`${historyPrefix} must declare only 'create' and 'update' verbs; unknown verb '${verb}'`);
      }
      if (mode !== undefined && !['conditional', 'full', 'none'].includes(mode)) {
        throw new Error(`${historyPrefix} must use 'conditional' | 'full' | 'none' for ${verb}, got ${JSON.stringify(mode)}`);
      }
      if (mode === 'none') {
        throw new Error(
          `${historyPrefix} 'none' is reserved for the no-history mutation variant (S3/A2) — ` +
            'use live: true to declare an entity with no durable history',
        );
      }
    }
  }
  if (live !== undefined && typeof live !== 'boolean') {
    throw new Error(`${prefix}: live must be a boolean, got ${JSON.stringify(live)}`);
  }
  if (tier !== undefined && !isDataTier(tier)) {
    throw new Error(`${prefix}: tier must be one of ${DATA_TIERS.join(' | ')}, got ${JSON.stringify(tier)}`);
  }
  if (tier !== undefined && !isEntityTier(tier)) {
    throw new Error(
      `${prefix}: tier '${tier}' is a resource category, not an entity tier — derived/operational resources ` +
        'are declared via their own producer + staleness contract, never as mutation entities',
    );
  }
  if (tier === 'history' && live === true) {
    throw new Error(`${prefix}: contradictory declaration — tier 'history' cannot be combined with live: true`);
  }
  if (tier === 'live' && live === false) {
    throw new Error(`${prefix}: contradictory declaration — tier 'live' cannot be combined with live: false`);
  }

  const wantsLive = live === true || tier === 'live';
  const requestsHistory = history !== undefined;
  if (wantsLive && requestsHistory) {
    throw new Error(
      `${prefix}: a live entity that also requests durable history (or undo) is a hard error — ` +
        'a live tier keeps current rows + live synchronization, no domain event history or undo',
    );
  }

  if (wantsLive) return { tier: 'live' };
  if (requestsHistory) {
    const modes = Object.values(history).filter((mode) => mode !== undefined);
    return { tier: 'history', historyMode: modes.includes('conditional') ? 'conditional' : 'full' };
  }
  return { tier: 'history', historyMode: 'full' };
}

// Resolve the live-data tier of a declared entity or resource. Entities
// resolve to `history` (default) or `live`; derived/operational resources
// resolve to their category (their producer + staleness completeness contract
// is validated by the owning S2/S4 lanes — see the module header). Raw tier
// declarations run the SAME normalization + validation as
// normalizeTierDeclaration, so a contradictory or malformed uncompiled object
// (e.g. `{ tier: 'history', live: true }`) fails closed instead of silently
// resolving; compiled entity records carry their resolved tier and pass
// through without throwing.
export function tierOf(resource         )           {
  if (resource === null || typeof resource !== 'object') return 'history';
  const declared = resource                           ;
  // Resource categories are not entity mutation tiers: classify them before
  // entity normalization. A resource that also carries the entity tier flags
  // (live/history) is a contradictory raw object and fails closed.
  if (typeof declared.tier === 'string' && isDataTier(declared.tier) && !isEntityTier(declared.tier)) {
    if (declared.live !== undefined || declared.history !== undefined) {
      throw new Error(
        `entity tier declaration: tier '${declared.tier}' is a resource category and cannot be combined with live/history entity flags`,
      );
    }
    return declared.tier;
  }
  return normalizeTierDeclaration(declared                   ).tier;
}
