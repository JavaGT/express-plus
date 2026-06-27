// projects/space-invaders/index.mjs — multiplayer Space Invaders arcade game.
//
// The Match entity: a game instance with invader grid, player ships, projectiles,
// score, lives, and a server-authoritative tick loop at 30 Hz. Multiple players
// co-op against the invader wave. Matches are ephemeral — when a match ends,
// the state evaporates (save a persisted HighScore). A Lobby lists joinable
// matches.
//
// CENTRAL TENSION: express-plus says "fields own sync, events derive from field
// mutations, presence is per-connection ephemeral." But an arcade game needs:
//   1. A server AUTHORITATIVE TICK that mutates shared state every 33 ms
//      regardless of any client. The framework has no scheduler/timer construct.
//   2. A SHARED ephemeral invader grid that ALL players see mutate together.
//      presence is per-connection; every other field type is PERSISTED (writing
//      the grid to DB 30 times/second is absurd).
//   3. 30 Hz match-state snapshots broadcast to N players through a WS stream
//      that re-authorizes every push.
//
// This file documents where the reactive-entity paradigm fits (HighScore,
// player roster, match lifecycle) and where it breaks (the tick, the invader
// grid, high-frequency broadcast re-auth). ASPIRATIONAL syntax is marked
// with <!-- ASPIRATIONAL --> and explained in PAIN-POINTS.md.
//
// Two entities:
//   Match     — ephemeral game instance (the hard case)
//   HighScore — persisted leaderboard entry (fits the framework perfectly)
import { entity, text, number, ref, date, set,
          grant, deny, hide,
          read, write, subscribe, admin } from 'express-plus';

// ============================================================================
// Match — the game instance
// ============================================================================
//
// Every field type available in express-plus is either PERSISTED (text, number,
// date, set, ref) or PER-CONNECTION EPHEMERAL (presence). There is no field
// type for "shared ephemeral state mutated authoritatively by a server tick."
//
// The invader grid, projectile array, and collision map need to be:
//   - SHARED (all connections see the same values)
//   - EPHEMERAL (evaporates when the match ends — no DB write)
//   - SERVER-AUTHORITATIVE (clients never write to them)
//   - TICK-MUTATED (updated at 30 Hz by the server, not by any field mutation)
//
// No field constructor satisfies all four. Below we use text fields as a
// pragmatic stopgap (serializing the grid into a text blob each tick), but
// this means 30 DB writes/second per match — absurd at scale. The aspirational
// field type `state.grid()` is shown in comments.

