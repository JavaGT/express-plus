# Pain Points: Collaborative Photo Editor on workbench (post-grill)

> **Stress-test of the grilled API** (7 ADRs, DECISIONLOG.md).  
> **Persona:** "The Pixel Pusher" — cares about CRDTs beyond text, binary
> storage, ordered collections, and whether declarative effects can drive a
> render pipeline.
>
> **Exemplar code:** `photo-editor.mjs` in this directory.

---

## Attempted entity shape

The photo editor declares two entities attempting to use ONLY the grilled API
surface:

```js
// Canvas — top-level collaborative photo editing document
// RasterLayer — standalone entity, grant inherited from Canvas via inherit()

Canvas = entity('Canvas', {
  fields: {
    title, width, height,
    owner: ref('User', { role: 'owner' }),
    collaborators: map(ref('User'), { role: ['viewer','editor'] }),
    linkShare: link({ tiers: ['view','edit'] }),
    // GAP: layers would be array(ref('RasterLayer')) — doesn't exist
    presence, createdAt, updatedAt,
  },
  checks: { owner, collaborator, editor, viewer, linkHolder },
  grant: scope(anyOf(is.owner(), is.collaborator(), is.linkHolder()))
           .can(async ({ is, entity }) => { /* tier → capabilities */ }),
  routes: (r) => { r.resource(); r.get('/:id/export.png', /* manual */); },
});

RasterLayer = entity('RasterLayer', {
  fields: {
    canvas: ref('Canvas'),
    // BLOCKER: raster.crdt() doesn't exist → forced into text() as base64
    imageData: text({ max: 50000000 }),
    // WORKING: visibility gating via field .can() + withheld marker
    visible: boolean({ default: true })
      .can(async ({ is, entity }, defaults) => {
        if (await is.editor()) return defaults;
        if (entity.visible) return defaults;
        return grant(subscribe);           // deny read → withheld
      }),
    // GAP: ordering via number() — fragile, non-atomic reorder
    order: number({ default: 0 }),
    opacity, blendMode, createdAt,
  },
  grant: inherit('Canvas', { via: 'canvas' }),  // RESOLVED: prior gap #7
  checks: { editor, owner },
});
```

---

## Pain points

### BLOCKER #1 — No raster CRDT field type; no custom CRDT plugin contract

**Failing code:**
```js
imageData: text({ max: 50000000 })
// IDEALIZED:
// imageData: raster.crdt({ mergeStrategy: 'blend' })
```

**What fails:** The only merge primitive is `text.crdt()` — character-level
string merging (Yjs/Automerge-style). A photo editor's core conflict is two
users painting overlapping regions concurrently. Forcing pixels into `text`
as base64:
- 33% storage overhead (base64 inflation)
- No streaming — entire field loads for every mutation
- No content-type metadata
- No per-region merge — two users painting different regions still produce an
  LWW conflict on the entire base64 string
- No compaction — the full pixel buffer is rewritten every mutation

**Which ADR/design feature this tests:** ADRs #1–2 (no hide axis, scope + can
= exactly two grant halves). The grilled design's auth model is correct for
raster data (read a pixel region? edit it? same two questions). What fails is
the FIELD-TYPE CATALOG: `text.crdt()` is the ONLY merge-aware field, and the
plugin contract for adding new CRDT types is undefined.

The implementation plan Phase 1 item 1 promises a "Field-type plugin contract
+ mutation pipeline" but doesn't define its shape. Without it, `raster.crdt()`
can't be designed — not even idealized — because we don't know what
`validate → access → apply → diff → persist|ephemeral → emit` expects from a
plugin, nor how merge strategies are declared.

**What's needed:** A defined field-type plugin contract so `raster.crdt()`
(and `polyline.crdt()`, `grid.crdt()`, etc.) can be implemented as plugins
rather than ad-hoc additions to a closed catalog.

---

### BLOCKER #2 — No blob/bytes binary field type

**Failing code:**
```js
imageData: text({ max: 50000000 })
// IDEALIZED:
// imageData: blob({ maxSize: 256 * 1024 * 1024, contentType: 'image/*' })
```

**What fails:** A 4096×4096 RGBA canvas is ~64 MB uncompressed. The only
field that can store large data is `text`, which:
- Inflates binary by ~33% (base64 encoding)
- Has no streaming — can't read/write a chunk (single tile of a large canvas)
- Has no content-type metadata — is this PNG, JPEG, or raw RGBA?
- Has no deduplication or hash-based storage
- Has an arbitrary `max` ceiling in characters, not bytes

**Which ADR/design feature this tests:** The implementation plan Phase 2 item
12 lists `blob` as a planned built-in plugin. The grilled exemplars don't
include it. For the photo editor, `blob` is as fundamental as `text` is for
a document editor — the core data is binary pixels, not strings.

