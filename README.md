# workbench

*Workbench for collaborative, persisted, realtime data.*

workbench is to collaborative, persisted, realtime apps what Express is to
request/response apps. Declare your entities, their authorization, and their
reactions; the framework owns the REST routes, the WebSocket live stream, the
event log, the reducers, optimistic UI, undo, gap recovery, and cross-tab sync.

Structurally it is a **small machine** (compile → commit → deliver) wearing a
**known-app coat** (auth product, jobs, blobs, UI). See `AGENTS.md` and
`docs/architecture-map.md`.

The north star is the same one the shipped `scope` workbench hit in production.
scope is the working proof; workbench is the cleaner second cut, built
proactively for a known set of stress-test apps rather than incrementally as
each app stubs its toe.

## Status

The framework is implemented and under active development. Zero dependencies —
Node 26 only (`node:http`, `node:crypto`, `node:sqlite`, `node:fs`). Tests run on
`node --test`; the suite is green (lead-verified raw). The binding exemplars
(`doc.mjs`, `gdoc.mjs`, `note.mjs`, `comment.mjs`, `todo.mjs`, `session.mjs`)
live under `projects/` and are the source of truth for naming and usage
direction.

## Quick start

```sh
node --test                          # run the full suite
node projects/chat/server.mjs        # run the chat sample (open localhost:3000 in two tabs)
```

## Documents

| Document | Job |
| --- | --- |
| **[AGENTS.md](AGENTS.md)** | The binding design values (naming, architecture, authorization, data, live/sync, defaults). Read this first; the SPEC obeys these. |
| **[CONTEXT.md](CONTEXT.md)** | Domain glossary — the language of seams (Entity, Grant, Scope handle, Kernel, …). Use these nouns in design and code. |
| **[docs/architecture-map.md](docs/architecture-map.md)** | Modules mapped to the three loops (Compile / Commit / Deliver) and the known-app coat. |
| **[SPEC.md](SPEC.md)** | The canonical specification — what workbench is, how it behaves, the build order. |
| **[DECISIONLOG.md](DECISIONLOG.md)** | The append-only ledger of architectural decisions (ADRs) and implementation decisions. The SPEC cites entries by number. |
| **[docs/adr/](docs/adr/)** | Numbered ADRs for settled architectural seams (event handles, schedule, entity authz, scope handles). |
| **[PLANS.md](PLANS.md)** | The restartable execution ledger — current priority state, fork resolutions, step-by-step progress. |
| **[SCOPE-FINDINGS.md](SCOPE-FINDINGS.md)** | What the shipped `scope` workbench proves is buildable; the validated architecture shape workbench adopts. |
| **[projects/STRESS-TEST-FINDINGS.md](projects/STRESS-TEST-FINDINGS.md)** | The 9-app synthesis that frames the featureset, with per-app evidence under `projects/<name>/`. |

Retired docs: `FEATURES.md` and `IMPLEMENTATION-PLAN.md` were absorbed into
**SPEC.md** (featureset and build-order roadmap). `CONTEXT.md` remains the live
domain glossary (it was briefly claimed absorbed — that claim is reversed; the
glossary is not restated in SPEC).