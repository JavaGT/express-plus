# S — Scope migration (stations A → B → C)

**Status: GATED.** Do not start implementation until BOTH hold:
1. Scope's refactor v2 is declared complete by the owner (wave 3 merged, tree
   quiet), and
2. the W-packets covering the surfaces being migrated report parity (W1/W2/W3
   for station B, W5 for stations A/C).

Exception: **S0 may run now** (read-only).

This work runs in the **Scope repo** (`~/Development/scope`) under Scope's own
AGENTS.md (multi-agent concurrency rules, red lines, UK English, `pnpm check`
+ `pnpm lint` green through changes). The coordinator session for Phase S
should be started in that repo; this document is the plan it executes from,
together with Scope's `docs/adr/0005-workbench-convergence.md`.

## S0 — wire-contract memo (pre-gate, read-only, run EARLY)

Scope's R8 shipped (`loadProjectSnapshot` returning `{ snapshot, cursors }`,
commits cf4eff4/76f0220/0e64350) — possibly **before** station-A cursor
numbering was formally agreed, which the R8 design doc said should happen
first. Task: compare Scope's shipped cursor semantics (what the `cursors` map
keys mean, what seq they carry, per which scope key) against workbench's seq
semantics (`SPEC.md` §7.1, `src/cursor.mjs`, the events-since/snapshot
surfaces). Deliver `docs/convergence/census/S0-wire-memo.md`: compatible /
adapter needed / incompatible — with evidence. If incompatible, this is an
immediate owner escalation: the numbering is a one-way door (ADR-0005).

## Station A — live spine

Scope's SSE/cursor/gap-recovery layer is replaced by workbench's live
transport. Note the transport changes (SSE → WebSocket): the client boots via
`{ snapshot, cursors }` (already R8-shaped), then subscribes over WS from
those cursors. Per-surface cutover; each surface deletes its SSE path in the
same change (Scope red line "no parallel mutation paths", read per-surface).

## Station B — server kernel (per-entity strangler)

Order entities by Scope's ADR-0002 census: mechanical CRUD first,
domain-rich (segments/codes with heavy handlers) last. Per entity:

1. Declare the entity in workbench vocabulary (fields, grant, checks) — W2's
   field-vocabulary proof should have de-risked this.
2. Golden parity proof: replay a recorded action set through both kernels,
   diff projections (Scope's R9 export goldens are the model for this).
3. Cut writes over; reads follow; **delete the old handler path in the same
   change**.
4. `pnpm check`, `pnpm lint`, full Scope suite + workbench `node --test`
   green.

Auth cutover rides station B: better-auth → workbench auth (W1). Owner
decides session migration (forced re-login vs session import) — do not assume.

Data migration: one script, Prisma SQLite → workbench SQLite. Acceptance =
Scope's R9 export goldens byte-identical before/after migration, plus row
counts per table. The script is rehearsed on a copy; it never runs on the
live DB without the owner present.

## Station C — client engine

Swap Scope's journal/ingest/optimistic layer for `createLiveStore` +
W5-delivered undo/cross-tab. Per-surface, same delete-in-the-same-change
rule. Scope's UI may adopt W4 kit components where the owner wants them —
that's an owner taste call per surface, not a default.

## Red lines carried from Scope (apply to every station)

One mutation pipeline; no org→data cascade; no silent optimistic UI; no
CRDT/OT beyond what workbench fields provide; no cloud transcription; AI
suggest-only; privacy first-class.

## Deliverable at gate time

When the gate opens, the Phase-S coordinator's first act is to generate a
Scope-side kickoff doc (per-entity checklist with the ADR-0002 ordering,
worker assignments, branch plan) from the W-censuses + S0 memo — then execute
station A.
