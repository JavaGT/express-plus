# Annotated Text T4 Runtime R3

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The `block.merge` command and block-topology event described below are
> historical — there are no blocks to merge. The current runtime handles
> whole-document offset edits only; see `src/annotated-text-continuous.ts`.

## Status

[IMPLEMENTED — TERRA APPROVED 2026-07-25]

## Cutover

R3 extends the established generated annotated-text aggregate seam with one structural variant: interior block merge. R1 version-1 `text.apply` and R2 version-2 `block.split` command and event grammars remain unchanged.

- The generated `<Entity>.<field>.operation` accepts closed version-3 `block.merge` commands with a document ID, exact structural revision/frontier, left block ID, and right block ID. The server requires equal block cells and epoch, adjacent blocks in family order, and equal membership sets on both sides.
- A successful merge emits exactly one document-scoped `operated` event. Its canonical facts include the full post-merge family, the retained left block cell snapshot, affected annotation memberships, and merged measurement facts. Structural revision increments by 1; frontier is unchanged.
- The left block identity survives; the right block is deleted from both the family and the block table. Merged text is restored to the visible concatenation of left and right content.
- Merge partitions existing RGA ownership only. The retained left block owns the union of both blocks' element keys.
- Active source-block memberships on both sides are merged into single full-block memberships on the left block. Dense ordinals are normalized across every membership of each affected annotation. Both sides must have identical membership sets; merge does not create, delete, or otherwise change annotations.
- Each measurement is validated, combined twice with independently deep-frozen input snapshots, compared for deterministic output, and validated against the merged visible text during action admission. The three combine cases are:
  - **Both present**: left measurement ID is retained; right measurement ID is removed; combine receives both left and right sources.
  - **Left only**: left measurement ID is retained; combine receives only left source.
  - **Right only**: right measurement ID is retained; combine receives only right source.
- The projector does not invoke adapters; it verifies event fact lineage and persists event-carried measurement payloads. The measurement combine is called exactly twice during admission, with frozen non-identical input/payload snapshots. A nondeterministic combine rolls back the entire action.
- Projection independently reruns only framework-owned family and membership reducers, verifies canonical event facts against its prior relational state, and persists the reducer-derived family checkpoint. State, blocks, memberships, measurements, event, and receipt share the existing transaction.
- R3 actions remain cursor-excluded and forbidden from generic batches. Adapter admission-only evaluation means a valid event applies in projection even if the combine is later changed to throw.
- A tampered R3 event (e.g., modified family checkpoint frontier, unequal stored block cells, or omitted source measurement family) is rejected by the projector with unchanged state and rows.
- Cell equality is checked by JSON round-trip comparison. Epoch equality is checked by direct value comparison. No migration path exists; no Scope pin is required.

## Affected Files

- `src/annotated-text-r3.mjs` — `assertR3BlockMergePayload`, `canonicalJsonEqual`
- `src/annotated-text-family.mjs` — `mergeBlocks` export
- `src/annotated-text-membership.mjs` — `mergeBlocksMemberships` export
- `src/entity/crud.mjs` — R3 handler in `createCrudHandlers` (lines ~480-714)
- `src/entity/projection.mjs` — `applyR3AnnotatedTextOperation` (lines ~405-670)
- `test/annotated-text-initialization.test.mjs` — R3 test suite

## Tests

All R3 tests are in `test/annotated-text-initialization.test.mjs` after the R2 suite:

1. **R3 successful block.merge** — one v3 event, left identity survives, right removed, text restored, revision 3, frontier unchanged
2. **R3 merge receipt retry dedupes** — no duplicate rows
3. **R3 merge rejects stale structural revision**
4. **R3 merge rejects non-adjacent blocks**
5. **R3 merge rejects mismatched block memberships**
6. **R3 merge with both-present measurements** — retains correct ID, rehomes safely
7. **R3 merge with left-only measurement** — retains correct ID, rehomes safely
8. **R3 merge with right-only measurement** — retains correct ID, rehomes safely
9. **R3 merge combine invoked exactly twice** — frozen non-identical input/payload snapshots
10. **R3 merge nondeterministic combine rolls back**
11. **R3 projection valid event applies** — even if combine is changed to throw after admission
12. **R3 tampered event rejects** — unchanged state and rows
13. **R3 projection rejects unequal stored right cells** — unchanged state and rows
14. **R3 projection rejects an omitted measurement family** — unchanged state and measurement rows
15. **R3 projection rejects per-side source omission when both sides have rows** — unchanged state, blocks, and measurements
16. **R3 projection rejects invalid right-only lineage, result shape/blockId mutations, and non-JSON result payloads** — unchanged state, blocks, and measurements

## Closure Coverage

- **R3 merge preserves active orphan-policy annotations and protector edges** proves an
  active `empty: 'orphan'` annotation and a protecting annotation retain their identity,
  memberships, and protecting-target edge through a split followed by merge. It creates
  no orphan state.
- **R2 edge splits remain no-ops before a valid R3 merge** proves offsets `0` and text
  length emit no events and leave the structural revision/frontier and block topology
  valid for a subsequent R3 merge.

Measurement edit actions and recipient delivery for orphan state remain outside R3.
