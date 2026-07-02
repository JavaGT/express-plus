# workbench

*Workbench for collaborative, persisted, realtime data.*

workbench is to collaborative, persisted, realtime apps what Express is to
request/response apps. Declare your entities, their authorization, and their
reactions; the framework owns the REST routes, the WebSocket live stream, the
event log, the reducers, optimistic UI, undo, gap recovery, and cross-tab sync.

The north star is the same one the shipped `scope` workbench hit in production.
scope is the working proof; workbench is the cleaner second cut, built
proactively for a known set of stress-test apps rather than incrementally as
each app stubs its toe.

## Status

The framework is implemented and under active development. Zero dependencies —
Node 26 only (`node:http`, `node:crypto`, `node:sqlite`, `node:fs`). Tests run on
`node --test`; the suite is green (lead-verified raw). The binding exemplars at
the repo root (`doc.mjs`, `gdoc.mjs`, `note.mjs`, `comment.mjs`, `todo.mjs`,
`session.mjs`) are the source of truth for naming and usage direction.

## Quick start

```sh
node --test                 # run the full suite
node doc.mjs                # run a binding exemplar
```

## Documents

| Document | Job |
| --- | --- |
| **[SPEC.md](SPEC.md)** | The canonical specification — what workbench is, how it behaves, the build order. The single source of truth. |
| **[AGENTS.md](AGENTS.md)** | The binding design values (naming, architecture, authorization, data, live/sync, defaults). Read this first; the SPEC obeys these. |
| **[DECISIONLOG.md](DECISIONLOG.md)** | The append-only ledger of architectural decisions (ADRs) and implementation decisions. The SPEC cites entries by number. |
| **[PLANS.md](PLANS.md)** | The restartable execution ledger — current priority state, fork resolutions, step-by-step progress. |
| **[SCOPE-FINDINGS.md](SCOPE-FINDINGS.md)** | What the shipped `scope` workbench proves is buildable; the validated architecture shape workbench adopts. |
| **[projects/STRESS-TEST-FINDINGS.md](projects/STRESS-TEST-FINDINGS.md)** | The 9-app synthesis that frames the featureset, with per-app evidence under `projects/<name>/`. |

The retired `CONTEXT.md`, `FEATURES.md`, and `IMPLEMENTATION-PLAN.md` were
absorbed into **SPEC.md** (glossary, featureset, and build-order roadmap
respectively) and removed.