// photo-editor.mjs — a shared collaborative photo editor (raster editing)
// expressed in the grilled express-plus API.
//
// This is a DESIGN STRESS-TEST, not production code. It attempts to declare
// entities for a Figma-for-photos app using ONLY the grilled API surface
// (post-grill, after all 7 ADRs). Where a construct does not exist, the code
// shows the failing attempt and names the gap.
//
// PERSONA: "The Pixel Pusher" — skeptical that a framework built around
// collaborative text CRDTs can handle collaborative raster editing, binary
// blob storage, ordered layer collections, and declarative render pipelines.
//
// Key grilled facts respected:
//   - Auth = TWO questions (read a row, edit it). No hide()/visibility axis.
//   - `checks` are PLAIN functions. `scope(...)` declares read intent;
//     `.can(fn)` = every other capability. Exactly two halves.
//   - `scope` is the ONLY grant compiled to SQL. Non-compilable check in
//     scope = LOAD-TIME ERROR.
//   - Field access always runtime `.can`. Field read-denial = `withheld`.
//     No-`.can` field strong-inherits row grant.
//   - Live delivery = re-auth-at-emit (latched) + subscriber interest
//     (data-not-code). NOT a third grant method.
//   - Effects = `{ mutate, with }`; bounded in-transaction effect-principal
//     reentrancy; same tx/composed event.
//   - NO DEFAULT GRANT (ADR #7): entity with no grant = LOAD-TIME ERROR.
//   - `never()`/`.is(undefined)` compile to SQL FALSE.

import {
  entity, text, number, date, ref, map, boolean, link, presence,
  grant, deny, read, write, subscribe, admin, anyOf, scope, never,
  inherit, router, User,
} from 'express-plus';

// ═══════════════════════════════════════════════════════════════════════════════
// ASPIRATIONAL IMPORTS — constructs now in the designed API (resolved) or
// deferred per SPEC.md. Referenced in comments below.
// ═══════════════════════════════════════════════════════════════════════════════
// import { blob, raster, list, projected } from 'express-plus';
//
// blob({ accept, maxSize })
//   RESOLVED (SPEC §5.1, ADR #9): binary field built-in with streaming
//   upload, content-type validation, and field-type persistence strategy.
//   Needed for: Layer.imageData (raw RGBA pixels), Canvas.export.
//
// raster.crdt({ mergeStrategy })
//   SHIPS as proof that the CRDT field-type contract is sufficient
//   (SPEC §5.1). Per-region CRDT merge for pixel buffers, region-deltas,
//   compaction. The custom CRDT-authoring TOOLKIT is deferred — raster, like
//   text.crdt and polyline, is a built-in instance, not a user-authored plugin.
//
// list(ref(T), { ordered: true })
//   RESOLVED (SPEC §5.1, ADR #9): ordered list field type with fractional-
//   index keyspace for atomic insertAt / move / reorder without renumbering.
//   Needed for: Canvas.layers (z-order).
//
// projected.async({ from, compute })
//   RESOLVED (SPEC §5.3, ADR #12): stored computed field updated by post-
//   commit projection over the committed log. The motivating case is exactly
//   this file — rendered PNG from composited layers. The old `render`
//   aspirational name is retired; the real name is `projected.async`.


// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY BUNDLES — typed, imported, never strings.
// ═══════════════════════════════════════════════════════════════════════════════

const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];


// ═══════════════════════════════════════════════════════════════════════════════
// Canvas — the top-level collaborative photo editing document.
//
// This models a Figma-for-photos canvas: width × height, ordered layers,
// collaborators with roles, link-share, and a render pipeline triggered when
// layers change.
// ═══════════════════════════════════════════════════════════════════════════════

