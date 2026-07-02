# Pain Points — workbench grilled API vs. Minecraft Voxel Clone

Stress-testing the grilled API (DECISIONLOG.md ADRs #1–#7) by attempting to
implement a Minecraft multiplayer clone using the exemplar style of doc.mjs / comment.mjs.

## Persona

The Voxel Worldbuilder — cares about custom data types, spatial fanout, and whether the
plugin/interest/tick contracts are real or just sketched. Skeptical that a doc-centric
framework can express a voxel world without escape hatches.

---

## Attempted entity shape

The idealized code below references field types (`chunk`, `vector3`) and exports (`tick`,
`subscribe`, `withheld`) that the grilled design sketches but does not concretize.
Referencing not-yet-existing handles IS the point — this section names what a complete
API would export.

```js
// minecraft-entities.mjs — World + Player entities expressed in the grilled API.
// Imports that DON'T EXIST are marked [GHOST]; these are the handles the stress test
// expects the field-type plugin contract (Phase 1 step 1), tick (Phase 2 step 9),
// subscriber interest (ADR #5 / Phase 2 step 7), and built-in plugins to provide.
import {
  // Core
  entity,               // entity declaration
  grant, deny,          // auth primitives
  read, write, subscribe, admin,  // capability handles
  scope, anyOf, never,  // grant grammar
  router,               // route mini-app

  // Built-in field types (Phase 1 + 2)
  text, number, date, ref, boolean,  // scalars
  map,                  // valued keyed set (collapses join entity)
  blob,                 // Phase 2 step 12: binary blob

  // [GHOST] field type plugin handles — the plugin contract (Phase 1 step 1)
  // MUST produce these as first-class imports:
  chunk,                // voxel grid: publish coords, delta diff, internal keyed store
  vector3,              // batched x/y/z with one event per mutation, server-authoritative

  // [GHOST] tick mechanism — Phase 2 step 9: entity-level recurring mutation
  tick,

  // [GHOST] subscriber interest — ADR #5: client declares interest at subscribe time
  subscribe,

  // Children
  inherit,              // grant inheritance through typed FK
  User, Inbox,          // built-in entities
} from 'workbench';

// ─── Capabilities ───
const PLAYER = [read, write, subscribe];
const OWNER  = [read, write, subscribe, admin];

// ─── World entity ──────────────────────────────────────────────────────

export const World = entity('World', {
  fields: {
    name:       text({ validate: (v) => v.length <= 100 || 'name too long' }),
    seed:       number({ default: () => Math.floor(Math.random() * 2**32) }),
    gameMode:   text({ options: ['survival', 'creative', 'adventure', 'spectator'] }),
    difficulty: text({ options: ['peaceful', 'easy', 'normal', 'hard'] }),

    owner: ref('User', { role: 'owner', readonly: true }),
    // Valued keyed set: membership keyed by User; uniqueness-by-construction.
    // Collapses the separate PlayerMembership entity pattern.
    players: map(ref('User'), {
      role: ['player', 'operator'],
      default: {},
    }).can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage players')),

    // [GHOST] chunk() — custom field type via the plugin contract (Phase 1 step 1).
    // The plugin publishes a coordinate schema { cx, cy, cz } so subscriber interest
    // can express viewport-range constraints at subscribe time (ADR #5). Internally
    // this field type manages a SPARSE KEY-VALUE STORE (chunk key → voxel data),
    // NOT thousands of entity rows. The plugin contract's scope enum (`entity` |
    // `connection`) doesn't fit: this is `entity`-scoped persistence but with
    // thousands of independently-addressable sub-records — neither a single blob nor
    // a connection-transient value. See BLOCKER #3.
    chunks: chunk({
      compression: 'rle',
      dimensions:  { x: 16, y: 16, z: 16 },
      // Published coordinate schema — subscriber interest validates + indexes on these.
      coordinates: { cx: 'number', cy: 'number', cz: 'number' },
    }).can(async ({ is }) =>
      // Field access always runtime .can (ADR #3). Player can read/write chunks.
      // Non-player link holders or viewers are denied — chunk read/write is
      // world-interactive, not read-only view.
      (await is.player())
        ? grant(read, write, subscribe)
        : deny('only world players may interact with chunks')),

    createdAt: date({ default: () => new Date() }),
  },

  checks: {
    owner:  ({ World, principal }) => World.owner.is(principal.id),
    player: ({ World, principal }) => World.players.has(principal.id),
  },

  // Grant: exactly scope().can() — two halves, no third method (ADR #5).
  // scope declares READ intent; .can decides write/subscribe at runtime.
  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.owner(), is.player()))
      .can(async ({ is }) => {
        if (await is.owner())  return grant(...OWNER);
        if (await is.player()) return grant(...PLAYER);
        return deny('no capability for this principal');
      }),
  ],

  // ── [GHOST] tick — Phase 2 step 9 ──
  // THIS IS A GAP: Phase 2 step 9 says tick is "lifecycle-bound to state transitions."
  // A Minecraft world has no `state` field — it's always running. Binding tick to
  // a state transition doesn't fit a continuous game loop. The plan's wording
  // conflates `state.auto` (field-level, conditional, Phase 1 step 4) with entity-level
  // recurring tick (a continuous timer) — these are different things. See BLOCKER #4.
  tick: {
    rate: 20, // Hz — fixed timestep with drift compensation
    handler: async (world) => {
      // Authoritative server mutations run through the pipeline as system principal.
      // Physics, mob AI, crop growth — self-driven mutations, not REST-driven.
      // world.players.toArray() yields each player; their position fields mutate
      // through the pipeline → emit events → subscriber interest filters by viewport.
    },
  },

  effects: {
    [native('World', 'players', 'added')]: { mutate: Inbox, with: {
      recipient: delta.member, world: entity.id, kind: 'world_join',
    } },
  },

  routes: (r, World) => {
    r.resource();
    r.get('/home', home);
  },
});

// ─── Player entity ─────────────────────────────────────────────────────

const inheritWorld = inherit('World', { via: 'world' });

export const Player = entity('Player', {
  fields: {
    world: ref('World', { required: true }),         // typed FK; grant inherits through this
    user:  ref('User', { role: 'author', readonly: true }),

    displayName: text({ validate: (v) => v.length <= 16 || 'name too long' }),

    // [GHOST] vector3() — Phase 2 step 12: blob doesn't cut it, we need a typed
    // 3D vector with batched x/y/z mutation emitting ONE event, server-authoritative
    // validation (anti-cheat speed clamping), and an event-coordinate schema for
    // subscriber interest (other players need to know where this player is).
    //
    // COMPOUND GAP: position is both PERSISTED (save on disconnect) and HIGH-FREQUENCY
    // (20 updates/sec during play). The grilled API has no "ephemeral during play,
    // commit-to-persisted on a trigger" persistence mode — Phase 3 step 16 defers this.
    // Without it, either every tick writes to the DB (20 writes/sec/player = disaster)
    // or position is fully ephemeral (lost on disconnect — wrong). See SHOULD-FIX #2.
    position: vector3({
      default: { x: 0, y: 64, z: 0 },
      // Anti-cheat: server validates every position update through the pipeline
      authority: 'server',                     // Phase 2 step 8: field authority
      validate: (newPos, { self }) => {
        const speed = distance(newPos, self.position) / dt;
        return speed <= 1.5 || 'moving too fast';
      },
    }),

    // Ditto vector3; same authority + validate pattern.
    velocity: vector3({ default: { x: 0, y: 0, z: 0 } }),
    look:     vector3({ default: { x: 0, y: 0, z: 0 } }),  // yaw, pitch, roll

    health: number({ default: 20, validate: (v) => (v >= 0 && v <= 20) || 'out of range' }),
    food:   number({ default: 20, validate: (v) => (v >= 0 && v <= 20) || 'out of range' }),

    // [GHOST] inventory field — keyed item-type → count map with stack limits.
    // Phase 2 step 12: array plugin covers ordered lists but not keyed-value maps
    // with per-key validation (stack limit depends on item type). A `map` field type
    // with typed values (not just refs) is needed. The existing `map` stores ref
    // memberships with a payload — it's a valued SET, not a keyed-value store.
    // See BLOCKER #5.
    inventory: map(text, number, { maxEntries: 36 })  // [GHOST — map over values, not refs]
      .can(async ({ is }) => (
        (await is.self()) ? grant(read, write, subscribe) : grant(read, subscribe))),

    createdAt: date({ default: () => new Date() }),
    lastSeen:  date({ touch: true }),
  },

  checks: {
    self: ({ Player, principal }) => Player.user.is(principal.id),
  },

  // Inherit World grant through typed FK — Comment inherits Doc (doc.mjs), same
  // machinery. Only world members (scope admits them) can read this player row.
  // .can refines: a player gets write on their own row; others get read/subscribe only.
  grant: ({ principal }) => [
    scope(inheritWorld)
      .can(async ({ is }) => {
        if (await is.self()) return grant(...OWNER);
        if (await is.playerOnWorld()) return grant(read, subscribe);
        return deny('not a world member');
      }),
  ],

  routes: (r) => {
    r.resource();
  },
});

// ─── Routes ───

function home(req, res) {
  res.render('worlds.html');
}

// [GHOST] subscribe() — ADR #5 says interest is "supplied at subscribe time" as
// a typed constraint expression. But there is NO visible subscribe() export or
// method in the grilled API. The doc.mjs exemplar has no subscribe path. Client
// code that wants to express spatial interest has no API surface to call.
// See BLOCKER #2.
```

---

## Pain points

### BLOCKER #1 — The subscribe() + interest API surface doesn't exist

**What the grilled API says:** ADR #5 — delivery = re-auth-at-emit (latched) +
subscriber interest ("a narrowing filter supplied at subscribe time, data-not-code,
a typed constraint expression over plugin-published coordinates, validated at
subscribe time, indexable").

**What's missing:** There is **no visible subscribe API**. The entity declaration
defines `checks`, `grant`, `effects`, `routes` — but nothing that a CLIENT calls
to express interest. The doc.mjs exemplar never shows a subscribe call. The
IMPLEMENTATION-PLAN Phase 2 step 7 says "live delivery" must precede delta-broadcast
but doesn't define the client-facing subscribe contract.

**Failing code — the API gap:**
```js
// The client needs to say: "I want World events, but ONLY chunk deltas for chunks
// within my viewport."
//
// What does this call look like? None of these exist:

// Option candidate A — entity-level subscribe with interest:
await World.subscribe(worldId, {
  interest: {
    // ONLY the chunks field, NOT all fields (name changes, difficulty changes
    // don't need spatial filtering — but do I want them?)
    chunks: {
      cx: { gte: 0, lte: 15 },
      cz: { gte: -7, lte: 7 },
    },
  },
  onEvent: (event) => { /* … */ },
});

// Option candidate B — connection-level subscribe:
ws.send(JSON.stringify({
  type: 'subscribe',
  entity: 'World',
  id: worldId,
  interest: { /* as above */ },
}));

// Both are hand-waved. No export exists. No method signature is defined.
// The exemplar (doc.mjs) routes to REST endpoints but never shows a subscribe path.
// The FEATURES.md §5 mentions `app.room()` for realtime but room-level events
// (broadcast all, no interest filter) are not the same as entity-level subscribe
// with per-field spatial interest.
```

**Gap summary:** The grilled design correctly separates re-authorization (latched
scope+can) from narrowing interest, but the **client-facing subscribe API surface**
that carries the interest expression is undesigned. Without it, spatial event
scoping is a declaration that no client can invoke.

**Which ADR this tests:** ADR #5 (live delivery = re-auth + interest). The
re-auth half is well-designed; the interest half has a data grammar but no
invocation surface.

---

### BLOCKER #2 — Interest at field-level: can I scope interest to specific fields?

**What the grilled API says:** ADR #5 — subscriber interest is "a narrowing filter"
running after re-authorization, structurally incapable of widening, data-not-code.

**What's missing:** Is interest per-entity or per-field? A World has fields `name`
(always relevant), `difficulty` (always relevant), and `chunks` (spatially scoped).
A player in a viewport wants ALL world-metadata events but ONLY chunks in their
viewport. If interest is entity-level, EVERY event (including `name:changed`) must
pass through the spatial filter — which doesn't make sense (a `name` field has no
coordinates). If interest is per-field, the grammar must declare WHICH fields
have interest and WHICH fields are unfiltered pass-through.

**Failing code — the ambiguous boundary:**
```js
// If interest is entity-level, a `name:changed` event has no `chunk` coordinates
// — does it pass through? Get rejected? The interest grammar would need a
// "don't filter non-spatial fields" escape hatch, which the design doesn't specify.

// If interest is per-field (my preferred interpretation):
interest: {
  chunks: { cx: { gte: 0, lte: 15 }, cz: { gte: -7, lte: 7 } },
  // fields NOT listed = unfiltered pass-through for name, difficulty, etc.
}

// But: how does the chunk field PUBLISH `cx`, `cy`, `cz` as interest-able
// coordinates? The field declaration says:
//
//   chunks: chunk({ coordinates: { cx: number, cy: number, cz: number } })
//
// This declares the schema, but: does the interest validator at subscribe time
// REJECT an interest expression referencing `cy` if the chunk plugin doesn't
// publish that coordinate? ADR #5 says "subscribe-time error on any unpublished
// coordinate" — yes. Good. BUT where is the field → coordinate binding?
//
// The subscribe expression says `chunks: { cx: ..., cz: ... }` — how does the
// framework know `chunks` is the field and `cx`/`cz` are the chunk plugin's
// coordinate keys? The field name (`chunks`) and coordinate keys (`cx`) need
// to be validated against the entity's field declarations at subscribe time.
//
// This validation requires the interest parser to traverse the entity's field
// declarations, check that `chunks` is a custom field with a published coordinate
// schema, and check that `cx`/`cz` are in that schema. The grilled design says
// this happens but doesn't show the grammar or the validation contract.
```

**Which ADR this tests:** ADR #5 — interest is "data, not code" with "coordinates
validated at subscribe time." The validation contract is underspecified.

---

### BLOCKER #3 — Chunk as field type vs. internal keyed store: the sub-record gap

**What the grilled API says:** Phase 1 step 1 — the field-type plugin contract
declares persistence strategy (`persisted`|`ephemeral`), scope (`entity`|`connection`),
authority (`user`|`server`), mutation operators + diffs, optional `inverse`, optional
`validate`, and a published event-coordinate schema.

**What's missing:** A chunk field is NOT a single scalar value. It is a SPARSE
INTERNAL KEYED STORE: key = `{cx, cy, cz}`, value = 4096-byte compressed voxel
data. The field as a whole has ~4,913 sub-records per world (at render distance 8).
The plugin contract's `scope` enum (entity | connection) and the persistence
strategy (persisted | ephemeral) describe the FIELD'S storage, not the SUB-RECORDS'
storage. Can a custom field type define its own internal indexing strategy?

**Failing code — the gap between field-type and collection:**
```js
// The chunk field holds a keyed internal store. The field plugin must:
// 1. Serialize/diff/delta-sync INDIVIDUAL sub-records, not the whole field.
// 2. Index sub-records by key for O(1) lookup + O(log n) range scan.
// 3. Publish a coordinate schema so subscriber interest can do range scans.
//
// The plugin contract as described (Phase 1 step 1) is designed for single-value
// fields — a field serializes to ONE column, diffs between old/new value, emits
// ONE event. A chunk field's internal store serializes to ONE column (the sparse
// map), but its diffs are PER-KEY ("block at (10,4,-5) changed from stone to dirt")
// and its events are PER-KEY.
//
// Is this the SAME "plugin contract" as a `vector3` field, or does a keyed store
// field need a different contract? The plan doesn't distinguish single-value
// fields from internally-keyed collection fields.

// What the plugin contract needs to express (doesn't):
const chunkPlugin = {
  scope: 'entity',        // persisted, survives connection restart
  persistence: 'persisted',
  authority: 'user',      // players can place blocks

  // [GAP] Internal store — the plugin manages MANY sub-records, not one value.
  // The framework needs to know the sub-record key schema (for interest indexing)
  // and the diff contract (per-key, not whole-field).
  subKey: { cx: 'number', cy: 'number', cz: 'number' },   // [GHOST]
  subValue: { type: 'binary', maxSize: 65536 },            // [GHOST]

  // [GAP] Per-key operators — mutate one chunk at a time, not the whole field.
  operators: {
    setBlock: { authority: 'user', args: { cx, cy, cz, x, y, z, block } },
    fillRegion: { authority: 'user', args: { … } },
  },

  // [GAP] Per-key diff — one block changed, not the whole chunk map.
  diffKey(oldSubRecord, newSubRecord) { /* … */ },

  // Serialize the WHOLE keyed store → persistence.
  serialize(store) { /* → compressed blob of all sub-records */ },
  deserialize(serialized) { /* → sparse keyed store */ },
};
```

**Which part of the plan this tests:** Phase 1 step 1 — the field-type plugin
contract. The contract is sketched for single-value fields but doesn't distinguish
between a scalar field and an internally-keyed collection field. A chunk field
needs the latter; forcing it into the former is the pre-grill `text` abuse
reborn at the plugin level.

---

### SHOULD-FIX #1 — Interest expression language: what operators exist?

**What the grilled API says:** ADR #5 — interest is "a typed constraint expression,
data-not-code, indexable."

**What's missing:** The OPERATOR grammar. Is it range-only (`gte`/`lte`)?
Can it express disjunction ("chunk (0,0,-5) OR chunk (0,0,-6)")? Is it
AND-only ("cx IN 0..15 AND cz IN -7..7")? The indexability constraint
implies range-comparable operators, but which ones?

```js
// These all produce indexable range scans. Are they all supported?
interest: {
  chunks: {
    cx: { gte: 0, lte: 15 },         // range
    cz: { in: [-7, -6, -5] },        // discrete set
    // cy: { eq: 0 },                 // exact match (redundant: range [0,0])
  },
}

// What about multi-key intersection? "Chunks where cx=0 AND cz=-5 OR cx=1 AND cz=-5"
// — this is not a single range per dimension; it's a Cartesian subset. The grammar
// must decide: AND-only per dimension (no OR across dimensions) or full expression?
// AND-only is indexable (composite index on (cx, cz)); OR introduces union queries.
```

**Which ADR this tests:** ADR #5 — "indexable" constrains the operator set, but
the set is unspecified.

---

### SHOULD-FIX #2 — Per-subscriber backpressure on the block-delta firehose

**What the grilled API says:** ADR #5 — re-auth at emit, latched for scale.
Subscription delivery is indexed range scans against dirty chunks.

**What's missing:** 100 players × 20Hz position updates × per-player events
= a firehose. The grilled design addresses SCALE of re-auth (latched = cache check,
not full re-eval) but says NOTHING about per-subscriber backpressure. A slow
client on a mobile connection receives the same event stream as a fast client —
no adaptive rate limiting, no per-subscriber queue depth, no priority class. The
plan defers "RPC/intent vs mutation" (P2) but doesn't touch event priority or
backpressure at all.

```js
// The framework needs per-subscriber queue management — NOT in the entity
// declaration, but in the WS delivery engine. The grilled design is silent.

// What a per-subscriber backpressure config might look like (doesn't exist):
subscribe({
  entity: World,
  id: worldId,
  interest: { … },
  // [GHOST] per-subscriber delivery config:
  backpressure: {
    maxQueueDepth: 200,           // drop oldest events when queue fills
    throttle: { maxPerSecond: 60 }, // drop above 60 events/sec
    priority: {
      'chunks:changed:block': 'high',   // block edits are critical
      'position:changed': 'low',        // position is loss-tolerant
    },
  },
});
```

**Which ADR/design feature this tests:** ADR #5 — live delivery with latched
auth addresses the AUTH scale problem but not the NETWORK scale problem.

---

### SHOULD-FIX #3 — Tick lifecycle binding: state-bound vs. continuous

**What the grilled design says:** Phase 2 step 9 — entity-level `tick` is
"lifecycle-bound to `state` transitions." Phase 1 step 4 — `state.auto` is
field-level conditional scheduled mutation ("when `shared` for 90 days, 
auto-archive").

**What's missing:** These are two different mechanisms:
- `state.auto` = conditional one-shot timer (doc idle for 90d → archive)
- entity `tick` = continuous recurring timer at fixed Hz (game loop always runs)

Phase 2 step 9 says tick is "lifecycle-bound to `state` transitions" — this
doesn't fit a Minecraft world. A world has no lifecycle state; it's running from
creation to deletion. Binding tick to a `state` field forces adding a synthetic
`state` field that never transitions, just to host the tick lifecycle. That's
a framework leak.

```js
// The plan conflates these two shapes. They need to be DISTINCT:

// Shape A: state.auto (Phase 1 step 4) — conditional one-shot.
state({
  auto: { when: 'shared', after: '90d', to: 'archived' }
})

// Shape B: entity.tick (Phase 2 step 9) — CONTINUOUS recurring.
// Must NOT require a state field to host it. The tick lifecycle is:
//   start → running → stop
// Not:
//   state=active → tick → state=paused → no tick
//
// If the framework REQUIRES a state field for tick lifecycle, it forces every
// real-time entity to model its uptime as a state machine, which is wrong.
tick: {
  rate: 20,
  // Lifecycle: starts when entity is first persisted, stops on entity delete.
  // NOT bound to a state value.
  handler: async (world) => { /* … */ },
},
```

**Which design features this tests:** Phase 2 step 9 vs. Phase 1 step 4 — the
tick design conflates one-shot scheduled mutation with continuous recurring
mutation. A game loop is the latter.

---

### SHOULD-FIX #4 — Partial-load protocol for spatially-scrolled data

**What the grilled API says:** `r.resource()` auto-generates CRUD. `findAll`
with field-handle predicates is indexed.

**What's missing:** A Minecraft join is not "load the World entity." It's
"load chunks progressively as the player moves." This is a PARTIAL-LOAD
PROTOCOL: the client says "I now need chunks in region R" and receives initial
data + starts receiving deltas for those chunks via the interest-filtered
subscribe. When the player moves to region R', the client (or server) detects
which chunks ENTERED and which LEFT the viewport, loads new chunks, and unloads
old ones. The plan mentions spatial event SCOPING (Phase 2 step 7) but NOT
spatial initial LOADING.

```js
// What a partial-load endpoint might look like (doesn't exist):
// GET /worlds/:id/chunks?cx=0..15&cy=0..0&cz=-7..7
// → returns chunk data for chunks in the spatial range
//
// This requires the chunk field type to expose a range-query operator.
// The framework would need to know:
//   1. The chunk field's KEY schema ({ cx, cy, cz })
//   2. How to BUILD an indexed range query over the internal store
//   3. How to SERIALIZE results for transport
//
// None of this is in the plugin contract sketch.

// The plugin contract would need a range-query method:
const chunkPlugin = {
  // … existing contract …

  // [GHOST] Range query over the internal keyed store:
  query: {
    byKeyRange: (store, { cx, cy, cz }) => {
      // Return sub-records matching the range. Framework calls this when
      // a client requests chunk data for a spatial region.
    },
  },
};
```

**Which part of the plan this tests:** The plan defers "spatial queries" to
"Deferred / plugin territory" — but spatial partial-load is NOT a query engine
feature; it's a DATA-ACCESS protocol that the field-type plugin must expose.
If it's deferred, every Minecraft client must hand-build a separate chunk-loading
endpoint outside the entity declaration.

---

### SHOULD-FIX #5 — Inventory / keyed-value map over non-ref values

**What the grilled API says:** Phase 1 step 4 — `map(ref('User'), value)` is a
valued keyed set (uniqueness-by-construction). Phase 2 step 12 — `array` plugin.

**What's missing:** A `map` over VALUE types (not entity refs). A player's
inventory is `{ itemType → count }` where `itemType` is a string ("dirt",
"stone_pickaxe") and `count` is a number. This is NOT a set of refs to entity
rows — the items aren't entities. The existing `map` stores ref memberships;
there's no `map(primitiveType, valueType)` variant.

```js
// The existing map(ref('User'), { role: ... }) stores refs to entity rows.
// A Minecraft inventory needs a map over string keys with number values.
// The framework has no first-class type for this.

// What the API should provide (doesn't):
inventory: map(text, number, {           // [GHOST] map over value types
  maxEntries: 36,
  validate: (count, { key }) => {
    const maxStack = ITEM_STACK_SIZES[key] ?? 64;
    return count <= maxStack || `stack overflow for ${key}`;
  },
}),

// Workaround: abuse blob with JSON serialization (the pre-grill text-abuse reborn):
inventory: blob({                             // Phase 2 step 12: blob exists
  validate: (v) => typeof v === 'object',
}),
// → loses per-item-type validation, per-slot access control, typed diff.
```

**Which design feature this tests:** Phase 1 step 4 `map` + Phase 2 step 12
`array`/`blob` — the gap between "valued keyed set of refs" and "keyed-value
map over primitives."

---

### Sharp edge #1 — Position: persisted vs ephemeral duality

A player's position is both persisted (save on disconnect) and high-frequency
(20 updates/sec during play). The grilled API has:
- `persisted` fields → every mutation writes to DB (20 writes/sec/player = disaster)
- `ephemeral` fields → data lost on disconnect (wrong — player should resume where
  they were)

The "ephemeral-with-commit-semantics" pattern (Phase 3 step 16) would solve this —
an `ephemeral` field with a declarative commit-reaction that persists on
disconnect / periodic save. But it's deferred to Phase 3, which means during
Phase 2 (the realtime phase with Minecraft as spine) this pattern doesn't exist.
A Minecraft implementation in Phase 2 would either hammer the DB or lose player
positions.

---

### Sharp edge #2 — Field authority: server-authoritative validation

`vector3` with `authority: 'server'` means the SERVER validates every position
update (anti-cheat speed clamping, no-clip detection). The Phase 1 step 1 plugin
contract reserves `authority` (`user`|`server`) but the validate hook's contract
is underspecified: does `authority: 'server'` mean client-submitted values pass
through `validate()` with rejection on failure? Or does the server compute the
value and the client's submission is ignored?

```js
// The intent: client submits position, server clamps to max speed.
// The validate hook rejects invalid values — but in a game, rejection means
// the client desyncs from server state. The server should AUTHORITATIVELY
// compute the new position, not just reject bad input.

// The plugin contract needs a distinction:
//   authority: 'user'   → validate + accept/reject
//   authority: 'server' → compute (the server owns the value; client input is advisory)
//
// A `compute` hook vs a `validate` hook — the grilled design has only `validate`.
position: vector3({
  authority: 'server',
  // [GHOST] compute hook — server computes the real position:
  compute: (clientInput, { self, world }) => {
    return clampSpeed(clientInput, self.position, MAX_SPEED);
  },
  validate: (newPos) => world.isWithinBounds(newPos) || 'out of bounds',
}),
```

---

## Prior findings re-checked

Each prior finding from the pre-grill PAIN-POINTS.md, re-evaluated against the
grilled ADRs (#1–#7) and the IMPLEMENTATION-PLAN.

| # | Prior finding | Status | Why |
|---|--------------|--------|-----|
| 1 | No custom field type extension | **RESOLVED** | Phase 1 step 1: field-type plugin contract. Custom field types are first-class. |
| 2 | No spatial event scope | **PARTIALLY-RESOLVED** | ADR #5 + Phase 2 step 7: subscriber interest is data-not-code narrowing. RESOLVED for the concept, but the interest expression grammar, subscribe API surface, and field-level-vs-entity-level interest scoping are undesigned gaps (see BLOCKER #1, #2, SHOULD-FIX #1). |
| 3 | No chunk streaming / partial load | **STILL-OPEN** | Spatial event SCOPING (Phase 2 step 7) covers deltas but not initial LOAD. The plan defers spatial queries to "Deferred / plugin territory" and has no partial-load protocol. See SHOULD-FIX #4. |
| 4 | No server tick / game loop | **PARTIALLY-RESOLVED** | Phase 2 step 9: entity-level `tick`. RESOLVED for the concept, but the lifecycle binding ("state transitions") conflates one-shot auto with continuous recurring tick. See SHOULD-FIX #3. |
| 5 | No binary/structured field types | **RESOLVED** | Phase 2 step 12: `blob` + `array` built-in plugins. Plus custom field types (Phase 1 step 1) cover any remaining binary type. |
| 6 | Entity explosion for dense data | **PARTIALLY-RESOLVED** | Custom field types can manage internal keyed stores, avoiding 4,913 entity rows. RESOLVED at the concept level, but the plugin contract doesn't distinguish single-value from internally-keyed-collection fields. See BLOCKER #3. |
| 7 | `presence` wrong for game position | **STILL-OPEN** | No `vector3` in the plan. The `authority` field (user/server) is reserved but the compute-vs-validate distinction is missing. The persisted-vs-ephemeral duality for position isn't solved until Phase 3 step 16. See Sharp edge #1, #2. |
| 8 | No batched multi-field mutation | **RESOLVED** | Phase 2 step 12: batched mutation + `batch()` in load-bearing guards. One composed event. |
| 9 | No field-level `validate` hook | **RESOLVED** | Phase 1 step 5: validate as a pipeline stage. Phase 1 step 1 plugin contract includes `validate(value, ctx)`. |
| 10 | No event priority / backpressure | **STILL-OPEN** | Nothing in the grilled design or implementation plan addresses per-subscriber backpressure, adaptive rate limiting, or event priority classes. See SHOULD-FIX #2. |
| 11 | No entity lifecycle hooks | **PARTIALLY-RESOLVED** | Effects + tick provide some lifecycle behavior declaratively. But explicit `onCreate`/`onDelete` hooks (for procedural terrain generation, cleanup) are not in the plan. Effects run on field mutations, not entity instantiation/deletion. See Sharp edge #3. |
| 12 | No boolean field type | **RESOLVED** | Phase 1 step 4: `boolean` built-in plugin. |
| 13 | `set` stores refs, not values | **RESOLVED** | Phase 2 step 12: `array` plugin. Custom field types cover any remaining value collections. |
| 14 | No structured sub-object field type | **PARTIALLY-RESOLVED** | Phase 2 step 12: `blob` handles nested data. But per-subfield access control, validated schemas, and structured diffs (not whole-blob diffs) are not designed. |
| 15 | No `setOnce` field modifier | **RESOLVED** | Phase 3 step 17: ergonomic modifiers list includes `setOnce`. |

### Additional gap surfaced by the grilled API

| # | New finding | Status | Why |
|---|-----------|--------|-----|
| 16 | Subscribe() API surface | **BLOCKER** | ADR #5 defines interest but no client-facing subscribe call. See BLOCKER #1. |
| 17 | Interest field-level scoping | **BLOCKER** | Can interest scope to specific fields? See BLOCKER #2. |
| 18 | Plugin contract: single-value vs keyed-store | **BLOCKER** | Chunk needs an internally-keyed collection field type. See BLOCKER #3. |
| 19 | Interest operator grammar | **SHOULD-FIX** | What operators exist? Range-only? See SHOULD-FIX #1. |
| 20 | Tick: continuous vs state-bound | **SHOULD-FIX** | Tick lifecycle conflated with state.auto. See SHOULD-FIX #3. |
| 21 | Partial-load protocol | **SHOULD-FIX** | Spatial initial load is undesigned. See SHOULD-FIX #4. |
| 22 | Map over non-ref value types | **SHOULD-FIX** | No keyed-value map over primitives. See SHOULD-FIX #5. |
| 23 | compute vs validate for server-authoritative fields | **Sharp edge** | `authority: 'server'` needs a compute hook, not just validate. See Sharp edge #2. |
| 24 | Entity onCreate/onDelete lifecycle | **Sharp edge** | Effects don't cover entity instantiation/deletion. Procedural terrain generation, cleanup, game loop start/stop need lifecycle hooks. |

---

## Summary

The grilled design is a **substantial improvement** over the pre-grill API:
- The field-type plugin contract (Phase 1 step 1) directly resolves 3 prior blockers.
- Subscriber interest as data-not-code (ADR #5) resolves spatial event scoping at the
  concept level.
- Entity-level tick (Phase 2 step 9) resolves the game-loop problem at the concept level.
- Batched mutation, boolean/blob/array types, and validate-as-pipeline-stage resolve
  5 more prior pain points.

**The remaining gaps cluster around three incompletely-designed surfaces:**

1. **The subscribe API + interest grammar** — the grilled design correctly separates
   re-auth from narrowing interest, but the client-facing invocation surface, the
   interest operator grammar (range? set? AND-only?), and field-level-vs-entity-level
   interest scoping are all underspecified. This is the largest gap.

2. **The field-type plugin contract for internally-keyed stores** — the contract is
   sketched for single-value fields; a chunk field manages thousands of sub-records
   with per-key diffs and per-key indexing. Without this distinction, chunk data is
   forced into whole-field-serialization (the pre-grill `text` abuse at the plugin level).

3. **Per-subscriber backpressure + tick lifecycle clarity** — the grilled design
   addresses AUTH scale (latched) but not NETWORK scale (backpressure). The entity
   tick design conflates one-shot `state.auto` with continuous recurring tick.
