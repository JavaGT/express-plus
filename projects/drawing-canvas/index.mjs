// projects/drawing-canvas/index.mjs — the drawing canvas reactive entities.
//
// Two entities: Board (the infinite collaborative canvas) and Shape (a committed
// vector shape on the board). Board owns the shape collection and the collaborative
// presence surface (cursor, viewport, in-progress stroke). Shape is a committed
// vector record: rect, ellipse, freedraw polyline, text, arrow.
//
// All live state is fields: presence carries ephemeral per-connection cursor,
// viewport, and active-stroke data; the baked-in /events WS stream broadcasts
// every mutation (shape added/removed/updated, cursor moved, stroke point appended)
// through a SINGLE auth engine. No separate rooms block, no hand-written emit —
// events ARE field mutations.
//
// DESIGN STRESS-TEST:
//   1. In-progress stroke (60Hz ephemeral) rides the `presence` field — but
//      `presence` is named/typed for cursor+selection semantics. Does it
//      generalize to arbitrary per-connection ephemeral data, or is the field-set
//      closed? Flagged in PAIN-POINTS.md.
//   2. Committed shapes use `set(ref('Shape'))` — an unordered, idempotent-add
//      set. No built-in ordering or reordering. Client-side zIndex sorting
//      simulates layers, but there is no server-enforced z-order. Flagged.
//   3. 60Hz × M cursors × per-push re-auth on the baked-in /events stream.
//      No "pre-auth on subscribe" escape hatch. The invariant "no second auth
//      path" is preserved; the perf cost for ephemeral high-frequency data is
//      flagged.
//
// Imports typed handles (not strings): entity, field constructors, auth
// primitives, capability handles.
import { entity, text, number, ref, date, set, presence,
          grant, deny, hide, router,
          read, write, subscribe, admin, owner } from 'express-plus';

// ── Shape: a committed vector shape on a Board ───────────────────────────────
//
// Each shape is an independent entity referenced from Board.shapes (a set field).
// The FK `board` ties it to its owning Board; auth flows through the Board entity
// (shape routes check board access in the handler, see routes block below).
//
// Field design (type-first naming — the DOMAIN noun leads, modifiers follow):
//   type          — "rect" | "ellipse" | "freedraw" | "text" | "arrow"
//   x, y          — top-left origin in canvas coordinate space
//   w, h          — bounding box dimensions
//   strokeColor   — hex or CSS color name for the outline
//   fillColor     — hex or CSS color name for the fill; "none" for wireframe
//   strokeWidth   — line thickness in canvas-logical pixels
//   points        — JSON-serialized polyline [{x,y},...] for freedraw shapes
//   textContent   — text content for text shapes
//   zIndex        — stacking order (higher = painted on top)
//   rotation      — degrees clockwise around center
//   createdBy     — FK to User who drew the shape
//
// GAPS flagged in PAIN-POINTS.md:
//   - `points` is forced into `text` (JSON blob). No array/polyline field type
//     exists. Every point-edit rewrites the entire blob; no granular sync for
//     polyline mutation.
//   - `type` is freeform `text` — no enum field type. Invalid type values are
//     caught only by client validation or access checks, not by the schema.
//   - `createdBy` lacks `from: 'req.user.id'` auto-population (only `role: owner`
//     triggers auto-fill). The handler sets it manually on create.
export const Shape = entity('Shape', {
  fields: {
    board:       ref('Board', { required: true }),
    type:        text({ default: 'rect' }),
    x:           number({ default: 0 }),
    y:           number({ default: 0 }),
    w:           number({ default: 100 }),
    h:           number({ default: 100 }),
    strokeColor: text({ default: '#000000' }),
    fillColor:   text({ default: 'none' }),
    strokeWidth: number({ default: 2 }),
    points:      text({ default: '[]' }),          // GAP: no array/polyline field
    textContent: text({ default: '' }),
    zIndex:      number({ default: 0 }),
    rotation:    number({ default: 0 }),
    createdBy:   ref('User', { readonly: true }),
    createdAt:   date({ default: () => new Date(), readonly: true }),
    updatedAt:   date({ touch: true, readonly: true }),
  },

  // Shape has no independent grant block — auth flows through the owning Board.
  // Shape routes (below) check Board access in the handler; individual shape
  // updates are accessible to anyone with Board write capability.
});

