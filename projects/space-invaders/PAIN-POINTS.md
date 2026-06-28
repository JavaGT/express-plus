## Persona — The Arcade Game Loop Engineer

Care about the tick/scheduler construct, ephemeral entities, and whether the
live layer can sustain game-scale frequency without a firehose swamping every
subscriber. Skeptical of any framework that assumes mutations originate only
from user REST calls.

## Attempted entity shape

The full aspirational implementation is at `projects/space-invaders/match.mjs`.
Summary shape:

- `entity('Match', { fields: { phase: state(...), score: number, players: map(ref('User'), {x, lives, score}), invaders: text (aspirational: grid), projectiles: text (aspirational: list) }, checks: { player }, grant: [(scope()...].can(...)], tick: { rate: 30, when: 'playing' } (aspirational), ttl: '5m' (aspirational) })`
- Phase transitions: `lobby → playing → gameover` (terminal).
- Grant: `scope(is.player())` — but can't express spectator read (no `everyone`/
  `authenticated` compiled constant). `.can` tiers player vs spectator.
- Tick: aspirational 30 Hz loop bound to `when: 'playing'`, system principal,
  through the mutation pipeline with delta broadcast.
- Fields: `grid` (2D boolean, delta-diff, ephemeral), `list` (ordered, delta-
  diff), `players` map with server-authoritative sub-fields.

## Pain points

### BLOCKER #1: `tick` construct — planned but zero API surface

Tests: IMPLEMENTATION-PLAN Phase 2 item 9 (entity-level tick); singular-system
principle (AGENTS.md).

Failing code:

```js
// What the game needs: an authoritative loop at 30 Hz.
// The plan says tick exists. The doc.mjs exemplar shows state.auto (a
// one-shot field-level timer), not a recurring entity-level loop.
//
// Without tick, the game loop is a raw setInterval in app.mjs — a second
// pathway outside the pipeline:
const matches = new Map();
const TICK_RATE = 1000 / 30;
let handle = null;

// Imperative wiring restating what the entity declaration should own.
// The framework should own tick lifecycle: start on phase→playing, stop
// on gameover, destroy on entity-end, attribute to system principal.
function startTickLoop() {
  handle = setInterval(() => {
    for (const [id, match] of matches) {
      if (match.phase !== 'playing') continue;  // polling lifecycle
      tick(match, TICK_RATE / 1000);
    }
  }, TICK_RATE);
}
```

Aspirational shape:
```js
entity('Match', {
  tick: {
    rate: 30,                               // Hz — framework owns setInterval
    when: 'playing',                         // lifecycle-bound to phase
    handler(match, dt, queuedActions) {       // through the pipeline
      match.invaders = stepInvaders(match.invaders, dt);
      match.projectiles = stepProjectiles(match.projectiles, dt);
      if (allDead(match.invaders)) match.phase = 'gameover';
    },
  },
});
```

The gap: `state.auto` is a one-shot timer (`when: 'shared', after: '90d', to:
'archived'`). A recurring game loop is a different construct with different
semantics: repeating, delta-time-aware, input-queue-integrated, stop-on-
transition. The plan acknowledges tick exists. The exemplar doesn't show it.

### BLOCKER #2: No `grid` field type for shared ephemeral authoritative state

Tests: IMPLEMENTATION-PLAN Phase 2 items 8 (ephemeral persistence), 11
(per-field-type delta broadcast). Field-as-reactive-primitive principle.

Failing code:

```js
// The invader grid is a 11×5 boolean grid. The field-type catalog has:
// text, number, date, ref, map, presence, log, state, boolean — no grid.
//
// Workaround: serialize to text. Catastrophic:
// 1. 30 DB writes/second per active match (text is LWW-persisted).
// 2. Full grid value broadcast to every subscriber every frame.
// 3. No delta diff — the framework sees "text field changed" and emits
//    the full 500-byte JSON, not the 2–5 cells that actually changed.

fields: {
  // THIS IS WHAT WE WRITE — but it's wrong:
  invaders: text({ default: '[]' }),   // JSON grid — persisted, full broadcast
}

// THIS IS WHAT WE NEED — but it doesn't exist:
// invaders: grid({ cols: 11, rows: 5 }),   // 2D boolean, delta-diff, ephemeral
```

Aspirational shape:
```js
fields: {
  invaders: grid({ cols: 11, rows: 5, ephemeral: true }),
  projectiles: list({ max: 50, item: { x: number, y: number, dy: -1|1, owner: ref('User') }, ephemeral: true }),
}
```

