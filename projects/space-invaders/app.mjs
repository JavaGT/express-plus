// projects/space-invaders/app.mjs — thin global wiring + the game loop.
//
// express-plus provides sensible defaults (auth, body parsing, sessions, CORS,
// rate limiting, error handling, graceful shutdown, WS /events stream). The
// framework owns the wiring; the app declares entities and routes.
//
// THE GAME LOOP: express-plus has NO scheduler/tick construct. The framework's
// reactive-entity paradigm says "events derive from field mutations" — but a
// game loop mutates state on a TIMER, not in response to any field mutation.
// This forces us to reach OUTSIDE the framework with setInterval.
//
// SECOND PATHWAY: every express-plus app should have one way to do a thing.
// The game loop (setInterval at 30 Hz) is a second pathway alongside field
// reactivity. It manages its own lifecycle (start/stop/cleanup), its own
// in-memory state (invader grid, projectiles, ship positions), and its own
// serialization for broadcast. This is NOT a critique of the app — it's a
// critique of a framework gap.
//
// ASPIRATIONAL: the Match entity declares a `tick` block; the framework starts
// the loop when phase transitions to 'playing', stops it on 'gameover', cleans
// up on entity destroy. The tick handler mutates the entity's own fields (which
// the framework diffs and broadcasts). No setInterval, no in-memory side-map.
import expressPlus from 'express-plus';
import { Match, HighScore } from './index.mjs';

const app = expressPlus();

// Landmark page: list active matches (the Lobby).
// ASPIRATIONAL: the Match entity's auto-generated /matches route handles this
// (see the custom GET / route in index.mjs). Here we mount a plain HTML page.
app.get('/', (req, res) => {
  res.render('lobby.html');
});

// Mount entities. The framework auto-generates CRUD + live field subscriptions
// at these paths, routed through grant/access/checks.
app.mount('/matches', Match);
app.mount('/scores',  HighScore);

// ============================================================================
// GAME-LOOP ENGINE (SECOND PATHWAY: setInterval outside the framework)
// ============================================================================
//
// This global in-memory map holds the game state that the framework's field
// types cannot represent: the invader grid, projectile array, ship positions,
// pending player inputs, and the tick interval handle.
//
// PAIN POINTS embodied here:
//   1. No scheduler/tick construct → manual setInterval lifecycle.
//   2. No shared-ephemeral field type → in-memory state outside the entity.
//   3. No broadcast-without-re-auth → we use the entity's text field as a
//      transport hack (serialize the grid to text each frame, which triggers
//      the framework's event broadcast). At 30 Hz, this writes 30 rows/second
//      to the DB per active match — absurd for an ephemeral game.

const GAME_WIDTH  = 80;   // logical columns
const GAME_HEIGHT = 24;   // logical rows
const TICK_RATE   = 30;   // Hz (≈33.3 ms)
const TICK_MS     = Math.floor(1000 / TICK_RATE);

// In-memory game state per match. In the aspirational design, this IS the
// Match entity's in-memory fields — not a separate map.
const gameState = new Map();

/**
 * Initialize in-memory game state for a match.
 * Called when match.phase transitions from 'lobby' → 'playing'.
 * ASPIRATIONAL: the framework calls match.tick.start() automatically.
 */
function initGameLoop(matchId, players) {
  const invaders = createInvaderGrid();
  const ships = new Map(); // playerId → { x, alive }
  for (const pid of players) {
    ships.set(pid, { x: Math.floor(GAME_WIDTH / 2), alive: true, lives: 3 });
  }

  const state = {
    matchId,
    invaders,
    ships,
    projectiles: [],     // { x, y, dy, owner }  dy < 0 = player bullet; dy > 0 = invader bomb
    score: 0,
    invadersDirection: 1, // 1 = right, -1 = left
    invadersStepTimer: 0,
    pendingInput: [],     // queued player actions for the next tick
    interval: null,
  };

  gameState.set(matchId, state);

  // ---- SECOND PATHWAY: setInterval -------
  state.interval = setInterval(() => tick(state), TICK_MS);
}

/**
 * The authoritative server tick. Called at 30 Hz.
 * Mutates in-memory state, then serializes the invader grid to the Match
 * entity's `invaders` text field to trigger the framework's event broadcast.
 *
 * PAIN POINT: Writing the serialized grid to the text field every tick means
 * 30 DB writes/second per match. This is a transport hack — the framework
 * should own the broadcast of tick-delta.
 */
