# Convergence programme ledger

Maintained by the **coordinator only**. Subagents never write this file.
Append; never rewrite history. Update the status table in place, add rows
to the logs.

## Packet status

| Packet | Doc | Stage | Branch(es) | Last full gate | Notes |
|---|---|---|---|---|---|
| W1 auth parity | `W1-auth-parity.md` | census | — | — | 25 features — 8 exists, 4 thin-wrap, 10 build, 3 defer-candidate |
| W2 persistence ownership | `W2-persistence-ownership.md` | census | — | — | 49 Prisma models — 2 GAPs (FTS + vector) |
| W3 job queue parity | `W3-job-queue-parity.md` | census | — | — | 3 BUILD (progress, cancel, scoping) |
| W4 UI kit | `W4-ui-kit.md` | census | — | — | 25 primitives — owner checkpoint required before build-out |
| W5 client engine parity | `W5-client-engine-parity.md` | census | — | — | 32 capabilities — 18 build, top gap: scope-wide subscription |
| S scope migration | `S-scope-migration.md` | gated + blocked-on-owner | — | — | S0 memo: INCOMPATIBLE — per-project vs per-entity seq. Owner escalation filed 2026-07-06. |

Stage vocabulary: `not started` → `census` → `design` → `slices` → `done`
(or `gated` / `blocked-on-owner`).

## Council log

One row per council question. Working files live under `.council/<qid>/`
(gitignored); this table is the durable record.

| qid | Date | Question (one line) | Converged after cross-eval? | GLM tie-break used? | Outcome adopted |
|---|---|---|---|---|---|

## Owner escalations

| Date | Question | Owner ruling | Where recorded |
|---|---|---|---|
| 2026-07-06 | S0 wire memo: Scope uses per-project seq numbering, workbench uses per-entity seq. Structurally incompatible — Scope's event numbering must adopt workbench's per-entity model before station A. See census/S0-wire-memo.md for the 5 changes needed in Scope's dispatch pipeline, event log, cursor table, snapshot shape, and bootstrap ordering. | — pending — | `census/S0-wire-memo.md` |

## Merged slices

Append one line per merge to main:
`YYYY-MM-DD · <packet> · <branch> · <commit range> · node --test <N>/<N>/0 · DECISIONLOG #<n>`
