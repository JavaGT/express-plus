// projects/minecraft/chunk-field.mjs — custom field type plugins for a voxel game.
//
// The express-plus built-in field types (text, number, set, presence, log, etc.)
// are designed for collaborative documents: strings, numbers, sets of refs,
// ephemeral cursor positions. A Minecraft clone needs dense binary voxel data,
// batched 3D vectors for high-frequency movement, and keyed inventory maps.
// None of these exist in the built-in catalog.
//
// This file models THREE custom field types and the EXTENSION POINT a developer
// would use to register them. The extension point (`registerFieldType`) is
// ASPIRATIONAL — the current express-plus API has no such mechanism. This file
// SHOWS what the ideal API would look like; every gap is a pain point.
//
// Each custom field type must conform to the framework's field contract:
//   1. Own its storage strategy (serialize / deserialize)
//   2. Own its sync transport (diff / apply for delta sync)
//   3. Own its event emission (declare which events fire on mutation)
//   4. Integrate with the authorization engine (access checks per field)

import { registerFieldType, fieldTypeContract } from 'express-plus';
//            ^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^
//            ASPIRATIONAL — does not exist.       ASPIRATIONAL — does not exist.

// ─── RLE Voxel Compression ───────────────────────────────────────────────────
// Compress a 16×16×16 block array (4096 bytes) into run-length-encoded pairs.
// Each pair is [blockType, runLength]; typical Minecraft terrain (air, stone,
// dirt) compresses to <100 pairs vs 4096 raw bytes — ~50:1 typical.

function rleEncode(blocks) {
  const pairs = [];
  let currentType = blocks[0];
  let run = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i] === currentType) {
      run++;
    } else {
      pairs.push(currentType, run);
      currentType = blocks[i];
      run = 1;
    }
  }
  if (run > 0) pairs.push(currentType, run);
  return new Uint16Array(pairs);
}

function rleDecode(pairs) {
  const blocks = new Uint8Array(4096);
  let offset = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const type = pairs[i];
    const count = pairs[i + 1];
    blocks.fill(type, offset, offset + count);
    offset += count;
  }
  return blocks;
}

// A delta is a sparse list of { index, type } changes.
// Only the blocks that changed are sent over the wire — not the whole chunk.
// The server keeps a version number per chunk; the client sends its last-known
// version, and the server computes what changed since then.

function computeChunkDelta(oldBlocks, newBlocks) {
  const delta = [];
  for (let i = 0; i < 4096; i++) {
    if (oldBlocks[i] !== newBlocks[i]) {
      delta.push({ index: i, type: newBlocks[i] });
    }
  }
  return delta;
}

function applyChunkDelta(blocks, delta) {
  for (const { index, type } of delta) {
    blocks[index] = type;
  }
  return blocks;
}

const EMPTY_CHUNK = new Uint8Array(4096); // all air
const CHUNK_SIZE = 16;

// INDEX helper — 3D coords to flat index (y-major for compression friendliness,
// since Minecraft terrain stacks vertically).
function toIndex(x, y, z) {
  return y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
}

// ─── 1. `chunk()` — Voxel Field Type ────────────────────────────────────────
//
// A field whose value is a 16³ block array, stored RLE-compressed, synced via
// sparse deltas. On mutation, emits `:changed:block` with the delta payload.
//
// This is the cornerstone field: without it, a Minecraft clone can't exist.

