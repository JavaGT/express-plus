# Pain Points — express-plus API vs. Minecraft Voxel Clone

Every gap found while implementing a Minecraft-style multiplayer voxel world
using the express-plus reactive-entity framework. Each entry cites the specific
API construct that failed, explains why it failed, and proposes what the ideal
API would provide.

**Ranking scale:**
- **BLOCKER** — cannot build the feature without a workaround that defeats the framework
- **SHOULD-FIX** — can build but requires a second pathway, a leak, or repetitive boilerplate
- **NIT** — minor ergonomic gap, the built-in types could express it with friction

---

## BLOCKER 1: No custom field type extension point

**API construct:** The field-type catalog is hardcoded — `text`, `text.crdt`,
`number`, `ref`, `set`, `presence`, `log`, `date`, `hash`. There is NO
`registerFieldType` export, no plugin registry, and no way to add a first-class
field type that integrates with the framework's persistence, sync, and
authorization layers.

**Why it fails for Minecraft:**
- A `chunk` field (RLE-compressed 16³ voxel data with delta sync) cannot be built.
- A `vector3` field (batched x/y/z with one event per mutation) cannot be built.
- An `inventory` field (keyed item-type → count map with stack limits) cannot be built.
- The only workaround is to abuse `text` with hand-rolled serialization
  (e.g., JSON-encode a 4096-byte array inside a text field → ~12KB of base64 in
  a field designed for strings, emitting `:changed` with the full blob every time
  one block changes). This is both semantically wrong and a performance disaster.

**What the ideal API would provide:**
```js
import { registerFieldType, fieldTypeContract } from 'express-plus';

const chunkFieldDef = {
  events: { set: ':changed:block' },
  init({ default }) { ... },
  serialize(value) { ... },     // → persistence
  deserialize(serialized) { ... },
  diff(oldValue, newValue) { ... },  // → delta sync
  merge(base, remote) { ... },       // → conflict resolution
  methods: { getBlock, setBlock, fillRegion },
};
registerFieldType('chunk', chunkFieldDef);

// Then use it as a first-class field:
entity('World', { fields: { chunks: chunk({ compression: 'rle' }) } });
```

The framework validates the field-type contract at registration time, integrates
the new type with the baked-in WS event stream (calls `diff` for delta payloads),
persistence layer (calls `serialize`/`deserialize`), and authorization engine
(field-level `access` works unchanged). The field's `methods` are surfaced on the
loaded entity instance as typed handles: `world.chunks.getBlock(cx, cy, cz, x, y, z)`.

**Current workaround:** Use `text` fields with manual JSON/binary serialization.
Every block mutation re-serializes the full chunk and emits the full chunk blob
over the WS stream. No delta sync, no structured query, no type safety.

---

## BLOCKER 2: No spatial event scope — all events broadcast to all subscribers

**API construct:** The baked-in WS `/events` stream broadcasts every field
mutation event (`:changed`, `:delta`, `:added`, `:removed`) to EVERY subscriber
that passed `grant(... subscribe)`. Re-authorization happens per push but
re-authorization only checks "can this user subscribe to this entity?" — not
"is this user near the chunk this event affects?"

**Why it fails for Minecraft:**
- A world has thousands of chunks. When a player places a block in chunk (10, 0,
  -5), the delta event should only reach players whose loaded-chunk radius
  includes those coordinates — typically 2–8 nearby players.
- With the current model, every player on the world receives every chunk delta.
  A 100-player server with even modest block-editing activity would saturate
  every client's network pipe with irrelevant events.
- The framework has NO spatial query concept, NO per-subscriber event filter,
  and NO way to express "subscribe to events matching a predicate" in `grant`.
- `grant` returns a capability set (`read`, `write`, `subscribe`), not a
  filter function. `subscribe` is a boolean — you either get all entity events
  or none.