The plan acknowledges ephemeral as a field persistence strategy ("a persisted
Match can host ephemeral fields — exactly what games need"). But no exemplar
shows an `ephemeral: true` field option, a `grid` plugin, or a `list` plugin.
The field-type catalog in doc.mjs and comment.mjs is entirely persisted.

### BLOCKER #3: No spectator read — `scope` can't express "any authenticated user"

Tests: ADR #1 (no hide axis, read governs existence), ADR #3 (scope compiles to
SQL), ADR #7 (no default grant). `publicRead` flag in plan Phase 1 item 6.

Failing code:

```js
// A match has players (who read+write) and spectators (who only read).
// In the grilled grammar, scope declares read intent via called checks
// that MUST compile to SQL. To admit spectators, we'd need:
grant: ({ principal }) => [
  scope(({ is }) => anyOf(
    is.player(),                                    // compiles: Match.players HAS user.id
    // is.everyone() ???                             // no such check
    // is.authenticated() ???                         // no such check
  )).can(/* ... */),
],
```

The plan mentions `publicRead` as a ~10-line entity flag. But the API surface
for it is not shown. Without `publicRead`, the only way to admit spectators is
to add a non-compilable check (`authenticated: () => true`) — which in scope
is a LOAD-TIME ERROR. Spectators are structurally locked out.

Alternatively, make every user a player on join, but then the ship grid gets
cluttered, the tick processes ghost players, and the `.can` function can't
cleanly split "player-who-can-fire" from "spectator-who-reads-only."

### SHOULD-FIX #1: Entity TTL — Phase 3, no API surface

Tests: IMPLEMENTATION-PLAN Phase 3 item 16 (entity TTL). Domain expectation
that match rows don't linger after the game ends.

Aspirational shape:
```js
entity('Match', {
  ttl: '5m',        // auto-delete row 5 min after creation
  // OR for purely in-memory matches:
  persist: false,    // no DB row at all
  fields: { /* ... */ },
});
```

The plan splits ephemeral-field from ephemeral-entity, but shows neither in an
exemplar. A match that writes 30×/sec to the DB only to be deleted 5 min later
is wasteful. If the entity is fully ephemeral (no DB row), the match state lives
in memory and the tick runs against in-memory fields — zero DB load.

### SHOULD-FIX #2: Subscriber interest — designed, not exemplified

Tests: ADR #5 (live delivery is NOT a third grant method; subscriber interest
is data-not-code, narrowing-only, indexable).

Failing code:

```js
// At 30 Hz × 100 lobby spectators, every tick mutation (invaders grid,
// projectiles, players map) is broadcast to all 100 subscribers. Most
// spectators don't need the full 500-byte invaders grid — they just
// want to know the phase and score.
//
// The grilled design says interest is a narrowing filter at subscribe
// time, data-not-code. But the subscribe-time syntax is not shown:
//
// match.subscribe({
//   interest: {
//     fields: ['phase', 'score', 'players.size'],  // spectator view
//     // fields: ['invaders', 'projectiles']        // player view
//   }
// })
//
// Without interest, the framework has no mechanism to limit what it
// emits per subscriber. The broadcast is all-or-nothing.
```

The design says interest is "a typed constraint expression over a coordinate
schema the field-type plugin publishes (typed handles), validated at subscribe
time." This is a strong design — but there is no exemplar showing what a
subscribe-time call with interest looks like, how a field type publishes event
coordinates, or how the framework indexes dirty chunks against interest.

### Sharp edge #1: Conditional effects — no `if` guard on triggers

Tests: ADR #8 (declarative effects: bounded, in-transaction, effect-principal).

```js
// Auto-start: when a player joins, if the roster is full, transition to
// 'playing'. But effects fire on EVERY trigger:
effects: {
  [players.onAdded]: { mutate: self, with: { phase: 'playing' } },
  // ^ fires on EVERY player join — even when roster has 1 player.
  //   There's no `if` condition: "only when players.size >= maxPlayers".
  //   The `with` template only interpolates trigger-delta fields (delta.member,
  //   entity.id). No conditional guard, no computed boolean expression.
}
```

The tick is the natural home for this logic (check roster size each frame, set
phase when full). But without tick in the API surface, conditional effects are
the only declarative path — and they can't do it.

### Sharp edge #2: `authority: 'server'` operators not exemplified

Tests: P2 adjudication (intents as mutations with server-authored `apply`). The
plan says intents are mutations with `authority: 'server'` operators. No exemplar
shows this.

