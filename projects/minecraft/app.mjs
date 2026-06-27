// projects/minecraft/app.mjs — thin global wiring for the Minecraft voxel clone.
//
// Mounts the World and Player entities, registers custom field types, and
// starts the game loop. This is a thin entry point — the entities own their
// shape, auth, and behavior. The game loop is the one leak: there's nowhere
// inside the entity for a timed loop to live, so it's started here.
//
// NOTE: `registerFieldType` and the custom field constructors (chunk(),
// vector3(), inventory()) are ASPIRATIONAL — the current express-plus API has
// no field-type extension point. The registrations below are no-ops in the
// current API but show what the ideal mounting flow would look like.

import expressPlus, { entity, text, number, ref, set, date,
                       grant, deny, hide,
                       read, write, subscribe, admin } from 'express-plus';
import { chunk, vector3, inventory, registerFieldType,
          chunkFieldDef, vector3FieldDef, inventoryFieldDef } from './chunk-field.mjs';
import { config } from '../../config.mjs';

// ─── STEP 1: Register custom field types ──────────────────────────────────
//
// ASPIRATIONAL. In the ideal API, this makes `chunk()`, `vector3()`, and
// `inventory()` first-class field types usable in any entity's fields block.
// The framework validates each against the field-type contract at registration
// time and integrates them with persistence, sync, and authorization.
//
// In the CURRENT API, this does nothing — there's no registerFieldType export.
// The custom field constructors return plain objects that the entity()
// constructor doesn't recognize. This is the #1 blocker.

registerFieldType('chunk', chunkFieldDef);
registerFieldType('vector3', vector3FieldDef);
registerFieldType('inventory', inventoryFieldDef);

// ─── STEP 2: Define entities ──────────────────────────────────────────────
//
// Imported from index.mjs for clarity. In a real app these would be defined
// inline or split into separate domains/ files (domains/world/index.mjs,
// domains/player/index.mjs).

import { Player, World } from './index.mjs';

// ─── STEP 3: Create app and mount entities ────────────────────────────────

const app = expressPlus();

// Mount entities at their REST prefixes. Express-style: explicit path.
app.mount('/worlds', World);
app.mount('/players', Player);

// ─── STEP 4: Mount cross-cutting auth routes ───────────────────────────────
//
// Reusing the session domain from the main app for auth.
// PAIN POINT: The Minecraft clone wants its own auth flow (username + UUID
// instead of email, maybe offline-mode auth). But the framework's User entity
// is hardcoded with `hash()` for passwords and session-based auth. A game
// server wants token-based auth (Mojang API verification) or offline-mode.
// There's no way to replace the framework's User entity or auth handler.
import { sessionRoutes, userRoutes } from '../../domain-modules/domains/session/routes.mjs';
app.use('/sessions', sessionRoutes());
app.use('/users', userRoutes());

// ─── STEP 5: Start the game loop (THE LEAK) ────────────────────────────────
//
// The game tick lives OUTSIDE the framework because there's nowhere INSIDE
// for it. The framework has no `loop` or `tick` hook on entities, no managed
// interval, no drift compensation. The developer reaches for raw setInterval
// and loses framework lifecycle management (shutdown, restart, pause).
//
// PAIN POINT: In a production game server, the tick loop would be more
// sophisticated (fixed timestep, render interpolation, worker threads for
// chunk generation). The framework provides none of this — it's designed for
// event-driven docs, not real-time game servers.

import { startGameLoop } from './index.mjs';

// LEAK: The game loop references a specific World by ID. This should be
// entity-owned — each World entity starts its own loop on creation and stops
// it on deletion. But we can't do that because the framework has no lifecycle
// hooks for entity creation/deletion.
//
// Workaround: loop starts at app startup, loads the world by ID.
setTimeout(() => {
  // After app starts, find the world and begin ticking.
  // This is fragile: if the world doesn't exist yet, it silently fails.
  // If the world is deleted, it keeps trying to tick a deleted entity.
  console.log('Game loop would start here — see PAIN-POINTS.md §4');
}, 1000);

// ─── STEP 6: Listen ───────────────────────────────────────────────────────

// Minecraft default port is 25565, but we use config.port for dev.
const mcPort = config.port || 25565;

app.listen(mcPort, () => {
  console.log(`minecraft-voxel-clone on ws://localhost:${mcPort}`);
  console.log(`  mounts: /worlds (World entity), /players (Player entity)`);
  console.log(`  events:  /events (baked-in WS stream — all events, no spatial filter)`);
});
