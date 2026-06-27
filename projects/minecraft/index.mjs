// projects/minecraft/index.mjs — reactive entities for a Minecraft-style voxel world.
//
// Three entities, additive in complexity:
//   Player — position, velocity, look, inventory, health. Custom `vector3` and
//            `inventory` fields own the batched/high-frequency mutations.
//   World  — name, seed, game rules, players, chunks. Custom `chunk` field owns
//            sparse voxel storage, RLE compression, and delta sync.
//   Block  — NOT an entity. A block is a VALUE inside a chunk field. Trying to
//            make every block a standalone entity would create 4,096 entities
//            per chunk × thousands of chunks = entity explosion. The framework's
//            `entity()` constructor is the WRONG abstraction for sub-document
//            granularity — it forces a CRUD route + route gate + grant eval on
//            every row, which is catastrophic for dense spatial data.
//
// NOTE: `registerFieldType` and the custom field constructors (`chunk()`,
// `vector3()`, `inventory()`) are ASPIRATIONAL — the current express-plus API
// has no field-type extension point. See ./chunk-field.mjs and PAIN-POINTS.md.

import { entity, text, number, ref, set, presence, log, date, hash,
          grant, deny, hide,
          read, write, subscribe, admin } from 'express-plus';
import { chunk, vector3, inventory } from './chunk-field.mjs';

// ─── Player ─────────────────────────────────────────────────────────────────
//
// A player entity owned by the player's User. Position, velocity, and look are
// `vector3` fields — one mutation per update instead of 3–9 individual number
// mutations. Inventory is a keyed item-stack map.
//
// PAIN POINT: Movement at 20Hz means the server receives 20 position mutations
// per second per player. Each mutation goes through: route gate → param bind →
// grant eval → field access → serialize → event emit. The framework has no
// concept of a "fast-path" or "batched mutation channel." The WS stream that
// carries chunk deltas and inventory changes also carries all position updates
// — noisy, no prioritization, no backpressure.
//
// PAIN POINT: `presence` is the WRONG field type for game position. `presence`
// is ephemeral (WS-layer only, not persisted) and connection-scoped (dies on
// disconnect). Game position MUST be persisted so players resume where they
// logged out. Using `presence` for game position is a category error — it was
// designed for collaborative-doc cursors, not world-space coordinates.

const Player = entity('Player', {
  fields: {
    // Position in world space. Custom `vector3` type — one mutation, one event,
    // one delta payload. Three `number` fields would emit three :changed events
    // per tick, each requiring its own grant/access evaluation.
    position:  vector3({ default: { x: 0, y: 64, z: 0 } }),

    // Velocity (movement direction × speed). Separate from position because
    // server-side physics applies velocity to position each tick. Also a
    // `vector3` — batched, same rationale.
    velocity:  vector3({ default: { x: 0, y: 0, z: 0 } }),

    // Look direction: yaw (horizontal), pitch (vertical). Two-component vector;
    // the third component is unused but vector3 is the closest available type.
    look:      vector3({ default: { x: 0, y: 0, z: 0 } }),

    // Health: 0–20 (10 hearts). Built-in `number` handles this perfectly.
    health:    number({ default: 20, min: 0, max: 20 }),

    // Food/saturation.
    food:      number({ default: 20, min: 0, max: 20 }),

    // Named dimension the player is in (overworld, nether, end).
    dimension: text({ default: 'overworld' }),

    // Inventory: keyed map of itemType → count. Custom `inventory` field type —
    // the built-in `set(ref('ItemType'))` stores membership, not quantities.
    // A `number` field per item type doesn't scale past a dozen items.
    inventory: inventory({ maxSlots: 36 }),

    // Hotbar: subset of inventory items, ordered array of references.
    // PAIN POINT: no ordered-list field type. `set` is unordered and set-valued.
    // The closest approximation is a text field with comma-separated IDs and
    // hand-written parse/validate — leaky, not type-safe.
    hotbar:    text({ default: '' }),

    // The world this player is currently in.
    currentWorld: ref('World'),

    // FK to the User account. `role: owner` marks ownership; framework
    // auto-derives the default grant (owner ⇒ all) and `checks.owner`.
    owner:     ref('User', { role: owner, readonly: true }),

    createdAt: date({ default: () => new Date(), readonly: true }),
    updatedAt: date({ touch: true, readonly: true }),
  },

  grant: async ({ is }) => {
    // Player owner gets full access to their own player data.
    if (is.owner()) return grant(read, write, subscribe, admin);
    // Other players on the same world can read position/look (for rendering)
    // but cannot write (anti-cheat).
    // PAIN POINT: per-field access at the grant level is all-or-nothing.
    // A non-owner should be able to READ position, velocity, look but NOT
    // write them, and should NOT read inventory. The framework requires this
    // to be expressed as per-field `access` on every field — repetitive and
    // error-prone when 4 out of 12 fields need the same override.
    return hide();
  },
});

