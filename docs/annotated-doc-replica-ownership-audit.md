# Ticket #3 audit: annotated-doc draft authority is package-owned

Status: **implementation-complete, test/audit deliverable**. Final full-repository
verification is recorded as dependent on the #55 blockless cutover (below).

## Ruling (Sol, openai-gpt-5.6-sol)

> **(a) Ticket #3 is now a test/audit gate, not a new vertical implementation.**
> Its material objective—removing app-owned draft/reconciliation authority in
> favor of the package-owned recipient replica—has already been achieved. The
> demo delegates editing, placeholders, settlement, retry, and reconciliation to
> `createAnnotatedTextHttpSession`, which delegates through
> `createLiveDeliveryHttpSession` to the single `createLiveDeliverySession`
> ingest engine. Legacy block-shaped views remaining in the demo are
> presentation/API compatibility debt, not a second draft or reconciliation
> authority.
>
> Do not rewrite the package-owned session or replica seams for #3 without a
> demonstrated invariant failure.
>
> **(b) The #55 coordinator exclusively owns all four conflicting demo-migration
> files** (`projects/annotated-doc/public/index.html`,
> `projects/annotated-doc/public/comment-panel.mjs`,
> `test/browser/annotated-doc.spec.mjs`,
> `test/annotated-doc-demo-smoke.test.mjs`). The #3 implementer must not edit
> those files. If #3 verification requires changes in any of them, stop and
> report the #55 dependency.
>
> No new #3 acceptance test is presently required beyond the cited coverage.
> A #3 audit may record and run those existing tests, but must not add redundant
> tests merely to produce a diff.
>
> **Closure boundary:** #3's material implementation is satisfied, but final
> acceptance item "full repository verification passes" must be recorded only
> after #55 finishes its atomic demo/public-contract migration and the resulting
> full suite is green.

## Why no vertical

The ticket's objective presumes an app-owned draft/reconciliation state machine
in the annotated-doc demo. None exists. `projects/annotated-doc/public/index.html`
creates the package-owned session and delegates every mutating path to it:

- `createAnnotatedTextHttpSession` (`public/workbench-client.mjs:3319`) →
  `createLiveDeliveryHttpSession` (`:3128`) → `createLiveDeliverySession`
  (`:2241`), the single recipient-ingest reconciliation engine.
- Optimistic edits are visible placeholders only: `optimistic` projection plus
  the operation lifecycle (`createOpLifecycle`, `:85`; `shouldReconcile`, `:68`).
- A transmitted request with a lost response stays `outcome-unknown` and retries
  the same stable operation ID via `retry(opId)` (`:3062`); the frozen envelope
  is resent unchanged (`operations.delete(actionId)` only on known rejection).
- IndexedDB durable replica for the HTTP/live delivery family:
  `createIndexedDbReplicaState` (`:1592`).
- Unsafe/ambiguous folds recover by opaque snapshot resync (fold baseCursor and
  shape validation before apply).
- History is document-bound and the server resolves the owning durable scope via
  the session's authenticated document identity.

The demo renders `session.document` and waits on settlement; it contains no draft,
reconciliation, optimistic, or retry authority of its own.

## Acceptance items → proving tests

All items map to existing green tests; no new tests were added (per ruling).

| Acceptance | Proving tests |
| --- | --- |
| Text-only declarations need no dummy annotations/measurements | `test/annotated-text-field.test.mjs:55` |
| Direct reducer tests deterministic and clock-free | `test/annotated-text-laws.test.mjs`, `annotated-text-r4/r5`, `annotated-text-continuous`, `annotated-text-seeded-convergence` (no clock/`Date.now` usage) |
| Rapid typing persists once and survives reload | `test/browser/annotated-doc.spec.mjs:145`, `:122` |
| Emoji deletion preserves well-formed Unicode | `test/browser/annotated-doc.spec.mjs:122`; `test/annotated-text-astral.test.mjs` |
| IME composition commits once | `test/annotated-text-editor.test.mjs:139` (single replacement) |
| Two real browser pages converge without compensating repair writes | `test/browser/annotated-doc.spec.mjs:729`, `:747`, `:781` |
| Rejection removes only its placeholder | `test/annotated-text-http-session.test.mjs:388` |
| Lost post-commit response retries the same ID without duplicate mutation | `test/live-delivery-session.test.mjs:172` (batch), `:225` (single) |
| Demo browser metadata is compiler-derived | `test/annotated-doc-demo-smoke.test.mjs:71` |
| Recipient payloads never expose raw CRDT/actor/frontier/checkpoint/topology/protection facts | `test/annotated-text-recipient-projection.test.mjs`, `annotated-text-recipient-blockless`, `annotated-text-recipient-read` |
| Unsafe/ambiguous changes are snapshot-resync boundaries | `test/live-delivery-session.test.mjs` fold-shape recovery tests; `test/annotated-text-http-session.test.mjs:668`, `:719`, `:791` |

## Verification run (this session)

- `node --test` field/law/live-delivery/http-session/editor/demo-smoke/astral
  + recipient projection/blockless/read (including #55's concurrent in-flight
  edits to those suites): **301 passed, 0 failed**.
- `node --test` r4/r5/r8-integration/continuous/seeded-convergence:
  **116 passed, 0 failed**.
- `npx playwright test test/browser/annotated-doc.spec.mjs`: **32 passed**.
- `git diff --check`: clean.

## File-ownership boundary

- Owned by #3 (this ticket): none — audit record only.
- Owned by #55 (must not be touched by #3):
  `projects/annotated-doc/public/index.html`,
  `projects/annotated-doc/public/comment-panel.mjs`,
  `test/browser/annotated-doc.spec.mjs`,
  `test/annotated-doc-demo-smoke.test.mjs`.
- Package-owned seams (verified, not modified): `public/workbench-client.mjs`,
  `public/workbench-annotated-text-editor.mjs`.
- Preserved concurrent worktree changes (all from the #55 cutover and other
  in-flight agent work; untouched by this audit): `index.d.ts`,
  `src/entity/crud.mjs`, `public/workbench-annotated-text-editor.mjs`,
  `src/annotated-text-recipient-projection.mjs`,
  `src/annotated-text-recipient-projection.ts`,
  `test/annotated-text-editor.test.mjs`,
  `test/annotated-text-recipient-blockless.test.mjs`,
  `test/annotated-text-recipient-projection.test.mjs`,
  `test/annotated-text-text-range.test.mjs` (modified, unstaged);
  `docs/annotated-text-undo-algebra.md`,
  `test/annotated-text-collaborative-undo.test.mjs` (untracked, another agent's
  deliverable).

## Closure dependency

Full-repository verification for #3 is recorded only after #55's demo/public-contract
migration lands green. Until then #3 is implementation-complete with verification
dependent on #55; do not reopen replica architecture on that basis.
