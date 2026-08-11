# Related-Entity Annotation Authoring

Status: accepted contract; implementation is one inseparable release slice

## Decision

Workbench owns one declaration-derived document action for creating an entity
referenced by an annotation and applying that annotation to a recipient-visible
selection. It is not a browser batch and does not expose generated CRUD.

The declaration grammar is:

```js
annotation('comments', {
  fields: { comment: ref(Comment) },
  actions: { compose: annotationEntityAction({
    relation: 'comment',
    project: 'projectId',
    author: 'userId',
    capability: write,
    input: { body: 'body' },
  }) },
  empty: 'orphan',
})
```

`relation` must name a required annotation `ref` whose target is a registered
entity. `project` must name a required immutable ref on that entity to the annotated
document's declared project target. `author` must name a required ref to the
document owner field's principal target. `capability` must be the imported typed
`write` capability; it names document authoring, not document ownership.
`input` is a closed public-name to entity-field map. Startup rejects missing,
optional, mismatched, duplicated, or unknown pieces and any required entity
field which is not supplied by input, project, author, or an entity declaration
default.

The root and `workbench/annotated-text` entries export
`annotationEntityAction`. The compiled annotation handle exposes a keyed typed
action handle, for example
`Transcript.annotatedText.annotations.comments.actions.compose`, rather than a
string. The public factory is:

```ts
annotatedTextAnnotationAction(entity, field, actionHandle, {
  id, basis, mutationId, from, to, values
}) => AnnotatedTextActionRequest
```

The document-bound browser session exposes the narrower typed form:

```ts
session.applyAnnotationAction(actionHandle, {
  mutationId, from, to, values: { body }
})
```

The session supplies document identity and its current opaque recipient basis.
In the standalone factory `id` is only the document ID. `mutationId` identifies
the semantic document mutation and participates in its deterministic internals;
it is not the durable receipt identity. The package session creates and retains
the separate envelope `actionId`; `(scope, actionId)` is the receipt/retry
identity supplied to the generated handler but never accepted in its payload.
The factory returns the generated public action type
`Transcript.annotatedText.comments.compose` with a closed package payload;
callers cannot supply related-entity or annotation IDs, project, author, family,
relation, defaults, operations, or checkpoints. Workbench derives stable entity
and annotation IDs from the owning `(scope, actionId)` plus declared action
identity. Retry therefore reuses both identities without exposing an ID policy.

The factory requires the entity, field, and action handles from the same
compiled declaration. Type parameters preserve that relationship and runtime
identity checks reject copied or cross-declaration handles.

For Scope comment compose, `body` is the only caller value. `projectId` comes
from the current Transcript row, `userId` is the authenticated committing
principal (not the Transcript owner), `resolved: false` is an explicit Comment
entity declaration default, parent is absent, and `createdAt`/`updatedAt` are
entity declaration defaults materialized once inside the first successful
transaction. Defaults are not regenerated on replay. `resolvedAt`/`resolvedBy`
are absent. A Comment remains a Project entity. Its body may be exposed only by
a separately declared document-authorized related projection; it is never
Project-shell discovery.

## Transaction and authorization boundary

One generated handler, one receipt, and one database transaction perform all
of the following: reload the document; resolve its declared Project; authorize
the principal as an explicit member of that exact Project with `write`, and for
the annotated field's declared document-authoring `write` capability, through
the normal grant engine; validate the recipient-bound basis and current
projected continuous text;
validate a non-empty UTF-16 range; revalidate the selected
action and related entity declaration; authorize creation of the related row
in that same Project; materialize canonical fields/defaults; emit/project the
entity creation and annotation application; and insert the receipt. The related
entity event uses the document's owning Project scope so the whole action has
one durable receipt identity and no cross-scope partial commit.

Both grants are mandatory. Editor/owner Project membership may satisfy them;
viewer/review-only access does not. Organization membership is irrelevant.
Author attribution is always the authenticated principal. A missing/revoked
document, stale or foreign
basis, hidden/cross-restricted text, invalid/reversed/out-of-range offsets,
cross-Project relation, malformed declaration, ID collision, authorization
failure, validation failure, or either projection failure rolls back everything.
Authorization runs again before receipt dedupe, so a revoked replay is denied;
an identical authorized replay returns the original receipt and creates
nothing, while changed payload under the same identity conflicts.

## Rejected alternatives

- Browser batch of `Comment.create` plus `annotation.apply`: generated CRUD is
  not public, independent admission cannot prove the joined invariant, and the
  document session intentionally exposes no batch or raw dispatch.
- Scope callback/registered action, REST writer, staged create, compensating
  delete, raw operation/checkpoint, or fallback: each creates another policy or
  mutation authority.
- A Project comment list: it leaks discussion bodies, authorship, resolution,
  orphan/quote state, or document association into the shell.
- Caller-selected author/project/IDs: these weaken attribution, alignment, and
  replay invariants without enabling a required use case.

## Release gate

Declaration, root/subpath exports and types, browser factory/session, generated
handler/admission, projection, replay, and hostile tests are inseparable. Do not
publish or pin a declaration-only or browser-only subset.

Acceptance tests must prove: editor/owner success and viewer, organization-only,
revoked, missing, and retired denial; absent/foreign/stale basis denial; hidden,
cross-restricted, collapsed, reversed, out-of-range, and
surrogate-splitting selection denial; malformed, missing, optional, mismatched,
duplicated, and unknown declaration pieces—including relation, project, author,
capability, input mappings, and defaults—fail at startup; related-row
validation, grant, FK/project mismatch, ID collision, entity projection, or
annotation projection failure leaves neither row nor annotation; same-envelope
authorized replay is a no-op, changed-envelope reuse conflicts, revoked replay
denies; and Project shell snapshots contain no Comment identity, body, author,
resolution, orphan, quote, membership, or document-association data.