const chunkFieldDef = {
  // Required by the framework: what events does a SET emit?
  // `events` is the contract: the framework wires these into the baked-in WS
  // stream AFTER re-authorizing through grant/access/checks.
  events: {
    set: ':changed:block',   // emits delta payload over WS
    get: null,               // reads don't event
  },

  // Initialize a new field value (e.g., on entity creation).
  init({ default: defaultVal }) {
    return defaultVal ? defaultVal : EMPTY_CHUNK;
  },

  // Serialize for persistence. Returns something the framework can store.
  // RLE-encoded Uint16Array → base64 for DB/transport compatibility.
  serialize(blocks) {
    const rle = rleEncode(blocks);
    // Convert to base64 for JSON-safe storage.
    return Buffer.from(rle.buffer).toString('base64');
  },

  // Deserialize from persistence back to live value.
  deserialize(serialized) {
    const buffer = Buffer.from(serialized, 'base64');
    return rleDecode(new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2));
  },

  // Compute a delta: old → new. The framework uses this for the WS payload.
  // Returns a sparse delta object the WS can transmit efficiently.
  diff(oldValue, newValue) {
    return computeChunkDelta(oldValue, newValue);
  },

  // CRDT-style merge (conflict resolution). For chunks: last-write-wins per block
  // is the sensible default — the last-placed/broken block wins.
  merge(baseValue, remoteValue, remoteDelta) {
    if (remoteDelta) return applyChunkDelta(baseValue, remoteDelta);
    return remoteValue; // full overwrite
  },

  // ─── Domain methods (surfaced on the loaded entity's field instance) ─────
  // These are the typed handle methods a route handler calls:
  //   await world.chunks.getBlock(cx, cz, x, y, z)
  //   await world.chunks.setBlock(cx, cz, x, y, z, type)  // → emits event
  methods: {
    getBlock(blocks, x, y, z) {
      return blocks[toIndex(x, y, z)];
    },

    fillRegion(blocks, x1, y1, z1, x2, y2, z2, type) {
      for (let y = y1; y <= y2; y++) {
        for (let z = z1; z <= z2; z++) {
          for (let x = x1; x <= x2; x++) {
            blocks[toIndex(x, y, z)] = type;
          }
        }
      }
    },

    isAir(blocks, x, y, z) {
      return blocks[toIndex(x, y, z)] === 0;
    },
  },
};

// The chunk() constructor a developer uses in their entity field list.
// Options customize compression and dimensions.
function chunk(opts = {}) {
  return {
    type: 'chunk',
    compression: opts.compression || 'rle',
    dimensions: opts.dimensions || CHUNK_SIZE,
    default: () => new Uint8Array(4096),
  };
}

// ─── 2. `vector3()` — Batched 3D Vector Field ───────────────────────────────
//
// Player movement at 20Hz generates position, velocity, and look-vector updates.
// If each axis were a separate `number` field, every tick would emit THREE
// `:changed` events per player per field — noise that destroys the event channel.
//
// A `vector3` is a SINGLE field that owns x/y/z as one unit: one mutation, one
// event, one delta payload. The framework's delta diff compares the whole triple,
// so a player standing still (same triple) emits NOTHING.

const vector3FieldDef = {
  events: { set: ':changed' },

  init({ default: d }) {
    return d ? { ...d } : { x: 0, y: 0, z: 0 };
  },

  serialize(v) { return v; },       // JSON-serializable by construction
  deserialize(v) { return v; },

  diff(oldV, newV) {
    if (oldV.x === newV.x && oldV.y === newV.y && oldV.z === newV.z) return null;
    return newV;
  },

  merge(base, remote) { return remote; },

  // Server-side VALIDATION hook: runs before the value is persisted. This is
  // where anti-cheat lives: clamp speed, reject no-clip positions, validate
  // against world collision data.
  //
  // PAIN POINT: the current express-plus field model has no `validate` hook.
  // Validation must live in route handlers, which breaks "declaration absorbs
  // imperative wiring" — every route that mutates position must remember to
  // call the same validation logic.
  validate(newValue, context) {
    // context provides: { entity (the loaded Player), world (lookup by ref),
    //   previousValue, user (who is making the mutation) }
    //
    // Example anti-cheat: no movement faster than 1.5 blocks/tick.
    const world = context.world;
    const prev = context.previousValue;
    const dx = Math.abs(newValue.x - prev.x);
    const dy = Math.abs(newValue.y - prev.y);
    const dz = Math.abs(newValue.z - prev.z);
    const maxSpeed = 1.5;
    return dx <= maxSpeed && dy <= maxSpeed && dz <= maxSpeed;
  },

  methods: {
    distance(from, to) {
      return Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2 + (to.z - from.z) ** 2);
    },
  },
};

function vector3(opts = {}) {
  return {
    type: 'vector3',
    components: opts.components || ['x', 'y', 'z'],
    default: opts.default || { x: 0, y: 64, z: 0 },
  };
}

// ─── 3. `inventory()` — Keyed Item-Stacks Field ─────────────────────────────
//
// A player's inventory maps item-type IDs to counts, with stack-size limits.
// `set(ref('ItemType'))` doesn't fit — it stores refs, not counts, and has no
// notion of quantity or stacking. A `number` field per item type doesn't scale.
//
// `inventory` is a MAP field: { itemTypeId → count }. On mutation it emits a
// slot-level delta (which items changed and by how much), not the whole map.

