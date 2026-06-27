// projects/drawing-canvas/app.mjs — drawing canvas app wiring.
//
// Thin global entry point. Sensible defaults (security headers, body parsing,
// cookie sessions, req.user hydration, rate limit, CORS, request logging, view
// engine, static files, 404 handler, error handler, graceful shutdown, AND the
// baked-in WS /events subscription stream) are built into express-plus — nothing
// to hand-mount, nothing to hand-apply.
//
// Mounting is Express-style: the Board entity is mounted at /boards (auto-CRUD +
// auto-surfaced /:id/presence + live WS fields). The /events WS endpoint is
// framework-baked and not declared here.
//
// HIGH-FREQUENCY DATA FLOW (the 60Hz path):
//   1. Client connects: WS upgrade to baked-in /events → subscribe capability
//      checked once at subscription time via Board's grant.
//   2. Client sends presence update: cursor moved, viewport panned, stroke point
//      appended — rides the same WS connection. NO separate channel.
//   3. Framework broadcasts `Board:<id>:presence:moved` to all subscribers of
//      that board — re-authorizing every push through Board.grant. Per-push
//      re-auth is the invariant: no second auth path.
//   4. Client pointer-ups: POST to /boards/:id/shapes → creates Shape entity + adds
//      to Board.shapes set → auto-emits `Board:<id>:shapes:added:<shapeId>` → all
//      subscribers receive the new committed shape. The drawer's own client clears
//      its activeStroke presence on receipt.
//
// The in-progress stroke (60Hz ephemeral polyline) and the committed shape
// (persisted, shared) ride the SAME transport (WebSocket /events + REST POST for
// commit) through the SAME auth engine. No split-brain, no second auth path.
import expressPlus from 'express-plus';
import BoardEntity from './index.mjs';

const app = expressPlus();

// Mount the Board entity: auto-CRUD at /boards, auto-surface presence at
// /boards/:id/presence, shape sub-resource at /boards/:id/shapes, baked-in
// /events WS stream for live field mutations (presence :moved at 60Hz,
// shapes :added/:removed on commit/delete).
app.mount('/boards', BoardEntity);

app.listen(process.env.PORT || 3000, () =>
  console.log(`drawing-canvas on http://localhost:${process.env.PORT || 3000}`));
