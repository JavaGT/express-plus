# Recipient snapshots may require a co-owned related row

Status: accepted

## Decision

A Project-keyed snapshot relation may add one closed required-relation clause:

```js
snapshot.keyed(Code, {
  via: Code.field.projectId,
  require: snapshot.related(Code.field.codebookId, {
    via: Codebook.field.projectId,
  }),
  select: snapshot.select(Code.field.codebookId, Code.field.label),
})
```

`related(childRef, { via: parentRef })` means that each candidate child is
included only when the row named by `childRef` exists, is not hidden by its
compiled tombstone rule, `parentRef` on that row equals the current snapshot
parent ID, and that related row passes its ordinary recipient `scopeFilter` and
`subscribe` authorization. The related row is a filter only and is never
projected. A missing, deleted, unauthorized, malformed, or authorization-error
related row excludes the child.

The compiler must prove from registered declarations and physical foreign keys
that `childRef` belongs to the candidate entity and is exactly one `ref(Related.id)`,
and that `parentRef` belongs to that Related entity and is exactly one ref to the
current branch entity's ID. It rejects unregistered or structurally substituted
entities, reversed handles, target mismatches, absent/duplicate physical foreign
keys, nested/callback/SQL values, and `require` on `one` relations. `many`,
`keyed`, and `count` use the same filtered candidate set.

## Rejected alternatives

- A caller predicate, endpoint filter, SQL fragment, or authorization callback
  opens the recipient grammar and creates a second authorization authority.
- Requiring only both child foreign-key values to equal the parent does not prove
  that the referenced row exists or is itself recipient-visible.
- A declaration-level composite foreign key is a valuable write-time domain
  invariant but is not sufficient for projection: it neither performs related
  row authorization nor defines soft-deletion visibility, and SQLite enforcement
  state must not become recipient authorization.
- General join/filter expressions add grammar not required by this use case.

Implementation is a separate narrow slice: the public constructor/types,
compile-time proof, capture of the required related candidate, authorization,
and projection omission must land together with hostile tests before this
contract is usable.
