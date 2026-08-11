# Annotated Text T4 Runtime R5

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The `annotation.detach` command with a `blockId` and the ordered membership
> postimage below are historical. The current model detaches an annotation range
> (`{annotationId, start, end}`) from the continuous document — no block identity —
> see `src/annotated-text-ranges.mjs`. The empty-policy (delete/orphan) and
> orphan-provenance semantics still hold.

## Scope

R5 provides the one-path transactional `annotation.detach` action for one
existing active whole-block membership. It does not split or merge blocks,
change structural revision/frontier, expose an annotation-wide remove command,
or add a recipient grammar for orphan provenance.

## Command

```js
{
  version: 5,
  id: documentId,
  expected: { structuralRevision, frontier },
  operation: { kind: 'annotation.detach', annotationId, blockId }
}
```

The generated document operation retains its existing write authorization,
transaction, receipt dedupe, scope, batch-forbidden, and cursor-excluded
properties.

## Durable Event

The single native `operated` event records exact `before` and unchanged `after`,
the closed operation, its admission-time lifecycle policy, and a closed derived
`result` fact:

- Complete ordered membership postimage for the affected annotation only.
- `retained`, `deleted`, or `orphaned` disposition. Terminal facts include the
  family; orphan facts include the canonical saved quote and provenance.
- Complete outgoing target postimages only for protectors changed by a final
  delete.

Admission and projection independently run `removeMembership()` on committed
state using the event's frozen target empty policy and require the result fact
to match before SQL writes. This preserves v5 replay when a later declaration
changes a family's empty policy. The projector
removes derived incoming edges before a final delete so the schema's direct-SQL
`RESTRICT` guard remains intact. Orphaning retains annotation identity, family
fields, and edges, removes active memberships, and persists canonical orphan
state.

## Verification

```bash
node --test test/annotated-text-r5.test.mjs test/annotated-text-r4-integration.test.mjs
```
