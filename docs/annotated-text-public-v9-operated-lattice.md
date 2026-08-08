# Annotated text — operated version admission and replay contract

Status: accepted contract (docs only). This note supersedes the retired
v1–v11 "operated lattice" guidance. The authoritative model decision is
[ADR 0008 — Inline Confidential Spans](./adr/0008-inline-confidential-spans.md);
this note records the durable `operated` version contract and the
recovery/migration boundary that follows from it.

## Rule

**Apps and clients mint only the public wire.** Durable `operated` event
versions are internal commit/projection history, not an app-facing API. There
is exactly **one admitted operated version today: v13** — the span-native
codec introduced by ADR 0008. Every other version — each pre-13 lattice
version and any unknown version — **fails closed** at the projection with a
stable error that names the version. No old reducer runs beside v13, and no
historical lattice row is replayed.

| Surface | What is allowed |
| --- | --- |
| Public operation wire | **Version 9** offset edits only (`assertV9AnnotatedTextOffsetEditPayload`) |
| Lifecycle beside ops | `annotatedTextCreateAction` / entity create; `annotatedText.retire` |
| Client/session | Build v9 actions via package/client helpers; hold authoring tokens |
| Durable log / projection | `Entity.<field>.operated` payloads **version 13 only** — admitted and reduced; every other version fails closed |
| Live delivery | Fully-visible recipients may receive a **recipient-safe v13 fold envelope** (`annotatedText` fold v3) for whole-document text transitions; redacted/restricted recipients and non-foldable operated events fall back to **snapshot resync** (`annotated-text-snapshot-required`) |

## Why pre-13 rows are not replayed

ADR 0008 made annotated text a single **span-native** model and, as a breaking
change (issue #23), **deleted the v1–v11 durable `operated` lattice**: old DB
was deleted, no layered versions, and historical rows are deliberately **not
replayed**. The v13 codec and the retired lattice codecs have no deterministic
shared fold; replaying an old row would require re-adding the retired reducers
— a second projection machine — so the projector instead admits v13 and fails
closed on everything else.

## Delivery: recipient-safe v13 fold, not the retired lattice

Live delivery does **not** run the retired v1–v11 client RGA lattice. The only
live op fold is the **recipient-safe v13 fold envelope**
(`src/annotated-text-fold-envelope.mjs`), built from a committed v13 `operated`
event after the delivery seam re-authorizes the recipient and re-projects their
view:

- A **foldable** event is a whole-document `text.apply` / `text.replace`
  transition with no frontier change. The delivery seam ships a fold **only**
  when the recipient reads the entire document unredacted — no restriction, no
  redaction, and no authoring redaction. The client folds the RGA text
  operations onto its own family copy (seeded by its snapshot's authoring
  envelope) and verifies the resulting text against the server projection.
- **Everything else resyncs** with `resync` / `annotated-text-snapshot-required`
  and recovers through the projected recipient snapshot: redacted or restricted
  recipients (ADR 0008: the client must never fold confidential content),
  annotation apply/remove (they change no text), block-era operation shapes, and
  any event the fold builder cannot verify against the committed family.

This is one fold mechanism with one eligibility gate — not a second
reconciliation path, and never the retired v1–v11 lattice.

## Fail-closed version guard

`src/entity/projection.mjs` (`applyAnnotatedTextOperation`) admits exactly
`data.version === 13` and throws for anything else. The error is stable and
names the offending version, the one admitted version, and the retirement
ticket:

```text
<entity>.<field>.operated event version <n> is not supported: only operated
version 13 is admitted; pre-13 lattice rows were retired and are never
replayed (issue #23)
```

The guard runs before any row write, so a **rejected event performs zero
writes** to durable state. The low-level projector does not own a transaction:
a whole-log rebuild that must stay atomic is the caller's job and has to wrap
the replay in the existing named transaction boundary (`txn` / `exclusiveTxn`
in `src/driver.mjs` — the same lanes the kernel's commit bracket and the
migration lane use). There is no second replay mechanism.

## Recovery / migration boundary

- **Current traffic** delivers through the recipient-safe v13 fold when the
  recipient is fully visible and the transition is foldable; everything else —
  redacted/restricted recipients, annotation edits, unverifiable events —
  recovers through the span-native snapshot path (`resync` /
  `annotated-text-snapshot-required`), never through a live fold of content the
  recipient is denied.
- **Pre-v13 persisted databases must be rejected or reset before startup or
  rebuild — an operator obligation, not something the framework enforces at
  boot.** No migration gate detects a pre-13 `operated` row automatically: the
  startup migration lane (`src/migrations.mjs`, the `migrations` app option) is
  for schema evolution, and the durable history contract is fresh-schemas-only
  ([`docs/durable-history-contract.md`](./durable-history-contract.md): "no
  legacy reader, migration, compatibility adapter, or alternate engine"). The
  projection rejects such a row only when it is reached (commit or replay),
  fail-closed and write-free. Beta allows reset: a pre-13 DB is **not silently
  upgraded**, it is deleted and rebuilt. The smallest faithful pre-flight check
  is to reject any `_Log` row whose `operated` `eventData.version` is not 13
  before starting the app or rebuilding a database.
- **Any future version change** must be a separate migration ticket with replay
  proofs, exactly as the retired lattice note required. ADR 0008's delete reset
  retired the v1–v11 rows themselves; it does not discharge an operator from
  rejecting a database that still carries them.

## Three loops

1. **Compile** — `annotatedText(...)` declaration → DDL, handlers, grants.
2. **Commit** — public v9 (or internal planner output) → authorize → append
   `operated` (v13) → the v13 projector folds it into the row.
3. **Deliver** — post-commit, re-authorized delivery tries the recipient-safe
   v13 fold envelope for a foldable whole-document text transition to a
   fully-visible recipient; every other recipient and event class falls back to
   `resync` / `annotated-text-snapshot-required` and recovers through the
   projected snapshot (the client **materialize** path).

There is no second write path. The only live op fold is the v13 recipient-safe
fold envelope — it is not the retired v1–v11 client RGA lattice, and it never
carries confidential content to a denied recipient.

## Public admission (v9)

External `{Entity}.{field}.operation` admits **version 9** offset commands
(text insert/delete/replace, annotation apply/detach/remove, and related v9
kinds). Admission binds authoring stream/lease and position tokens, then the
handler plans durable events. Apps never choose an internal R-version.

## Non-goals (this note)

- Replaying or migrating the retired v1–v11 lattice.
- Re-adding old reducers or running a second projection machine.
- Exposing internal versions on package/client constructors.
- Folding confidential or redacted content client-side (ADR 0008 boundary), or
  a second live op-fold mechanism beside the recipient-safe v13 fold envelope.

## Where to look in code

| Concern | Home |
| --- | --- |
| Public v9 assert + operation handler | `src/entity/crud.mjs` |
| Operated version guard + v13 projector | `src/entity/projection.mjs` (`applyAnnotatedTextOperation`) |
| Recipient-safe v13 fold + resync fallback | `src/live-delivery-public.mjs`, `src/annotated-text-fold-envelope.mjs` |
| Ephemeral fan-out (annotated-text always resyncs) | `src/live-fanout.mjs` |
| Typed public actions | `src/annotated-text-action.mjs` / browser action helper |
| RGA grammar (not op versions) | ADR 0005, `src/annotated-text.mjs` |
| Lattice retirement decision | [ADR 0008](./adr/0008-inline-confidential-spans.md) |
