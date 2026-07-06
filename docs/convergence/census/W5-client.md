# W5 Client Engine Parity Census

**Date:** 2026-07-06 | **Agent:** explore-flash | **Source:** workbench client SDK + Scope client engine

## Section 1: Big questions answered

### Q1. Subscription breadth

**Workbench today:** Subscribe is per `(entity, id)` only. `LiveChannel.subscribe(entity, id, ...)` sends `{ type: 'subscribe', entity, id }`. `live-admission.mjs:22` requires `msg.entity` (string) and `msg.id`. No scope-level wildcard, no "subscribe to all entities in a project".

**Scope today:** Subscribes at **project scope** — one SSE connection per project at `GET /api/projects/:id/events` that receives ALL typed action frames for ALL entities.
- `projects.ts:56-93` — handleEvents creates one SSE transport per project
- `realtime-client.ts:99-157` — feeds all SseActionFrames to `wb.ingest()`
- `sse.ts:28-31` — addClient subscribes to `{ kind: 'project', id: projectId }`

**Gap: BUILD** — fundamentally different subscription model. Load-bearing for station A.

### Q2. Undo

**Workbench today:** SPEC §7.3 is aspirational. `workbench-local-store.mjs:256-273` has a naive client-only CRUD-inverse undo. No server-side undo log, no `history.undo`/`.redo` action types, no generic `computeInverse`.

**Scope today:** Server-persisted undo log with `UserUndoLog` (action, preimage, seqNum, undoneAt) + `UserUndoCursor` (sesionId, lastSeq). `computeInverse()` (`server/action-inverse.ts:118-408`) is domain-specific with 30+ discriminated preimage kinds. `history.undo`/`.redo` registered as workbench actions (`action-table.ts:572-584`).

**Gap: BUILD**

### Q3. Cross-tab

**Workbench today:** `workbench-local-store.mjs` has full BroadcastChannel + Web Locks leader election: leader owns single WS, followers read from shared IndexedDB log via BroadcastChannel.

**Scope today:** No BroadcastChannel, no shared worker, no leader election. Each tab opens independent SSE connection. sessionStorage journal for reload survival only.

**Gap: THIN-WRAP** — workbench already has the pattern. Scope just doesn't use it yet.

### Q4. Offline/queue semantics

**Both: Fail fast.** Neither queues mutations offline. Workbench reconnects WS with backoff + re-subscribes. Scope reconnects SSE on `online` event. Neither retries pending mutations on reconnect.

**Gap: EXISTS** — equivalent. Both fail fast. Policy decision (want offline queue?) is orthogonal.

## Section 2: Per-capability census table