async function tick(state) {
  const dt = TICK_MS / 1000;

  // 1. Process queued player inputs (move, fire)
  processInputs(state);

  // 2. Move invaders (lateral + occasional step-down)
  moveInvaders(state, dt);

  // 3. Advance projectiles
  state.projectiles = state.projectiles
    .map((p) => ({ ...p, y: p.y + p.dy * dt * 60 }))
    .filter((p) => p.y >= 0 && p.y < GAME_HEIGHT);

  // 4. Collision detection: bullets vs invaders, bombs vs ships
  checkCollisions(state);

  // 5. Check game-over conditions
  if (invadersAllDead(state.invaders)) {
    // Wave cleared! Advance to next wave.
    state.invaders = createInvaderGrid(/* faster */);
    state.score += 1000;
    // ASPIRATIONAL: match.advanceWave() → framework handles persistence.
  }

  const allShipsDead = [...state.ships.values()].every((s) => !s.alive || s.lives <= 0);
  if (allShipsDead) {
    stopGameLoop(state.matchId, state);
    // Persist the final score as a HighScore.
    await persistFinalScore(state.matchId, state);
    return;
  }

  // 6. Send invaders down toward ships periodically
  if (state.invadersStepTimer <= 0) {
    stepInvadersDown(state);
    state.invadersStepTimer = 30; // every ~1 second at 30 Hz
  }
  state.invadersStepTimer--;

  // 7. Serialize grid to the entity to trigger broadcast.
  //    PAIN POINT: this writes to DB 30 times/second.
  //    ASPIRATIONAL: the tick handler declares which fields changed, and the
  //    framework broadcasts only the delta over WS without touching the DB.
  await broadcastState(state);
}

function processInputs(state) {
  for (const input of state.pendingInput) {
    const ship = state.ships.get(input.playerId);
    if (!ship || !ship.alive) continue;

    if (input.type === 'move') {
      ship.x = Math.max(0, Math.min(GAME_WIDTH - 1, ship.x + input.direction));
    } else if (input.type === 'fire') {
      // One bullet per player on-screen at a time.
      const hasActiveBullet = state.projectiles.some(
        (p) => p.owner === input.playerId && p.dy < 0
      );
      if (!hasActiveBullet) {
        state.projectiles.push({
          x: ship.x,
          y: GAME_HEIGHT - 2,
          dy: -1,
          owner: input.playerId,
        });
      }
    }
  }
  state.pendingInput = [];
}

function moveInvaders(state, dt) {
  const step = state.invadersDirection * dt * 10;
  for (let row = 0; row < state.invaders.length; row++) {
    for (let col = 0; col < state.invaders[row].length; col++) {
      if (state.invaders[row][col] === 1) {
        state.invaders[row][col] = 0;
        const newCol = Math.round(col + step);
        if (newCol >= 0 && newCol < GAME_WIDTH) {
          state.invaders[row][newCol] = 1;
        }
      }
    }
  }
  // Bounce off edges
  const hasLeftEdge  = state.invaders.some((row) => row[0] === 1);
  const hasRightEdge = state.invaders.some((row) => row[GAME_WIDTH - 1] === 1);
  if (hasLeftEdge)  state.invadersDirection = 1;
  if (hasRightEdge) state.invadersDirection = -1;
}

function stepInvadersDown(state) {
  // Shift all invaders one row down.
  for (let row = state.invaders.length - 1; row >= 0; row--) {
    for (let col = 0; col < state.invaders[row].length; col++) {
      if (state.invaders[row][col] === 1) {
        state.invaders[row][col] = 0;
        if (row + 1 < GAME_HEIGHT - 2) {
          state.invaders[row + 1][col] = 1;
        }
      }
    }
  }
}

function checkCollisions(state) {
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i];
    const px = Math.round(p.x);
    const py = Math.round(p.y);

    if (p.dy < 0) {
      // Player bullet: check against invaders
      for (let row = 0; row < state.invaders.length; row++) {
        if (state.invaders[row][px] === 1) {
          state.invaders[row][px] = 0;
          state.score += 10;
          state.projectiles.splice(i, 1);
          break;
        }
      }
    } else {
      // Invader bomb: check against ships
      for (const [pid, ship] of state.ships) {
        if (!ship.alive) continue;
        if (Math.abs(px - ship.x) <= 1 && py >= GAME_HEIGHT - 3) {
          ship.lives--;
          if (ship.lives <= 0) ship.alive = false;
          state.projectiles.splice(i, 1);
          break;
        }
      }
    }
  }

  // Random invader bombs (1% chance per tick per invader column with alive invaders)
  if (Math.random() < 0.3) {
    const aliveCols = [];
    for (let col = 0; col < GAME_WIDTH; col++) {
      for (let row = state.invaders.length - 1; row >= 0; row--) {
        if (state.invaders[row][col] === 1) {
          aliveCols.push(col);
          break;
        }
      }
    }
    if (aliveCols.length > 0) {
      const col = aliveCols[Math.floor(Math.random() * aliveCols.length)];
      state.projectiles.push({ x: col, y: 1, dy: 1, owner: null });
    }
  }
}