export const Match = entity('Match', {
  fields: {
    // ---- Shared ephemeral game state (PAIN POINT: no field type fits) ----

    // The invader fleet: a 2D grid of alive/dead cells. Serialized as JSON
    // every tick because no field type is "shared ephemeral tick-mutated."
    // ASPIRATIONAL: invaders: state.grid({ cols: 11, rows: 5 })
    //   → framework owns the data structure, serialization, delta compression,
    //     and broadcast — the tick handler mutates in-memory, and the framework
    //     diffs + pushes only changed cells each frame.
    invaders: text({ default: '[]', access: ({ is }, defaults) =>
      is.inMatch() ? defaults : hide()
    }),

    // Active projectiles (both invader bombs and player bullets). Same problem:
    // serialized to text every tick.
    // ASPIRATIONAL: projectiles: state.list()
    projectiles: text({ default: '[]', access: ({ is }, defaults) =>
      is.inMatch() ? defaults : hide()
    }),

    // ---- Ephemeral per-match state ----

    // Player roster: which users are currently connected to this match.
    // `set(ref('User'))` is PERSISTED — it writes to DB on every join/leave.
    // For a 5-minute match this is fine (handful of writes), but the framework
    // has no in-memory-only set type for ephemeral membership.
    // ASPIRATIONAL: a `set` variant with `persist: false`.
    players: set(ref('User')),

    // ---- Persisted match metadata ----

    // The player who created the match. `role: owner` auto-derives
    // `checks.owner` + the zero-to-one default grant.
    host: ref('User', { role: owner, readonly: true }),

    // Match phase: lobby (waiting for players), playing (invaders active),
    // gameover (wave cleared or all players dead). Persisted for lobby listing.
    phase: text({ default: 'lobby' }),

    // Accumulated score for this match (shared across all players — co-op).
    // Persisted so a client joining mid-match sees the current score.
    score: number({ default: 0 }),

    // Wave number (increases as waves are cleared).
    wave: number({ default: 1 }),

    // Ticks elapsed since match started. Persisted as a simple counter.
    tick: number({ default: 0 }),

    // ---- Timestamps ----
    createdAt: date({ default: () => new Date(), readonly: true }),
  },

  // ---- Authorization checks ----
  // `owner` is auto-derived from `role: owner` on the `host` field.
  // `inMatch` checks whether the user is currently in the player roster.
  checks: {
    inMatch: async ({ entity, user }) => entity.players.has(user.id),
  },

  // ---- Grant: who can see/interact with this match ----
  //
  // PAIN POINT: At 30 Hz, `grant` is called per-push per-subscriber. For a
  // 4-player match, that's 120 re-auth checks per second. The answer ("is this
  // player still in the match?") doesn't change frame-to-frame during play, so
  // these are pure overhead. An authorization-latch-on-join pattern would be
  // more appropriate for in-flight game state.
  grant: async ({ is }) => {
    if (is.owner())                          return grant(read, write, subscribe, admin);
    if (await is.inMatch())                  return grant(read, subscribe);
    // Non-players can read lobby metadata (phase, player count) but not
    // subscribe to game state.
    if (entity.phase === 'lobby')            return grant(read);
    return hide();
  },

  // ---- Routes ----
  routes: (r, Match) => {
    r.resource();

    // POST /matches/:matchId/join — join a match
    r.post('/:matchId/join', async (req, res, next) => {
      const match = req.match;
      if (match.phase !== 'lobby') {
        return next({ status: 400, message: 'match already in progress' });
      }
      await match.players.add(req.user.id);
      res.json({ joined: true, matchId: match.id });
    });

    // POST /matches/:matchId/start — host starts the match
    //
    // PAIN POINT: This is where we MUST reach outside the framework.
    // express-plus has no scheduler/tick construct. The game loop (setInterval
    // at 30 Hz) is started here manually — a SECOND PATHWAY alongside field
    // reactivity. The framework should own the tick lifecycle (start on phase
    // transition, stop on gameover, cleanup on entity destroy).
    // ASPIRATIONAL: match.phase = 'playing' triggers the tick hook declared
    //   on the entity, which the framework starts/stops/cleans up.
    r.post('/:matchId/start', async (req, res, next) => {
      const match = req.match;
      if (!match.isOwner(req.user)) {
        return next({ status: 403, message: 'only the host can start' });
      }
      if (match.phase !== 'lobby') {
        return next({ status: 400, message: 'match already started' });
      }
      // ---- SECOND PATHWAY: setInterval outside the framework ----
      // The game loop (see app.mjs) is started by the app-level wiring because
      // the framework has no tick/scheduler construct. This is a leak.
      match.phase = 'playing';
      // The entity's phase field mutation auto-persists and emits
      // Match:<id>:phase:changed. The app-level game-loop manager (app.mjs)
      // polls for this transition and starts the tick — because there is no
      // framework-owned tick lifecycle. ASPIRATIONAL: assigning 'playing' to
      // the `phase` field triggers the framework to start the declared `tick`
      // block automatically.
      res.json({ started: true, matchId: match.id });
    });

    // POST /matches/:matchId/fire — player fires a bullet
    r.post('/:matchId/fire', async (req, res, next) => {
      const match = req.match;
      if (match.phase !== 'playing') {
        return next({ status: 400, message: 'match not in play' });
      }
      if (!(await match.isInMatch(req.user))) {
        return next({ status: 403, message: 'not in this match' });
      }
      // PAIN POINT: This is an imperative RPC-style action, not a field mutation.
      // The fire intent should be queued for the next tick. But the in-memory
      // game loop lives in app.mjs (outside the framework), and the route
      // handler (inside the entity) cannot reach it without a back-channel.
      // ASPIRATIONAL: the entity has an `actions` block; match.fire(shipX)
      // validates and queues automatically. The tick handler receives queued
      // actions alongside the match state.
      const { shipX } = req.body;
      // ⚠ Gap: no way to reach gameState.get(req.match.id).pendingInput from here.
      res.json({ fired: true });
    });

    // POST /matches/:matchId/move — player moves their ship
    r.post('/:matchId/move', async (req, res, next) => {
      const match = req.match;
      if (match.phase !== 'playing') {
        return next({ status: 400, message: 'match not in play' });
      }
      // PAIN POINT: Player ship position is genuinely per-connection — it
      // belongs in a server-validated `presence` variant. But `presence` is
      // client-dictated (no server validation) and designed for document
      // cursors, not game input. Ship position lives in the in-memory game
      // loop in app.mjs, inaccessible from this route handler.
      const { direction } = req.body; // -1, 0, or 1
      // ⚠ Gap: no way to reach gameState.get(req.match.id).ships from here.
      res.json({ moved: true });
    });

    // GET /matches — list joinable matches (the lobby)
    r.get('/', async (req, res) => {
      const matches = await Match.findAll(Match.phase.is('lobby'))
        .sort(Match.createdAt, 'desc')
        .limit(20);
      res.json({
        matches: matches.map((m) => ({
          id: m.id,
          host: m.host.username,
          playerCount: m.players.size,
          createdAt: m.createdAt,
        })),
      });
    });
  },

  // ---- ASPIRATIONAL: tick declaration ----
  //
  // The framework SHOULD own the game loop. A `tick` block declares the update
  // rate and the authoritative tick handler. The framework starts the loop when
  // the match enters `playing`, stops it on `gameover`, and cleans up on entity
  // destroy. The tick handler receives the match's in-memory state and mutates
  // it; the framework diffs changed fields and broadcasts only the delta.
  //
  // Without this, the app must reach outside the framework with setInterval
  // (a second pathway), manage its own lifecycle, and serialize the entire
  // grid to a text field every frame (30 DB writes/second).
  //
  // tick: {
  //   rate: 30,  // Hz
  //   handler(match, dt) {
  //     // Move the invader fleet one step
  //     match.invaders.step();
  //     // Advance all projectiles; check collisions
  //     match.projectiles.advance(match.invaders, match.ships);
  //     // Check game-over conditions
  //     if (match.invaders.allDead() || match.ships.allDead()) {
  //       match.phase = 'gameover';
  //       // Framework auto-stops the tick.
  //     }
  //   },
  // },
});