// ── Shape routes: sub-resource mounted inside Board's routes block ────────────
//
// Factory receives the Shape entity class (available from module scope — no
// circular import since Shape is defined above and Board's routes callback
// captures it by closure). The Board entity class is available as the second
// arg to the routes callback (standard pattern); the framework auto-loads
// req.board from :boardId via the param-binding rule.
//
// Committed shapes are managed here. The IN-PROGRESS stroke flows through
// the Board.presence field (60Hz ephemeral); on pointer-up, the client POSTs
// the finalized shape to commit it (below).
function shapeRoutes(Shape) {
  const shapes = router();

  // List all committed shapes on this board, ordered by zIndex.
  // Typed field-handle query: `Shape.board.is(boardId)`, not a magic string.
  // FK auto-populates: `createdBy` resolves to a User object.
  shapes.get('/', async (req, res) => {
    const items = await Shape.findAll(Shape.board.is(req.board.id))
      .sort(Shape.zIndex, 'asc');
    res.json(items);
  });

  // Commit a shape (pointer-up). Creates the Shape entity, then adds it to
  // the board's shapes set. The set mutation auto-emits
  // `Board:<id>:shapes:added:<shapeId>`, notifying all subscribers — including
  // the drawer's own client, which uses that event to clear its activeStroke
  // presence state. One atomic side effect (set add) drives the broadcast.
  shapes.post('/', async (req, res) => {
    if (!req.board.isCollaborator(req.user)) return res.sendStatus(403);

    const shape = await Shape.create({
      ...req.body,
      board: req.board.id,
      createdBy: req.user.id,    // manual: no `from: req.user.id` support for non-owner refs
    });
    await req.board.shapes.add(shape.id);   // → auto-emits Board:<id>:shapes:added:<shapeId>
    res.status(201).json(shape);
  });

  // Update a committed shape (move, resize, recolor, reorder zIndex).
  // LWW merge: concurrent edits to the same field last-write-wins.
  // Each modified field emits `Shape:<id>:<field>:changed` individually.
  shapes.patch('/:shapeId', async (req, res) => {
    if (!req.board.isCollaborator(req.user)) return res.sendStatus(403);

    const shape = await Shape.update(req.params.shapeId, req.body);
    res.json(shape);
  });

  // Delete a committed shape. Removes from the board's set (auto-emits
  // `:removed:<shapeId>`) and destroys the Shape entity.
  shapes.delete('/:shapeId', async (req, res) => {
    if (!req.board.isCollaborator(req.user)) return res.sendStatus(403);

    await req.board.shapes.remove(req.params.shapeId);  // → auto-emits Board:<id>:shapes:removed:<shapeId>
    await Shape.destroy(req.params.shapeId);
    res.sendStatus(204);
  });

  return shapes;
}

