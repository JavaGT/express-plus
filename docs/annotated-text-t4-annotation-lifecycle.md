# Annotated Text T4 Annotation Lifecycle

[IMPLEMENTED — TERRA APPROVED 2026-07-25]

## Concept

Pure annotation data model and membership lifecycle operations for the
annotated-text family system. This module is a prerequisite for any runtime
annotation action admission, providing the closed, deeply frozen data shapes
and deterministic transforms that the reducer handles.

## Prerequisites

This module depends on the following T4 prerequisites:

- **[Family Checkpoint](./annotated-text-t4-family-checkpoint.md)**: block
  ownership, materialization, split/merge, and structural endpoints.
- **[Membership Points](./annotated-text-t4-membership-points.md)**: endpoint
  validation, comparison, projection, and range validation.

## Data Model

### Annotation

```js
{
  id: string,           // non-empty annotation identifier
  family: string,       // annotation family name (matches declaration)
  empty: 'delete' | 'orphan',  // policy when last membership is removed
  protectedTargetIds?: string[]  // sorted unique target annotation IDs
}
```

- `protectedTargetIds` is optional. When present, it must be sorted and unique.
- The annotation is deeply frozen after validation.

### Membership

```js
{
  annotationId: string,  // references Annotation.id
  blockId: string,       // references Family.blocks[].id
  ordinal: number,       // reducer-owned, dense per annotation by document block order
  start: Endpoint,       // validated structural endpoint (assertStructuralEndpoint)
  end: Endpoint,         // validated structural endpoint (assertStructuralEndpoint)
}
```

- At most one membership per `(annotationId, blockId)`.
- Ordinals are reducer-owned, assigned dense per annotation in document block
  order. The membership module normalizes ordinals on every mutation.

### Outcomes

Operations return explicit post-image effects for the caller to persist:

```js
// Delete outcome — annotation is removed entirely
{ type: 'delete', annotationId: string }

// Orphan outcome — active membership is removed while durable annotation identity remains
{
  type: 'orphan',
  annotationId: string,
  savedQuote: string,             // concatenated visible text from all memberships
  lastMemberships: [
    'workbench.annotation-last-memberships', 1, structuralRevision,
    protectedTargetIds,
    entries,
  ]
}
```

`lastMemberships` is closed, versioned historical provenance, not an active
range. `protectedTargetIds` is sorted unique. Each dense entry is
`[ordinal, blockId, ['endpoint', basisFrontier, point], ['endpoint', basisFrontier, point]]`.

## API

### `assertAnnotation(annotation)`
Validates and freezes an annotation object. Rejects unknown keys, invalid
`empty` values, and non-sorted/non-unique `protectedTargetIds`.

### `assertMembership(membership)`
Validates and freezes a membership object. Rejects unknown keys, invalid
identifiers, and invalid endpoints.

### `addMembership(family, annotations, memberships, annotationId, blockId, startEndpoint, endEndpoint)`
Adds a new membership for an annotation on a block.

- Requires the annotation to exist in the annotations array.
- Requires the block to exist in the family.
- Validates `assertMembershipRange` on the endpoints.
- Requires exact canonical whole-block coverage; partial active ranges are rejected.
- Rejects duplicate `(annotationId, blockId)`.
- Rejects fully tombstoned blocks.
- Assigns ordinal dense by document block order.
- Returns `{ annotations, memberships, outcomes }`.

### `removeMembership(family, annotations, memberships, annotationId, blockId, { structuralRevision })`
Removes a membership for an annotation on a block.

- **Non-last membership**: normalizes ordinals, no outcome.
- **Last membership, `empty: 'delete'`**: produces delete outcome, removes
  annotation from annotations array.
- **Last membership, `empty: 'orphan'`**: produces orphan outcome with
  `savedQuote` (concatenated visible text from all pre-action memberships,
  direct, no normalization/separators) and closed v1 `lastMemberships`
  provenance. The annotation is retained in the returned annotations array
  (no memberships remain) so the caller can persist the durable identity;
  historical entries are syntax-validated but not revalidated against later
  family topology.
- **Protection**: if the last membership is protected by an active protector
  with overlapping block membership, the removal is rejected. Protection does
  not block non-last removal. Boundary touch (no overlap) does not protect.

### `splitBlockMemberships(family, annotations, memberships, blockId, newBlockId)`
Splits memberships when a block is split. Source block must be the immediate
predecessor of `newBlockId` in family blocks.

- For each annotation with membership on the source block, creates canonical
  full-block memberships on both children if they are nonempty.
- `splitBlock` invokes this transform only for its `type: 'split'` result.
  Edge offsets return `type: 'unchanged'` and preserve memberships unchanged.
- Normalizes ordinals.

### `mergeBlocksMemberships(family, annotations, memberships, leftBlockId, rightBlockId)`
Merges memberships when blocks are merged. Blocks must be adjacent.

- Requires the annotation-ID membership sets on both blocks to be exactly equal.
- Each membership must be canonical full coverage of its block.
- Produces one full-block membership on the survivor for each annotation.
- Rejects mismatched or different annotation ID sets.
- Normalizes ordinals.

## Invariants

- All data is deeply immutable. Inputs are never mutated.
- Ordinals are reducer-owned, dense per annotation by document block order.
- Whole-block ranges rely on exact current frontier and endpoint APIs.
- Active membership cannot exist on a fully tombstoned block.
- Protection requires the protector to have `protectedTargetIds` containing the
  target's ID AND positive active membership overlap on the same block.
- Split and merge never produce invalid zero visible membership. A nonempty
  family never persists a zero-owned block; the empty-document bootstrap is
  the sole exception.

## Verification

```bash
node --test test/annotated-text-membership.test.mjs
```

Also validate family, membership points, and laws tests:

```bash
node --test test/annotated-text-family.test.mjs test/annotated-text-membership-points.test.mjs test/annotated-text-membership.test.mjs
```