function invadersAllDead(invaders) {
  return invaders.every((row) => row.every((cell) => cell === 0));
}

function createInvaderGrid() {
  // 5 rows x 11 columns of invaders, with gaps.
  const grid = [];
  for (let row = 0; row < 5; row++) {
    grid[row] = [];
    for (let col = 0; col < GAME_WIDTH; col++) {
      grid[row][col] =
        col >= 2 + row && col < GAME_WIDTH - 2 - row && col % 2 === 0 ? 1 : 0;
    }
  }
  return grid;
}

/**
 * Serialize the invader grid into the Match entity's `invaders` text field.
 * This triggers the framework's event broadcast, but ALSO writes to DB.
 *
 * PAIN POINT: 30 DB writes/second per match. The `invaders` field should be
 * ephemeral (in-memory only, broadcast via WS delta without DB persistence).
 * The framework's text field forces persistence — there's no ephemeral variant.
 */
async function broadcastState(state) {
  try {
    // Load the Match entity row to mutate its field.
    const MatchEntity = Match; // the entity class
    const match = await MatchEntity.findOne(MatchEntity.id.is(state.matchId));
    if (!match || match.phase !== 'playing') {
      stopGameLoop(state.matchId, state);
      return;
    }

    // Serialize the invader grid to the text field → triggers DB write + broadcast.
    // ASPIRATIONAL: match.broadcast({ invaders: state.invaders, projectiles, ships })
    //   → framework diffs, broadcasts delta over WS, no DB write.
    match.invaders = JSON.stringify({
      grid: state.invaders,
      projectiles: state.projectiles,
      ships: [...state.ships.entries()].map(([id, s]) => ({ id, ...s })),
      score: state.score,
    });
    match.tick = (match.tick || 0) + 1;
    match.score = state.score;
    // Field mutations (invaders, tick, score) auto-persist via the framework —
    // no explicit .save() needed. But this still means 30 DB writes/second
    // because these are persisted text/number fields.
  } catch (err) {
    console.error(`[game-loop] match=${state.matchId} broadcast failed:`, err.message);
    stopGameLoop(state.matchId, state);
  }
}

function stopGameLoop(matchId, state) {
  if (state && state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  gameState.delete(matchId);

  // ASPIRATIONAL: framework stops the tick automatically when match.phase
  // transitions to 'gameover'.
}

async function persistFinalScore(matchId, state) {
  try {
    // Record a HighScore for each player who participated.
    for (const [playerId] of state.ships) {
      await HighScore.create({
        [HighScore.score]: state.score,
        [HighScore.player]: playerId,
        [HighScore.match]: matchId,
      });
    }
  } catch (err) {
    console.error(`[game-loop] match=${matchId} score persist failed:`, err.message);
  }
}

// ============================================================================
// Lifecycle hooks: wire the game loop to match phase transitions.
// ============================================================================
//
// PAIN POINT: The framework has no lifecycle hooks for entity state transitions
// (e.g., "when Match.phase changes from 'lobby' to 'playing'"). We use a
// polling approach as a workaround. ASPIRATIONAL: the framework fires
// `match.onPhaseChange('playing', handler)`.

// Track which matches we've already started game loops for.
const startedMatches = new Set();

// ASPIRATIONAL: this polling loop should not exist. The framework should
// detect the phase transition and start/stop the tick automatically.
setInterval(async () => {
  try {
    const playing = await Match.findAll(Match.phase.is('playing'));
    for (const m of playing) {
      if (!startedMatches.has(m.id)) {
        startedMatches.add(m.id);
        const playerIds = await m.players.toArray().then((users) => users.map((u) => u.id));
        initGameLoop(m.id, playerIds);
      }
    }
    // Cleanup: stop loops for matches that are no longer playing.
    for (const id of startedMatches) {
      if (!playing.some((m) => m.id === id)) {
        startedMatches.delete(id);
        stopGameLoop(id, gameState.get(id));
      }
    }
  } catch (err) {
    // Match entity may not be queryable yet during startup.
  }
}, 5000);

// ============================================================================
// Start the server.
// ============================================================================
app.listen(3000, () => {
  console.log('space-invaders on http://localhost:3000');
});

export default app;