**What the ideal API would provide:**
```js
// Option A: Per-subscriber event filter in grant
grant: async ({ is, event }) => {
  if (event.field === 'chunks' && !isNearChunk(event.coords, is.cameraPosition())) {
    return grant(read);  // read allowed, but suppress this event's push
  }
  return grant(read, subscribe);
}

// Option B: Subscription with a predicate
app.entity.subscriptions.add(userId, Entity, {
  filter: (event) => distance(event.position, player.position) < renderDistance,
});

// Option C: Named spatial scopes on the chunk field itself
chunks: chunk({
  subscribe: ({ playerPosition, chunkCoords, renderDistance }) =>
    manhattanDistance(playerPosition, chunkCoords) <= renderDistance * 16,
})
```

**Current workaround:** Implement a spatial routing layer OUTSIDE the framework
that receives all events from the WS stream, filters them client-side, and
discards irrelevant ones. This defeats the framework's "one auth engine, no
second path" principle — the spatial filter is a second auth-like layer that
lives outside grant/checks/access. It also doesn't save bandwidth — irrelevant
events still traverse the server → client pipe.

---

## BLOCKER 3: No chunk streaming / partial-load protocol

**API construct:** The framework's data-access model is: REST to load the full
entity (or auto-CRUD list), then WS for live deltas. `r.resource()` auto-generates
GET /:id for the full row, GET / to list rows, and GET /:id/chat + GET /:id/presence
for live-field history.

**Why it fails for Minecraft:**
- When a player joins, they need to load ALL chunks within their render distance
  (render-distance 8 = (2×8+1)³ = 4,913 chunks × 4KB = ~20MB of voxel data).
  Loading the full World entity via REST doesn't work — the world IS its chunks,
  and you can't send 20MB over a REST call.
- After joining, the player MOVES continuously. As they move, new chunks enter
  render distance and must be loaded; old chunks leave render distance and must
  be unloaded. This is SPATIALLY SCROLLING data access — fundamentally different
  from the document model where you load the entity once and stream deltas
  thereafter.