| # | Capability | Scope evidence (file:line) | Workbench-client equivalent | Gap class |
|---|-----------|---------------------------|----------------------------|-----------|
| 1 | **Project-scope SSE stream** | `projects.ts:56-93`; `realtime-client.ts:99-157` | `LiveChannel.subscribe(entity, id)` — per-(entity,id) only | **build** |
| 2 | **Snapshot bootstrap** (snapshot + cursors in one txn) | R8 `loadProjectSnapshot`; `ProjectActionCursor` model | `LiveList.subscribe()` — snapshot per (entity,id) + events-since gap fill | **build** |
| 3 | **Optimistic dispatch pipeline** | `wb/workbench.ts:313-410` | `createLiveStore.dispatch()` — equivalent shape but single-entity vs scope-spanning | **thin-wrap** |
| 4 | **Journal** (pending/failed ops with preimages) | `wb/journal.ts` — per-key pending/failed, actionId index, retry/discard/prune | `createLiveStore._overlay` — Map of pending overlays, no preimage storage, no persistence | **build** |
| 5 | **Per-key sync status** | `workbench.ts:61-68` — `syncStatus(key)`, `onSyncStatusChange(key)`, `pendingCount()`, `failedCount()` | `createLiveStore._overlay` — `pendingCreates()` for create-only, no generic syncStatus | **build** |
| 6 | **Server-persisted undo log** (UserUndoLog) | `prisma/schema.prisma:747-764`; `server.ts:257-303` | None (client-only naive CRUD-inverse only) | **build** |
| 7 | **Undo/redo action types** (history.undo/redo) | `action-table.ts:572-584` | None | **build** |
| 8 | **Generic inverse derivation from preimages** | `action-inverse.ts:118-408` — domain-specific, 30+ kinds | None (`workbench-local-store.mjs:256-273` naive kind-switch) | **build** |
| 9 | **Per-action-type undo/restore table** | `undo-apply.ts:157-410` — declarative table with DB writes | None | **build** |
| 10 | **Server-persisted undo session cursor** (UserUndoCursor) | `prisma/schema.prisma:766-770` | None | **build** |
| 11 | **Non-undoable action opt-out** (`undoable: false`) | `action-table.ts:298-436` (14 actions); `server.ts:281` | Not applicable (no undo at all) | **build** |
| 12 | **SSE transport** | `sse-transport.ts:39-82`; `sse.ts:54-111` | `LiveChannel` uses WebSocket, not SSE | **thin-wrap** |
| 13 | **Cross-tab BroadcastChannel relay** | Not present in Scope | `workbench-local-store.mjs:65-187` — createLocalRelay with Web Locks | **defer** |
| 14 | **Cross-tab journal persistence** (sessionStorage) | `store.svelte.ts:208-256` | `workbench-local-store.mjs` — IndexedDB local log | **thin-wrap** |
| 15 | **Boot sweep** (reconcile stale pending ops on reload) | `store.svelte.ts:268-353` | None in workbench-client.mjs alone | **build** |
| 16 | **Per-entity reconnect resubscribe** | SSE auto-reconnects at EventSource level | `LiveChannel._scheduleReconnect` — re-subscribes active pairs | **exists** |
| 17 | **Gap detection + resync** | `wb/replay.ts:3-30` | `LiveList._ingest` — same dup/gap/next logic | **exists** |
| 18 | **Event fold reducers** (pure, registered by event type) | `wb/workbench.ts:188-192` | `LiveList._applyEvent` — kind-aware reducer, same concept | **exists** |
| 19 | **Scope-based authorization at subscribe** | `live-admission.mjs:72-88` | Same code, shared implementation | **exists** |
| 20 | **Delivery-time re-authorization** | `live-fanout.mjs:176` | Same code, shared | **exists** |
| 21 | **Paced subscriptions** | `live-fanout.mjs:91-120` | Server-side only; client receives paced events | **exists** |
| 22 | **Optimistic create → server-confirm → move to state** | `store.svelte.ts` delegates to `wb.dispatch()` | `createLiveStore.dispatch()` — same pattern | **exists** |
| 23 | **Offline detection** (`navigator.onLine`) | `sync-state.svelte.ts:81-97` | Not present (WS reconnects independently) | **defer** |
| 24 | **Per-entity CRUD actions** (40+ action types) | `server.ts:100-162` — registers ~40 action types | `createLiveStore.dispatch()` handles single entity CRUD generically | **exists** |
| 25 | **Action registry** (`wb.action(name, spec)`) | `wb/workbench.ts:242-246` | Not in workbench-client.mjs (single entity only) | **build** |
| 26 | **Event registry** (`wb.event(name, spec)`) | `wb/workbench.ts:248-250` | Not in workbench-client.mjs (LiveList reducers hardcoded) | **build** |
| 27 | **SeqCursor management** (per-scope cursor) | `wb/workbench.ts:198-232` | `LiveList._cursor` (per-LiveList, single entity:id) | **build** |
| 28 | **Retry failed operation** | `wb/workbench.ts:301-311` | None in workbench-client.mjs | **build** |
| 29 | **Discard failed operation** | `wb/workbench.ts:81` / `journal.ts:151-165` | None in workbench-client.mjs | **build** |
| 30 | **Prune journal** (periodic cleanup of synced entries) | `wb/workbench.ts:95` / `journal.ts:234-256` | None | **build** |
| 31 | **Composite event reducers** (history.undone/redone fold nested entityEvents) | `store.svelte.ts:382-385` — `wb.foldEvents()` | None | **build** |
| 32 | **Preimage capture for undo** | `server.ts:289-302` — captures action + preimage in onCommitTx | `workbench-client.mjs:970-978` captures preimage for optimistic rollback only | **build** |

## Section 3: Gap summary

| Gap class | Count |
|-----------|-------|
| **exists** | 9 |
| **thin-wrap** | 3 |
| **build** | 18 |
| **defer-candidate** | 2 |
| **Total** | **32** |

### Top 3 gaps

1. **Scope-wide subscription (#1, #2)** — Foundation gap. Workbench subscribes per `(entity, id)`. Scope receives ALL project events via single stream. Load-bearing for station A.

2. **Server-persisted undo (#6-#10)** — 5 capabilities required (undo log, history actions, computeInverse, undoApplyTable, undo cursor). Workbench has none server-side. Per-action inverse logic is inherently app-specific.

3. **Journal with per-key sync status (#4, #5, #30)** — Scope's journal tracks per-entity-key pending/failed/synced with actionId confirmation. Workbench's overlay is in-memory, create-only, no persistence.
