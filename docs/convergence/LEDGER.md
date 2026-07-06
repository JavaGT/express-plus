# Convergence programme ledger

Maintained by the **coordinator only**. Subagents never write this file.
Append; never rewrite history. Update the status table in place, add rows
to the logs.

## Packet status

| Packet | Doc | Stage | Branch(es) | Last full gate | Notes |
|---|---|---|---|---|---|
| W1 auth parity | `W1-auth-parity.md` | not started | — | — | |
| W2 persistence ownership | `W2-persistence-ownership.md` | not started | — | — | |
| W3 job queue parity | `W3-job-queue-parity.md` | not started | — | — | |
| W4 UI kit | `W4-ui-kit.md` | not started | — | — | owner checkpoint required before build-out |
| W5 client engine parity | `W5-client-engine-parity.md` | not started | — | — | |
| S scope migration | `S-scope-migration.md` | gated | — | — | S0 wire memo may run pre-gate |

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

## Merged slices

Append one line per merge to main:
`YYYY-MM-DD · <packet> · <branch> · <commit range> · node --test <N>/<N>/0 · DECISIONLOG #<n>`
