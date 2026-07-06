# Convergence programme ledger

Maintained by the **coordinator only**. Subagents never write this file.
Append; never rewrite history. Update the status table in place, add rows
to the logs.

## Packet status

| Packet | Doc | Stage | Branch(es) | Last full gate | Notes |
|---|---|---|---|---|---|
| W1 auth parity | `W1-auth-parity.md` | **done** | `convergence/W1-two-plane` (1), `convergence/W1-passkeys` (2), `convergence/W1-invitations` (3), `convergence/W1-api-keys` (4), `convergence/W1-totp` (5) | 1412/1412/0 | S1: membership(). S2: passkey WebAuthn. S3: invitation flow. S4: ApiKey principal. S5: TOTP 2FA + email seam. 10 build items closed, 3 defer-candidates skipped (2FA enforcement, forgot-password, email verification — dead Scope features). |
| W2 persistence ownership | `W2-persistence-ownership.md` | **done** | `convergence/W2-fts` (1), `convergence/W2-vector` (2) | 1378/1378/0 | S1: FTS — text({ indexed: 'fts' }), FTS5, .matches(), lifecycle sync. S2: vector(dim) — JSON-stored embeddings, cosine similarity, .nearest(). Both GAPs closed. |
| W3 job queue parity | `W3-job-queue-parity.md` | slices | `convergence/W3-job-queue` (slice 1) | 1273/1273/0 (merged) | Slice 1: progress (+stage), cancellation (cancelled status), scoping (scope column + scoped claim). 3 BUILD items closed. |
| W4 UI kit | `W4-ui-kit.md` | **done** | `convergence/W4-wave1` (1), `convergence/W4-wave2` (2), `convergence/W4-wave3` (3), `convergence/W4-wave4` (4) | 1576/1576 + 162/162 browser | All 25 primitives shipped (4 waves). Svelte 5 components + bindAction/bindField/bindList/bindConnection helpers. Owner overruled c02 (Option C, Svelte-first). Council c03 reviewed waves 1-2. W5 filings: onConnectionChange + overlay-status API. |
| W5 client engine parity | `W5-client-engine-parity.md` | slices | `convergence/W5-scope-subscription` (slices 1+2) | 1216/1216/0 | Slice 1: subscribeScope() + normalizeSubscribeMsg. Slice 2: scope-keyed fan-out (per-entity Map retired), scope-level snapshot/events-since routes, generic subscribed ack. Council c01 adopted B′. |
| S scope migration | `S-scope-migration.md` | **building (station A)** | `phase-S/station-A` (Scope repo) | 1933/1934, 0 check errors | S0 joint recommendation: station A is transport swap (SSE→WS). Adapter: projectId → scope "project:<id>". Boot: snapshot→subscribe→events-since. Single-path pipeline (wb.ingest). Per-surface cutover. Station B (physical migration) and Station C (client engine) deferred. |

Stage vocabulary: `not started` → `census` → `design` → `slices` → `done`
(or `gated` / `blocked-on-owner`).

## Council log

One row per council question. Working files live under `.council/<qid>/`
(gitignored); this table is the durable record.

| qid | Date | Question (one line) | Converged after cross-eval? | GLM tie-break used? | Outcome adopted |
|---|---|---|---|---|---|
| c02 | 2026-07-07 | W4 UI kit: technology (Web Components vs DOM factories vs per-framework adapters), binding contract, 3-primitive API sketch | Yes — Opus 4.8 + GPT 5.5 converged on B (DOM factories). GPT revised from A after Opus's restyling argument. | No (converged) | Option B adopted: DOM factory functions + formal light-DOM token/attribute contract. Reject Web Components (Shadow DOM contradicts 'deep restyling without forking' — the single most-emphasized owner constraint). Reject per-framework adapters (singular-system rule). Binding: factory owns the store projection; component holds no local state. 3 code discoveries: overlayFor() skips failed, LiveList is single-row not collection, dispatch() only overlays CRUD. Wave 1 = ActionButton, TextInput, ListView. |

## Owner escalations

| Date | Question | Owner ruling | Where recorded |
|---|---|---|---|
| 2026-07-06 | S0 wire memo: Scope uses per-project seq numbering, workbench uses per-entity seq. Structurally incompatible. See census/S0-wire-memo.md. | Owner ruled (2026-07-07): Scope's per-project seq IS a valid coarse scope under B′. No re-key, no seq change, no prefix-matching. Joint recommendation: one cursor per project, scope-keyed fan-out in W5 slice 2, adapter maps projectId → scope key. Station A is transport swap only. See `S0-joint-recommendation.md`. | `census/S0-wire-memo.md`, `S0-joint-recommendation.md`, council c01 |
| 2026-07-07 | W4 UI kit: council c02 converged on Option B (DOM factories). | Owner overrules (2026-07-07): use per-framework adapters (Option C), Svelte-first. Scope is built in Svelte — native Svelte component ergonomics outrank singular-implementation purity. Web Components retained as secondary bridge for plain-JS consumers. | `docs/convergence/W4-owner-checkpoint.md` (updated) |

## Merged slices

Append one line per merge to main:
`YYYY-MM-DD · <packet> · <branch> · <commit range> · node --test <N>/<N>/0 · DECISIONLOG #<n>`
2026-07-06 · W5 · convergence/W5-scope-subscription (slice 1) · c87407f..c6dc078 · node --test 1206/1206/0 · DECISIONLOG #82
2026-07-07 · W5 · convergence/W5-scope-subscription (slice 2) · 5ca1fcb..9cad72e · node --test 1216/1216/0 · DECISIONLOG #83
2026-07-07 · W1 · convergence/W1-two-plane (slice 1) · 3abc225..acb030e · node --test 1230/1230/0 · DECISIONLOG #84
2026-07-07 · W1 · convergence/W1-passkeys (slice 2) · 695b928..ecfce1b · node --test 1252/1252/0 · DECISIONLOG #85
2026-07-07 · W3 · convergence/W3-job-queue (slice 1) · 7f56605..999d48a · node --test 1273/1273/0 · DECISIONLOG #86
2026-07-07 · W2 · convergence/W2-fts (slice 1) · 999d48a..75f4d94 · node --test 1302/1302/0 · DECISIONLOG #87
2026-07-07 · W1 · convergence/W1-invitations (slice 3) · 75f4d94..ca77e19 · node --test 1323/1323/0 · DECISIONLOG #88
2026-07-07 · W1 · convergence/W1-api-keys (slice 4) · ca77e19..4375262 · node --test 1353/1353/0 · DECISIONLOG #89
2026-07-07 · W2 · convergence/W2-vector (slice 2) · 4375262..e7bd970 · node --test 1378/1378/0 · DECISIONLOG #90
2026-07-07 · W1 · convergence/W1-totp (slice 5) · e7bd970..f8a71be · node --test 1412/1412/0 · DECISIONLOG #92
2026-07-07 · W4 · convergence/W4-wave1 (wave 1) · f8a71be..91d7264 · node --test 1458/1458/0 · DECISIONLOG #93
2026-07-07 · W4 · convergence/W4-wave2 (wave 2) · 91d7264..dbc078f · node --test 1498/1498/0 · DECISIONLOG #94
2026-07-07 · W4 · convergence/W4-wave3 (wave 3) · dbc078f..e1e4125 · node --test 1556/1556/0 · DECISIONLOG #95
2026-07-07 · W4 · convergence/W4-wave4 (wave 4) · e1e4125..7609eb6 · node --test 1576/1576/0 · DECISIONLOG #96