// ============================================================================
// PlayerShip — per-player state in a match
// ============================================================================
// ASPIRATIONAL: per-player entities embedded in a match, with field types for
// in-game state (position, lives, score contribution). Currently, ship state
// lives in the in-memory game loop because there is no entity-per-connection
// pattern for shared game sessions.

// ============================================================================
// HighScore — persisted leaderboard entry (fits the framework PERFECTLY)
// ============================================================================
//
// This is the easy case: a HighScore is a persisted row with a score number,
// a player FK, and a timestamp. Auto-CRUD works; the live stream notifies
// clients of new entries. The reactive-entity paradigm shines here.
export const HighScore = entity('HighScore', {
  fields: {
    // The score value. `sort` in queries uses the typed field handle.
    score: number({ required: true }),

    // The player who earned this score.
    player: ref('User', { required: true, readonly: true }),

    // The match this score came from (nullable — a match may be deleted).
    match: ref('Match', { readonly: true }),

    // Wave reached
    wave: number({ default: 1 }),

    // When the score was recorded.
    recordedAt: date({ default: () => new Date(), readonly: true }),
  },

  // High scores are publicly readable, but only the framework (via game-over
  // handler) creates them. No user can modify a high score.
  checks: {
    owner: ({ entity, user }) => entity.player === user.id,
  },

  grant: async ({ is }) => {
    // Everyone can read the leaderboard. Only the player who earned it can
    // see write/subscribe on their own row (for notification of new personal
    // best). The framework creates high scores server-side on game over.
    if (is.owner()) return grant(read, subscribe);
    return grant(read);
  },

  // Auto-CRUD (r.resource() default) + a ranked leaderboard query.
  routes: (r, HighScore) => {
    r.resource();

    // GET /scores/leaderboard — top scores, all-time.
    r.get('/leaderboard', async (req, res) => {
      const top = await HighScore.findAll()
        .sort(HighScore.score, 'desc')
        .limit(10);
      res.json({
        leaderboard: top.map((e) => ({
          score: e.score,
          player: e.player.username,
          wave: e.wave,
          recordedAt: e.recordedAt,
        })),
      });
    });
  },
});
