# Pain Points: collaborative photo editor on express-plus

A design stress-test of the `entity()` reactive-entity API for a domain that is
NOT a text-document app. The framework's field-type vocabulary was designed for
Google Docs (collaborative text editing) and generalizes well to CRUD apps with
user/role/permission modeling — but it breaks down when the core data is a
raster pixel buffer, not a string.

Each pain point cites the **specific API construct tried** and explains **what
failed** and **what a fix would look like**.

---

## 1. No blob / bytes / binary field type

**Severity: BLOCKER**

**Construct tried:** `text({ max: 50_000_000 })` for `Layer.imageData`

**What failed:**

The only field types available are `text`, `text.crdt`, `number`, `date`, `ref`,
`set(ref)`, `presence`, `log`, and `hash`. None stores raw binary. A photo
editor's core data is pixel buffers — a 4096×4096 RGBA canvas is ~64 MB
uncompressed. Forcing this into `text` as base64 means:

- **33% storage overhead** on every read/write (base64 inflates binary by ~33%).
- **No streaming.** A `text` field is loaded in full for every mutation; you
  cannot read/write a chunk (e.g., a single tile of a large canvas).
- **No content-type metadata.** Is the base64 blob PNG, JPEG, or raw RGBA? The
  field doesn't know — the app carries that as a separate `format: text()`
  field, which can drift.
- **Arbitrary max ceiling.** `max: 50_000_000` (chars) ≈ 37 MB decoded binary —
  less than a single 4K RGBA layer. The field doesn't understand that it holds
  pixels; it's a string with a length cap.
- **No deduplication or hash-based storage.** Two layers with the same base image
  are stored twice. A `bytes` field could content-address the blob.

**What a fix would look like:**

```js
// A `bytes` field that owns chunked storage, streaming reads/writes,
// content-type tagging, and optional hash-based dedup.
imageData: bytes({ maxSize: 256 * 1024 * 1024, contentType: 'image/*' })
```

The field would expose `.stream()`, `.write(stream)`, `.range(offset, length)`,
and `.contentType`. Mutations emit `:changed` (LWW) — the same event contract as
`text`, so the live-sync plumbing is reused.

---

## 2. No raster / region-based CRDT merge field

**Severity: BLOCKER**

**Construct tried:** `strokes: log()` as a workaround

**What failed:**

The only merge primitive in the field vocabulary is `text.crdt()` —
character-level string merging (Yjs/Automerge-style). There is no
`raster.crdt()` or `region.crdt()` for merging pixel-buffer edits. A photo
editor is NOT a text document: the core conflict is two users painting
overlapping regions concurrently.

Our workaround — an append-only `log()` of brush strokes replayed client-side —
has fundamental problems:

- **Replay cost.** Every new client joining a session with 10,000 strokes must
  download and replay all 10,000 strokes locally. This is O(stroke count) per
  join; a proper CRDT delta would be O(region changed) ≈ constant for small
  brush edits.
- **No server-side merge.** The server is a dumb append sink. It cannot composite
  strokes into a canonical raster state; it cannot serve a pre-rendered
  thumbnail without replaying the entire log server-side.
- **No conflict resolution strategy.** Two users painting the same pixel — does
  the last stroke win (LWW per-pixel)? Does opacity blend? The `log()` replay is
  order-dependent and opaque to the framework: the framework doesn't know it's
  pixels, so it can't offer a merge strategy.
- **No snapshot/compaction.** The stroke log grows unbounded. A real raster CRDT
  would periodically compact (flatten strokes into a base image + reset the
  operation log) — the framework has no compaction hook.

**What a fix would look like:**

```js
// A raster field with per-pixel or per-region CRDT merge. The merge function
// is a framework extension point — the app provides a compositing strategy.
raster: raster.crdt({
  width: e => e.width,
  height: e => e.height,
  format: 'rgba8',
  // mergeStrategy resolves concurrent edits to the same pixel/region.
  // 'lww' = last-write-wins per-pixel (simplest).
  // 'blend' = Porter-Duff compositing.
  // Custom: (base, ops[]) => resolved.
  mergeStrategy: 'blend',
})
```

