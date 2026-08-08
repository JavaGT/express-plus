# Annotated-text undo/redo inverse algebra

Ticket #13 — action provenance and the inverse/redo algebra for collaborative
annotated-text undo. This is the annotated-text specialization of the general
durable-history contract in [`durable-history-contract.md`](./durable-history-contract.md)
and the semantic-operations rule in [`semantic-operations.md`](./semantic-operations.md).

## 1. Provenance

Undo/redo eligibility is scoped to the **requesting human principal**, the
**Studio session**, and the **owning document scope** — the same cursor identity
the durable history cursor uses everywhere:

- cursor key = `(owning scope, user principal type+id, sessionId)`.
- Only `user` principals with a `history.session` enter a cursor. Machine/system
  writes stay attributable but never enter human undo state.
- An undo/redo may only target actions recorded on that exact
  principal+session+scope cursor. A different principal or a different session
  observes `undo: 0`; their move against an empty cursor is a durable `empty`
  no-op, never a jump to another user's history.
- Every compensation is a **new durable annotated-text mutation** delivered and
  reconciled through the ordinary event/`ingest` path (v13 operated event →
  projection → receipt → fold). It never replaces the whole document from a
  private image.

## 2. The compensation action

A package-owned, non-public action is generated per annotated field:

- type: `<entity>.<field>.compensate`
- payload (version 1): `{ id, history: { version: 1, rootActionId, targetActionId, direction: 'undo' | 'redo' } }`
- handler-only opaque input: `{ kind: ANNOTATED_TEXT_COMPENSATION, targetFact }`
  bound as `history.input` inside the history transaction only. It is never part
  of the action payload, never serialized to the log/receipt, never delivered,
  and never replayed.
- Direct public dispatch of a compensation payload fails closed (`forbidden`);
  compensation is history-authored only.
- The `_PrivateActionFact` for a compensation records narrow linkage
  `{ rootActionId, targetActionId, direction, outcome }` plus the compensation's
  own fresh contribution. It is never a whole-document or whole-table image and
  is never delivered.

## 3. Inverse/redo algebra

### 3.1 Text CRDT insert (current landing)

Eligible: a v9 `text.insert` edit with non-empty text
(`<entity>.<field>.operation` whose payload parses to
`edit.kind === 'text.insert'`). Its private fact is an
`annotated-text.contribution` v2 fact:

```
{ version: 2, kind: 'annotated-text.contribution',
  documentId, contribution: { kind: 'text.insert', opId, anchor, text, scalarCount } }
```

**Inverse (undo)** of an insert — a *fresh* `text.delete` operation that targets
only the surviving contribution:

- basis: the current family checkpoint frontier and liveness of the
  contribution's scalar elements;
- if **all** `scalarCount` elements named by `opId` are still live, delete them
  with a fresh actor derived from the compensation actionId, `lamport = max+1`;
- the compensating op carries a fresh opId/lamport/frontier — it is a new
  contribution, not a replay;
- the compensation private fact records `outcome: 'applied'` and, for undo,
  `redo: { kind: 'text.insert', opId: <original>, anchor, text, scalarCount }`
  so redo can reconstruct the original identity.

**Redo** of that undo — a *fresh* `text.insert` operation at the original
anchor with a fresh opId/actor/lamport/frontier. It re-applies only the intended
contribution. It is not snapshot restoration: the anchor is resolved against the
current family, so intervening collaborators' contributions remain placed
around it.

**No-op law.** An inverse that cannot apply safely is an explicit, durable no-op,
never a global rewind:

- undo when some (or all) of the contribution's elements are already
  transformed/removed → `outcome: 'noop'`, zero events, cursor still advances;
- redo after a `noop` undo → `outcome: 'noop'`, zero events (a no-op undo has
  nothing to compensate);
- retried moves return their committed receipt (`deduped`) with no second
  execution.

Authoring streams, position tokens, and ephemeral caret presence are **never
revived** by undo/redo. The compensation's fresh actor/lamport derive from the
compensation actionId and current family only.

### 3.2 Text CRDT delete (designed, currently a fail-closed barrier)

Undoing a delete must restore the deleted contribution as a **fresh valid CRDT
insert** with correct visible placement — it may not resurrect the old op
identity. Designed algebra (same shape as the insert inverse above):

- delete contributions are captured at commit with their surviving contribution
  shape (`text`, `anchor`, `scalarCount`, original `opId`) so a later inverse can
  rebuild a fresh insert at the surviving anchor;
- inverse = fresh insert of the deleted contribution's text at its surviving
  anchor; redo = fresh delete of that restored contribution;
- the same liveness/atomicity/no-op laws apply.

**Current landing:** deletes are not yet undoable. A `text.delete` (and any
non-eligible annotated edit) is a **barrier**: it clears that principal's cursor
(`past = future = []`) rather than exposing an older eligible action across a
newer non-eligible one, and the annotated history surface fails closed. Making
deletes undoable is tracked against the compensation handler
(`src/entity/crud.mjs`).

### 3.3 Paragraph anchors, structural block changes, block groups

The blockless model (issue #33) removed the block layer: one continuous RGA
family per document. Block-era paragraph-anchor and block-group operations are
not eligible actions — they are barriers, and the cursor reconstruction never
exposes them. Their intended algebra, should a structural kind return, is
compensate-only-the-created-topology with the same no-op law; a structural
inverse that would rewind document topology fails closed.

### 3.4 Annotation memberships and measurements

Annotation apply/remove edits and measurement-producing edits change no text
(`before.frontier === after.frontier`) and are not eligible: they fall through to
the ordinary envelope grammar and act as cursor barriers. Intended algebra:

- an annotation membership inverse compensates only that membership's surviving
  contribution, atomically with its text transform;
- a protecting-family edit that changes a recipient's visibility must fail
  closed to snapshot recovery rather than fold (a fold would disclose an
  annotation the recipient was never entitled to see);
- measurement facts compensate atomically with the text transition they rode in
  on; a measurement inverse without its paired text change is a no-op.

## 4. Atomicity

A compensation commits **one** v13 operated event (or a durable no-op with zero
events) atomically with its receipt, private fact, and cursor transition in the
same transaction. Text, paragraph topology, annotations, block groups, and
measurements transform together or no-op together; any handler throw rolls back
projection, log, receipt, private fact, and cursor together.

## 5. Fail-closed inventory

The following are rejected before any write, or commit a durable no-op, never a
partial write:

- stale `revision` on a move → `409` (cursor changed during dispatch).
- missing, erased, malformed, or retired private facts / inverse targets →
  `forbidden`/`TypeError` before the handler runs.
- principal/session mismatch on a retried actionId → `409`.
- forged public compensation dispatch → `forbidden`.
- non-eligible annotated actions (deletes, annotation edits, retired payloads)
  → barrier that clears the cursor; the annotated surface stays forbidden.
- restricted/redacted recipients and protecting-family transitions → snapshot
  recovery, never a fold.
- redo after a no-op undo, or undo of a fully-consumed contribution → durable
  no-op.

## 6. Cursor semantics

The cursor is **reconstructed from durable receipts** when the `_HistoryCursor`
row is absent (retention/restart): eligible actions push `past` frames, undo pops
`past → future`, redo pops `future → past`, and a barrier clears both. A move
requires the caller-generated `actionId` plus the opaque `revision`; concurrent
stale moves conflict, and retrying the same id returns its committed receipt
without re-executing. See `durable-history-contract.md` for the general
mechanism.
