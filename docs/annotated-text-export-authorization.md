# Annotated-text canonical export authorization

`exportAnnotatedText` assembles the canonical document only after binding the
document's declared `annotatedText.project` relation to the caller's typed
`expectedOwningScope` and resolving the current principal through that owning
entity's ordinary Workbench `admin` capability. The application registry, not a
caller-provided policy object or raw scope string, supplies the owning entity and
authorization checks. Missing documents/scopes, relation mismatches, absent
`admin`, revoked grants, malformed aggregate state, and retired documents fail
closed before canonical facts are returned.

The package API requires `{ app, entity, field, documentId,
expectedOwningScope: { entity: Project, id }, principal }`. Canonical assembly
remains package-owned and its output grammar is unchanged.

Rejected alternatives:

- Document-owner identity checks: a project owner cannot export a document
  created or owned by an editor, and callers would have to impersonate that
  editor.
- Raw scope strings or caller-supplied authorization callbacks: either permits
  document/scope confusion or creates a second authorization authority.
- Scope-owned canonical assembly or direct table/checkpoint access: duplicates
  the package's canonical transcript authority and exposes storage grammar.
