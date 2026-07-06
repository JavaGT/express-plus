# W5 — Client engine parity (station C prerequisites)

**Goal:** the workbench client SDK (`public/workbench-client.mjs`:
LiveChannel / LiveList / createLiveStore) grows the capabilities Scope's
in-tree client engine has today, so station C (Phase S) is a swap, not a
rewrite.

## Binding rulings

- One reconciliation path (AGENTS.md): `_ingest` stays the sole canonical
  writer; optimistic state stays a visible overlay. Nothing in this packet may
  add a second apply path.
- Undo: SPEC §7.3 — preimage-restore plus inverse events. Whatever ships must
  keep that shape; per-user undo becomes a **generic** client+server feature.
- Wire-contract changes (WS protocol, CRUD commit headers
  `x-workbench-action-id`/`x-workbench-seq`, snapshot shapes) are
  owner-escalation territory — they become load-bearing for Scope at
  station A.

## Current workbench state (verified 2026-07-06)

Client SDK complete per PLANS.md P7 (Slices A–C + hardening, DECISIONLOG
#77–#80): multiplexed WS channel with reconnect/re-subscribe, span-aware
cursor with dup-skip/gap-resync, kind-aware reducer mirroring
field-delta/field-strategy, optimistic overlay retired by confirmed-seq. Known
subscription granularity: **per (entity, id)**.

## Scope parity surface

Scope's client engine (post-refactor-v2 layout — locate via Scope's
`AGENTS.md` routing index): journal, optimistic placeholders, ingest, undo,
cross-tab sync. Server-persisted undo: Prisma `UserUndoLog` + `UserUndoCursor`.
Scope subscribes at **project scope** (many entities, one stream), and boots
via `loadProjectSnapshot → { snapshot, cursors }` (R8, already shipped to the
§7.1 contract).

## Stage 0 — census (Flash, read-only, runs in BOTH repos)

Produce `docs/convergence/census/W5-client.md`: one row per Scope client-engine
capability — evidence (file:line) · workbench-client equivalent · gap. Answer
specifically:

1. **Subscription breadth**: can a workbench client subscribe to a whole scope
   (all entities of a project) with one cursor, or only per (entity,id)? What
   does `src/live-admission.mjs` / the subscribe surface (SPEC §8.1, ADR #14)
   actually admit? This is the biggest suspected gap and it is load-bearing
   for station A.
2. **Undo**: what exists server-side for §7.3 today; what Scope's undo log
   stores per entry; whether inverse events can be derived from `_Log`
   preimages generically.
3. **Cross-tab**: what Scope does (BroadcastChannel? leader election? shared
   worker?) and what invariant it protects (one WS per browser? journal
   consistency?).
4. **Offline/queue semantics**: does Scope queue mutations offline or fail
   fast? (Determines whether the overlay needs persistence.)

## Expected design decisions (council items)

1. Scope-wide subscription: extend the subscribe surface to scope-level
   streams vs client-side aggregation over per-entity subs. (Server already
   fans out per scope key internally — census verifies.) Wire impact → owner
   is informed either way.
2. Generic per-principal undo: server-side undo log derived from `_Log`
   preimages + an inverse-dispatch endpoint, vs client-journal undo. Must land
   as ONE design that Scope and `projects/*` apps share.
3. Cross-tab: which invariant workbench owns (recommend: one channel per
   browser via leader election, others proxy) vs leaving it app-side.

## Slices

1. Scope-wide subscription (if ruled in) end-to-end: admission, fanout,
   client cursor semantics, `LiveList`-of-lists or store-level fold — with the
   §7.1 bootstrap ordering preserved.
2. Generic undo per council design, acceptance-tested in a `projects/*` app
   (undo across two clients: undo is visible live to the other client).
3. Cross-tab per council design (fake-indexeddb devDep exists for tests).
4. Any W4-requested client API additions (filed by coordinator, each passing
   the deletion test).

## Done criteria

- Census closed; every Scope client capability has a shipped generic
  equivalent or an owner-signed deferral.
- A `projects/*` acceptance test exercises boot-from-snapshot+cursors →
  live stream → optimistic mutate → undo, matching the ordering Scope will
  use at stations A/C.

## Contention

Owns: `public/workbench-client.mjs`, `src/live-*.mjs`, `src/websocket.mjs`,
`src/cursor.mjs`; undo work may touch `src/pipeline.mjs` — coordinator
sequences that against W2/W3 merges. W4 must not touch this packet's files.