// ── Board: the infinite collaborative canvas ─────────────────────────────────
//
// The Board is the top-level domain entity. Its fields:
//   name          — board title
//   owner         — FK to User, marked `role: owner` (auto-derives checks.owner
//                   and the zero-to-one default grant; also auto-sets req.user.id
//                   on create — ONE source of truth for ownership)
//   shapes        — unordered set of committed Shape entities
//   presence      — ephemeral per-connection state for cursor, viewport, and
//                   the in-progress activeStroke (60Hz polyline stream)
//   createdAt     — immutable creation timestamp
//   updatedAt     — auto-bumps on any mutation via `touch: true`
//
// PRESENCE DESIGN — THE 60Hz EPHEMERAL CHANNEL:
//   `presence({ cursor, viewport, activeStroke })` carries THREE kinds of
//   ephemeral per-connection state:
//
//     cursor       → { x, y } in canvas coordinates — where my pointer is
//     viewport     → { x, y, zoom } — my current pan/zoom state
//     activeStroke → { type, color, strokeWidth, points: [{x,y},...] }
//                     the growing in-progress polyline until pointer-up commits
//
//   Presence field events:
//     Board:<id>:presence:joined   — user connects, sends full current state
//     Board:<id>:presence:moved    — ANY presence field changes (60Hz per-drawer)
//     Board:<id>:presence:left     — user disconnects (stroke discarded)
//
//   The baked-in /events WS stream delivers these events. `r.resource()` on
//   Board auto-surfaces a read side: GET /boards/:id/presence returns the
//   current roster, so the client bootstraps on first paint before subscribing
//   to live deltas.
//
// GAPS flagged in PAIN-POINTS.md:
//   - `presence` is named for passive state ("where I am, what I'm looking at");
//     repurposing it for activeStroke ("what I'm actively building") overloads
//     the concept. Is the field set closed to {cursor, selection} or extensible?
//     If closed, this is a BLOCKER — no API surface for per-connection ephemeral
//     high-frequency data that isn't cursor/selection.
//   - No way to declare the TYPE of presence data. `cursor: true` is a boolean
//     flag; `activeStroke: true` doesn't declare what shape activeStroke data
//     has. Type-safety is lost.
//   - Every presence update fires per-push re-auth through grant/access. At 60Hz
//     with M drawers, that's 60×M auth-checks/second. Pre-authorized ephemeral
//     channels (authorize-on-subscribe, not per-push) don't exist — the invariant
//     "no second auth path" is preserved, but the cost for ephemeral data is
//     notable.
//
// SHAPES COLLECTION GAP:
//   `set(ref('Shape'))` is unordered and idempotent. The client simulates z-order
//   via each shape's `zIndex` number field (sorted on paint). But there is no
//   server-side ordered-collection primitive — no atomic "move to front," no
//   guaranteed unique zIndex allocation. Two shapes at the same zIndex are
//   ambiguous. A `list` or `ordered` field type would capture z-order natively.
//
// UNDO GAP:
//   No field primitive exposes mutation history for undo/redo. LWW and CRDT
//   fields overwrite; `log()` is append-only with no delete. Implementing undo
//   requires client-side operation tracking and inverse-op replay through the
//   normal CRUD API — no server-side undo stack.
export default entity('Board', {
  fields: {
    name:      text({ max: 200, default: 'Untitled Board' }),
    owner:     ref('User', { role: owner, readonly: true }),

    // Committed shapes. `set(ref('Shape'))` gives us:
    //   - typed FK references (no magic strings)
    //   - auto-emit `Board:<id>:shapes:added:<shapeId>` / `:removed:<shapeId>`
    //   - auto-population on traversal (`await board.shapes.toArray()`)
    //   - idempotent .add / .remove operations
    // LIMITATIONS (see PAIN-POINTS.md): unordered, no server-side reorder, no
    // atomic z-order swap.
    shapes:    set(ref('Shape')),

    // Ephemeral per-connection collaborative presence.
    // Carries cursor position, viewport pan/zoom, and the active in-progress
    // stroke (60Hz point stream). Emits :joined / :moved / :left.
    //
    // `r.resource()` auto-surfaces GET /boards/:id/presence for bootstrap.
    // The WS /events stream delivers live :moved events at 60Hz.
    presence:  presence({ cursor: true, viewport: true, activeStroke: true }),

    // Future: `chat: log()` for text chat alongside drawing.

    createdAt: date({ default: () => new Date(), readonly: true }),
    updatedAt: date({ touch: true, readonly: true }),
  },

  // ── Auth ──────────────────────────────────────────────────────────────
  // Checks are per-Board — NOT universal. Each Board defines its own notion
  // of collaborator. `owner` is auto-derived from `role: owner` on the FK above;
  // the rest are declared.
  //
  // subscribe is a PEER of read (one-shot REST fetch vs sustained WS push).
  // Both are granted to collaborators; an anonymous board could grant read
  // but deny subscribe to bound the WS DoS surface.
  checks: {
    owner:        ({ entity, user }) => entity.owner === user.id,
    collaborator: ({ entity, user }) => entity.owner === user.id,
    // Future: `shares: set(ref('User'))` for shared boards — then
    // `collaborator` would check `entity.shares.has(user.id)` as well.
  },

  grant: async ({ is }) => {
    if (is.owner())        return grant(read, write, subscribe, admin);
    if (is.collaborator()) return grant(read, write, subscribe);
    return hide();          // 404 — board existence not leaked
  },

  // ── Routes ────────────────────────────────────────────────────────────
  // `r.resource()` opts into auto-CRUD at /boards + auto-surfaces presence
  // reads at /boards/:id/presence. Shape CRUD is mounted as a sub-resource.
  //
  // The framework auto-loads req.board from :boardId (param-binding rule:
  // `:<entity>Id` → `req.<entity>` through the route gate). Sub-routers
  // inherit the param without mergeParams.
  routes: (r, Board) => {
    r.resource();                                     // /boards CRUD + /:id/presence, through grant/access
    r.use('/:boardId/shapes', shapeRoutes(Shape));   // shape sub-resource
  },
});