- The framework has no concept of:
  - A spatial query ("give me all chunks in radius R around (x,y,z)")
  - A batch-load endpoint ("send me these 50 chunk IDs at once")
  - A push-based chunk stream ("keep sending me chunk deltas for chunks in my
    loaded radius, and notify me when a new chunk enters/exits my radius")
  - A chunk-unload protocol ("I've left chunk (cx,cy,cz); stop sending its deltas")

**What the ideal API would provide:**
```js
// A spatial sub-resource that auto-generates chunk load/unload endpoints
routes: (r, World) => {
  r.resource();
  // Framework-owned: the chunk field's spatial API is surfaced automatically
  // GET /worlds/:id/chunks?cx=0..15&cy=0..0&cz=-7..7&at=x,y,z&radius=8
  //   → returns compressed chunk data for all chunks in the spatial range
  // WS protocol: client sends `subscribe:chunks` with position + radius;
  //   server computes which chunks are in range, sends initial batch, then
  //   streams deltas for those chunks. On player move, server recomputes
  //   the chunk set and sends load/unload directives.
}
```

**Current workaround:** Build a custom chunk-streaming WebSocket protocol on a
separate socket (a second transport, violating "uniform transport"), with
hand-rolled spatial queries against the data store. This is an entirely separate
system living outside the entity — the entity's field declarations don't drive
any of it.

---

## BLOCKER 4: No server tick / game-loop concept

**API construct:** The paradigm is "fields are reactive primitives; events derive
from field mutations; mutations originate from user actions (REST calls)." There
is no `loop`, `tick`, `interval`, or `schedule` hook on entities. There is no
framework-managed timer with drift compensation or lifecycle management.

**Why it fails for Minecraft:**
- Physics (gravity, fluid flow, entity collision) runs on a fixed timestep.
- Mob AI, crop growth, hunger decay, and day/night cycle are timer-driven.
- All of these are SELF-DRIVEN mutations — the system mutates its own fields on
  a timer, not in response to a REST call.
- The game loop must be framework-owned (not `setInterval` at module scope)
  because:
  - It needs to stop when the world is deleted (lifecycle).
  - It needs drift compensation (fixed timestep, variable frame rate).
  - It needs to pause when the server is under load (backpressure).
  - Multiple worlds each need their own loop at their own tick rate.

**What the ideal API would provide:**
```js
entity('World', {
  fields: { ... },

  // A framework-managed game loop. Runs at the declared interval. Framework
  // handles start/stop on entity mount/unmount, drift compensation, and
  // graceful shutdown.
  tick: {
    rate: 20,  // Hz (50ms interval)
    handler: async (world) => {
      // Physics, AI, decay — mutation emits events normally
      for (const player of await world.players.toArray()) {
        player.position = applyPhysics(player.position, player.velocity);
      }
    },
  },
});
```

**Current workaround:** `setInterval` at app scope in `app.mjs`, manually loading
the world entity by ID. No lifecycle integration: if the world is deleted, the
interval keeps running. No drift compensation. No pause/resume. This is a full
framework leak — the entity doesn't own its own behavior.

---

## BLOCKER 5: No binary/structured field types

**API construct:** The field catalog has `text` (LWW string), `text.crdt`
(CRDT-merged string), `number` (LWW), and `date` (LWW). No `binary`, `blob`,
`json`, `struct`, or `buffer` field type.

**Why it fails for Minecraft:**
- Chunk voxel data is 4,096 bytes of dense binary data. Storing it in a `text`
  field requires base64 encoding → 5,461 bytes, plus the overhead of treating
  it as a string. `text` emits `:changed` on mutation and has no delta concept —
  every block edit sends the full chunk.
- Game rules (difficulty, gameMode, pvp, spawnMonsters, etc.) are a nested
  object. Without a `json` or `struct` field type, each rule must be a separate
  scalar field (exploding the field count) or encoded as JSON in a `text` field
  (losing per-rule type safety and per-rule access control).
- Player inventory is a keyed map ({ itemTypeId → count }). No `map` or `dict`
  field type exists.

**What the ideal API would provide:**
```js
fields: {
  chunks:    binary({ maxSize: 65536 }),        // raw binary with delta diff
  gameRules: json({                             // validated structured object
    schema: { difficulty: 'string', gameMode: 'string', pvp: 'boolean' }
  }),
  inventory: map(text, number, { maxEntries: 100 }),  // key→value map
}
```

---

## BLOCKER 6: Entity-explosion for dense sub-document data

**API construct:** `entity()` is the ONLY way to model persisted data. Every
entity gets auto-CRUD routes (or `r.resource()` opts in), a route gate
(`requireAuth` on every route), and a grant evaluation on every access. There
is no lighter-weight "value object" or "embedded document" construct.

**Why it fails for Minecraft:**
- A World has thousands of chunks. If each chunk is a standalone `entity('Chunk',
  { fields: { cx, cy, cz, voxels } })`, you get:
  - 4,913 entities per world (at render distance 8) × grant evals per route.
  - 4,913 REST endpoints (GET /chunks/:id for each chunk — never used).
  - 4,913 route-gate evaluations on every chunk-level operation.
  - N+1 queries for every "load all chunks for a world" operation.
- The framework PUSHES you toward entity-per-row because `set` only stores refs
  to OTHER entities, and there's no collection field that stores values inline.
- A custom `chunk` field that manages a sparse key-value store internally is a
  workaround — but it hides the collection structure from the framework, so the
  framework can't auto-generate queries, indexes, or access controls on
  individual chunks.

**What the ideal API would provide:**
```js
// A `collection` field that stores sub-documents WITHOUT making them full entities
fields: {
  chunks: collection({
    key: ['cx', 'cy', 'cz'],          // compound key
    value: chunk({ compression: 'rle' }),
    access: ({ chunkCoords, playerPosition }) =>
      isWithinRadius(chunkCoords, playerPosition),
  }),
}
```

---

## SHOULD-FIX 7: `presence` is the wrong field type for game position

**API construct:** `presence({ cursor: true, selection: true })` is designed for
collaborative document cursors: ephemeral (lives in the WS layer, not persisted),
connection-scoped (dies on disconnect), and low-frequency (a few updates per
second per user).

**Why it fails for Minecraft:**
- Player position MUST be persisted — if a player disconnects and reconnects,
  they should resume at the same coordinates. `presence` data evaporates on
  disconnect.
- Player position MUST be server-validated (anti-cheat). `presence` has no
  validation hook — it's designed as a "the client tells the server where its
  cursor is" field, not a "the server validates and broadcasts" field.
- Player position updates at 20Hz. `presence` emits per-user per-change events —
  fine for 5 collaborators on a doc, catastrophic for 100 players on a world.
- `presence` tracks connection identity (one entry per WS connection), not game
  identity (one entry per Player entity). A Player entity with multiple
  connections would have multiple presence entries.

**The fix:** Add a `vector3` field type (or at minimum, clarify that `presence`
is for document-collaboration ephemeral state and is NOT a general-purpose
position field). Game position should be a persisted, validated, batched-mutation
field type.

---

## SHOULD-FIX 8: No batched / atomic multi-field mutation

**API construct:** Each field mutation is an independent operation. REST
`PUT /players/:id` updates one field at a time (or a single body object, but
the framework's field model handles them sequentially). There is no `patch`
or multi-field mutation endpoint.

**Why it fails for Minecraft:**
- On player spawn/respawn, you need to set position, velocity, look, health,
  food, and dimension atomically. Doing 6 sequential writes means a game tick
  could process intermediate state (e.g., position updated but health still at
  the old value).
- The intermediate states emit events. Between setting position and setting
  health, other players see the player at the new position but with the old
  health — a visible inconsistency.
- Each individual write goes through the full auth pipeline (grant → field
  access → serialize → event emit). 6 writes = 6 full pipeline traversals.

**What the ideal API would provide:**
```js
// A batch mutation that emits ONE composed event
await player.batch({
  position: { x: 0, y: 64, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  look: { x: 0, y: 0, z: 0 },
  health: 20,
  food: 20,
}).commit(); // → emits one Player:<id>:respawned event with all fields
```

---

## SHOULD-FIX 9: No field-level `validate` hook

**API construct:** Fields own storage and sync but NOT validation. The `access`
function controls who can read/write but not whether the VALUE is valid. Route
handlers must validate manually: "is this position within the world bounds?",
"is this block type valid?", "is the player within reach distance?"

**Why it fails for Minecraft:**
- Anti-cheat position validation (speed clamping, no-clip detection, world
  bounds) must be copied into EVERY route that mutates a player's position.
  Miss one route, and you have a cheat vector.
- Block placement validation (is the item in the player's inventory? is the
  target block within the player's reach distance?) must be hand-written in the
  block-edit route handler. The field doesn't own its own validity rules.
- This violates "declaration absorbs imperative wiring" — the field's shape
  should encode what constitutes a valid value, and the framework should enforce
  it on every mutation path.

**What the ideal API would provide:**
```js
position: vector3({
  default: { x: 0, y: 64, z: 0 },
  validate: (newPos, { player, world }) => {
    const speed = distance(newPos, player.position) / dt;
    return speed <= 1.5 && world.isWithinBounds(newPos);
  },
}),
```

The framework calls `validate` before persisting, on EVERY mutation path
(REST, WS, batch, game tick). One place to define the rule; enforced everywhere.

---

## SHOULD-FIX 10: No event priority, rate limiting, or backpressure

**API construct:** The WS `/events` stream sends every field mutation event to
every subscriber that passed `grant(... subscribe)`. No priority queue, no
rate limiting per subscriber, no backpressure (slow clients don't signal
congestion).

**Why it fails for Minecraft:**
- 100 players × 20 position updates/sec = 2,000 events/sec just for position.
  Add chunk deltas, inventory changes, chat messages — the stream is flooded.
- A player on a slow connection (mobile, high latency) receives the same firehose
  as a player on a fast connection. No adaptive rate limiting.
- Critical events (block placed that affects a player's immediate surroundings)
  and non-critical events (a player moved 0.001 blocks) share the same queue.
- The framework assumes low-frequency events (a few per second per document)
  because it was designed for collaborative editing, not real-time games.

**What the ideal API would provide:**
```js
// Per-field event priority
position: vector3({
  eventPriority: 'low',      // position updates are frequent, loss-tolerant
  rateLimit: { perSecond: 5, strategy: 'throttle' },
}),
chunks: chunk({
  eventPriority: 'high',     // block edits are critical, must-deliver
}),
```

---

## SHOULD-FIX 11: No entity lifecycle hooks

**API construct:** Entities are defined via `entity(name, config)` with keys
`fields`, `checks`, `grant`, `routes`. There is no `onCreate`, `onDelete`,
`onMount`, or `onUnmount` hook.

**Why it fails for Minecraft:**
- A World entity should start a game loop on creation and stop it on deletion.
  Without lifecycle hooks, the loop must be managed externally (in `app.mjs`),
  breaking encapsulation.
- A Player entity should allocate/initialize inventory slots on creation.
  Without `onCreate`, initialization logic must live in route handlers
  (repeated everywhere a Player can be created).
- A World entity should generate initial spawn chunks on creation
  (procedural terrain generation). Without `onCreate`, this must be a
  separate non-declarative step after `World.create()`.

**What the ideal API would provide:**
```js
entity('World', {
  fields: { ... },

  onCreate: async (world) => {
    await world.chunks.generateSpawn();    // procedural terrain
    startGameLoop(world);                  // start ticking
  },

  onDelete: async (world) => {
    stopGameLoop(world.id);               // cleanup
  },
});
```

---

## SHOULD-FIX 12: No boolean field type

**API construct:** Field types are `text`, `number`, `ref`, `set`, `presence`,
`log`, `date`, `hash`. No `bool` or `boolean` type.

**Why it matters for Minecraft:** PvP on/off, spawn monsters on/off, allow flight
on/off, do daylight cycle on/off — all are booleans forced into `number({ default:
1 })` or `text({ default: 'true' })`. Losing type semantics: a `number` field
reads as "how many PvP?" when it means "is PvP enabled?"

**The fix:** Add `bool()` to the built-in catalog.

---

## SHOULD-FIX 13: `set` stores refs, not values — no collection-of-values field

**API construct:** `set(ref('User'))` stores refs to OTHER entities. No field
type stores inline values in a collection (like a `Set` of strings, numbers, or
nested objects).

**Why it matters for Minecraft:** A player's hotbar is an ordered list of item
references, not a set of refs to standalone Item entities. Making every item a
full entity with CRUD routes for a hotbar slot is absurd. The workaround is a
`text` field with comma-separated IDs — fragile, not type-safe, no framework
integration.

**What the ideal API would provide:**
```js
// An ordered list of values
hotbar: list(text, { maxLength: 9, default: [] }),

// A set of values (not refs)
allowedBlocks: set(text, { allowed: ['stone','dirt','grass'] }),
```

---

## NIT 14: No structured sub-object field type

**API construct:** All fields are flat scalars (text, number, date), single
refs, or sets of refs. No nested-object or structured field type.

**Why it matters for Minecraft:** Game rules (difficulty + gameMode + pvp +
spawnMonsters + doDaylightCycle + ...) are a conceptually single object that
must be split across 6+ scalar fields. This:
- Clutters the field listing with what is conceptually one unit.
- Makes "reset all game rules to defaults" require 6+ field writes.
- Loses the ability to validate the object as a whole (e.g., "spectator game
  mode requires pvp off").
- Loses per-field access granularity on the sub-fields (you can't grant read on
  difficulty but hide pvp).

**The fix:** Add a `json()` or `struct()` field type with optional validation
schema.

---

## NIT 15: No `read-only-except-on-create` field modifier

**API construct:** `readonly: true` makes a field immutable after creation.
`readonly: false` makes it always mutable. There's no "set once at creation, then
readonly" modifier.

**Why it matters for Minecraft:** A World's seed must be set at creation and
never changed — but `readonly: true` prevents setting it during `World.create()`
(the auto-CRUD POST endpoint). You need the `default` option to auto-generate
it, but what if the player wants to CHOOSE their seed? Then the field must be
mutable, and you must validate in the route that it's not being changed after
creation.

**The fix:**
```js
seed: number({ setOnce: true }),  // writable on create, readonly thereafter
```

---

## Summary table

| # | Pain Point | Rank | API construct | Can work around? |
|---|-----------|------|---------------|-----------------|
| 1 | No custom field type extension | BLOCKER | `entity()` fields catalog | Only by abusing `text` |
| 2 | No spatial event scope | BLOCKER | `/events` WS broadcast | Client-side filter (wasteful) |
| 3 | No chunk streaming / partial load | BLOCKER | `r.resource()` auto-CRUD | Build second WS protocol |
| 4 | No server tick / game loop | BLOCKER | Field-mutation-only model | `setInterval` leak |
| 5 | No binary/structured field types | BLOCKER | `text`, `number` only | base64 in text field |
| 6 | Entity explosion for dense data | BLOCKER | `entity()` + `set(ref)` only | Custom sparse field workaround |
| 7 | `presence` wrong for game position | SHOULD-FIX | `presence` field type | Use custom `vector3` (needs #1) |
| 8 | No batched multi-field mutation | SHOULD-FIX | Individual field writes | Sequential writes (racy) |
| 9 | No field-level `validate` hook | SHOULD-FIX | Route handler validation | Copy-paste validation per route |
| 10 | No event priority/rate-limiting | SHOULD-FIX | WS stream firehose | Client-side throttling |
| 11 | No entity lifecycle hooks | SHOULD-FIX | `entity()` config keys | App-level manual management |
| 12 | No boolean field type | SHOULD-FIX | No `bool` in catalog | `number({ default: 1 })` |
| 13 | `set` stores refs, not values | SHOULD-FIX | `set(ref('User'))` | `text` with comma-sep IDs |
| 14 | No structured sub-object type | NIT | Flat scalars only | Split into N scalar fields |
| 15 | No `setOnce` field modifier | NIT | `readonly: true` on creation | Manual route validation |

---

## Design reflection

The express-plus API was designed for **collaborative documents** — the
"Google Docs" use case shaped every abstraction:

- **Field types** target text documents (text, text.crdt for collab editing) and
  document metadata (number, date, ref). Binary, spatial, and structured data
  are absent because they never arise in docs.
- **Event fan-out** assumes "all collaborators see all changes" — true for a
  shared document, false for a spatially scoped game world.
- **Data access** assumes "load the entity once, then stream deltas" — true for
  a fixed-size document, false for a scrollable world where data is constantly
  loaded and unloaded.
- **Mutation source** assumes user-driven REST calls — true for typing and
  sharing, false for a server game loop that self-mutates at 20Hz.

A Minecraft clone doesn't just need "more field types" — it challenges the
framework's **data-access model** (spatial vs. one-shot load), **event model**
(broadcast vs. scoped), and **mutation model** (user-driven vs. timer-driven).

The framework's design is tight for its domain but **not pluggable** for domains
outside it — and the #1 gap (no custom field type extension point) makes it
impossible to bridge.
