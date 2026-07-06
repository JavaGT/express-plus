# W2 — Full persistence ownership

**Goal:** consumer apps run **no second ORM**. Every table Scope's Prisma owns
today has a workbench destination; the generic gaps (search, vectors, schema
evolution) are closed in workbench.

## Binding rulings

- Scope's Prisma — including auth/job/infra tables — is retired at end state.
- Anything that enters workbench is generic; Scope's need is evidence, the
  `projects/*` apps are the genericity proof (deletion test, AGENTS.md).
- One reconciliation path / no second write path: new storage features ride
  the existing entity/field/pipeline seams, never a side channel.

## Current workbench state (verified 2026-07-06)

`src/db.mjs` (node:sqlite), `src/ddl.mjs`, `src/migrations.mjs`,
`src/field.mjs` + open field-type registry (SPEC §5.1, ADR #9),
`src/scope-sql.mjs` (predicates incl. `.gte/.lte`), `src/blob-store.mjs` /
`fs-blobs.mjs` / `blob-lifecycle.mjs`, `json(shape)` fields, `computed()` /
`computed.stored()` / `projected.async`.

## Scope parity surface

~48 Prisma models. Classify in the census by family:

- **Domain** (Project…Theme, Artefact/Transcript/Segment/Speaker/Code…): these
  become app-side entity declarations at station B (Phase S) — W2 only needs
  to prove the *field vocabulary* covers them.
- **Infra** (`ProjectActionLog, ProjectActionCursor, ProjectEventLog`): this is
  Scope's in-tree event log — replaced wholesale by workbench `_Log`/cursors at
  station B. No W2 work beyond noting it.
- **Search** (`Embedding, TranscriptSpeakerEmbedding` + Scope's FTS virtual
  tables): the real W2 build items.
- **Per-user preference/support tables** (`UserUndoLog, UserUndoCursor,
  UserCommandUsage, User*Preference, Notification`): undo/cross-tab go to W5;
  the rest are ordinary entities — census confirms the vocabulary suffices.
- **Auth** → W1. **Jobs** (`Job, Worker`) → W3.

## Stage 0 — census (Flash, read-only)

Produce `docs/convergence/census/W2-persistence.md`: one row per Prisma model —
family · workbench destination (existing field kinds / station-B declaration /
W1 / W3 / W5 / **gap**) · evidence (the model's fields that don't map, with
file:line of their heaviest Scope query). Plus: enumerate Scope's raw-SQL
surfaces (FTS queries, embedding similarity, any `$queryRaw`) — each is either
a predicate-plugin candidate or a redesign conversation.

## Expected design decisions (council items)

1. **FTS**: SPEC §11 predicates + "geo/FTS predicate plugins" were already
   named as a deferred system. Decide the plugin seam: an FTS5-backed field
   option (`text({ indexed: 'fts' })`?) + a `.matches()` predicate lowering to
   the virtual table, vs an app-side plugin via the open field registry.
2. **Vectors/embeddings**: generic `vector(dim)` field + nearest-neighbour
   query (brute-force SQL first — Scope's scale is single-user projects) vs
   keeping embeddings app-side over blob storage. Council decides the seam;
   owner decides only if it implies a dependency (it must not).
3. **Schema evolution**: census `src/migrations.mjs` capabilities vs what a
   real consumer app needs (add field, backfill, rename). Decide the developer
   story for migrating a deployed app's declared entities.

## Slices

1. Field-vocabulary proof: declare the 3 gnarliest domain models from the
   census as workbench entities in a scratch acceptance test (not shipped to
   Scope) — every unmappable field becomes a census gap row.
2. FTS predicate plugin (per council design) + acceptance test in a
   `projects/*` app (e.g. library/blog search).
3. Vector field + similarity query (per council design) + acceptance test.
4. Migration-story hardening per census (with a documented walkthrough in
   SPEC or docs/).

## Done criteria

- Census table complete: every Prisma model has a named destination; zero
  unclassified rows.
- FTS + vector seams shipped generic with `projects/*` proofs, or explicitly
  owner-deferred.
- A written "consumer app schema evolution" walkthrough exists and its steps
  are tested.

## Contention

Owns: `field*.mjs, ddl.mjs, migrations.mjs, scope-sql.mjs, db.mjs`. W1 may add
auth tables through `ddl.mjs` — coordinate; entity internals (`entity/`)
changes need a coordinator heads-up because W5's server-side work may touch
`pipeline.mjs` nearby.