const MAX_STACK = 64;

const inventoryFieldDef = {
  events: { set: ':changed:slot' },

  init({ default: d }) {
    return d ? { ...d } : {};
  },

  serialize(inv) { return inv; },
  deserialize(inv) { return inv; },

  diff(oldInv, newInv) {
    const changed = {};
    for (const item of new Set([...Object.keys(oldInv), ...Object.keys(newInv)])) {
      if ((oldInv[item] || 0) !== (newInv[item] || 0)) {
        changed[item] = newInv[item] || 0;
      }
    }
    return Object.keys(changed).length > 0 ? changed : null;
  },

  merge(base, remote) { return remote; },

  methods: {
    add(inv, itemType, count) {
      const current = inv[itemType] || 0;
      const newCount = Math.min(current + count, MAX_STACK);
      inv[itemType] = newCount;
      return newCount;
    },

    remove(inv, itemType, count) {
      const current = inv[itemType] || 0;
      if (current < count) return false;
      const newCount = current - count;
      if (newCount === 0) { delete inv[itemType]; } else { inv[itemType] = newCount; }
      return true;
    },

    has(inv, itemType, count) {
      return (inv[itemType] || 0) >= count;
    },

    count(inv, itemType) {
      return inv[itemType] || 0;
    },

    slots(inv) {
      return Object.keys(inv).length;
    },
  },
};

function inventory(opts = {}) {
  return {
    type: 'inventory',
    maxSlots: opts.maxSlots || 36,
    maxStack: opts.maxStack || MAX_STACK,
    default: opts.default || {},
  };
}

// ─── 4. `worldSeed()` — Immutable Seed Number ───────────────────────────────
//
// A world's seed is set at creation time and never changes. The built-in
// `number` field can express this, but it emits `:changed` on write — which
// shouldn't be possible for an immutable field. A seed field that REJECTS
// writes after creation would be self-documenting.
//
// Actually: `number({ readonly: true, default: () => generateSeed() })` handles
// this perfectly. No custom field needed — just flagging that the built-in
// covers this case.

// ─── 5. REGISTERING CUSTOM FIELD TYPES ──────────────────────────────────────
//
// The extension point. A developer registers their field types ONCE at app
// startup. The framework validates each against the field-type contract
// (serialize/deserialize/diff/merge/events) and rejects invalid registrations.
// After registration, `chunk()`, `vector3()`, and `inventory()` are first-class
// field types — usable in ANY entity's `fields` block, integrated with the
// framework's event stream, persistence layer, and authorization engine.
//
// ASPIRATIONAL: `registerFieldType` does not exist in the current API.
// There is NO extension point for custom field types. Every field type is
// built-in and hardcoded. This is the #1 BLOCKER for non-document domains.

// Ideal API:
//   registerFieldType('chunk', chunkFieldDef);
//   registerFieldType('vector3', vector3FieldDef);
//   registerFieldType('inventory', inventoryFieldDef);
//
// The framework would:
//   1. Validate the def against fieldTypeContract (must have serialize,
//      deserialize, diff, merge, events at minimum).
//   2. Wire the type into the entity field parser — `chunk()` in a fields block
//      is now a recognized type that produces a fully integrated field.
//   3. Integrate delta sync: framework calls diff(old, new) and sends the result
//      over the WS stream for live subscribers.
//   4. Integrate persistence: framework calls serialize/deserialize when
//      reading/writing to the data store.
//   5. Integrate authorization: field-level `access` works the same — `is`
//      and `defaults` are passed in; the field type doesn't need to know auth.

// Since registerFieldType doesn't exist, we emulate it for the exemplar:

const registry = new Map();

function registerFieldType(name, def) {
  // Validate contract
  const required = ['events', 'init', 'serialize', 'deserialize', 'diff', 'merge'];
  for (const key of required) {
    if (!def[key]) {
      throw new Error(`Custom field type "${name}" missing required method: ${key}`);
    }
  }
  registry.set(name, def);
}

// Register our types (this is what the framework SHOULD do natively):
registerFieldType('chunk', chunkFieldDef);
registerFieldType('vector3', vector3FieldDef);
registerFieldType('inventory', inventoryFieldDef);

export { chunk, vector3, inventory, registerFieldType, registry };

// Also export raw defs so the framework extender can subclass/customize them:
export { chunkFieldDef, vector3FieldDef, inventoryFieldDef };