export const Canvas = entity('Canvas', {
  fields: {
    title: text({
      validate: v => v.length <= 200 || 'title too long',
    }),

    width:  number({ default: 1920, min: 1, max: 8192 }),
    height: number({ default: 1080, min: 1, max: 8192 }),

    owner: ref('User', { role: 'owner', readonly: true }),

    collaborators: map(ref('User'), {
      role: ['viewer', 'editor'],
      default: {},
    }).can(async ({ is }) =>
      (await is.owner())
        ? grant(...OWNER)
        : deny('only the owner may manage collaborators')),

    linkShare: link({ tiers: ['view', 'edit'], tier: 'view', token: 'autogen' })
      .can(async ({ is }) =>
        (await is.owner())
          ? grant(...OWNER)
          : deny('only the owner may manage link sharing')),

    // ── RESOLVED: the Canvas owns layers via `list` with `ordered: true` ─────
    // (SPEC §5.1, ADR #9). No standalone RasterLayer entities + FK + fragile
    // client-side sort — the field-type plugin owns the keyspace.
    // Real API:
    //   layers: list(ref('RasterLayer'), { ordered: true }),
    //
    // Below is the pre-resolution state (no collection field).

    backgroundColor: text({ default: '#ffffff', max: 9 }),

    presence: presence({ cursor: true }),

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),
  },

  checks: {
    owner:        ({ Canvas, principal }) => Canvas.owner.is(principal.id),
    collaborator: ({ Canvas, principal }) => Canvas.collaborators.has(principal.id),
    editor:       ({ entity, principal }) =>
                     entity.collaborators.get(principal.id)?.role === 'editor',
    viewer:       ({ entity, principal }) =>
                     entity.collaborators.get(principal.id)?.role === 'viewer',
    linkHolder:   ({ Canvas, principal }) =>
                     principal.type === 'link'
                       ? Canvas.linkShare.token.is(principal.attributes?.token)
                       : never(),
  },

  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator(), is.linkHolder()))
      .can(async ({ is, entity }) => {
        if (await is.owner())    return grant(...OWNER);
        if (await is.editor())   return grant(...EDITOR);
        if (await is.viewer())   return grant(...VIEWER);
        if (await is.linkHolder()) {
          const tier = entity.linkShare.tier;
          return grant(...(tier === 'edit'
            ? EDITOR
            : VIEWER));
        }
        return deny('no capability for this principal');
      }),
  ],

  // ── RESOLVED: render pipeline via projected.async (SPEC §5.3, ADR #12) ──
  //
  // A render pipeline should recompute the composited PNG whenever any
  // layer changes. The old grilled `effects` were `{ mutate, with }` —
  // in-transaction data mutations only, which could not run external
  // compositing (sharp/canvas). The designed API splits on the atomicity
  // boundary:
  //
  //   Wall A (computation) — `projected.async` is a stored computed field
  //   updated by a post-commit projection over the committed log with a
  //   sequence watermark and explicit staleness. The compute function shelling
  //   out to sharp/canvas is the motivated case in the spec.
  //
  //   Wall B (out-of-transaction) — out-of-band effects are projections
  //   over the committed event log (SPEC §9.3, ADR #8): independently
  //   durable, retried on their own schedule, never rolling back the origin.
  //   `projected.async` is the in-framework read-model case of this same
  //   projection primitive.
  //
  // Real API (the field declaration owns its own projection strategy):
  //
  //   export: projected.async({
  //     from: 'layers',     // tracks changes to the ordered layers list
  //     compute: async (canvas) => {
  //       const layers = await canvas.layers.toArray();
  //       return compositeToPng(layers, canvas.width, canvas.height);
  //     },
  //   }),
  //
  // The projection principal (a bounded post-commit consumer, ADR #8) is
  // admitted by the target's own grant. No hand-rolled route handler, no
  // polling — the committed log is the source.
  //
  // IDEALIZED pre-resolution effects approach (kept for contrast):
  //
  //   effects: {
  //     [RasterLayer.events.anyMutate]: {
  //       mutate: self,
  //       with: { export: render.compute(entity) },
  //     },
  //   },

  routes: (r, Canvas) => {
    r.resource();

    // ── Render route — now expressible as projected.async ──────────────────
    //
    // The old hand-rolled pipeline (below) is replaced by `projected.async`
    // (SPEC §5.3, ADR #12): the field declaration owns its own projection
    // strategy — dependency-tracking, caching, invalidation, content-type.
    // The committed log is the source; no polling, no hand-rolled route.
    r.get('/:canvasId/export.png', async (req, res) => {
      const canvas = await Canvas.getOrFail(req.params.canvasId);
      const layers = await RasterLayer.findAll(
        RasterLayer.canvas.is(canvas.id),
      );
      layers.sort((a, b) => a.order - b.order);

      const png = await compositeToPng(layers, canvas.width, canvas.height);

      // Real API (projected.async field, self-serve via r.resource):
      //   const png = await canvas.export.toBuffer();
      //   // `export` is a projected.async field — cached, auto-invalidated,
      //   // content-type baked in, served through the resource route.

      res.type('image/png').send(png);
    });

    // ── Layer sub-resource ──────────────────────────────────────────────────
    r.use('/:canvasId/layers', layerRoutes());
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// RasterLayer — a single raster layer in a canvas.
//
// Designed as a STANDALONE entity (not a field-owned collection on Canvas)
// because the grilled API's `map` is unordered. In the idealized API,
// Canvas would have `layers: array(ref('RasterLayer'))` with list-CRDT merge.
// Here, ordering is simulated via `RasterLayer.order: number()` (fragile).
//
// Grant is inherited from Canvas via `inherit('Canvas', { via: 'canvas' })` —
// this RESOLVES prior pain point #7 ("no cross-entity grant delegation").
// The grilled `inherit` compiles BOTH the parent's read-scope (SQL WHERE join
// through the `canvas` FK) AND the parent's `.can`.
// ═══════════════════════════════════════════════════════════════════════════════

const inheritCanvas = inherit(Canvas, { via: 'canvas' });

export const RasterLayer = entity('RasterLayer', {
  fields: {
    canvas: ref('Canvas', { required: true }),

    name: text({
      default: 'New Layer',
      validate: v => v.length <= 100 || 'name too long',
    }),

    // ── RESOLVED: raster.crdt ships as a built-in (SPEC §5.1, ADR #9) ──────
    //
    // The core collaborative data is pixel buffers. `fieldType.crdt` is one of
    // the four named-whole field contracts (ADR #9): `text.crdt()` is one
    // instance (character-level string merging), `raster.crdt()` another
    // (per-region pixel merge). These ship as proof of the contract; only the
    // custom CRDT-authoring TOOLKIT is deferred (SPEC §5.1). Per-region merge
    // avoids forcing pixels into `text` as base64 (storage inflation, no
    // streaming, no content-type metadata, whole-field LWW conflict on every
    // co-edit).
    imageData: raster.crdt({
      mergeStrategy: 'blend',   // Porter-Duff compositing per-region
      compaction: true,         // periodically flatten the stroke log
    }),

    // ── RESOLVED (vs prior): boolean exists ────────────────────────────────
    //
    // Prior report said "no boolean field type" — the grilled API added it.
    // comment.mjs uses `boolean({ default: false })`. ✔
    visible: boolean({ default: true })

      // ── FIELD-LEVEL ACCESS: visibility gating via .can() ──────────────────
      //
      // The grilled API's field `.can(fn, defaults)` is the correct home for
      // per-layer visibility rules. Viewers should not read invisible layers
      // → field read-denial → `withheld` marker. Editors (who control
      // visibility) see all layers regardless.
      //
      // CHICKEN-AND-EGG NOTE: `.can` needs `entity.visible` (the field's own
      // current value) to decide whether to grant read. This works because the
      // row is materialized before `.can` runs (field access is always runtime
      // per ADR #3): the framework loads the full row from DB, then runs `.can`
      // per field, then returns only authorized fields. entity.visible IS
      // available during `.can` evaluation. This is a sharp edge, but a
      // correct one — it flows from the grilled design, not a gap.
      .can(async ({ is, entity }, defaults) => {
        // Editors always see all layers (they control visibility)
        if (await is.editor()) return defaults;
        // Owner always sees all layers
        if (await is.owner()) return defaults;
        // Viewers + link-holders: inherit row grant normally if visible
        if (entity.visible) return defaults;
        // Invisible layer for a non-editor viewer:
        // deny read → framework produces `withheld` marker
        // keep subscribe so client is notified when visibility changes
        return grant(subscribe);
      }),

    // ── RESOLVED: ordered list field type (SPEC §5.1, ADR #9) ──────────────
    //
    // Layers are inherently ordered (z-order: background → foreground). The
    // `ordered` field-type contract uses a fractional-index keyspace for
    // atomic insertAt / move / reorder without renumbering — no two-layer
    // LWW collision, no client-side fragility. The `order: number()` below
    // is the old workaround.
    //
    // Real API (the Canvas owns the ordered collection):
    //   layers: list(ref('RasterLayer'), { ordered: true }),
    //   // → canvas.layers.insertAt(layer, 3)  // one mutation, one event
    //   // → positional deltas via fractional-index CRDT merge
    order: number({ default: 0 }),

    opacity: number({ default: 100, min: 0, max: 100 }),

    blendMode: text({
      default: 'normal',
      validate: v =>
        ['normal','multiply','screen','overlay','darken','lighten',
         'color-dodge','color-burn','hard-light','soft-light','difference',
         'exclusion','hue','saturation','color','luminosity'].includes(v)
          || 'invalid blend mode',
    }),

    createdAt: date({ default: () => new Date() }),
  },

  // ── RESOLVED (vs prior): grant inheritance ────────────────────────────────
  //
  // `inherit('Canvas', { via: 'canvas' })` compiles BOTH parent read-scope
  // (SQL JOIN through `canvas` FK → rows are readable exactly when Canvas is
  // readable) AND parent `.can` (write/admin capability). This is exactly
  // what "same as parent Canvas" authorization needs. ✔
  grant: inheritCanvas,

  checks: {
    // Check for field `.can()` visibility gating — runtime only (non-compilable
    // because it traverses the `canvas` FK to read Canvas.collaborators). Used
    // ONLY in field `.can()`, never in `scope` (scope comes from inheritCanvas,
    // which compiles the Canvas-side scope).
    editor: async ({ entity, principal }) => {
      const canvas = await entity.canvas;
      return canvas.collaborators.get(principal.id)?.role === 'editor';
    },
    // Owner check (the Canvas owner). Also runtime-only — same reason.
    owner: async ({ entity, principal }) => {
      const canvas = await entity.canvas;
      return canvas.owner === principal.id;
    },
  },

  routes: (r) => {
    r.resource();
  },
});




// ═══════════════════════════════════════════════════════════════════════════════
// Layer sub-routes — mounted under /canvases/:canvasId/layers
// ═══════════════════════════════════════════════════════════════════════════════

function layerRoutes() {
  const r = router({ mergeParams: true });
  r.mount('/', RasterLayer);

  // ── Reorder endpoint — now expressible via `list` with `ordered: true` ──
  //
  // The `ordered` field type (SPEC §5.1, ADR #9) uses a fractional-index
  // keyspace — atomic insertAt / move / reorder in one mutation, one event.
  // No fragile dual-LWW hand-roll.
  r.post('/:layerId/move', async (req, res) => {
    const { newIndex } = req.body;
    // Real API: canvas.layers.move(layerId, newIndex)
    res.json({ moved: true });
  });

  return r;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Stub compositor — would use sharp/canvas in a real implementation.
// Now expressible via projected.async (SPEC §5.3, ADR #12): a stored
// computed field updated by post-commit projection over the committed log.
// ═══════════════════════════════════════════════════════════════════════════════

async function compositeToPng(layers, width, height) {
  // In a real app:
  //   import sharp from 'sharp';
  //   const composite = sharp({ create: { width, height, channels: 4, background: bg } });
  //   for (const layer of layers) {
  //     if (!layer.visible) continue;
  //     composite.composite([{ input: Buffer.from(layer.imageData, 'base64'), ... }]);
  //   }
  //   return composite.png().toBuffer();
  return Buffer.alloc(0);
}
