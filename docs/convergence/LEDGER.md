# Convergence programme ledger

Maintained by the **coordinator only**. Subagents never write this file.
Append; never rewrite history. Update the status table in place, add rows
to the logs.

## Packet status

| Packet | Doc | Stage | Branch(es) | Last full gate | Notes |
|---|---|---|---|---|---|
| W1 auth parity | `W1-auth-parity.md` | slices | `convergence/W1-two-plane` (slice 1), `convergence/W1-passkeys` (slice 2) | 1252/1252/0 | Slice 1: membership() two-plane pattern. Slice 2: passkey (WebAuthn) auth — Credential entity, challenge/verify on node:crypto, 5 /auth/passkey routes, 22 tests. |
| W2 persistence ownership | `W2-persistence-ownership.md` | census | — | — | 49 Prisma models — 2 GAPs (FTS + vector) |
| W3 job queue parity | `W3-job-queue-parity.md` | census | — | — | 3 BUILD (progress, cancel, scoping) |
| W4 UI kit | `W4-ui-kit.md` | census | — | — | 25 primitives — owner checkpoint required before build-out |
| W5 client engine parity | `W5-client-engine-parity.md` | slices | `convergence/W5-scope-subscription` (slices 1+2) | 1216/1216/0 | Slice 1: subscribeScope() + normalizeSubscribeMsg. Slice 2: scope-keyed fan-out (per-entity Map retired), scope-level snapshot/events-since routes, generic subscribed ack. Council c01 adopted B′. |
| S scope migration | `S-scope-migration.md` | gated | — | — | S0 memo: INCOMPATIBLE — per-project vs per-entity seq. Owner direction (2026-07-06): run W5 scope-wide-subscription design council first (with S0 memo as binding input), come back with joint recommendation on cursor granularity + subscription breadth + what changes on each side. S0 ruling deferred. |

Stage vocabulary: `not started` → `census` → `design` → `slices` → `done`
(or `gated` / `blocked-on-owner`).

## Council log

One row per council question. Working files live under `.council/<qid>/`
(gitignored); this table is the durable record.

| qid | Date | Question (one line) | Converged after cross-eval? | GLM tie-break used? | Outcome adopted |
|---|---|---|---|---|---|
| c01 | 2026-07-06 | Scope-wide subscription granularity: per-entity vs coarser scope, cursor model, wire changes | Yes — Opus 4.8 + GPT 5.5 converged on B′. No material disagreement. | No | Option B′ adopted. `subscribe(scope, interest?)` as single primitive — scope is ordered stream key. Per-entity is the degenerate scope. Stream-scope separated from row-identity. Old `{entity,id}` is decode shim, not second path. Rejected A/C/D. SINGULAR ordering. |

## Owner escalations

| Date | Question | Owner ruling | Where recorded |
|---|---|---|---|
| 2026-07-06 | S0 wire memo: Scope uses per-project seq numbering, workbench uses per-entity seq. Structurally incompatible. See census/S0-wire-memo.md. | Owner ruled (2026-07-07): Scope's per-project seq IS a valid coarse scope under B′. No re-key, no seq change, no prefix-matching. Joint recommendation: one cursor per project, scope-keyed fan-out in W5 slice 2, adapter maps projectId → scope key. Station A is transport swap only. See `S0-joint-recommendation.md`. | `census/S0-wire-memo.md`, `S0-joint-recommendation.md`, council c01 |

## Merged slices

Append one line per merge to main:
`YYYY-MM-DD · <packet> · <branch> · <commit range> · node --test <N>/<N>/0 · DECISIONLOG #<n>`
2026-07-06 · W5 · convergence/W5-scope-subscription (slice 1) · c87407f..c6dc078 · node --test 1206/1206/0 · DECISIONLOG #82
2026-07-07 · W5 · convergence/W5-scope-subscription (slice 2) · 5ca1fcb..9cad72e · node --test 1216/1216/0 · DECISIONLOG #83
2026-07-07 · W1 · convergence/W1-two-plane (slice 1) · 3abc225..acb030e · node --test 1230/1230/0 · DECISIONLOG #84
2026-07-07 · W1 · convergence/W1-passkeys (slice 2) · 695b928..ecfce1b · node --test 1252/1252/0 · DECISIONLOG #85
