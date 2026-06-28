# Pain Points: Drawing Canvas on express-plus (post-grill)

Stress-testing the grilled API (DECISIONLOG.md ADRs #1–7) by attempting to
implement a live collaborative drawing canvas. Each entry identifies a specific
API construct that failed the drawing-canvas domain and names which ADR or
design feature it tests.

---

## Persona — The Realtime Artist

I build live collaborative drawing apps. My domain is ephemeral per-connection
data shapes (60Hz in-progress ink strokes), high-frequency sync with
backpressure, CRDT merging of vector data (polylines), ordered mutable
collections (z-ordered shape layers), and cursor presence for every
collaborator. I am skeptical that `presence({cursor, selection})` — a closed set
of boolean toggles — can hold an in-progress 60Hz stroke, and that the live
layer won't drown subscribers.

---

## Attempted entity shape

The code below attempts to express the full drawing-canvas domain in the
grilled `doc.mjs` style. `// !!! WALL` marks API surfaces that don't exist.

```js
// canvas.mjs — collaborative drawing canvas entity expressed in the grilled API.
// Demonstrates: shapes as ordered layers (z-order), in-progress ephemeral stroke
// (testing presence vs ephemeral), cursor presence, backpressure/throttle for
// high-frequency sync, polyline CRDT for freedraw strokes.
import {
  entity, text, number, ref, map, presence, log, enum_,
  grant, deny, read, write, subscribe, admin, anyOf, never, scope,
  router, User,
} from 'express-plus';

const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

export const Canvas = entity('Canvas', {
  fields: {
    name:     text({ validate: (v) => v.length <= 200 || 'name too long' }),
    owner:    ref('User', { role: 'owner', readonly: true }),

    // Collaborators with role tiers (viewer/collaborator). Same pattern as Doc.
    collaborators: map(ref('User'), {
      role: ['viewer', 'collaborator'],
      default: {},
    }).can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only the owner may manage collaborators')),

    // !!! WALL — Shapes as ordered mutable layers (z-order).
    // The grilled API offers `set(ref)` (unordered, idempotent),
    // `map(ref, value)` (keyed, unordered), and `log()` (append-only, no delete).
    // NONE supports: insert-at-index, reorder (move from→to), remove-at-index.
    //
    // What we need:
    shapes: list(ref('Shape'), { ordered: true }),
    //          ^^^^ — list field type does not exist.
    //
    // Workaround: `set(ref('Shape'))` + a client-side `zIndex` number field on
    // each Shape. But two users moving shapes concurrently to zIndex 5 creates
    // ambiguity; there is no server-enforced total order; no atomic "bring to
    // front" operation. Client-side zIndex sorting is fragile.
    //
    // ADR tested: Data & queries "A collection owned by one side is a field"
    // — a Canvas genuinely owns its Shape order, so shapes SHOULD be an ordered
    // field. The gap is not the ownership model (correct) but the missing
    // ordered-collection field type.
    shapes: set(ref('Shape')),  // WORKAROUND — unordered, client zIndex sorting
    // !!! END WALL

    // !!! WALL — In-progress ephemeral stroke (60Hz, per-connection).
    // The grilled API's ONLY per-connection ephemeral field is `presence()`.
    // The `presence({ cursor: true, selection: true })` syntax implies a closed
    // registry of boolean feature toggles — each enables a baked-in feature
    // with a fixed data shape. There is NO mechanism to declare:
    //   - A custom field name ("activeStroke")
    //   - A custom data type (polyline of {x,y} points)
    //   - High-frequency update semantics (delta-diff, not full-value replace)
    //   - Write authority (self-only per-connection)
    //
    // Test: trying to express an in-progress stroke as presence:
    presence: presence({ cursor: true, activeStroke: true }),
    //                                             ^^^^^^^^^^^^
    // "activeStroke" is not a recognized presence feature. Even if it were,
    // there is no way to declare its data shape (it's not a polyline, it's a
    // boolean flag). The presence field type is semantically wrong: cursor is
    // passive state ("I am here"); an in-progress stroke is active
    // construction-in-progress ("I am building this shape").
    //
    // What we need (Phase 3 item 16 acknowledges this gap):
    inProgressStroke: ephemeral({
      activeStroke: polyline.crdt(), // growing polyline, per-connection, 60Hz
      cursor: point,                  // cursor position
    }).withCommitSemantics({
      // When the user lifts the pointer, promote the stroke to a Shape.
      on: 'strokeCommitted',
      effect: { mutate: Shape, with: {
        canvas: entity.id,
        points: ephemeral.activeStroke,
        creator: principal.id,
      } },
    }),
    //          ^^^^^^^^^ — ephemeral({...}) does not exist in the grilled API.
    //          `polyline.crdt()` does not exist either.
    //          `.withCommitSemantics()` does not exist.
    //
    // The IMPLEMENTATION-PLAN Phase 3 item 16 acknowledges this exact gap:
    //   "ephemeral({...}) with commit-semantics (accumulate-then-promote via
    //   a declarative commit-reaction — dissolves the active-construction case,
    //   e.g. drawing-canvas in-progress stroke)"
    //
    // ADRs tested: ADR #5 (live delivery is not a third grant method) —
    // ephemeral fields still need auth (who can see my in-progress stroke?).
    // The `presence` field bakes in "self-write, all-collaborators-read" but
    // a generalized `ephemeral` needs to DECLARE that authority explicitly
    // (connection-scoped write, entity-scoped read). The gap is not in the
    // auth model (scope+can handles this) but in the field type contract:
    // `ephemeral` needs to publish its scope (connection vs entity) and
    // authority (self vs server) in the plugin contract from Phase 1 step 1.
    // !!! END WALL

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),
  },

  // Checks: plain functions — works fine. Same pattern as Doc.
  checks: {
    owner:        ({ Canvas, principal }) => Canvas.owner.is(principal.id),
    collaborator: ({ Canvas, principal }) => Canvas.collaborators.has(principal.id),
  },

  // Grant: scope(...).can(...) — works fine for row-level auth.
  // ADRs tested: ADR #1 (no hide axis) — denied read = row absent, correct.
  // ADR #2 (plain-function checks) — correct.
  // ADR #3 (field access runtime .can) — correct.
  // ADR #4 (field strong-inherits row grant) — correct.
  // ADR #5 (live delivery NOT a third grant method) — correct, but see
  //   BLOCKER #4 below for backpressure.
  // ADR #6 (effects) — not stressed here (no cross-entity effects needed).
  // ADR #7 (no default grant) — entity has a grant, passes load check.
  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator()))
      .can(async ({ is }) => {
        if (await is.owner())         return grant(...OWNER);
        if (await is.collaborator())  return grant(...EDITOR);
        return deny('no capability for this principal');
      }),
  ],

  routes: (r, Canvas) => {
    r.resource();
    r.get('/feed', feed(Canvas));
    r.use('/:canvasId/shapes', shapeRoutes(Canvas));
  },
});

// !!! WALL — Shape entity: no polyline CRDT field type.
// The Shape entity needs a `points` field for freedraw strokes — an ordered
// array of {x,y} coordinate pairs that supports per-point CRDT merging.
// `text.crdt()` operates on characters; it cannot merge vector points.
// Storing points as JSON in a LWW `text` field sends the entire array on
// every edit — no granular sync, no concurrent editing of different segments
// of the same polyline.
export const Shape = entity('Shape', {
  fields: {
    canvas:  ref('Canvas', { required: true }),
    creator: ref('User', { role: 'creator', readonly: true }),
    type:    enum_(['rect', 'ellipse', 'freedraw', 'text', 'arrow']),
    //     ^^^^^ — enum_ field type does not exist in the grilled API.
    //     Falls back to text + app-level validation. (NIT, pre-existing)

    // Structured shape params:
    // For rect/ellipse: x, y, width, height
    // For freedraw: a polyline of {x,y} points
    // For arrow: start {x,y}, end {x,y}
    x:       number({ default: 0 }),
    y:       number({ default: 0 }),
    width:   number({ optional: true }),
    height:  number({ optional: true }),

    // !!! WALL — freedraw points need a polyline CRDT.
    // What we need:
    points: polyline.crdt(),  // per-point CRDT merge, granular deltas
    //        ^^^^^^^^ — polyline.crdt() does not exist.
    //
    // Workaround:
    points: text({ default: '[]' }),  // JSON-serialized, LWW, no granular sync
    //        ^^^^ — every point edit rewrites the ENTIRE JSON blob.
    //        Two users cannot concurrently edit different segments of the same
    //        freedraw polyline — LWW on the whole array wins.
    //
    // This is the same gap `text.crdt()` solved for characters. The framework
    // needs a way to define custom CRDT field types (polyline, coordinate, etc.)
    // via the Phase 1 step 1 plugin contract — a field-type plugin that
    // declares its merge strategy, diff format, and mutation operators.
    // !!! END WALL

    style:   text({ default: '{}' }),   // JSON: { fill, stroke, strokeWidth }

    zIndex:  number({ default: 0 }),    // WORKAROUND for ordered layers
    //        ^^^^^^ — client-simulated z-order, fragile under concurrent reorder.

    createdAt: date({ default: () => new Date() }),
  },

  checks: {
    creator: ({ Shape, principal }) => Shape.creator.is(principal.id),
  },

  // Grant: inherits Canvas scope through the typed FK. Same pattern as Comment→Doc.
  grant: inherit('Canvas', { via: 'canvas' }),
  //       ^^^^^^^ — inherit() works (ADR #5 typed-FK traversal).
  //       But field-level .can on `points` is still LWW-text, not CRDT.

  routes: (r) => {
    r.resource();
  },
});

// !!! WALL — Backpressure/throttle in subscription interest.
// The grilled design (ADR #5) has subscriber interest as data-not-code,
// narrowing-only, indexable — e.g. viewport bounding box. But it has NO
// mechanism for RATE CONTROL: "deliver at most 15Hz for stroke deltas,
// coalescing pending updates" or "drop intermediate frames when buffer > N."
//
// What we need on the subscribe call (in the client or on the room config):
//
//   canvas.subscribe({
//     interest: {
//       // Existing: viewport spatial filter (ADR #5)
//       viewport: { x: [0, 1920], y: [0, 1080] },
//       // Missing: rate control
//       throttle: {
//         field: Canvas.inProgressStroke,  // throttled field
//         rate: 15,                         // Hz — coalesce to 15fps
//         mode: 'latest',                   // deliver latest, drop intermediate
//       },
//     },
//   });
//
// Without backpressure, at 60Hz with 10 collaborators drawing simultaneously,
// every stroke-point-append from every collaborator reaches every other
// collaborator at full rate: 10 × 60 = 600 events/sec per subscriber, many of
// which are stale by the time they arrive. The client can't keep up; the
// server has no mechanism to help.
//
// ADR tested: ADR #5 (interest is data-not-code, indexable) — the interest
// model is correct for spatial narrowing but incomplete for temporal
// (rate-limiting). Throttle is a SECOND dimension of interest (temporal
// narrowing, not spatial narrowing) that the design doesn't address.
// !!! END WALL

// --- product routes ---
function feed(Canvas) {
  return async (req, res) => {
    const me = req.principal.id;
    const [owned, shared] = await Promise.all([
      Canvas.findAll(Canvas.owner.is(me)).sort(Canvas.updatedAt, 'desc').limit(10),
      Canvas.findAll(Canvas.collaborators.has(me)).sort(Canvas.updatedAt, 'desc').limit(10),
    ]);
    res.json({ owned, shared });
  };
}

function shapeRoutes(Canvas) {
  const r = router({ mergeParams: true });
  r.get('/', async (req, res) => {
    // No server-enforced ordering — shapes come back in arbitrary order.
    // Client sorts by zIndex.
    const shapes = await req.canvas.shapes.toArray();
    res.json({ shapes });
  });
  r.post('/', async (req, res) => {
    // Create shape — works through the mutation pipeline.
    // But no atomic "insert at z-order position N" operation.
    const shape = await req.canvas.shapes.add(req.body);
    res.status(201).json(shape);
  });
  // !!! WALL — No "reorder shapes" endpoint.
  // To reorder, the client must individually update each shape's zIndex field,
  // which is N writes for an N-item reorder, and is not atomic.
  r.patch('/:shapeId/reorder', async (req, res) => {
    // IDEAL: await req.canvas.shapes.move(req.params.shapeId, req.body.newIndex);
    // REALITY: update shape.zIndex on the Shape entity, client-side ordering.
    const shape = await Shape.findById(req.params.shapeId);
    await shape.update({ zIndex: req.body.zIndex });
    res.sendStatus(200);
  });
  return r;
}
```

---

## Pain points

### BLOCKER #1 — `presence` cannot hold an in-progress stroke; `ephemeral({...})` is required

**ADR tested:** ADR #5 (live delivery, per-connection state), Phase 1 step 1 plugin contract (persistence strategy: `ephemeral`)

**Failing code:**
```js
// This is what the grilled API offers:
presence: presence({ cursor: true, selection: true })
//                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// Closed set of boolean-feature toggles. No custom field names,
// no custom data types, no 60Hz delta semantics.

// This is what a drawing canvas needs:
inProgressStroke: ephemeral({
  activeStroke: polyline.crdt(),  // growing polyline, per-connection, 60Hz
  cursor: point,                   // cursor position
}).withCommitSemantics({
  on: 'strokeCommitted',
  effect: { mutate: Shape, with: {
    canvas: entity.id,
    points: ephemeral.activeStroke,
    creator: principal.id,
  } },
})
// `ephemeral({...})`, `polyline.crdt()`, `.withCommitSemantics()` —
// NONE of these exist in the grilled API.
```

**Why it blocks:** The in-progress stroke at 60Hz is THE defining feature of a
live drawing app. `presence()` is the only per-connection ephemeral field type,
and its `{cursor: true, selection: true}` boolean-flag syntax implies a closed
feature registry with fixed data shapes. Even if the registry were open (i.e.
`presence({ activeStroke: true })` were accepted), there is no way to declare
`activeStroke`'s data type (a growing `polyline` of `{x,y}` points, not a
boolean toggle). The semantic mismatch compounds: "presence" implies passive
state ("I am here, my cursor is here"); an in-progress stroke is active
construction-in-progress ("I am building this shape").