```js
// A player sends "move left" → this should queue into the tick's pending
// input. The plan says: intents are mutations with a server-authored `apply`
// that may reject. But the API for declaring an `authority: 'server'` field
// or operator is not shown. doc.mjs field types are all client-authoritative
// (user writes title, user adds collaborators).
//
// The `presence` field is server-readonly from the client perspective, but
// it's designed for passive state (cursor position), not game input (fire bullet).
//
// Aspirational shape for a ship-position field on the players map:
players: map(ref('User'), {
  x: number({ authority: 'server' }),   // only the tick may write x
  lives: number({ authority: 'server' }),
  score: number({ authority: 'server' }),
})
```

## Prior findings re-checked

Each prior finding from the pre-grill report, re-assessed against the grilled
design (ADRs + IMPLEMENTATION-PLAN + doc.mjs/comment.mjs exemplars).

| # | Prior finding | Prior rank | New verdict | Reason |
|---|--------------|-----------|-------------|--------|
| 1 | No tick/scheduler construct | BLOCKER | **NEW-ANGLE** | The plan adds tick in Phase 2 (item 9). The concept exists. But the API surface — `tick: { rate, when, handler }` — is not shown in any exemplar. `state.auto` (one-shot) exists; recurring tick does not. This flips from "framework doesn't know about game loops" to "framework knows about game loops but hasn't designed the API form yet." |
| 2 | No shared-ephemeral field type | BLOCKER | **STILL-OPEN** | The plan splits ephemeral-FIELD from ephemeral-ENTITY (Phase 2 item 8) — a sharper concept. But no exemplar shows an `ephemeral: true` field option, a `grid` plugin, or a `list` plugin. The field-type catalog in doc.mjs/comment.mjs is entirely persisted. |
| 3 | Per-push re-auth at 30 Hz | SHOULD-FIX | **RESOLVED** | ADR #5 explicitly designs latched re-auth: "the grant decision is cached at subscribe time and invalidated by roster/share/role/ownership changes, so the 30Hz path does a cheap cache check." The design directly addresses the high-frequency re-auth overhead. No API surface yet, but the architecture covers it. |
| 4 | No ephemeral entity lifecycle | SHOULD-FIX | **STILL-OPEN** | Entity TTL is in Phase 3 (item 16). The concept is acknowledged but zero API surface. Match rows at 30 writes/sec → DB → delete 5 min later is wasteful even with TTL; the truly ephemeral entity (no DB row) is a stronger need not yet addressed. |
| 5 | No RPC/action pattern | NIT | **NEW-ANGLE** | The plan reframes intents as mutations with server-authored `apply` (`authority: 'server'` operators). This is a clean model: one pipeline, attributed to principal, server validates. But the API surface for declaring server-authoritative fields/operators is not shown in any exemplar. |
| 6 | No delta broadcast for game fields | SHOULD-FIX | **RESOLVED** | The mutation pipeline design (Phase 1 item 1) includes `diff` as a pipeline stage per field type. ADR #5 and the pipeline contract bake in per-field-type delta broadcast. The concept is structural; the remaining gap is which specific field types (grid, list) ship with delta definitions. |

## Summary

| # | Pain point | Rank | Tests |
|---|-----------|------|-------|
| 1 | `tick` — planned but zero API surface | BLOCKER | Phase 2 item 9; singular-system principle |
| 2 | No `grid` field type | BLOCKER | Phase 2 items 8+11; field-as-reactive-primitive |
| 3 | No spectator read in `scope` grammar | BLOCKER | ADR #1+#3+#7; `publicRead` flag |
| 4 | Entity TTL — no API surface | SHOULD-FIX | Phase 3 item 16 |
| 5 | Subscriber interest — not exemplified | SHOULD-FIX | ADR #5 |
| 6 | Conditional effects — no `if` guard | Sharp edge | ADR #8 |
| 7 | `authority:'server'` — not exemplified | Sharp edge | P2 adjudication |

**Design verdict:** The grill dramatically improved the live-delivery story
(latched re-auth solves the high-frequency overhead; subscriber interest provides
a principled narrowing path; the mutation pipeline unifies all mutation sources).
But the framework still assumes mutations originate from a user REST call or
a one-shot `state.auto` timer. The game loop — a recurring authoritative tick
that is the *primary* mutation source for an entity — has no API form. Without
tick, the game collapses to `setInterval` outside the framework (second pathway,
violating the singular-system principle). The `grid`/`list` field types and
`ephemeral` persistence strategy are acknowledged in the plan but not shown.
The `spectator` authorization gap (no `everyone`/`authenticated` compiled
constant in `scope`) is a new BLOCKER in the grilled design that the pre-grill
report didn't catch because the old model had a separate `hide()` axis.