Or, more minimally, a `region.crdt()` that operates on rectangular pixel regions
with LWW merge, emitting deltas the client applies to a local texture — no full
replay, no dumb server.

---

## 3. No ordered collection / array field type

**Severity: SHOULD-FIX**

**Construct tried:** `layers: set(ref('Layer'))` + per-Layer `order: number()`

**What failed:**

The only collection field is `set(ref(T))` — an UNORDERED set of FK references.
Layers in a photo editor are inherently ordered (z-order: background on bottom,
foreground on top). We fake ordering with a per-Layer `order` number field, but:

- **Reorder is two LWW writes.** Moving layer at index 3 to index 1 requires
  updating the moved layer's `order` AND the displaced layer's `order`. Two
  separate entity-field mutations with no transactional boundary — if one write
  succeeds and the other fails (network, validation), the ordering is corrupted.
- **Concurrent reorders diverge.** Two users reordering different layers
  simultaneously produce `order` values that may duplicate or collide. `number`
  is LWW per-field — the last writer to each layer's `order` wins, but the
  *set* of order values is not merged as a whole.
- **Fragile client-side sort.** Every consumer must remember to sort by `order`
  before rendering. The framework's FK auto-population (`layers.toArray()`)
  returns results in insertion order or undefined order — it doesn't know about
  the sort field.

```js
// Current — fragile, two mutations, LWW per field:
await movedLayer.update({ order: 1 });
await displacedLayer.update({ order: 3 });
```

**What a fix would look like:**

```js
// An `array(ref(T))` field with insert-at-index semantics and a list-CRDT
// merge (RGA / LSEQ). Reorder is a single field mutation.
layers: array(ref('Layer'))

// Reorder: move layer to index 1. Framework figures out the CRDT op, emits
// a delta to all clients, one mutation, one event.
await canvas.layers.move(layerId, 1);
```

The array field would be backed by a fractional-indexing or RGA CRDT, so
concurrent reorders merge deterministically. The same construct would also fix
ordered todo lists, slide decks, and any domain where item order matters.

---

## 4. No undo/redo primitive

**Severity: SHOULD-FIX**

**Construct tried:** None — no API to try. `log()` is append-only.

**What failed:**

The framework has no undo/redo concept. `text.crdt()` internally tracks
operations for merge, but there is no exposed `.undo()` or `.redo()` method on
any field type. `log()` is explicitly append-only (like a chat): you can only
append, never pop or revert.

A photo editor MUST have undo/redo — it's the most-used keyboard shortcut after
brush. The workaround is to build an undo stack outside the framework:

- Snapshot the entire `imageData` before a stroke batch (expensive for large
  canvases).
- Maintain a separate `undoStack: log()` of inverse operations, replayed in
  reverse — but `log()` doesn't support popping or marking a checkpoint.

**What a fix would look like:**

```js
// A `history` wrapper or field option that tracks mutations and exposes undo.
imageData: text({ history: { depth: 50 } })
// → entity.imageData.undo(), entity.imageData.redo()

// Or, for log-based undo (stroke-by-stroke):
strokes: log({ undoable: true, groupBy: 'batchId' })
// → entity.strokes.undoLastBatch() removes the last batch of strokes
//   and emits a `:reverted:<batchId>` event so clients drop the strokes.
```

This is not a new field type — it's a capability that several existing field
types (`text`, `number`, `set`, `log`) should carry.

---

## 5. No boolean field type

**Severity: NIT**

**Construct tried:** `visible: number({ default: 1 })`

**What failed:**

There is no `boolean` field type. Toggles (layer visibility, "is flattened",
"show grid") are encoded as `number` with 0/1. This is semantically wrong
(`number` means quantity; `boolean` means truth) and forces every consumer to
remember the encoding convention: `if (layer.visible)` works by accident
(0 is falsy, 1 is truthy), but `layer.visible === true` does not.

The framework already has typed field constructors — adding `boolean()` is a
small, obvious gap-fill.

**What a fix would look like:**

```js
visible: boolean({ default: true })
// Emits :changed (same event contract as number/text).
// Validated to true/false at the field boundary.
```

---

## 6. No render / computed-binary pipeline

**Severity: SHOULD-FIX**

**Construct tried:** Manual route `GET /:canvasId/export.png`