The **IMPLEMENTATION-PLAN Phase 3 item 16** acknowledges this gap explicitly:
> `ephemeral({...})` with commit-semantics (accumulate-then-promote via a
> declarative commit-reaction — dissolves the active-construction case, e.g.
> drawing-canvas in-progress stroke)

This is the right fix: generalize `presence` into `ephemeral({...})` with a
field-type plugin that declares per-connection scope + write authority + delta
diff + optional commit-semantics. The `presence` API becomes a convenience
wrapper for the common cursor+selection case.

**What else it tests:** `ephemeral` must publish its scope (connection) and
authority (self-write) in the Phase 1 step 1 plugin contract. The grilled
`presence` bakes these in implicitly; `ephemeral` must declare them explicitly
so the framework can compile them — same discipline as `scope`'s
compilability requirement.

---

### BLOCKER #2 — No ordered mutable collection field type for z-ordered layers

**ADR tested:** ADR "Data & queries: A collection owned by one side is a field on that entity" (AGENTS.md)

**Failing code:**
```js
// What the grilled API offers:
shapes: set(ref('Shape'))   // unordered, idempotent add/remove — no order, no reorder
shapes: map(ref('User'), { role: ['viewer', 'editor'] })  // keyed, unordered — no reorder
shapes: log({ sender: ref('User'), body: text() })         // append-only, no delete, no reorder

// What a drawing canvas needs:
shapes: list(ref('Shape'), { ordered: true })
//       ^^^^ — list field type does not exist.
// Operations needed: insertAt(index), remove(id), move(fromIndex, toIndex)

// Workaround (fragile):
//   - shapes: set(ref('Shape')) — unordered add/remove
//   - Each Shape has a `zIndex: number({ default: 0 })` field
//   - Client sorts by zIndex to simulate z-order
//   - "Bring to front" = read all shapes, find max zIndex, set this shape's
//     zIndex to max+1
//   - "Send to back" = read all shapes, find min zIndex, set this shape's
//     zIndex to min-1
//   - "Reorder to position N" = update N shapes' zIndex values (not atomic)
```

