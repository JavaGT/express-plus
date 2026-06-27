// projects/space-invaders/PAIN-POINTS.md
//
// Stress-test results: building an authoritative-server multiplayer arcade
// game (Space Invaders) on the express-plus reactive-entity paradigm.
//
// Each pain point is ranked: BLOCKER (cannot ship), SHOULD-FIX (major
// ergonomic/performance issue), NIT (minor naming or API surface gap).


## PAIN POINT 1: No scheduler/tick construct for authoritative server loops

**Rank: BLOCKER**

**API construct that failed:** The entity constructor has `fields`, `checks`,
`grant`, `routes` — but no `tick`, `loop`, `scheduler`, or `interval` block.
The framework's reactivity model is "events derive from field mutations," but a
game loop mutates state on a **timer** (every 33 ms at 30 Hz), not in response
to any field mutation.

**What we had to do:** Reach outside the framework with `setInterval` (a second
pathway, violating "prefer a singular system" — AGENTS.md line 26). The game
loop in `app.mjs` is a global `setInterval` that manages its own lifecycle
(start on match start, stop on game over, cleanup on entity destroy). The
framework provides no lifecycle hooks for entity state transitions (e.g., "when
Match.phase changes to 'playing'"), so we also had to add a **polling interval**
to detect phase changes (another `setInterval` in `app.mjs`).

**Aspirational fix:** An entity should be able to declare a `tick` block:
```js
entity('Match', {
  fields: { ... },
  tick: {
    rate: 30,  // Hz — framework owns the setInterval lifecycle
    handler(match, dt) {
      // Authoritative tick: move invaders, advance projectiles,
      // check collisions. Framework diffs changed fields and
      // broadcasts deltas — no manual serialization, no DB writes.
      if (match.invaders.allDead()) match.phase = 'gameover';
    },
  },
});
```
The framework starts the loop on a configurable trigger (e.g., phase
transition to `playing`), stops it on `gameover`, and cleans up on entity
destroy. No `setInterval`, no polling, no second pathway.


## PAIN POINT 2: No field type for shared ephemeral server-authoritative state

**Rank: BLOCKER**

**API construct that failed:** Every field type available to the `fields` block
is either **persisted** (`text`, `number`, `date`, `set`, `ref`, `log`) or
**per-connection ephemeral** (`presence`). There is no field type for:
  - SHARED (all connections see the same value)
  - EPHEMERAL (evaporates when the match/entity is destroyed — no DB persistence)
  - SERVER-AUTHORITATIVE (clients can read but never write)
  - TICK-MUTATED (updated by the server tick, not by any client action)

The invader grid is the canonical example: a 2D boolean array (11×5 or wider)
that every player's client must render identically, that the server mutates
every tick, and that should never touch the database.

**What we had to do:** We serialized the invader grid, projectile array, and
ship positions as a JSON string into the `invaders: text` field of the Match
entity every tick. This has two catastrophic consequences:
  1. **30 DB writes/second per active match.** A text field is LWW-persisted;
     every `match.invaders = jsonString` triggers a database write. For a
     lobby with 10 active matches, that's 300 writes/second — to store data
     that should be ephemeral.
  2. **The entire grid is serialized and broadcast every frame.** There's no
     delta compression — the framework sees "text field changed" and pushes
     the full new value to all subscribers. A diffing broadcast (only send
     the cells that changed) requires framework support.

**What we also couldn't do:** Player ship positions are genuinely per-player —
they belong in `presence`. But `presence` is designed for cursor/selection in
collaborative document editing, not for game input. `presence` has no built-in
server validation (it's client-dictated) and emits `:joined/:moved/:left`
events — no mechanism for the server to clamp positions, enforce velocity caps,
or reject spoofed coordinates. Ship positions ended up in the in-memory game
loop, outside the entity system entirely.

**Aspirational fix:** New field types for shared ephemeral game state:
```js
fields: {
  invaders:    grid({ cols: 11, rows: 5 }),   // 2D boolean grid, delta-broadcast
  projectiles: list({ max: 50 }),              // array of {x, y, dy, owner}
  ships:       perPlayer({ x: number, lives: number }, {
    serverAuthoritative: true,  // server clamps/rejects client values
  }),
}
```
These fields are **in-memory only** — no DB persistence. On tick, the framework
diffs each field and broadcasts only the delta to subscribers. On entity
destroy, the memory is freed.


## PAIN POINT 3: Per-push re-authorization at high frequency (30 Hz × N players)

**Rank: SHOULD-FIX**

**API construct that failed:** The baked-in WS `/events` stream re-authorizes
every push through `grant`/`access`/`checks` — "no second auth path"
(DOMAIN-MODULES.md line 142). For a document-collaboration app, this is correct:
shares change, collaborators are added/removed, and re-auth on each push catches
permission revocations within one push-cycle.

For an in-flight arcade match, the auth answer **does not change** between
ticks. Once a player joins a match (authorized at join), they remain in the
player roster (the `inMatch` check in `grant`). Re-checking `entity.players.has(user.id)`
120 times per second (30 Hz × 4 players) is overhead with no security benefit.

**The per-push pattern also blocks delta-compression optimizations.** If the
framework must call `grant` per subscriber per push, it evaluates authorization
for every connected user before it can even decide what to push. A match with
4 players and 100 lobby spectators would call `grant` 3,000 times/second
(30 Hz × 100 subscribers) — most of whom get `hide()` because they're not in
the match. The framework ideally filters subscribers BEFORE evaluating per-push
re-auth.

**Aspirational fix:** Authorization-latch-on-subscribe. When a client subscribes
to a match's fields, the framework evaluates `grant` ONCE and latches the
capability set for the lifetime of that subscription (or until a
subscription-invalidating event occurs, like a share revocation or player
roster change). For fields that don't change auth mid-flight (the invader grid),
this eliminates 99% of re-auth calls. A field could opt in:
```js
invaders: grid({ cols: 11, rows: 5, authLatch: true })
```
The framework would still re-auth on player join/leave (roster change) but skip
per-tick re-auth during gameplay.


## PAIN POINT 4: No ephemeral entity lifecycle

**Rank: SHOULD-FIX**

**API construct that failed:** All entities in express-plus are persisted by
default. The Match entity has a `createdAt` date field and the framework stores
every row in the database. But a Match is **ephemeral** — it exists for the
duration of a game (typically 3–5 minutes) and should evaporate afterward.

**What we had to do:** Nothing explicit — the Match rows linger in the database
indefinitely as stale rows. The game loop reads/writes them every tick (see
Pain Point 2), and when the match ends, the `score` and `phase` fields are
preserved in the DB row, but the invader grid and projectile data are ephemeral
(serialized in the text field, now stale). To clean up, the app would need a
periodic sweep job (yet another `setInterval` — third pathway).

**Aspirational fix:** An entity-level `ttl` (time-to-live) or `ephemeral` flag:
```js
entity('Match', {
  ttl: '5m',  // auto-delete row 5 minutes after creation
  fields: { ... },
});
```
Or a stronger `ephemeral: true` that keeps the entity entirely in-memory
(no DB row, no persistence) — suitable for game sessions, temporary rooms,
and other short-lived shared state.


## PAIN POINT 5: No RPC/action pattern alongside field mutations

**Rank: NIT**

**API construct that failed:** The framework's only mutation path is field
assignment (`match.invaders = ...`, `match.players.add(id)`). But arcade games
need **actions** — "fire bullet," "move left," "start match." These are not
field mutations: they're server-validated intents that the authoritative tick
processes and whose side effects (a projectile appearing, a ship moving) are
**derived state**, not client-written field values.

**What we had to do:** We added POST routes (`/:matchId/fire`, `/:matchId/move`)
that accept the intent, validate it, and queue it into the in-memory game loop's
`pendingInput` array. The tick then processes the input and updates the game
state. This works but feels like a parallel mutation mechanism — the framework
knows about field mutations (and derives events from them), but action intents
are opaque JSON payloads with no type safety, no validation, and no event
derivation.

**Aspirational fix:** An `actions` block on the entity that declares typed,
server-validated player actions:
```js
entity('Match', {
  actions: {
    move: { direction: number(-1, 0, 1) },  // typed, validated
    fire:  { shipX: number(0, GAME_WIDTH) },
  },
  tick: {
    rate: 30,
    handler(match, dt, queuedActions) {
      // queuedActions = [{ player, action: 'move', payload: { direction: -1 } }, ...]
      // Already validated by the framework.
    },
  },
});
```
Actions are queued per-tick (one action per player per tick), validated against
the declared types, and passed to the tick handler alongside the match state.
The framework derives `Match:<id>:action:fire` events for spectators if desired.


## PAIN POINT 6: No built-in delta broadcast for high-frequency fields

**Rank: SHOULD-FIX**

**API construct that failed:** When a text field changes, the framework emits
`Doc:<id>:<fieldPath>:changed` with the full new value. For a CRDT text field,
it also emits `:delta` with the operational transform. But for a serialized
game grid in a `text` field, there's no delta — the full grid (JSON string)
is pushed to every subscriber every frame.

At 30 Hz with a 4-player match and a 55-cell invader grid, the full grid JSON
(≈500 bytes) is pushed 120 times/second. With delta compression, only the
≈2–5 cells that changed per tick (≈20 bytes) would be pushed — a 25× bandwidth
reduction.

**Aspirational fix:** All field types should support delta compression. The
framework owns the diff algorithm per field type:
  - `text.crdt()` → operational transform deltas (already exists)
  - `grid()` → cell-level diffs (new field type)
  - `list()` → add/remove/move operations (new field type)
  - `number` → only emit when value changes (skip duplicate writes)
The tick handler mutates fields in-memory; the framework diffs and broadcasts
only what changed.


## Summary

| # | Pain Point | Rank | Workaround |
|---|-----------|------|------------|
| 1 | No tick/scheduler construct | BLOCKER | `setInterval` in app.mjs + polling for lifecycle |
| 2 | No shared-ephemeral field type | BLOCKER | Serialize grid to `text` field → 30 DB writes/sec |
| 3 | Per-push re-auth at 30 Hz | SHOULD-FIX | Accept the overhead (no workaround) |
| 4 | No ephemeral entity lifecycle | SHOULD-FIX | Stale Match rows linger in DB |
| 5 | No RPC/action pattern | NIT | POST routes with opaque JSON payloads |
| 6 | No delta broadcast for game fields | SHOULD-FIX | Full grid serialized every frame |

**Design verdict:** The reactive-entity paradigm is a strong fit for
collaborative document editing (the Doc use case). It is a structural mismatch
for authoritative-server real-time games, where the central abstraction is a
timer-driven simulation loop, not reactive field mutations. The two most
severe gaps (#1 and #2) require framework-level additions (a `tick` block and
shared-ephemeral field types) before an arcade game could ship without reaching
outside the framework for every core mechanic.
