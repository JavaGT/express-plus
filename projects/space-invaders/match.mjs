// match.mjs — Space Invaders multiplayer match entity.
// Expresses an authoritative-server real-time arcade game in the grilled
// express-plus API. Demonstrates: the state machine (lobby → playing →
// gameover), map-valued player roster, grant with scope + can (player vs
// spectator), declarative effects, and aspirational constructs (tick, grid,
// list, entity TTL, subscriber interest).
//
// Where a construct does not yet exist in the API surface, the code imports
// it from 'express-plus' as an idealized handle and documents the gap.
import {
  entity, text, number, date, ref, map, state,
  grant, deny, read, write, subscribe, anyOf, never, scope,
  // ── aspirational imports (not yet in API surface) ──
  // grid    — 2D boolean grid, delta-broadcast, ephemeral
  // list    — ordered mutable collection, delta-broadcast
  // tick    — recurring entity lifecycle hook
  // Player    — per-connection principal with session
} from 'express-plus';

// ────────────────────────────────────────────────────────────────────────────
// Capability bundles — typed, imported, never strings.
// ────────────────────────────────────────────────────────────────────────────
const PLAYER   = [read, write, subscribe];
const SPECTATOR = [read, subscribe];

// ────────────────────────────────────────────────────────────────────────────
// Match entity — the authoritative game session.
// ────────────────────────────────────────────────────────────────────────────
export const Match = entity('Match', {
  fields: {
    // ── persisted fields ────────────────────────────────────────────────────
    phase: state({
      values: ['lobby', 'playing', 'gameover'],
      transitions: {
        lobby:    ['playing'],
        playing:  ['gameover'],
        gameover: [],                      // terminal — no transitions out
      },
      effects: {
        // When the game ends by tick detection, record the timestamp.
        [state.transition('playing', 'gameover')]: { with: { endedAt: now } },
      },
      // NOTE: no `auto` here — the authoritative tick (not a one-shot timer)
      // drives the phase transition when all invaders are dead or all players
      // have lost. `state.auto` is a field-level single-fire timer; we need a
      // recurring tick construct for the game loop.
    }).can(async ({ is }) =>
      // Only the tick/system principal may advance phases. Players read.
      (await is.owner()) ? grant(PLAYER) : grant(read)),

    score:        number({ default: 0 }),
    maxPlayers:   number({ default: 4, validate: (v) => v <= 8 || 'max 8 players' }),
    createdAt:    date({ default: () => new Date() }),
    endedAt:      date({ optional: true }),

    // ── player roster — typed map with per-player ship state ────────────────
    // Players join/leave; each carries their ship x-position and lives.
    players: map(ref('User'), {
      x:      number({ default: 0 }),       // ship x-position
      lives:  number({ default: 3 }),
      score:  number({ default: 0 }),
    }).can(async ({ is }) =>
      // Any player may join/leave; only the tick may write ship positions.
      // GAP: authority: 'server' operator not yet shown in API surface.
      // In the grilled design, only `presence` has a defined authority split.
      (await is.player()) ? grant(read, write) : grant(read)),

    // ── shared ephemeral game state (aspirational field types) ─────────────
    // GAP: grid() does not exist in the field-type catalog.
    // GAP: list() does not exist in the field-type catalog.
    // GAP: no field persistence strategy `ephemeral` is shown in the API.
    //
    // Ideal form:
    //   invaders:    grid({ cols: 11, rows: 5 }),        // delta-broadcast, ephemeral
    //   projectiles: list({ max: 50, item: { x: number, y: number, dy: 1|-1, owner: ref('User') } }),
    //
    // Current workaround: serialize to text (full-value broadcast, writes to
    // DB every frame — catastrophic at 30 Hz).
    invaders:     text({ default: '[]' }),   // JSON grid — NOT ephemeral, NOT delta
    projectiles:  text({ default: '[]' }),   // JSON list — same problems
  },

  // ── checks — plain functions, facts about a row ───────────────────────────
  checks: {
    // Auto-derived from `players` map: checks.player = ({ Match, principal }) =>
    //   Match.players.has(principal.id)
    // Explicit here only for clarity.
    player: ({ Match, principal }) => Match.players.has(principal.id),
  },

  // ── grant — scope (SQL-compilable read admission) + can (runtime write) ───
  // No third method. Live delivery = re-auth-at-emit (latched) + subscriber
  // interest (narrowing filter at subscribe time).
  grant: ({ principal }) => [
    // scope: who may READ this match row?
    // `never()` compiles to SQL FALSE — non-user principals (link, system)
    // are excluded from read scope. Only players and... anyone? No — we want
    // spectators to read too. So we need a public-read pattern.
    //
    // PROBLEM: The grilled design provides `anyOf(is.player(), ...)` but
    // there is no clean way to express "any authenticated user" without a
    // new check. If we add `authenticated: () => true`, that check is
    // non-compilable (it can't be a SQL predicate on row columns alone)
    // but scope requires compilability → load-time error.
    //
    // The grilled design says `scope` is compiled to SQL WHERE. To admit all
    // authenticated users (spectators), we'd need a framework-level concept
    // like `everyone` or `authenticated` that compiles to `TRUE` in the WHERE
    // clause — but that's a fixed constant, not a check. The `publicRead`
    // entity-level flag mentioned in the plan (Phase 1 item 6) is not yet
    // shown in the API surface.
    //
    // Workaround: scope admits players only. Spectators cannot read the match
    // row → they can't see the invader grid. This is broken for spectators.
    //
    // ALTERNATIVE: Make Match world-readable via a constant scope, but the
    // API for that is not shown. `anyOf(is.player(), true)` won't compile.
    scope(({ is }) => anyOf(is.player()))
      .can(async ({ is }) => {
        if (await is.player()) return grant(...PLAYER);
        // Spectator path unreachable if scope filters them out.
        return deny('no capability for this principal');
      }),
  ],

  // ── effects ────────────────────────────────────────────────────────────────
  // When a player joins, if the match is full, auto-start the game.
  // GAP: cannot reference match.players.size in a template path — the
  // `with` template only interpolates `delta.member`, `entity.id`, and
  // trigger-delta fields. There's no `if`/condition guard on effects
  // (the effect fires unconditionally on the trigger). The auto-start logic
  // would need to live in the tick, not in effects.
  effects: {
    // [players.onAdded]: { mutate: self, with: { phase: 'playing' } }
    // ^ This would fire every time a player joins — even when not full.
    //   We can't express a conditional effect ("only if players.size >= maxPlayers").
    //   The tick is the right place for this, but tick is not in the API surface.
  },

  // ── tick (aspirational) ────────────────────────────────────────────────────
  // GAP: entity-level tick construct exists in the plan (Phase 2 item 9) but
  // the API surface is not defined. The plan says: "recurring, lifecycle-bound
  // to state transitions, through the pipeline, system principal."
  //
  // Ideal form:
  //   tick: {
  //     rate: 30,                            // Hz
  //     when: 'playing',                      // lifecycle-bound to phase
  //     handler(match, dt, queuedActions) {
  //       // Move invaders: shift-right until edge, then drop+reverse.
  //       // Advance projectiles: move by dy each tick.
  //       // Check collisions: projectile vs invader, invader vs ground.
  //       // Apply queued player input: move ship, fire bullet.
  //       // If all invaders dead → match.phase = 'gameover'.
  //       // If all players dead → match.phase = 'gameover'.
  //
  //       // Mutations flow through the pipeline: diffs computed, deltas
  //       // broadcast, ephemeral fields skipped for DB, latch re-auth
  //       // checked once at subscribe-time.
  //
  //       match.invaders = nextInvaders;
  //       match.projectiles = nextProjectiles;
  //       // players map is also mutated (ship positions, lives, score)
  //     },
  //   },

  // ── entity TTL (aspirational) ──────────────────────────────────────────────
  // GAP: entity TTL is in Phase 3 (item 16). No API surface shown.
  //
  // Ideal form:
  //   ttl: '5m',      // auto-delete 5 min after creation
  // OR for truly ephemeral (no DB row):
  //   persist: false,  // entire entity in-memory only

  routes: (r, Match) => {
    r.resource();                                // CRUD through grant

    // ── player actions (aspirational RPC) ────────────────────────────────────
    // GAP: no `actions` block in the API. The plan says intents are mutations
    // with server-authored `apply` (authority: 'server' operators), but the
    // API surface is not shown.
    //
    // Current workaround: raw POST routes with opaque JSON payloads, validated
    // in the handler, queued into the tick's pending-input array.
    r.post('/:matchId/move', async (req, res) => {
      const { direction } = req.body;            // -1, 0, or 1
      // GAP: no typed validation — direction is any value
      // GAP: no queue into the tick — must use a side channel (in-memory map)
      res.json({ queued: true });
    });
    r.post('/:matchId/fire', async (req, res) => {
      // GAP: same problems — no typed action schema, no tick integration
      res.json({ queued: true });
    });
  },

  // ── subscriber interest (aspirational) ─────────────────────────────────────
  // GRILED DESIGN: interest is a narrowing filter, data-not-code, validated
  // at subscribe time, indexable. The API surface is not exemplified.
  //
  // For Space Invaders, a spectator in the lobby would subscribe with:
  //   match.subscribe({ interest: { fields: ['phase', 'players'] } })
  // A player in-game would subscribe with:
  //   match.subscribe({ interest: { fields: ['invaders', 'projectiles', 'players'] } })
  // The server uses interest to limit what it emits to each subscriber.
  //
  // Without interest, every tick mutation is broadcast to every subscriber
  // regardless of whether they need it. At 30 Hz × 100 lobby spectators ×
  // full game state, this is a firehose.
});
