// projects/photo-editor/app.mjs — thin global wiring.
//
// Sensible defaults (security, body, sessions, req.user hydration, rate limit,
// cors, logs, views, static, error handling, graceful shutdown, AND the WS
// /events subscription stream) are baked into express-plus — nothing to apply,
// nothing to hand-mount.
//
// Mounting is Express-style: you declare the endpoint path. Persisted product
// domains are entities (`app.mount('/canvases', CanvasEntity)`). The live
// /events WS endpoint is framework-baked and not declared here.
//
// The Layer entity is imported for reference resolution (Canvas's `set(ref('Layer'))`
// needs Layer to exist as a registered entity), but Layer is NOT directly mounted —
// it's a child resource accessed through Canvas routes.
import expressPlus from 'express-plus';
import { config } from '../../config.mjs';
import CanvasEntity, { Layer } from './index.mjs';

const app = expressPlus();

// Layer entity registration — needed for FK resolution by Canvas's `set(ref('Layer'))`.
// Not mounted at a URL prefix; Layer routes are surfaced through Canvas's
// auto-CRUD sub-resources (r.resource() → /canvases/:id/layers).
// If the framework auto-discovers entities by import, this is redundant.
app.entity(Layer);

// Mount the Canvas entity. Auto-CRUD through grant/access at:
//   GET    /canvases          → list user's Canvases (grant-filtered)
//   GET    /canvases/:id       → get one Canvas
//   POST   /canvases           → create Canvas
//   PATCH  /canvases/:id       → update Canvas fields
//   DELETE /canvases/:id       → soft-delete Canvas
//   GET    /canvases/:id/chat  → bootstrap chat log (log field)
//   GET    /canvases/:id/presence → bootstrap presence roster (presence field)
//   GET    /canvases/:id/layers → list layers (set field, FK-auto-populated)
//   GET    /canvases/:id/export.png → composite and download PNG (custom route)
//
// Live WS events auto-emitted by field mutations (no hand-written emit):
//   Canvas:<id>:layers:added:<layerId>     → when a layer is created
//   Canvas:<id>:layers:removed:<layerId>   → when a layer is deleted
//   Layer:<id>:imageData:changed           → when base image is replaced
//   Layer:<id>:strokes:appended:<entryId>  → when a brush stroke is committed
//   Layer:<id>:opacity:changed             → when opacity changes
//   Layer:<id>:visible:changed             → when visibility toggles
//   Layer:<id>:blendMode:changed           → when blend mode changes
//   Layer:<id>:order:changed               → when z-order changes
//   Canvas:<id>:presence:joined            → when a user opens the canvas
//   Canvas:<id>:presence:moved             → when a user's cursor moves
//   Canvas:<id>:presence:left              → when a user disconnects
//   Canvas:<id>:chat:appended:<msgId>      → when a chat message is sent
app.mount('/canvases', CanvasEntity);

app.listen(config.port, () =>
  console.log(`photo-editor on http://localhost:${config.port} [${config.env}]`));
