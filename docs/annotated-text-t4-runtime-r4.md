# Annotated Text T4 Runtime R4

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The "one current block", internal-split, and whole-block-membership description
> below is historical. The current model applies an annotation as a character
> range `{annotationId, start, end}` over the continuous document — no block
> splits — see `src/annotated-text-ranges.mjs` and `src/annotated-text-continuous.ts`.

## Scope

R4 adds the generated version-4 `annotation.apply` operation. It applies one
declared annotation to a non-empty UTF-16 range in one current block.

- The command requires the exact structural revision and CRDT frontier.
- Admission owns zero, one, or two internal splits to isolate the range as a
  complete selected block, then creates canonical whole-block membership.
- Existing memberships are propagated through every internal split. Registered
  measurement adapters partition measurements during admission only.
- The operation produces one `operated` event and one transaction/receipt
  boundary. A topology change advances structural revision exactly once.
- Projection replays split topology, block-cell lineage, memberships,
  annotation field materialization, and measurement ID/family/block lineage
  without invoking adapters. Malformed or tampered facts fail before writes.

## Deliberate Boundaries

- Selection is limited to one current block. Cross-block selection is closed.
- Entity write authorization remains the existing generated action boundary;
  annotation action declarations remain compile-time contracts, not runtime
  callbacks.
- Scope domain annotation declarations, confidentiality delivery projection,
  carets, and direct measurement actions remain outside R4.

## Evidence

`test/annotated-text-r4.test.mjs` covers command parsing and UTF-16 selection
topology. `test/annotated-text-r4-integration.test.mjs` covers 0/1/2 splits,
field defaults, stale and invalid requests, deduplication, membership and
measurement propagation, rollback, and projector tampering.