// ─── World ──────────────────────────────────────────────────────────────────
//
// A World owns chunks (dense voxel data), players (connected set), and game
// rules. Block placement/breaking mutates a chunk and auto-emits a delta event
// for all subscribed players whose loaded-chunk radius includes that chunk.
//
// PAIN POINT: The framework's event model broadcasts to ALL subscribers of the
// entity. For a voxel world, ONLY players near the mutated chunk should receive
// the delta. There is no SPATIAL SCOPE concept in the event fan-out — every
// `subscribe` holder gets every chunk delta, which is a bandwidth disaster.
// The workaround is a spatial routing layer OUTSIDE the framework, which
// defeats "nothing lives outside the entity."
//
// PAIN POINT: The `chunks` field is a SINGLE custom field that internally
// manages a sparse key-value store of (cx,cy,cz → chunk data). The framework's
// entity model has no concept of a "collection field" — `set` stores refs to
// OTHER entities, not inline data. If we created a `Chunk` entity, we'd have
// thousands of entities each with its own CRUD route, route gate, and grant eval
// — prohibitive overhead. The custom field is a workaround for the framework's
// inability to model sub-document collections.

const World = entity('World', {
  fields: {
    name:      text({ max: 100, default: 'New World' }),

    // Seed for world generation. Set once, never changed.
    seed:      number({ readonly: true }),

    // Game rules: difficulty, game mode, pvp toggle, etc.
    // PAIN POINT: no structured sub-object field type. Game rules are a nested
    // object (difficulty, gameMode, pvp, spawnMonsters, etc.) but the framework
    // has no JSON/document field type. Using one `text` per rule explodes the
    // field count; using one `text` with JSON encoding loses type safety and
    // per-rule access control. A `json` or `struct` field type is missing.
    difficulty: text({ default: 'normal' }),      // peaceful|easy|normal|hard
    gameMode:   text({ default: 'survival' }),     // survival|creative|adventure|spectator
    pvp:        number({ default: 1 }),             // 0=off, 1=on (could be boolean — no bool type)

    // The voxel data. One custom `chunk` field that internally stores a sparse
    // 3D grid of chunk-voxel data. Methods:
    //   await world.chunks.getBlock(cx, cy, cz, x, y, z)
    //   await world.chunks.setBlock(cx, cy, cz, x, y, z, type)
    // Mutation emits ChunkDelta over WS for nearby subscribers.
    chunks:    chunk({ compression: 'rle', dimensions: 16 }),

    // Connected players. `set` of refs to Player entities.
    // PAIN POINT: `set` emits :added:<id> / :removed:<id> for every player
    // join/leave. In a game with hundreds of connected players, each join
    // generates an event for EVERY subscriber — not just nearby players.
    // The framework has no spatial or rate-limited event fan-out.
    players:   set(ref('Player')),

    // Whitelist: who can join this world.
    whitelist: set(ref('User')),

    owner:     ref('User', { role: owner, readonly: true }),
    createdAt: date({ default: () => new Date(), readonly: true }),
  },

  checks: {
    owner:    ({ entity, user }) => entity.owner === user.id,
    // A whitelisted user can join
    canJoin:  ({ entity, user }) => entity.whitelist.has(user.id),
  },

  grant: async ({ is }) => {
    if (is.owner()) return grant(read, write, subscribe, admin);
    // Connected players can subscribe to chunk updates
    // PAIN POINT: This grants subscribe to ALL events, including chunk deltas
    // for chunks the player isn't near. There's no per-subscription spatial
    // filter in the framework's grant model.
    if (await is.canJoin()) return grant(read, subscribe);
    return hide();
  },

  // Routes: basic CRUD for world management.
  routes: (r, World) => {
    r.resource();

    // ─── JOIN endpoint ───────────────────────────────────────────────────
    // A player joins a world → added to players set, spawn position set.
    // PAIN POINT: The join handshake (load nearby chunks, set spawn point,
    // subscribe to chunk deltas for loaded area) is a multi-step process that
    // doesn't fit a single REST endpoint. The client needs a CHUNK STREAMING
    // protocol: "I joined at position (x,y,z) with render distance 8 → send
    // me those 4,096 chunks, then keep me live-updated on their deltas."
    // The framework's model is: one WS stream for entity events, no spatial
    // filtering, no batch-load protocol. This is a full protocol gap.
    r.post('/:worldId/join', async (req, res) => {
      const world = req.world;
      const player = await Player.findOne(Player.owner.is(req.user.id));
      if (!player) return res.sendStatus(404);

      if (!await world.canJoin(req.user)) {
        return res.status(403).json({ error: 'not whitelisted' });
      }

      // Set spawn position (server-assigned).
      // PAIN POINT: `number` field writes emit :changed events.
      // Setting position, velocity, AND look on join would emit 3 events
      // for what should be one atomic initialization.
      player.position = world.spawnPoint;
      player.currentWorld = world.id;

      await world.players.add(player.id);

      // PAIN POINT: The client now needs its loaded chunks. There's no API
      // for "send me chunks in radius R around position P." The framework
      // was designed for docs where the entire document loads via REST, then
      // deltas stream via WS. A voxel world is SPATIALLY SCROLLING — you
      // constantly load/unload chunks as the player moves. This is a
      // fundamentally different data-access pattern.
      res.json({ joined: true, world: world.id, player: player.id });
    });

    // ─── BLOCK edit endpoint ─────────────────────────────────────────────
    // A player places or breaks a block. The mutation auto-emits a delta event.
    r.put('/:worldId/block/:cx/:cy/:cz/:x/:y/:z', async (req, res) => {
      const world = req.world;
      const { cx, cy, cz, x, y, z } = req.params;
      const blockType = req.body.type; // 0 = air (break), non-zero = place

      // PAIN POINT: No server-side VALIDATION hook on the chunk field.
      // Validation (is the player within reach range? does the player have
      // the item in their inventory?) must be hand-written in every route
      // that mutates chunk data. The field declaration should own this.
      const player = await Player.findOne(Player.owner.is(req.user.id));
      if (!player) return res.sendStatus(404);

      // TODO: validate player is within reach range of (cx*16+x, cy*16+y, cz*16+z)
      // TODO: if placing, check player inventory has the block item
      // TODO: if breaking, award the block item to player inventory

      // PAIN POINT: The chunk field's .getBlock/.setBlock methods live on the
      // LOADED field instance (world.chunks), NOT on the entity class. But the
      // custom field's sparse internal storage (which chunk at cx,cy,cz?) is
      // ALSO on the loaded instance. The API boundary is unclear: does
      // `world.chunks.setBlock(0, 0, 0, 5, 10, 5, 'stone')` mutate one block or
      // load/create a chunk? The custom field type has to paper over all of this.
      await world.chunks.setBlock(cx, cy, cz, x, y, z, blockType);

      res.json({ placed: blockType, at: { cx, cy, cz, x, y, z } });
    });
  },
});

