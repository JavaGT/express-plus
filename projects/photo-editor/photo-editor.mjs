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
// ASPIRATIONAL IMPORTS — constructs the grilled API does not yet export.
// These are the gaps this stress-test surfaces. Referenced in comments below.
// ═══════════════════════════════════════════════════════════════════════════════
// import { blob, raster, array, render } from 'express-plus';
//
// blob(maxSize, { contentType })
//   Binary field with chunked storage, streaming read/write, content-type
//   metadata, optional hash-based dedup. Needed for: Layer.imageData (raw
//   RGBA pixels), Canvas.export (rendered PNG). Phase 2 item 12 of the
//   implementation plan; not yet in API surface.
//
// raster.crdt({ mergeStrategy })
//   Per-region CRDT merge for pixel buffers. Emits region-deltas, supports
//   compaction. Needed for: Layer.imageData (collaborative brush strokes).
//   No design exists; the custom CRDT field plugin contract is undefined.
//
// array(ref(T))
//   Ordered mutable collection with list-CRDT merge (RGA/LSEQ). Supports
//   insert-at, move-to, remove-at, emitting positional deltas. Needed for:
//   Canvas.layers (z-order). Phase 2 item 12; not yet in API surface.
//
// render({ format, compute })
//   Computed-binary field with dep-tracked caching and auto-invalidation.
//   Serves via r.resource() with correct content-type. Needed for:
//   Canvas.export (composited PNG of all visible layers). No design exists.


// ═══════════════════════════════════════════════════════════════════════════════
// CAPABILITY BUNDLES — typed, imported, never strings.
// ═══════════════════════════════════════════════════════════════════════════════

const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];


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

const inheritCanvas = inherit('Canvas', { via: 'canvas' });