**What's needed:** A `blob(maxSize, { contentType, dedup })` field that owns
chunked storage, streaming reads/writes, content-type tagging, and optional
hash-based dedup. Mutations emit `:changed` (LWW) — same event contract as
`text`, reusing the live-sync plumbing.

---

### SHOULD-FIX #1 — No ordered array collection (layers need z-order)

**Failing code:**
```js
// On RasterLayer: fragile ordering via number()
order: number({ default: 0 })

// On Canvas: NO collection field declared — layers are standalone entities
// related by FK, sorted client-side by `order`.

// IDEALIZED on Canvas:
// layers: array(ref('RasterLayer'))
// → canvas.layers.move(layerId, 3)  // ONE mutation, ONE event
```

**What fails:** Layers are inherently ordered (z-order: background on bottom,
foreground on top). The grilled API's `map` (valued set) is UNORDERED and
keyed by a ref type — it can't express positional order. The workaround:
1. Layers are standalone `RasterLayer` entities with a `canvas` FK + `order`
   number
2. Reordering layer at index 3 to index 1 requires TWO LWW writes (moved
   layer's `order` + displaced layer's `order`)
3. If one write succeeds and the other fails → corrupted ordering
4. Concurrent reorders produce duplicate/colliding `order` values
5. Every consumer must sort by `order` before rendering — fragile convention

**Which ADR/design feature this tests:** Phase 2 item 12 lists `array` as a
planned built-in. The `map` plugin (Phase 1 item 4) solves valued sets
(keyed-member uniqueness) but NOT ordered collections. An `array(ref(T))`
field with list-CRDT merge (RGA/LSEQ) would own insert-at, move-to,
remove-at, emitting positional deltas — one mutation, one event, no drift.

**What's needed:** `array(ref(T))` with list-CRDT merge, insert-at-index
semantics, delete-and-close-gap, and move-to-index as a single atomic
mutation. Same field-owns-events contract as every other field type.

---

### SHOULD-FIX #2 — Effects can't drive a render pipeline (two walls)

**Failing code:**
```js
// IDEALIZED effect — DOES NOT COMPILE against the grilled API:
effects: {
  [RasterLayer.events.anyMutate]: {
    mutate: self,
    with: { export: compositeToPng(entity) },   // ← WALL A
  },
},

// IDEALIZED render field:
export: render({
  format: 'image/png',
  compute: async (canvas) => {                   // ← WALL B
    const layers = await canvas.layers.toArray();
    return compositeToPng(layers, canvas.width, canvas.height);
  },
}),
```

**Wall A — `with` templates can't run computations.** The `{ mutate, with }`
primitive interpolates only `delta.member`, `entity.id`, and trigger-delta
fields. A render pipeline IS a computation: compositing N layers with opacity
+ blend modes + masks into a single PNG buffer. There is no way to express
"run function X, store the result in field Y" in the `with` template.

