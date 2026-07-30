# Terminal scope identities for polymorphic tombstones

## Contract

`snapshot.tombstones(...)` normally requires its scoped polymorphic `scopeId` to
be a typed, physical foreign key to the snapshot target. An application whose
permanent-erasure contract physically removes that target may instead declare
`terminalScope`.

- `terminalScope` must be a registered identity-only entity: it declares no
  fields beyond the implicit `id`.
- `scopeId` must be a declared `ref(terminalScope)` backed by exactly one
  physical foreign key to `terminalScope.id` using `ON DELETE RESTRICT` or
  `NO ACTION`.
- The terminal identity and tombstone entity are read-internal and cannot be a
  snapshot anchor or output relation.
- Snapshot matching compares the opaque scope identity to the target's declared
  owner reference with the same field name as `scopeId` (for example,
  `Codebook.projectId`). Identity-root targets without that field compare their
  own `id`. A same-named target field must be a declared ref; malformed owner
  declarations fail closed. The application must create the terminal identity
  before its first tombstone and retain it while tombstones refer to it.
- A terminal identity contains no authorization state or erased payload. It is
  not a substitute live target and grants no recipient access.

This is deliberately narrower than accepting an untyped scope ID or an arbitrary
alternate scope entity. It preserves package-owned schema validation and
recipient-safe fail-closed visibility while allowing the live target row to be
physically erased.

## Rejected alternatives

- Disabling foreign keys, accepting a declared `text()` scope, or trusting a
  structurally false `ref(Target)` would make schema integrity advisory.
- Cascading deletion of tombstones would destroy required erasure provenance.
- Retaining a payload-bearing or authorizable live target after erasure would
  preserve the wrong lifecycle and risk recipient access to erased data.
- Callbacks or application SQL in delivery would create a second projection and
  authorization path.