// ─── TICK — the missing server game loop ────────────────────────────────────
//
// PAIN POINT: The express-plus paradigm is "everything is a field mutation;
// events derive from field mutations." A server game tick doesn't fit this
// model. Physics (gravity, water flow), mob AI, hunger decay, crop growth —
// these are SYSTEM BEHAVIORS that run on a timer, not field mutations triggered
// by user action.
//
// Where does the game loop live?
//   Options evaluated:
//   1. A TICK field on the World entity (inverted: the field drives the loop,
//      the loop drives the field — circular and nonsensical).
//   2. A `setInterval` in the route handler (leaks framework boundary;
//      route handler lifetimes don't match the world's lifetime).
//   3. An app-level `setInterval` in app.mjs (breaks the entity — the entity
//      no longer owns its own behavior).
//   4. A `loop` config key on the entity (does not exist — would need to be
//      added as a new API construct).
//
// None of these is clean. The framework was designed for event-driven docs
// where mutations are externally originated (user types, user shares). A game
// loop with 20Hz physics is self-driven mutation — a fundamentally different
// mutation source that the framework's declarative model cannot express.
//
// This is exported as a SEPARATE function — it lives outside the entity because
// there's nowhere INSIDE the entity for it to live.

function startGameLoop(world, intervalMs = 50) {
  // Leaky: setInterval lives at module scope, not framework-managed.
  // No framework shutdown hook cleans this up.
  // No framework tick rate control or drift compensation.
  const id = setInterval(async () => {
    // Process player movement: apply velocity to position, check collision,
    // broadcast validated positions to nearby players.
    const connectedPlayers = await world.players.toArray();

    for (const player of connectedPlayers) {
      // Apply velocity to position
      // PAIN POINT: Reading then writing position is two separate field
      // operations — they don't happen atomically. Between read and write,
      // another tick or route handler could modify position.
      const pos = player.position;
      const vel = player.velocity;

      const newPos = {
        x: pos.x + vel.x * (intervalMs / 1000),
        y: pos.y + vel.y * (intervalMs / 1000),
        z: pos.z + vel.z * (intervalMs / 1000),
      };

      // TODO: collision check against world chunks (expensive — O(chunks))
      // TODO: gravity (y -= 9.8 * dt)
      // TODO: water/lava physics
      // TODO: mob AI
      // TODO: hunger decay
      // TODO: crop growth

      // This write triggers a :changed event on the vector3 field.
      // At 20Hz per player × N players → N*20 events/second just for position.
      // With 100 players: 2000 position events/second + inventory events +
      // chunk delta events → the WS stream is overloaded.
      // PAIN POINT: No event priority or rate-limiting in the framework.
      // Position updates at 20Hz should be rate-limited per subscriber
      // (send at most 5/sec to distant players, 20/sec to nearby).
      player.position = newPos;
    }
  }, intervalMs);

  return id;
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { Player, World, startGameLoop };
</｜DSML｜parameter>