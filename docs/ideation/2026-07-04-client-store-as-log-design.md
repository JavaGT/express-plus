# Client store as a log — design

2026-07-04 · Survivor #2 from 2026-07-03-workbench-improvements-ideation.md

## What this is

A design for the client-side local event log — the mechanism that makes cross-tab sync, undo, and offline all work from one thing, instead of bolting on three separate features.

**Current state**: three tabs open = three WebSockets to the server = three fanout copies of every event. Undo is nowhere. State is in-memory — tab close = gone.

**Target**: one WebSocket per browser (leader tab), relayed to all tabs. State lives in a local event log (IndexedDB) that LiveList folds into reactive state — mirroring how `_Log` drives projections server-side. Undo = inverse dispatch through the normal pipeline using already-captured preimages.

The existing preimage capture at `workbench-client.mjs:970-978` already runs on every dispatch — it captures the effective state before the operation. The machinery exists, unused. This design connects it.

---

## Architecture

```
Tab A (LEADER)
  owns WebSocket ─────────────────────────────► Server
  writes events to local log (IndexedDB)
  broadcast("new-event") ──► BroadcastChannel ──► Tab B, Tab C

Tab B (FOLLOWER)
  no WebSocket
  reads local log → LiveList folds → reactive state
  dispatches via REST directly (doesn't need leader for writes)
  listens on BroadcastChannel for new log entries

Tab C (FOLLOWER)
  same as B
```

One `ingest` function — all three event sources enter the log through it:

