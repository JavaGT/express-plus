# Annotated Text T4 Membership Points

[IMPLEMENTED — TERRA APPROVED 2026-07-25]

## Concept

Membership points are a pure, closed, deeply frozen endpoint representation for
navigating and validating structural ranges within a text family. They provide
the foundation for block-level membership ranges (e.g., code spans, highlights)
without introducing runtime actions, events, projections, or browser/public
exports.

## Endpoint Structure

```
{
  point: ['point', anchor, 'left' | 'right'],
  basisFrontier: Frontier  // the frontier at which this endpoint was composed
}
```

- `point` is validated by `assertStructuralPoint` from the T1 grammar.
- `basisFrontier` is validated by `assertFrontier` from the T1 grammar.
- The result is deeply frozen.

## Root Semantics

- Root is the virtual HEAD anchor.
- At an endpoint's basis, **both root-left and root-right are the start cut** (position 0).
- Root-right is **NOT** usable as document end just because text exists.
- Current text/block end must use a right-affine point after the final owned structural scalar.

## Marker Semantics

For anchor A at basis:

- **Left affinity**: cuts immediately after A, before every child subtree.
- **Right affinity**: cuts immediately before the FIRST basis-observed direct child subtree.
  - If there is NO basis-observed direct child, right follows all current child subtrees.

Comparison uses canonical RGA topology, child ordering, and `basisFrontier` — not
simplistic anchor ancestry.

## Tombstones

- Tombstones remain structural elements. They have zero displayed width.
- Distinct tombstone points can have equal display offsets but retain structural ordering.
- Tombstoned elements remain valid anchors and are included in traversal/ownership.

## Frontier Admission

- Fresh comparison, projection, range validation, and browser-position resolution
  require an endpoint `basisFrontier` exactly equal to the family's canonical
  current frontier. Stored endpoints at older frontiers require an explicit replay
  transformation before those operations; this pure foundation does not perform it.
- `assertStructuralEndpoint` takes only the endpoint object (no separate basis argument).

## Membership Ranges

An active membership range must:

1. Have the same `basisFrontier` on both endpoints.
2. Have `start < end` structurally.
3. Have positive visible UTF-16 width.
4. Cover only the named block's structural scalars (including tombstones).
5. **End must be canonical block end**: the final OWNED structural scalar in canonical traversal with RIGHT affinity. No partial ranges, no final-left, no end-before-final.
6. **Start anchor**:
   - For first block: only root-left is accepted (exact canonical lower boundary).
   - For non-first block: start endpoint allowed from prior block only if EXACT canonical lower boundary — the final OWNED structural scalar in immediately preceding block with RIGHT affinity.
   - A start owned by the named block is rejected (not a canonical lower boundary).
7. Root-right is rejected as start.

Coverage is determined by full traversal, not just endpoint offsets.

## API

- `assertStructuralEndpoint(endpoint)` — validates and freezes an endpoint object.
- `compareStructuralEndpoints(family, left, right)` — structural comparison.
- `projectEndpointToBlockOffset(family, blockId, endpoint)` — projects to UTF-16 offset.
- `resolvePositionToEndpoint(family, blockId, utf16Offset, basisFrontier)` — resolves a UTF-16 position to an endpoint.
- `assertMembershipRange(family, blockId, startEndpoint, endEndpoint)` — validates a membership range.

## No Runtime Action Exposure

This remains pure internal. No public/browser/DDL/action/projection exports or wiring.

## Verification

```bash
node --test test/annotated-text-membership-points.test.mjs
```

Also validate family, laws, and edit generator tests:

```bash
node --test test/annotated-text-family.test.mjs test/annotated-text-laws.test.mjs
```

## Prerequisite

This module is a separate prerequisite for any runtime membership or highlight
system. See [family-checkpoint](./annotated-text-t4-family-checkpoint.md) for the
underlying family structure.