export const RasterLayer = entity('RasterLayer', {
  fields: {
    canvas: ref('Canvas', { required: true }),

    name: text({
      default: 'New Layer',
      validate: v => v.length <= 100 || 'name too long',
    }),

    // ── BLOCKER #1: no raster CRDT field ──────────────────────────────────
    //
    // The core collaborative data is pixel buffers. The grilled API offers
    // `text.crdt()` (character-level string merging) but no `raster.crdt()`
    // for per-region pixel-merge. Forcing pixels into `text` as base64:
    //   - 33% storage overhead (base64 inflation)
    //   - No streaming — the entire field loads for every mutation
    //   - No content-type metadata (PNG? JPEG? raw RGBA?)
    //   - No deduplication — identical base images stored N times
    //   - No CRDT merge — two users painting different regions still produce
    //     an LWW conflict on the entire base64 string.
    //
    // IDEALIZED:
    //   imageData: raster.crdt({
    //     mergeStrategy: 'blend',   // Porter-Duff compositing per-pixel
    //     compaction: true,          // periodically flatten stroke log
    //   }),
    imageData: text({ max: 50000000 }),

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

    // ── GAP #1: no ordered array collection ────────────────────────────────
    //
    // Layers are inherently ordered (z-order: background → foreground). The
    // grilled API's `map` (valued set) is UNORDERED and keyed by ref type —
    // it cannot express "the 3rd layer is ...". We fake ordering with an
    // `order: number()` field (LWW), but:
    //   - Reorder = two LWW writes to two different layer entities
    //     (no atomicity — if one write fails, ordering is corrupted)
    //   - Concurrent reorders produce duplicate/colliding `order` values
    //   - Client MUST sort by `order` before every render
    //
    // IDEALIZED (Canvas, not Layer):
    //   layers: array(ref('RasterLayer')),
    //   // → canvas.layers.move(layerId, 3)   // one mutation, one event
    //   // → positional deltas via RGA/LSEQ CRDT merge
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

    // ── GAP: no ordered array collection (see RasterLayer.order above) ─────
    // IDEALIZED:
    //   layers: array(ref('RasterLayer')),
    //
    // No collection field declared here — layers are standalone RasterLayer
    // entities related by FK, ordered by client-side sort of `order`. The
    // `map` (valued set) can't express z-order; it's keyed by User, not
    // position.

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

  grant: ({ principal }) => [
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

  // ── GAP: effects can't drive a render pipeline ───────────────────────────
  //
  // A render pipeline should recompute the composited PNG whenever any layer
  // changes (imageData, visibility, opacity, blendMode, order, or the canvas
  // dimensions). The grilled `effects` are:
  //
  //   effects: { [triggerEvent]: { mutate: <target>, with: <template> } }
  //
  // This hits TWO walls:
  //
  // Wall A — No computation in `with` templates.
  //   Templates interpolate `delta.member`, `entity.id`, and trigger-delta
  //   fields. They cannot run `compositeLayers(canvas)`. A render pipeline
  //   IS a computation — compositing N layers with opacity + blend modes +
  //   masks into a single PNG buffer. `{ mutate, with }` can't express this.
  //
  // Wall B — No out-of-transaction side effects.
  //   Grilled effects are bounded, in-transaction, effect-principal
  //   reentrancy — they re-enter the mutation pipeline for DB writes only.
  //   FEATURES.md §7: "Out-of-band side effects (webhooks, emails, external
  //   HTTP) — NOT yet designed." Rendering is out-of-band: it calls sharp/
  //   canvas/image libraries, which are not DB mutations.
  //
  // IDEALIZED (depends on blob + render + effects with conditional triggers):
  //
  //   effects: {
  //     // On ANY layer field change, invalidate + recompute the render.
  //     // Ideal trigger: a compound event handle covering the relevant fields.
  //     [RasterLayer.events.anyMutate]: {
  //       mutate: self,
  //       with: { export: render.compute(entity) },
  //     },
  //   },
  //
  //   // Or, a `render` field that owns its own invalidation:
  //   export: render({
  //     format: 'image/png',
  //     compute: async (canvas) => {
  //       const layers = await canvas.layers.toArray({ sort: 'order' });
  //       return compositeToPng(layers, canvas.width, canvas.height);
  //     },
  //   }),
  //
  // Without these, the framework expresses NOTHING about the render pipeline.
  // The entire pipeline — trigger detection, caching, invalidation,
  // compositing, content-type — is hand-rolled in route handlers.

  routes: (r, Canvas) => {
    r.resource();

    // ── Manual render route — framework can't help ─────────────────────────
    //
    // Render pipeline is hand-rolled:
    //   1. Load canvas
    //   2. Load all layers via FK traversal (filtered to visible by client)
    //   3. Sort by `order` (client-side)
    //   4. Composite with external library (sharp/canvas)
    //   5. Return PNG buffer with manual content-type header
    //
    // No caching, no dependency-tracking invalidation, no declarative trigger,
    // no integration with the mutation pipeline. Every request recomputes.
    r.get('/:canvasId/export.png', async (req, res) => {
      const canvas = await Canvas.getOrFail(req.params.canvasId);
      // GAP: no typed `.toArray({ sort: field })` or batch-load API.
      const layers = await RasterLayer.findAll(
        RasterLayer.canvas.is(canvas.id),
      );
      // Client-side sort is fragile — see RasterLayer.order gap.
      layers.sort((a, b) => a.order - b.order);

      // Compositing happens outside the framework. No caching.
      const png = await compositeToPng(layers, canvas.width, canvas.height);

      // IDEALIZED:
      //   const png = await canvas.export.png();
      //   // `export` is a `render` field — cached, auto-invalidated,
      //   // content-type baked in.

      res.type('image/png').send(png);
    });

    // ── Layer sub-resource ──────────────────────────────────────────────────
    r.use('/:canvasId/layers', layerRoutes());
  },
});


// ═══════════════════════════════════════════════════════════════════════════════
// Layer sub-routes — mounted under /canvases/:canvasId/layers
// ═══════════════════════════════════════════════════════════════════════════════

function layerRoutes() {
  const r = router({ mergeParams: true });
  r.mount('/', RasterLayer);

  // ── Idealized reorder endpoint — can't be expressed declaratively ───────
  //
  // Reordering a layer requires TWO LWW writes (moved layer + displaced
  // layer), which can't be batched into one atomic mutation in the current
  // API. An `array` field would handle this as a single `.move()` mutation.
  r.post('/:layerId/move', async (req, res) => {
    const { newIndex } = req.body;
    // ... fragile hand-rolled reorder logic with `order` numbers ...
    res.json({ moved: true });
  });

  return r;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Stub compositor — would use sharp/canvas in a real implementation.
// This is the computation that effects CANNOT express.
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
