# Annotated Text T4 Family Checkpoint

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The block-ownership family described below (blocks, elementKeys, split/merge)
> is historical. The current family is `{id, checkpoint}` only — one RGA text
> stream per document with absolute UTF-16 offsets — see
> `src/annotated-text-continuous.ts`. The RGA checkpoint grammar it builds on
> remains authoritative (ADR 0005).

## Concept

A text family is an immutable projection of a canonical v1 RGA checkpoint onto
ordered block ownerships. Every family retains:

- A stable `id` (string).
- The full canonical v1 checkpoint (elements, operations, pending, frontier).
- An ordered array of blocks, each owning a disjoint subset of element keys.

Blocks are a **disjoint ownership projection** of the canonical RGA graph. They
never clone, re-root, or discard elements. Every element key from the underlying
checkpoint is owned by exactly one block.

## Model

```
Family {
  id: string,
  checkpoint: canonical v1 checkpoint (frozen),
  blocks: [{ id: string, elementKeys: string[] }]
}
```

- The checkpoint is validated by `restoreTextCheckpoint` from the existing v1
  foundation. The family preserves exact checkpoint round-trip fidelity.
- `materializeBlock(family, blockId)` traverses the canonical RGA graph in
  deterministic Lamport/op-ID order but emits only visible scalars owned by the
  requested block.
- `splitBlock(family, blockId, newBlockId, utf16Offset)` reassigns ownership of
  RGA-ordered elements at the cut point, preserving every scalar assignment
  exactly once. Tombstoned elements are included in the traversal to determine
  the cut but are never duplicated or lost.
- `mergeBlocks(family, leftBlockId, rightBlockId)` reassigns ownership of
  adjacent blocks, preserving the graph.
- `createTextFamily(id, checkpoint, blockId)` creates a family from a v1
  checkpoint with a single initial block owning all elements.

## Important invariants

- No runtime actions, events, projections, or browser/public changes are
  introduced. This is a pure, in-memory foundation.
- The canonical v1 checkpoint is never mutated. Split and merge return new
  frozen family objects with the same checkpoint reference.
- UTF-16 split offsets are validated by `assertUtf16Offset` from the existing
  v1 module, which rejects surrogate-pair interiors.
- Unknown/extra fields in the family checkpoint are rejected. Duplicate or
  missing ownership is rejected. Non-adjacent merge is rejected. Same new block
  ID in split is rejected.

## Membership Points

Membership points (structural endpoints, comparison, projection, and range
validation) are defined in a separate prerequisite module. See
[membership-points](./annotated-text-t4-membership-points.md).

## Verification

```bash
node --test test/annotated-text-family.test.mjs test/annotated-text-laws.test.mjs
```

## Block-targeted operations

`applyTextOperationToBlock(family, blockId, operation)` applies a single
canonical operation to a family, attributing newly inserted scalars to the
target block while preserving all ownership invariants.

### Admission policy

- Rejects if `checkpoint.pending` has any entries or `rebootstrapRequired` is
  true.
- Rejects any operation that is not immediately causally ready (including one
  that would otherwise buffer as pending).
- No pending buffering/draining occurs — the operation must be ready to apply
  immediately.

### Validation

- Target block must exist in the family.
- Before application, the target block ownership is defined from the family.
- A delete must name only scalars owned by the target block; cross-block delete
  is rejected.
- An element anchor insert is valid only if its final canonical RGA traversal
  placement can be owned by the target block while every block remains a
  contiguous traversal segment in existing block order. Root anchor insertion
  obeys the same resulting projection rule.
- Full insert run is assigned to the target block.

### Application

- Operation is applied via canonical `applyTextOp`, retaining its duplicate and
  equivocation behavior.
- Same-ID/same-content returns equivalent canonical family.
- No ownership change for delete / duplicate.
- New inserted scalar IDs all belong to target block.

### Result

- Final family passes current ownership assertions / restore round-trip.
- No SQLite sequencing as order input.
- Exact action-level structure-version belongs later in action admission.

[IMPLEMENTED — TERRA APPROVED 2026-07-25]

## Split-block result shape and edge cases

[IMPLEMENTED — TERRA APPROVED 2026-07-25]

`splitBlock` returns a tagged result object rather than returning a family directly:

- **`{ type: 'split', family, leftBlockId, rightBlockId }`** — both partitions are non-empty. The returned family has two adjacent blocks at the split point, each owning at least one structural element key.
- **`{ type: 'unchanged', reason: 'empty-child', family, retainedBlockId }`** — the split offset would produce an empty child block (either offset 0 or offset equal to block text length). No block identity is consumed. The returned family is the original family (referentially identical). The `retainedBlockId` is the original block ID.

### Invariants

- **Nonempty checkpoint**: every non-empty checkpoint block owns at least one structural element key in `elementKeys`. A checkpoint with any elements must not have a zero-owned block.
- **Empty checkpoint bootstrap**: exactly one zero-owned bootstrap block is allowed, and only when the checkpoint has zero elements. This is the only case where a block can have an empty `elementKeys` array.
- **All-tombstoned owned block**: a block whose entire owned element set is tombstoned is valid. It materializes to the empty string but still owns structural element keys. This is distinct from the zero-owned bootstrap block.
- **Edge offset returns `unchanged`**: `splitBlock` at offset 0 or at the UTF-16 text length of a nonempty block returns `{ type: 'unchanged', reason: 'empty-child', family, retainedBlockId }`. No new block identity is consumed; the original family is returned unchanged.
- **Empty bootstrap cannot split**: `splitBlock` on a zero-owned bootstrap block (empty checkpoint) is rejected with `"cannot split an empty block"`, since there are no element keys to partition.

[IMPLEMENTED — TERRA APPROVED 2026-07-25]