**Why it blocks:** Z-order is a first-class domain concept in drawing apps.
Client-side zIndex sorting with concurrent reorder operations produces
ambiguity (two users move shapes to zIndex 5 simultaneously), has no
server-enforced total order, and requires O(N) writes for move-to-top/bottom
operations (rebasing all zIndex values). The LWW `number` field for zIndex
does not compose with concurrent reorders: the framework has no way to know
that a zIndex update is a "move relative to peers" rather than a
"set absolute value."

The IMPLEMENTATION-PLAN does not explicitly schedule an `ordered list` field
type. It lists `array` in Phase 2 item 12, but `array` without order
semantics is just a collection — the `list` field with atomic
insert-at/remove/reorder operations is a separate concern.

---

### BLOCKER #3 — No custom CRDT field type for polyline/vector data

**ADR tested:** Design principle "Fields are reactive primitives that own their persistence, sync strategy, and event emission" (FEATURES.md §4, AGENTS.md)

**Failing code:**
```js
// What the grilled API offers:
body: text.crdt()  // character-level CRDT merging — works for text

// What a drawing canvas needs:
points: polyline.crdt()  // point-level CRDT merging for vector data
//        ^^^^^^^^ — polyline.crdt() does not exist.

// Workaround (loses granular sync):
points: text({ default: '[]' })  // JSON-serialized, LWW on entire array
// Every point edit sends the FULL points array over the wire.
// Two users editing different segments of the same polyline → LWW wins.
```

