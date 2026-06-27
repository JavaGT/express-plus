// projects/photo-editor/index.mjs — Canvas + Layer reactive entities for
// a collaborative photo editor (multiplayer Photoshop).
//
// One concept, applied twice: a reactive ENTITY whose typed FIELDS own
// persistence, sync, and event emission. Authorization lives WITH the data.
//
// Model: a Canvas (the editing session) with multiple Layers. Each Layer has
// a base image (base64 snapshot, LWW) and an append-only stroke log. Brush
// strokes are replayed client-side to reconstruct the pixel state.
//
// PAIN POINTS surfaced by this design (see PAIN-POINTS.md):
//   [A] No blob/bytes field → image data crammed into `text` as base64 (BLOCKER).
//   [B] No raster CRDT → fake it with `log()` stroke replay (BLOCKER).
//   [C] No ordered collection → layer z-order via `number` field, fragile (SHOULD-FIX).
//   [D] No undo/redo primitive → `log()` is append-only; undo needs custom stack (SHOULD-FIX).
//   [E] No boolean type → `visible` is `number` with 0/1 (NIT).
//   [F] No render pipeline → PNG export is a manual route, no computed-binary field (SHOULD-FIX).
import { entity, text, number, ref, date, set, presence, log,
          grant, deny, hide,
          read, write, subscribe, admin, router, owner } from 'express-plus';

// ── Layer entity (owned by Canvas) ──────────────────────────────────────────
//
// A Layer is a raster plane with a base image + an append-only stroke log.
// Clients reconstruct the layer's pixel state by replaying the stroke log
// over the base. The merge primitive is the log's append order — deterministic,
// but not a true raster CRDT (pain point [B]).
export const Layer = entity('Layer', {
  fields: {
    // Parent Canvas FK. Layers are owned by a Canvas and have no independent
    // lifecycle. `required: true` enforces Canvas existence on create.
    canvas:    ref('Canvas', { required: true }),

    name:      text({ default: 'Layer 1', max: 100 }),

    // Opacity: 0.0–1.0. No float constraint on `number` — framework trusts the
    // client. Clamp is a presentation concern.
    opacity:   number({ default: 1 }),

    // Visibility toggle. [E] No boolean type exists in the field vocabulary —
    // we encode 1=visible, 0=hidden as `number`.
    visible:   number({ default: 1 }),

    // Blend mode string: 'normal', 'multiply', 'screen', 'overlay', etc.
    blendMode: text({ default: 'normal' }),

    // Z-order index. Higher = rendered on top. [C] `set(ref('Layer'))` on Canvas
    // is unordered; we maintain order via this per-Layer `number` field. But
    // `number` is LWW — concurrent reorders (two users moving different layers)
    // can produce duplicate order values or violate the ordering invariant.
    // An ordered-collection / array field type would fix this.
    order:     number({ default: 0 }),

    // ── THE BLOB GAP [A] ───────────────────────────────────────────────────
    // Base image: base64-encoded PNG/JPEG data. LWW replacement when the user
    // uploads a new image, flattens the layer, or pastes a selection.
    //
    // THERE IS NO `blob` / `bytes` / `binary` FIELD TYPE. We base64-encode
    // raster pixel data into `text`, costing ~33% storage overhead, no
    // streaming, no chunked upload. The `max: 50_000_000` is an arbitrary
    // ceiling on a text field pretending to hold binary — a 4K RGBA canvas
    // (~32 MB uncompressed) fits; larger canvases exceed it. A proper `bytes`
    // field would own chunked storage, streaming read/write, and content-type
    // metadata natively.
    imageData: text({ default: '', max: 50_000_000 }),

    // ── THE RASTER CRDT GAP [B] ────────────────────────────────────────────
    // Brush strokes: append-only log of stroke operations. Each entry is a
    // JSON-serialized object: { tool, brush, color, opacity, blendMode,
    //   points: [{ x, y, pressure }], timestamp }.
    //
    // `text.crdt()` merges strings character-by-character — it does NOT merge
    // pixel regions, brush strokes, or raster state. There is no `raster.crdt()`
    // or `region.crdt()` field that would merge overlapping pixel edits.
    //
    // Our workaround: treat brush strokes as an append-only operations log.
    // Clients replay the entire log client-side to reconstruct the raster.
    // This is deterministic (same base + same log = same result) but:
    //   (a) replay cost grows linearly with stroke count — every new client
    //       joining a session with 10,000 strokes recomputes 10,000 strokes.
    //   (b) There is no server-side merge — the server is a dumb append sink.
    //   (c) No conflict resolution for overlapping brush strokes — if two
    //       users paint the same pixel region concurrently, the result is
    //       stroke-order-dependent (last stroke wins per-pixel), which is
    //       correct for paint blending but not a first-class merge primitive.
    //
    // A proper solution would be a `raster.crdt()` field that accepts per-pixel
    // or per-region ops, merges them with a compositing strategy (e.g., LWW
    // per-pixel, Porter-Duff blending, or a custom merge function), and emits
    // deltas the client applies to a local texture without full replay.
    strokes:   log(),
  },

  // Layer authorization: a user can access a Layer iff they can access its
  // parent Canvas. The Canvas's grant already decides; we delegate by loading
  // the parent and checking the same conditions. (No cross-entity grant
  // delegation API exists — we re-check manually.)
  grant: async ({ load, entity, user }) => {
    const canvas = await load(entity.canvas);
    const isOwner = canvas.owner === user.id;
    const isCollab = canvas.shares.has(user.id);
    if (isOwner || isCollab) return grant(read, write, subscribe);
    return hide();
  },
});