**What failed:**

The framework has `derived` fields (pure-pull computed values from other fields)
but only for scalar types. There is no `derived` that produces binary (a PNG
buffer), no render pipeline, and no caching/invalidation for expensive
computations.

Exporting a canvas to PNG is the photo editor's equivalent of "print" — it's a
core operation, not a niche route. The current approach:

1. Write a manual route handler.
2. Load all layers via FK traversal (potentially dozens of queries).
3. Composite server-side with an external library (sharp/canvas).
4. No caching — every request recomputes the full composite.
5. No invalidation — the route doesn't know when a layer changed, so it can't
   cache the result.

**What a fix would look like:**

```js
// A `render` field that is a function (entity) => Buffer, with framework-owned
// caching and dependency-tracking invalidation.
export: render({
  format: 'image/png',
  compute: async (canvas) => {
    const layers = await canvas.layers.toArray();
    return compositeToPng(layers, canvas.width, canvas.height);
  },
})
// → GET /canvases/:id/export returns the PNG.
// → Cached. Auto-invalidated when any layer's relevant fields mutate.
// → Surfaced by r.resource() like any other field.
```

The `render` field tracks which entity fields its `compute` function reads
(Canvas.width, Canvas.height, Layer.imageData, Layer.strokes, etc.) and
invalidates the cache when any of them change. This is the declarative version
of the manual route — the framework owns the cache, the invalidation, and the
content-type header.

---

## 7. No cross-entity grant delegation

**Severity: NIT**

**Construct tried:** Manual re-check in Layer's `grant`

**What failed:**

Layer authorization is "same as parent Canvas." The natural expression would be
to delegate: `return parent.grantCapabilities`. But there is no API for one
entity's `grant` to call another entity's `grant` and receive back a set of
capabilities. We re-check manually:

```js
grant: async ({ load, entity, user }) => {
  const canvas = await load(entity.canvas);
  const isOwner = canvas.owner === user.id;
  const isCollab = canvas.shares.has(user.id);
  if (isOwner || isCollab) return grant(read, write, subscribe);
  return hide();
}
```

This duplicates the Canvas entity's `grant` logic. If Canvas's grant changes
(adding a "viewer" role, say), Layer's grant must be updated independently —
they can drift.

**What a fix would look like:**

```js
// Delegate to the parent entity's grant, receiving back a capability set.
grant: async ({ load, entity }) => {
  const canvas = await load(entity.canvas);
  return canvas.authz.as(canvas); // returns grant(read,write,subscribe) or hide()
}
```

Or, a field-level annotation that auto-delegates:

```js
canvas: ref('Canvas', { grant: delegate })
// → Layer's grant is auto-derived from Canvas's grant.
//   `delegate` is a typed handle, like `owner` for `role: owner`.
```

---

## Summary ranking

| # | Pain point | Severity | Fix complexity |
|---|-----------|----------|---------------|
| 1 | No blob/bytes field | **BLOCKER** | New field type: `bytes()` |
| 2 | No raster CRDT merge | **BLOCKER** | New field type: `raster.crdt()` or `region.crdt()` — high design cost |
| 3 | No ordered collection | SHOULD-FIX | New field type: `array(ref())` with list-CRDT merge |
| 4 | No undo/redo primitive | SHOULD-FIX | Add `{ history: depth }` option to existing field types |
| 5 | No render pipeline | SHOULD-FIX | New field type: `render()` with dep-tracked caching |
| 6 | No boolean type | NIT | New field constructor: `boolean()` |
| 7 | No cross-entity grant delegation | NIT | Add `grant: delegate` to `ref()` options |

**Verdict:** The `entity()` reactive paradigm — typed fields owning persistence,
sync, and events — is sound and expressive. Auth, presence, chat, shares, and
CRUD routing all map cleanly to a photo editor. But the field-type vocabulary is
**text-document-shaped**: it has strings, CRDT strings, numbers, dates, FK
refs, and sets. It lacks the three primitives a non-text collaborative domain
needs: binary storage, a merge strategy for the domain's native conflict unit
(pixels, not characters), and ordered collections. Without these, the photo
editor is a leaky workaround, not a supported application.
