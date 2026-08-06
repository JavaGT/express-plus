# Inline Confidential Spans for Annotated Text

Status: accepted (implemented; tracked via issues #22–#28)

## Decision

Annotated-text becomes a **single span-native model**: annotations are arbitrary
overlapping ranges (structural endpoints with affinity) over the RGA text, and a
`protecting` annotation family applied over a range creates a **confidential
span** that is redacted per-recipient at delivery. This is a breaking change —
the v1–v11 durable `operated` lattice is deleted and replaced with one
span-native durable model; historical rows are not replayed.

## Motivation

Block annotations are today whole-block-only; sub-range annotation requires
physically splitting the block (`isolateAnnotationSelection` in
`annotated-text-r4.mjs`), and confidentiality is block-granular only. We want
BlockNote-style inline ranged annotations, plus a confidentiality feature no
mainstream editor ships: some text is hidden from some editors (e.g. a
transcript shows `[speakers address]` to some), while authorized users see the
original. This unifies collaboration (a reducer CRDT) with server-enforced
per-recipient redaction.

## Locked design

### Model

- Block-based document; text is a single RGA CRDT (reducer/action-dispatch),
  partitioned into blocks.
- Annotations are **unified spans** — a range with two structural (affinity-bound)
  endpoints. A block annotation is a span covering the whole block.
- Spans **overlap and nest arbitrarily**.

### Confidentiality

- A confidential span is an annotation of a `protecting` family, created by the
  ordinary `annotation.apply` over a range. No new op kind; existing
  apply/detach/remove payloads gain a range.
- Each span authorizes **per-principal**.

### Redaction rule

- A recipient's visible document = real text with every interval covered by a
  confidential span they are denied for, replaced by a **placeholder token**
  (`[address]`).
- Placeholders = **union of denied spans' intervals** — overlapping denied spans
  merge into one placeholder, leaking no structure.
- Computed **server-side at delivery** (recipient projection). Raw text and the
  denied spans' shapes never reach an unauthorized client.

### Show-through

- Comments/annotations render in full over the text, including over confidential
  spans — only the underlying information is redacted. A comment entirely over a
  confidential span still shows, with the placeholder token inside.

### Nesting

- Per-span allow/deny. **Deny is transitive outward; allow is not transitive
  inward.** Allowed-inner-within-denied-outer → redacted; denied-inner-within-
  allowed-outer → the inner interval joins the denied union.

### Editing

- Authorized users edit real text; boundaries are what's protected, not content
  identity.
- Unauthorized users edit surrounding visible text; the placeholder is an
  affinity-bound, non-editable gap (typing attaches to the visible neighbor,
  never into the hidden region).
- The client optimistic path renders a placeholder at the projected position but
  is never handed the real denied text.

### Structure and undo

- Spans split with a block; merge across boundaries.
- Undo is a server-owned durable compensation action operating on spans as units
  and on text edits; **undo never leaks** — it never reveals hidden text to an
  unauthorized recipient; the projection re-evaluates per recipient after.

### Migration

- Delete old DB, breaking change — collapse the v1–v11 lattice to a single
  span-native model. No layered versions, no replay of historical rows.

## Non-negotiable invariant

The recipient projection is the confidentiality boundary. The CRDT is the
collaboration engine; the projection is the lock. **The client must never fold
confidential ops.** The CRDT "full copy on every replica" instinct and the
confidentiality boundary pull against each other; the resolution is that
redaction is computed in the recipient projection and the raw denied text never
reaches an unauthorized replica.

## Implementation

Tracked as issues #22 (epic) and #23–#28 (tickets). The v1–v11 lattice collapse
is #23; the undo-interplay ticket #28 blocks on the existing collaborators'
undo/redo issue #13.

## Consequences

- Removes the physical block-split-for-subrange machinery and the v1–v11 replay
  switch — a net simplification of the durable model.
- Introduces overlap/nesting resolution in the projection — the "union of denied
  intervals" rule is the load-bearing part and needs focused tests (arbitrary
  overlap and nesting).
- Confidentiality is explicitly a server-side delivery concern, not a client
  filter — fail-closed by construction.

## Non-goals

- No live op fold for confidential ops (client never folds confidential content).
- No UI hinting that a confidential span exists where placement could leak secure
  content (parked caveat).
- No browser-local-only undo or second reconciliation path.