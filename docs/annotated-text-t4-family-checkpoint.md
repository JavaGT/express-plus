# Annotated Text T4 Family Checkpoint

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

## Verification

```bash
node --test test/annotated-text-family.test.mjs test/annotated-text-laws.test.mjs
```

[IMPLEMENTED — TERRA APPROVED 2026-07-24]
