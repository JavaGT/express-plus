# Annotated text — public v9 vs internal operated versions

Status: accepted guidance (docs only). Parent epic: complexity simplification.

## Rule

**Apps and clients mint only the public wire.** Durable `operated` event
versions are internal commit/projection history. Do not treat the lattice as an
app-facing API.

| Surface | What is allowed |
| --- | --- |
| Public operation wire | **Version 9** offset edits only (`assertV9AnnotatedTextOffsetEditPayload`) |
| Lifecycle beside ops | `annotatedTextCreateAction` / entity create; `annotatedText.retire` |
| Client/session | Build v9 actions via package/client helpers; hold authoring tokens |
| Durable log / projection | `Entity.<field>.operated` payloads **v1–v11** (replay + reduce) |
| Live delivery | **No** recipient op grammar — `operated` forces snapshot **resync** |

## Three loops

1. **Compile** — `annotatedText(...)` declaration → DDL, handlers, grants.
2. **Commit** — public v9 (or internal planner output) → authorize → append
   `operated` → projectors switch on durable `data.version` (v1–v12).
3. **Deliver** — post-commit fan-out classifies annotated-text `operated` as
   `resync` / `annotated-text-snapshot-required`. Recipients recover through the
   projected snapshot; the client **materialize** path is the only fold.

There is no second write path and no client RGA fold of live ops.

## Public admission (v9)

External `{Entity}.{field}.operation` admits **version 9** offset commands
(text insert/delete/replace, block split/merge/continue, annotation
apply/detach/remove, block-group assignment, and related v9 kinds). Admission
binds authoring stream/lease and position tokens, then the handler plans durable
events. Apps never choose an internal R-version.

## Internal operated lattice (v1–v11)

Projectors dispatch durable `operated` by `data.version` (including structural
split/merge, annotation apply/remove variants, group assignment, and v9-shaped
rows that may appear on the log). Unknown versions fail closed.

These shapes exist so historical log rows keep replaying. **Minting new public
traffic still goes through v9** (and create/retire). Internal versions are not a
menu for application code.

## Live: snapshot only

Annotated-text operations have no recipient event envelope. Fan-out sends
`resync` with reason `annotated-text-snapshot-required`. Optimistic UI may show a
text placeholder; authority is always the next recipient snapshot.

## Non-goals (this note)

- Collapsing or migrating the durable version lattice
- Exposing internal versions on package/client constructors
- Adding a live op-fold path beside snapshot materialize

Version collapse, if ever done, is a separate migration ticket with replay
proofs — not implied by this document.

## Where to look in code

| Concern | Home |
| --- | --- |
| Public v9 assert + operation handler | `src/entity/crud.mjs` |
| Durable version switch | `src/entity/projection.mjs` (`applyAnnotatedTextOperation`) |
| Snapshot-only live | `src/live-fanout.mjs` |
| Typed public actions | `src/annotated-text-action.mjs` / browser action helper |
| RGA grammar (not op versions) | ADR 0005, `src/annotated-text.mjs` |