**Why it blocks:** A freedraw stroke is a polyline — an ordered sequence of
`{x,y}` coordinate pairs, often 100–500 points. Reshaping a curve by adjusting
3 points out of 500 should send only those 3 points (a granular delta), not
the entire 500-point array. This is the EXACT same gap that `text.crdt()`
solved for characters — per-element merge with granular deltas. The framework
has proven the CRDT plugin pattern for `text`; it needs to generalize this
into a **custom CRDT field-type plugin contract** that any field type can
implement (polyline, coordinate, image-blob-region, etc.).

The IMPLEMENTATION-PLAN Phase 1 step 1 defines a plugin contract with
mutation operators, diffs, and optional `inverse` — but the existing exemplars
only show `text.crdt()` as a baked-in type, not as an instance of a
developer-extensible CRDT plugin system. The question is whether the plugin
contract is open (anyone can write a `polyline.crdt()` plugin that conforms to
the contract) or closed (only framework-provided CRDT types exist). This pain
point tests that question.

---

### SHOULD-FIX #1 — No backpressure/throttle in subscriber interest for high-frequency fields

**ADR tested:** ADR #5 (subscriber interest as data-not-code, narrowing-only, indexable)

**Failing code:**
```js
// The grilled subscriber interest model (ADR #5):
// Interest is a typed constraint expression over plugin-published coordinates.
// It is narrowing-only (keep/drop), structurally incapable of widening.
//
// What exists (viewport spatial filter):
interest: {
  viewport: { x: [0, 1920], y: [0, 1080] }  // spatial narrowing — works
}

// What is MISSING: temporal narrowing (rate control).
// At 60Hz with 10 concurrent drawers, an in-progress stroke emits 600
// stroke-point-append events/sec per subscriber (×10 peers = even more).
// The subscriber interest cannot express:
interest: {
  viewport: { x: [0, 1920], y: [0, 1080] },
  // !!! MISSING — rate control:
  throttle: {
    field: Canvas.inProgressStroke,  // which field to throttle
    rate: 15,                         // Hz — coalesce to 15fps
    mode: 'latest',                   // deliver latest, drop intermediate
  },
}
```