| Source | When | What happens |
|--------|------|-------------|
| Optimistic dispatch | User acts (you type) | Written to log with `status:pending` + preimage |
| Server REST response | HTTP response received | Entry updated to `status:committed` with real seq |
| WebSocket | Live event arrives (your echo or someone else's) | Written to log with `source:remote` and server seq |

LiveList folds the log into state — same contract as today's `_ingest` (duplicate skip, gap resync, next apply). The log is append-only, cursor-tracked, same shape as `_Log` server-side.

---

## The local log

Stored in IndexedDB, one database per store (e.g., `workbench:local:<appName>`). One object store:

```js
// Schema (what the framework owns — user never touches this)
{
  id: autoIncrement,           // IndexedDB key
  opId: 'op_3',                // client-generated, tombstone for overlay tracking
  seq: 42,                     // server-assigned monotonic seq (null while pending)
  scope: 'todo_abc123',        // per-scope identifier
  entity: 'Todo',              // entity name
  rowId: 'abc123',             // entity row id
  kind: 'update',              // create | update | remove | field-set
  type: 'Todo.update',         // full event type
  payload: { title: 'New' },   // mutation payload
  preimage: { title: 'Old' },  // captured before dispatch (null for create/remote)
  actionId: 'uuid...',         // server dedup key (null for remote events)
  status: 'committed',          // pending | committed | failed
  source: 'local',             // local (your action) | remote (someone else's)
  timestamp: 1719876543210,
}

// Indexes
byScope: ['scope', 'seq']      // for LiveList to fold in order
byOpId: 'opId'                 // for overlay lookup
byStatus: 'status'             // for offline replay (committed but not acked to server)
```

The existing `_overlay` Map stays. It tracks the in-flight gap between dispatch and confirmation (same as today). When an entry confirms, it graduates from `_overlay` into the log and `_overlay` can clear it lazily (same `_clearConfirmedOverlays` logic).

The log grows unbounded. Retention is a future concern (the server has `_Log` retention reaping; the client log is local and cheap — IndexedDB can hold millions of entries). For now, no retention.

---

## Cross-tab: leader election

Web Locks API — zero dependencies, works everywhere. The lock name scopes per-store:

```js
// What the framework owns (inside createLiveStore, if local mode enabled):

const LOCK_NAME = `workbench:live:${name}`;

async function _acquireLeaderLock() {
  const lock = await navigator.locks.request(LOCK_NAME, async () => {
    // I am the leader — open the WebSocket
    const ws = _openSocket();
    _leaderWs = ws;

    // When the lock is held, new events from WS → write to log → broadcast
    // (the existing LiveChannel message handler, refactored to write to log)

    // Hold the lock until tab closes or WS fails permanently
    await new Promise(() => {}); // never resolves — released on tab close
  });

  // Lock released — old leader is gone
  // Start polling for lock again (follower → maybe become leader)
}
```

- **Leader tab**: opens WebSocket, writes events to IndexedDB, broadcasts "new log entry" on BroadcastChannel
- **Follower tab**: no WebSocket, reads from IndexedDB, listens on BroadcastChannel for new entries
- **When leader closes**: lock released → one follower acquires it → opens its own WebSocket → catches up from log cursor → continues
- **No message loss**: the log in IndexedDB persists across tab closes; the new leader reads from where the old leader's cursor left off

Follower tabs still dispatch via REST directly — writing doesn't need the leader. The REST response writes back to the log (same IndexedDB), and the WS echo later becomes a duplicate (seq ≤ cursor → skip, same `_ingest` logic as today).

The `BroadcastChannel` name is the same as the lock name: `workbench:live:<storeName>`. Messages are simple: `{ type: 'log-entry', count: 5 }` — just a signal that new entries exist. Each tab reads them from IndexedDB independently (avoids serializing full event objects over postMessage).

---

## Undo

SPEC §7.3 defines undo as two halves:

1. **Client-side**: immediately restore the preimage (instant, no server round trip)
2. **Server-side**: append inverse events through the pipeline (every client converges, log stays append-only)

The preimage is already captured at `dispatch()` line 971:

```js
const preimage = id ? overlayFor(id) : null;
```

This preimage enters the log alongside the event. Undo reads it back:

```js
// What the framework owns:
store.undo(opId);

// → reads entry from log by opId
// → if status !== 'committed' → error (can't undo uncommitted)
// → client-side: write inverse to log (payload = preimage, preimage = current state)
//                 LiveList folds → instantly shows old state
// → server-side: dispatch inverse through normal pipeline
//                server deduplicates by undo's own actionId
```

Redo is the same shape, reversed: `redo(opId)` restores the post-state from the inverse's preimage.

**What counts as undo** is the user's call — the framework doesn't guess. The preimage stored in the log is the effective state *before that specific dispatch*. For `update`, that's the field values before the change. For `create`, that's null (undo = remove). For `remove`, that's the row before deletion (undo = re-create).

```js
// Example: user changes title from "Old" to "New"
store.dispatch('Todo.update', { id: 'x', title: 'New' });
// Log entry: { opId:'op_3', kind:'update', payload:{title:'New'}, preimage:{title:'Old'} }

// User hits undo
store.undo('op_3');
// Framework dispatches: 'Todo.update', { id: 'x', title: 'Old' }
// Preimage for this inverse = { title: 'New' } (enables redo)
```

The inverse event type is the same as the original — `Todo.update` for `Todo.update`, `Todo.create` for `Todo.remove`, `Todo.remove` for `Todo.create`. No new event types needed. The pipeline is the same.

---

## Offline

Two directions:

**Outbound (you → server)**: Events you dispatch while offline stay in the log with `status:committed` (the REST call succeeded before you went offline — unlikely) or `status:pending` (the REST call never completed). Actually, thinking more carefully:

- If you dispatch while offline, the REST call fails immediately (network error). Today this rolls back the overlay. With the log, we instead mark the entry as `status:queued` — committed to the local log, not yet sent.
- On reconnect, the framework replays queued entries through the normal dispatch path. The server deduplicates by actionId (already built — `pipeline.mjs:355`).
- If a replayed entry is a duplicate (already committed before disconnect), the server returns the existing committed result → entry updates to `status:committed` with real seq. If it's genuinely new, the server commits it normally.

**Inbound (server → you)**: Missed server events during offline are caught up via `events-since` (already built — `serve.mjs:226-271`). The replay writes to the local log, LiveList folds, cursor advances. Same gap-resync logic as today.

This slice is deferred to a later phase — the first slice focuses on cross-tab + undo (offline needs more design around conflict resolution).

---

## What changes for the user

```js
// TODAY — works, unchanged:
const store = createLiveStore({
  baseUrl: 'https://myapp.com',
  name: 'Todo',
  path: '/api/todos',
});
const list = store.subscribe(id);
await list.ready;
// list.state is reactive — render

store.dispatch('Todo.update', { id, title: 'New title' });

// NEW — opt-in local log (nothing else changes):
const store = createLiveStore({
  baseUrl: 'https://myapp.com',
  name: 'Todo',
  path: '/api/todos',
  local: { name: 'myapp-todos' },  // <-- enables the log + cross-tab
});

// NEW — undo (only available when local log is enabled, because preimage is in the log):
store.undo(opId);
store.redo(opId);
```

No other API changes. `subscribe`, `dispatch`, `create`, `update`, `remove`, `overlayFor`, `onRender` all work the same. The log is framework-internal.

When `local` is not passed, behavior is exactly today's (in-memory, no cross-tab, no undo). The log is opt-in to avoid breaking existing apps that don't need it.

---

## Implementation plan (first slice)

The doc's instruction: "choose leader-election + envelope relay as the client's core primitive, before the SDK grows these as separate features."

### Slice 1a: Local log + leader election + BroadcastChannel (cross-tab only, no undo yet)

1. **New file `public/workbench-local-log.mjs`** — indexedDB wrapper:
   - `openLog(name)` → `{db}` (opens/creates IndexedDB `workbench:local:<name>`)
   - `appendEntry(db, entry)` → `{id}`
   - `entriesSince(db, scope, cursor)` → `[entry]` (for LiveList fold, same contract as `events-since`)
   - `deleteOldEntries(db, beforeTimestamp)` (future retention hook, not called yet)

2. **Refactor `createLiveStore`** — when `local` option is present:
   - Open the local log instead of using `_overlay` alone
   - `dispatch()` writes pending entry to log instead of `_overlay` Map; overlay stays for in-flight state query (overlayFor reads from log + overlay)
   - REST response updates the log entry (status → committed, seq written)
   - `_clearConfirmedOverlays` retires confirmed entries from overlay (log keeps them)

3. **Leader election** — inside `createLiveStore` when `local` is set:
   - Spawn `_acquireLeaderLock()` loop
   - Leader opens `LiveChannel` WebSocket, writes incoming events to log, broadcasts signal
   - Follower skips WebSocket, listens on BroadcastChannel

4. **LiveList reads from log** — when `local` is set:
   - `LiveList._ingest` reads from log entries instead of receiving WS events directly
   - `_resync` calls `entriesSince` on the local log (local, instant), falling through to `events-since` HTTP only when the cursor is behind the log head
   - Bootstrap: snapshot from REST, then fold log entries after snapshot seq

5. **Tests** (new file `test/client-local-log.test.mjs`):
   - Dispatch writes to log, REST response updates seq
   - Second tab opening sees existing commits (reads same IndexedDB)
   - Leader WS event written to log, follower tab receives via BroadcastChannel
   - Leader close → follower acquires lock → WS opens → no events lost
   - Regression: existing `live-store.test.mjs`, `live-list.test.mjs`, `live-channel.test.mjs` still pass (with `local` absent, zero behavior change)

### Deferred to later slices

- **Slice 1b**: Undo (`store.undo(opId)`, `store.redo(opId)`)
- **Slice 1c**: Offline queue (status:queued → replay on reconnect)
- **Slice 1d**: Log retention (prune old entries)

---

## Risks and open questions

### Q1: IndexedDB in Node tests?

Node doesn't have IndexedDB natively. We'd need `fake-indexeddb` as a dev dependency, OR we test the log + leader election in a browser environment (Playwright/Puppeteer). **Recommendation**: use `fake-indexeddb` for unit tests of the log wrapper, and defer browser-level leader-election tests to Slice 1d (ce-test-browser). The core logic (log write/read, entry folding) is testable in Node with a polyfill.

### Q2: BroadcastChannel in Node tests?

Node 22+ does NOT have BroadcastChannel. `fake-indexeddb` doesn't help here. **Recommendation**: the leader-election + relay wiring is tested via an integration test that uses a mock event bus (an `EventEmitter` or `MessageChannel`). The real BroadcastChannel is exercised in browser tests later.

### Q3: Two tabs dispatching simultaneously?

Two tabs can both dispatch via REST independently. Both write to the same IndexedDB (IndexedDB handles concurrent transactions). The REST responses may arrive in either order, but the server-assigned seq is monotonic per-scope — the log entries are ordered by seq, not by arrival time. No conflict because both operations went through the server's single-writer serialization — they were linearized there. The client log just records the outcome.

### Q4: What if the leader tab crashes mid-relay?

The lock is released (browser drops locks on tab close/crash). A follower acquires it, opens a new WebSocket, catches up from the log cursor. Any events the old leader received but hadn't written to the log yet are lost — but the server still has them. The new leader's WebSocket sends `{cursor}` on connect, and the server replays events from that cursor. This is the same gap-resync logic that already works today (LiveList `_resync` on gap detection).

### Q5: IndexedDB performance?

Local reads are near-instant (synchronous API via cursor). The log is append-only with a compound index `[scope, seq]` — one range query to fold all new entries for a scope. This is IndexedDB's happy path. Millions of entries are fine (it's designed for this). The current in-memory approach is faster for small datasets but loses everything on tab close — the trade-off is intentional.

### Q6: Private browsing / storage quota?

IndexedDB is available in private browsing (unlike localStorage in some older Safari versions). Storage quota is per-origin, typically 10-60% of disk free space. Event log entries are tiny (a few hundred bytes each). Even a busy session with 100K entries is ~30MB — well within quota. The log is per-store (per `local.name`), so multiple apps in the same origin share the database/storage but have separate object stores.

---

## What the framework owns vs what the user owns

| Framework owns | User owns |
|---------------|-----------|
| Local event log (IndexedDB schema, open, append, query) | Nothing — the log is invisible |
| Leader election (Web Locks) | Nothing — automatic when `local` is set |
| BroadcastChannel relay | Nothing — automatic |
| `ingest` fold (same contract as server) | Nothing |
| `store.undo(opId)` / `store.redo(opId)` | Deciding when to call undo (keyboard shortcut, button click) |
| Offline queue + replay | Nothing |
| Log retention | Nothing (future: configurable TTL) |
