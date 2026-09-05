# Conflict / merge policy (M1, #188)

Global rule: **last-writer-wins is rejected as a framework-wide policy.** Each
field kind declares its concurrent/offline outcome below. LWW appears only as a
named per-kind fact (whole-value replace), never as the default. See #180.

## Declared per-kind outcomes

| Kind | Concurrent writes | Basis |
|---|---|---|
| `value` (text/number/boolean/date/json/ref/blob...) | Whole-value replace (last commit wins), silent | `STRATEGIES.value`, `src/field-delta.ts` |
| `annotatedText` | Merge / coexist; stale-region edit rejected as validation, not merged | Frontier/pending causal reducer; region limits |
| `crdt` text | Merge (commutative), native ops only | `commutativeMerge: true`; whole-value diff throws |
| `crdt` raster / polyline | Replace stub (merge deferred, non-prod warn) | `reportReplaceStubDelta`; must graduate to merge, not to silent LWW |
| `hash` | Replace (write-only digest compare) | `STRATEGIES.hash` |
| `store` / `map` | Merge across members; per-member last-commit; idempotent re-set is client no-op | Side-table rows + probe; `{added, removed, changed}` delta |
| `log` | Coexist (append-only, minted entry ids; no write-write conflict) | `src/strategy/log.ts` |
| `ordered` / `list` | Coexist for distinct ids (fractional keys, no renumber); same-element `move` contention = last committed key wins (no OT) | `keyBetween`; native events only (DECISIONLOG #74) |
| `struct` | Per-sub-cell replace; different cells coexist | Flattened `<field>__<cell>` columns |
| `state` | Replace + conflict-error on illegal move (validation, not merge) | Transition guard in CRUD handler |
| `computed` / `projected` / `ephemeral` | Not client-writable | Payload presence → `ValidationError`; no persistence seam |

## Optimistic concurrency

Opt-in, live/no-history tier only: `expectedRevision` vs `_LiveRevision`,
mismatch → 409 `conflict` (`src/live-revision.ts`). History tier has no
per-field OCC. #183 must decide whether queued live actions carry (possibly
stale) revisions or rebase before resend.

## Offline resend rule (binds #183)

- Same `actionId` resend: safe — pipeline dedupes the whole `(scope, actionId)`
  against receipts before field logic (`src/pipeline.ts` dedupe checks).
- Fresh `actionId` resend: a NEW mutation re-entering the table above.
  The outbox must never mint fresh actionIds for retries.

## What #182 / #183 must obey

- #182 codegen: parity test per kind; kinds whose outcome is merge/stub cannot
  be covered by whole-value assignment codegen.
- #183 outbox: conflict behavior tested per kind (CRDT coexist, map merge,
  ordered-insert coexist, value replace, live 409), not single-writer only.