// ── Canvas entity (the editing session) ─────────────────────────────────────
export default entity('Canvas', {
  fields: {
    title:     text({ max: 200, default: 'Untitled Canvas' }),
    width:     number({ default: 800, min: 1, max: 8192 }),
    height:    number({ default: 600, min: 1, max: 8192 }),
    owner:     ref('User', { role: owner, readonly: true }),
    shares:    set(ref('User')),

    // ── THE ORDERED-COLLECTION GAP [C] ─────────────────────────────────────
    // `set(ref('Layer'))` is an UNORDERED set of FK references. Layer z-order
    // is maintained by each Layer's `order` number field, sorted client-side.
    //
    // Problems:
    //   1. Reordering layer N to position P requires updating two `order` fields
    //      (the moved layer + the displaced layer). Two LWW writes across two
    //      entity rows — no transactional boundary, no ordered-list merge.
    //   2. Concurrent reorders produce inconsistent orderings (duplicate values,
    //      gaps). The `number` field is LWW — last writer to each layer's `order`
    //      wins, but the set of order values as a whole is not merged.
    //
    // An `array(ref())` / `list(ref())` field type with insert-at-index semantics
    // and a list-CRDT merge (e.g., RGA, LSEQ) would fix this. The set field does
    // not carry ordering; `number` fakes it but doesn't merge it.
    layers:    set(ref('Layer')),

    // Per-user cursor position. Ephemeral (not persisted).
    presence:  presence({ cursor: true }),
    chat:      log(),
    createdAt: date({ default: () => new Date(), readonly: true }),
    updatedAt: date({ touch: true, readonly: true }),
  },

  checks: {
    owner:        ({ entity, user }) => entity.owner === user.id,
    collaborator: ({ entity, user }) => entity.owner === user.id || entity.shares.has(user.id),
  },

  grant: async ({ is }) => {
    if (is.owner())              return grant(read, write, subscribe, admin);
    if (is.collaborator())       return grant(read, write, subscribe);
    return hide();
  },

  routes: (r, Canvas) => {
    // Auto-CRUD at /canvases + /:id/chat + /:id/presence + /:id/layers.
    // `r.resource()` auto-surfaces `log`/`presence` sub-resources so clients
    // can bootstrap history/roster before subscribing to live deltas.
    r.resource();

    // ── THE RENDER-PIPELINE GAP [F] ───────────────────────────────────────
    // Export to PNG: composites all visible layers (ordered by `order`) into
    // a single PNG buffer. There is no "computed field that produces binary"
    // in the framework — no `derived` that returns a buffer, no `render` field
    // type. This is a manual route that:
    //   1. Loads all layers via FK traversal.
    //   2. Sorts by `order`.
    //   3. Decodes each layer's base64 `imageData`.
    //   4. Replays each layer's `strokes` log into a pixel buffer.
    //   5. Composites layers by blend mode + opacity.
    //   6. Encodes to PNG and streams the buffer.
    //
    // The framework has no opinion on binary rendering. A `render` field that
    // is a function `(entity) => Buffer` with caching + invalidation would
    // declaratively own this, but it doesn't exist.
    r.get('/:canvasId/export.png', exportPng());
  },
});

// ── Export PNG handler (sketch) ─────────────────────────────────────────────
// Real path would use `sharp` or `canvas` npm packages to composite layers,
// decode base64, replay strokes, blend, and encode PNG.
function exportPng() {
  return async (req, res) => {
    const canvas = req.canvas; // auto-bound by framework from :canvasId param

    const layers = await canvas.layers.toArray(); // FK auto-population
    const sorted = layers
      .filter((l) => l.visible)
      .sort((a, b) => a.order - b.order);

    // Composite: decode base64 imageData, replay strokes, blend by mode + opacity.
    // const pngBuffer = await compositeToPng(sorted, canvas.width, canvas.height);

    // Exemplar only: this is the point where the framework stops helping.
    res.status(501).json({
      error: 'PNG compositing requires a server-side image library (sharp/canvas).',
      layerCount: sorted.length,
      canvasSize: { width: canvas.width, height: canvas.height },
    });
  };
}