**Wall B — Effects are bounded in-transaction DB mutations only.** FEATURES.md
§7: "Out-of-band side effects (webhooks, emails, external HTTP) — NOT yet
designed." Rendering calls sharp/canvas/image libraries — these are
out-of-band computations, not DB mutations. Even if `blob` existed (BLOCKER
#2), an effect can't invoke an external render library.

**Which ADR/design feature this tests:** ADR #6 (declarative effects). The
grilled `effects` are correctly bounded (in-transaction, effect-principal,
no SYSTEM god, structural cycle = load-time error). But they cover ONLY
the "mutation triggers another mutation" case — not the "mutation triggers
a computation whose RESULT is stored" case. The photo editor's render
pipeline needs the latter: layer changes → composite → store PNG.

Without this, the ENTIRE render pipeline is hand-rolled in route handlers:
no caching, no dependency-tracking invalidation, no declarative trigger, no
integration with the mutation pipeline.

**What's needed:** One of:
- A `render({ format, compute })` field type that owns dep-tracking
  invalidation, caching, and content-type (the declarative approach —
  framework owns the pipeline)
- `effects` extended with a `compute` variant that runs a declared function,
  stores the result in a field, and invalidates on dependency changes
- Out-of-band effect hooks (deferred per FEATURES.md §7)

---

### Sharp edge #1 — Field `.can()` reading its own value (chicken-and-egg)

**Code that works but tests a subtle contract:**
```js
visible: boolean({ default: true })
  .can(async ({ is, entity }, defaults) => {
    if (entity.visible) return defaults;   // ← reading this field's OWN value
    return grant(subscribe);
  }),
```

**What's subtle:** To decide whether `visible` should be withheld, `.can()`
reads `entity.visible` — the field's own current value. This works because
ADR #3 says field access is always runtime and the row is already
materialized when `.can` runs. But it means the framework MUST load the
entire row (including fields with `.can` overrides) before evaluating any
`.can`, not lazily. This is a correct consequence of the grilled design, not
a bug — but it's a sharp edge worth documenting: a lazy-load implementation
would deadlock on any field whose `.can` reads itself.

---

### Sharp edge #2 — No typed compound event trigger for effects

**Code that can't be expressed:**
```js
// IDEALIZED: trigger when ANY of these fields change on ANY RasterLayer
// that belongs to this Canvas:
effects: {
  [RasterLayer.events.anyMutate]: { ... },
}
```

**What fails:** Even if `blob` + render computation existed, effects are
triggered by a single typed event handle (e.g., `collaborators.onAdded`).
There is no compound trigger like "any field on any child RasterLayer
changes." The canvas render should recompute when imageData, visibility,
opacity, blendMode, or order changes — on ANY of its layers. That is N
separate triggers = N separate effect declarations. This is expressible
(declare one effect per trigger) but noisy, and the framework must
deduplicate when multiple fields change in one batch.

---

### Sharp edge #3 — No batch mutation API for multi-entity reorder

**Failing code:**
```js
// Reorder: two separate LWW writes, no atomic boundary
await movedLayer.update({ order: 1 });
await displacedLayer.update({ order: 3 });
// If the second fails after the first succeeds → ordering corrupted

// IDEALIZED (with array field):
// await canvas.layers.move(layerId, 3);   // ONE mutation
```

**What fails:** The workaround for ordered collections (per-Layer `order`
number) requires multi-entity mutation for any reorder. There is no
`.batch()` API in the grilled surface to make multiple entity writes atomic.
The implementation plan mentions `batch()` as "the pipeline run in a
transaction emitting one composed event" but doesn't exemplify the API.
This sharp edge is a consequence of SHOULD-FIX #1 (no `array` field).

---

## Prior findings re-checked

| # | Prior finding (pre-grill) | Status | Why |
|---|--------------------------|--------|-----|
| 1 | No blob/bytes field | **STILL-OPEN** | Planned in Phase 2 item 12; not in grilled API surface. BLOCKER #2 above. |
| 2 | No raster CRDT merge | **STILL-OPEN** | No design; blocked on undefined custom CRDT plugin contract. BLOCKER #1 above. |
| 3 | No ordered collection | **STILL-OPEN (NEW-ANGLE)** | Planned in Phase 2 item 12; `map` (valued set) is unordered. The grilled API adds `map` but NOT `array`. SHOULD-FIX #1 above. |
| 4 | No undo/redo primitive | **STILL-OPEN** | Deferred per IMPL PLAN P6. The grilled design reserves the `inverse` slot in the operator contract but doesn't expose it. Not raised as a new pain point here — the same gap, unchanged. |
| 5 | No boolean field type | **RESOLVED** | `boolean` is imported and used in `comment.mjs` (`resolved: boolean({ default: false })`). Grill added it. ✔ |
| 6 | No render pipeline | **STILL-OPEN (NEW-ANGLE)** | The grilled API adds `effects` (declarative mutations) but they can't drive a render pipeline — see SHOULD-FIX #2 above. The pre-grill report asked for a `render` field; the grilled answer is `effects`, which solves a DIFFERENT problem (declarative side-effects on mutation) but not THIS one (computation → cached binary output). |
| 7 | No cross-entity grant delegation | **RESOLVED** | `inherit('Canvas', { via: 'canvas' })` compiles BOTH parent read-scope (SQL JOIN through FK) AND parent `.can`. The grilled `comment.mjs` exemplar demonstrates this. ✔ |

---

## Summary ranking

| # | Pain point | Severity | Tests |
|---|-----------|----------|-------|
| 1 | No raster CRDT + no custom CRDT plugin contract | **BLOCKER** | Field-type catalog, plugin extension point |
| 2 | No blob/bytes binary field | **BLOCKER** | Phase 2 item 12 (planned, not surfaced) |
| 3 | No ordered array collection (z-order) | SHOULD-FIX | `map` solves valued sets but not ordered lists |
| 4 | Effects can't drive a render pipeline | SHOULD-FIX | ADR #6 (effects are DB-only, `with` can't compute) |
| 5 | Field `.can()` reading its own value | Sharp edge | ADR #3 (row materialized before field eval) |
| 6 | No compound event trigger for effects | Sharp edge | ADR #6 (single typed handle per effect) |
| 7 | No batch mutation API | Sharp edge | Consequence of no `array` field |

**Verdict:** The grilled design's authorization model (`scope` + `.can`,
`inherit`, `withheld`, field `.can()` visibility gating) maps cleanly to a
photo editor. The `effects` primitive is the RIGHT direction (declarative,
not `afterSave`) but doesn't reach far enough. The real gaps are in the
FIELD-TYPE CATALOG: the grilled API is still text-document-shaped — it has
`text.crdt()` but no `raster.crdt()`, `text` but no `blob`, `map` but no
`array`, `derived` but no `render`. The plugin contract that would let
applications add these types is promised but undefined.