**Why it matters:** Without backpressure, every 60Hz stroke-point-append from
every collaborator reaches every other collaborator at full rate. The client
can't keep up; the server has no mechanism to help. The interest model handles
spatial narrowing correctly (viewport filter) but has no temporal dimension.
Throttle is a SECOND axis of narrowing (temporal, not spatial) that the
design doesn't address. It's not a grant concern (the events are already
authorized); it's a delivery-pacing concern.

The grilled ADR #5 says interest is "data-not-code" and "indexable". A
throttle declaration fits this model: `{ field: typed-handle, rate: number,
mode: 'latest'|'batch' }` is data, not code; it's validated at subscribe
time; and it's indexable (the server can coalesce by field before emitting).
But the design hasn't generalized to this dimension yet.

---

### SHOULD-FIX #2 — No `shape.crdt()` plugin surface for non-text CRDTs

**ADR tested:** Phase 1 step 1 field-type plugin contract (mutation operators, diff, merge)

**Failing code (what we need to write but can't):**
```js
// A custom polyline CRDT plugin that conforms to the framework's plugin contract:
const polyline = fieldType('polyline', {
  persistence: 'persisted',
  operators: {
    appendPoint: { args: { x: 'number', y: 'number' }, apply: (state, {x, y}) => [...state, {x,y}] },
    movePoint:   { args: { index: 'number', x: 'number', y: 'number' }, apply: ... },
    deletePoint: { args: { index: 'number' }, apply: ... },
  },
  merge: lamportCRDT,  // or a custom merge function
  diff: (prev, next) => ...,  // compute granular delta
  publishedCoordinates: ['x', 'y'],  // for subscriber interest indexing
});

// Then use it:
points: polyline({ default: [] })
// or equivalently:
points: polyline.crdt()
```

**Why it matters:** The framework's `text.crdt()` proves the CRDT-field
pattern works. Without an open plugin contract for custom CRDT types, every
non-text collaborative data structure needs framework-level changes. The
polyline CRDT is to vector drawing what `text.crdt()` is to documents — the
canonical use case for a general CRDT field-type plugin.

---

### SHOULD-FIX #3 — No `list`/`orderedArray` field type with atomic reorder operations

**ADR tested:** AGENTS.md "A collection owned by one side is a field on that entity"

**Failing code:**
```js
// Ideal:
shapes: list(ref('Shape'), { ordered: true })

// Operations we need on a list field:
canvas.shapes.insertAt(0, shape);     // prepend
canvas.shapes.append(shape);          // append
canvas.shapes.remove(shapeId);        // remove by id
canvas.shapes.move(shapeId, 0);       // bring to front
canvas.shapes.move(shapeId, -1);      // send to back
canvas.shapes.move(shapeId, 5);       // reorder to index
canvas.shapes.swap(aId, bId);         // swap two shapes
```

**Why it matters:** The `map(ref, value)` plugin (keyed-set,
uniqueness-by-construction) dissolved the separate-join-entity pattern.
An ordered `list` plugin would dissolve the client-side zIndex workaround the
same way — replacing fragile application-level integer ordering with a
framework-owned ordered-collection field type that guarantees a total order
and provides atomic reorder operations.

---

## Sharp edges

### Sharp edge #1 — `enum_` field type missing; falls back to `text` + app validation

**Failing code:**
```js
type: enum_(['rect', 'ellipse', 'freedraw', 'text', 'arrow'])
//    ^^^^^ — enum_ does not exist in the grilled API.
// Workaround: text({ validate: v => SHAPE_TYPES.includes(v) || 'invalid type' })
```

The `state` plugin exists (doc.mjs line 65) but is a lifecycle state machine
(transitions + effects + auto), not a simple value-constrained enum. A
lightweight `enum_` field type without transitions is a common need.

### Sharp edge #2 — `ref` `from: 'req.user.id'` auto-population only for `role: 'owner'`

```js
creator: ref('User', { role: 'creator', readonly: true })
// `role: 'creator'` is not a recognized role — only `owner` triggers
// auto-population. A non-owner FK like `creator` must be set manually
// in every POST handler.
```

FEATURES.md §4 mentions `from: 'req.user.id'` as a ref option. Phase 3 item 17
mentions "Ergonomic modifiers: setOnce, role: author auto-populate". This is
a known gap, already scheduled.

### Sharp edge #3 — `presence` implicit self-write authority is undocumented

The `presence` field type implicitly grants write to the owning connection
(self-write) and read to all row-admitted connections. This authority model
is baked in and not surfaced in the field type's API — there's no
`presence({...}).authority('self')` or equivalent. A generalized `ephemeral`
would need to declare authority explicitly, but `presence` currently hides it.

---

## Prior findings re-checked

Each finding from the PRE-GRILL PAIN-POINTS.md re-evaluated against the
grilled API (DECISIONLOG.md ADRs #1–7).

| # | Prior Finding | Status | Why |
|---|--------------|--------|-----|
| 1 | `presence` may be closed — no in-progress stroke surface | **STILL-OPEN — NEW-ANGLE** | The grill did NOT change `presence`. IMPLEMENTATION-PLAN Phase 3 item 16 acknowledges this gap and proposes `ephemeral({...})` with commit-semantics, but that is a NEW construct, not a change to `presence`. The grilled `presence({cursor:true, selection:true})` remains a closed boolean-flag registry. The new angle: `ephemeral` is the recognized fix, but it doesn't exist yet; `presence` is confirmed insufficient. |
| 2 | No ordered mutable collection field (z-order layers) | **STILL-OPEN** | The grill did not add ordered collections. `map(ref, value)` (keyed set) was added, which dissolves the compound-uniqueness case, but `list`/`orderedSet` for z-order was not addressed. Not in the IMPLEMENTATION-PLAN phases 1–2. |
| 3 | No array/polyline field type (freedraw points) | **STILL-OPEN** | The grill did not add array or polyline field types. `text.crdt()` shows the CRDT pattern works, but there's no open plugin surface for custom CRDT types. Phase 2 item 12 mentions `array` but this is likely a simple array, not a CRDT polyline with per-point merge. |
| 4 | Per-push re-auth for ephemeral 60Hz presence data | **RESOLVED** | ADR #5: "latched subscribe-time auth — cached grant, invalidated by roster change/share revocation". This is exactly the pre-authorized ephemeral channel the prior report requested. The latched-auth design (Phase 2 item 10) explicitly addresses this: the grant decision is cached at subscribe time, so the 60Hz path does a cheap cache check, not a full re-eval. The concern is resolved BY DESIGN — the implementation doesn't exist yet, but the architecture does. |
| 5 | No undo/redo field primitive | **RESOLVED** | IMPLEMENTATION-PLAN §6 (original pain point P6): "per-client undo is a client-SDK concern; shared undo is inverse mutations through the pipeline (operators optionally declare an `inverse`)". The `inverse` slot is reserved in Phase 1 step 1; shared undo runs inverse mutations through the pipeline. This is sufficient architecture — not a gap. |
| 6 | `createdBy` ref lacks `from: req.user.id` auto-fill | **STILL-OPEN** | Phase 3 item 17: "Ergonomic modifiers: setOnce, role: author auto-populate". Scheduled but not designed/imlemented in the grilled API. Remains a NIT, not a blocker. |
| 7 | No enum field type for Shape.type | **STILL-OPEN** | The grilled API has `state()` (lifecycle state machine with transitions + effects + auto) but no lightweight `enum_()` for simple value constraints. Not explicitly scheduled but a minor gap. Still a NIT. |
| 8 | No infinite-canvas coordinate support | **RESOLVED** | Was already marked "not a real gap" in the prior report. `number` handles arbitrarily large values. Confirmed: no change needed. |

---

## Summary

| # | Pain Point | Ranking | What's Missing |
|---|-----------|---------|---------------|
| 1 | `presence` closed; `ephemeral({...})` required for in-progress stroke | **BLOCKER** | `ephemeral({...})` field type with per-connection scope + custom shapes + commit-semantics (Phase 3 item 16) |
| 2 | No ordered mutable collection (z-order layers) | **BLOCKER** | `list(ref, {ordered:true})` field type with atomic insert/remove/reorder |
| 3 | No custom CRDT for polyline/vector data | **BLOCKER** | Open CRDT field-type plugin contract (polyline.crdt, coordinate.crdt, etc.) |
| 4 | No backpressure/throttle for high-frequency subscriptions | **SHOULD-FIX** | Temporal-narrowing interest dimension: `throttle: {field, rate, mode}` |
| 5 | No open CRDT plugin surface (separate from BLOCKER #3 — this is about the contract API) | **SHOULD-FIX** | Developer-extensible CRDT field-type plugin API (Phase 1 step 1) |
| 6 | No `list` field with atomic reorder (separate from BLOCKER #2 — operational semantics) | **SHOULD-FIX** | `insertAt`, `move(from,to)`, `swap(a,b)` as atomic list operations |
| — | `enum_` missing (NIT) | Sharp edge | Lightweight value-constrained enum without state-machine transitions |
| — | `from: 'req.user.id'` only for `owner` (NIT) | Sharp edge | Scheduled Phase 3 item 17 |
| — | `presence` implicit authority undocumented | Sharp edge | `ephemeral` should declare authority explicitly |

3 of 4 pre-grill findings resolved by the grilled design; the remaining
pre-grill finding (presence) is confirmed insufficient and the gap is
acknowledged in the IMPLEMENTATION-PLAN. 3 new BLOCKERs found in the
grilled API: ephemeral in-progress data shapes (tests presence), ordered
mutable collections (tests collection field types), and custom CRDTs beyond
text (tests the field-type plugin contract).
