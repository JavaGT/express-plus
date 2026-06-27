# Pain Points: Drawing Canvas on express-plus

Each entry identifies a specific API construct that failed the canvas domain, why it
mattered, and a concrete ranking.

---

## 1. BLOCKER — `presence` field: closed or extensible?

**API construct cited:** `presence({ cursor: true, selection: true })`  
**Expected:** `presence({ cursor: true, viewport: true, activeStroke: true })`  

**What failed:** The doc uses `presence` with boolean flags `cursor: true` and
`selection: true`. These read as enable/disable toggles for predefined features
whose data shapes (`{x,y}` for cursor, `{start,end}` for selection) are
framework-baked. The API surface gives no indication whether `viewport` or
`activeStroke` are valid flag names, nor how their data shapes would be declared.

**Why it matters for the drawing canvas:**
- The **in-progress stroke** at 60Hz is THE defining feature of a live drawing
  app. It is a growing polyline of `{x,y}` points broadcast ephemerally to all
  viewers and discarded on pointer-up (when the committed Shape replaces it).
- `presence` is the ONLY ephemeral per-connection field type in the API.
  There is no `stream()`, `ephemeral()`, `broadcast()` or any other per-connection
  mutable state primitive.
- If `presence` is a **closed set** of predefined features (cursor, selection),
  the in-progress stroke has **no API surface** — the domain can't be expressed.
- Even if `presence` is extensible, the **naming** is wrong: "presence" implies
  passive state ("I am here, my cursor is here"); an active stroke is
  construction-in-progress ("I am drawing this shape"). The semantic mismatch
  will cause confusion in every auth rule, route handler, and client that
  touches presence data — some of it is passive state, some is active
  work-in-progress.
- Sub-issue: no way to declare the **TYPE** of activeStroke data. `cursor: true`
  is a boolean flag; there's no `activeStroke: { type: 'polyline', points: [...] }`
  shape declaration. Type-safety is lost at the framework boundary.

**Rank: BLOCKER.** The canvas domain cannot be built if presence is closed.

---

## 2. SHOULD-FIX — No ordered mutable collection field type

**API constructs cited:** `set(ref('User'))` (unordered, idempotent) and `log()`
(append-only, persisted)  
**Expected:** `list(ref('Shape'))`, `orderedSet(ref('Shape'))`, or a field type
that supports delete + reorder  

**What failed:** A canvas shape layer is ordered (z-order: what paints on top),
mutated (move, resize, recolor, delete), and reordered (bring to front, send to
back). The available collection field types are:

| Field | Order? | Delete? | Reorder? | Persisted? |
|---|---|---|---|---|
| `set(ref)` | No — unordered | Yes (.remove) | No | Yes |
| `log()` | Append-only (by insertion time) | No | No | Yes |

Neither fits. `set` is closest: you can add and remove shapes, but there is no
server-enforced ordering. The client simulates z-order by sorting on each shape's
`zIndex` number field — but two shapes at the same zIndex are ambiguous, there's
no atomic "move to front" operation, and z-order integrity is entirely client-side.

**Why it matters:** Z-order is a first-class concept in drawing apps (layers,
bring-to-front, send-to-back). Client-side zIndex sorting is a workaround that
breaks under concurrent reorder operations (two users move shapes to zIndex 5
simultaneously) and gives no server-side ordering guarantee. A `list` field type
with insert-at/remove/reorder operations would capture z-order natively.

**Rank: SHOULD-FIX.** The domain works with `set` + client-side zIndex, but
the workaround is fragile and the gap is real.

---

## 3. SHOULD-FIX — No array/polyline field type for vector point data

**API construct cited:** `text({ default: '[]' })` storing JSON-serialized points  
**Expected:** `polyline()` or a generic `array(number)` / `array(point)` field type  

**What failed:** A freedraw stroke is a polyline — an ordered sequence of
`{x,y}` coordinate pairs. The only field type that can store structured data
is `text` (a LWW string), forcing JSON serialization of the entire points array.

**Why it matters:**
- Every point edit rewrites the **entire** JSON blob — no granular sync.
  Reshaping a freedraw curve (adjusting 3 points out of 500) sends all 500
  points over the wire.
- No CRDT merging for point-level edits. Two users can't simultaneously edit
  different parts of the same freedraw polyline — LWW on the whole array wins.
- This is the same gap that `text.crdt()` solved for characters. A
  `polyline.crdt()` or `coordinates.crdt()` field would give per-point merge.

**Rank: SHOULD-FIX.** The domain works with JSON-in-text, but it's the wrong
abstraction for vector data and blocks granular multi-user editing of polylines.

---

## 4. SHOULD-FIX — Per-push re-auth for ephemeral high-frequency presence data

**API constructs cited:** `grant` + the baked-in `/events` WS stream  
**Invariant cited:** "No second auth path. Every transport runs through the same
authorization engine. Live events are re-authorized before delivery, not bypassed."

**What failed:** At 60Hz with M concurrent drawers, every cursor-move + every
stroke-point-append fires a presence `:moved` event. The framework re-auths every
push through `grant`/`access`/`checks`. For a simple board where everyone is a
collaborator, the check is cheap (`is.collaborator()` → memozied boolean). But:

- 10 concurrent drawers × 60Hz = **600 auth checks/second** just for presence.
  Add shape mutations and the number grows.
- The auth is **mechanically unnecessary** for ephemeral presence data: the
  client was already authorized at subscribe time. Presence data carries no
  persisted side effects; it's transient per-connection state broadcast to peers.
- The invariant "no second auth path" is **preserved** — there IS only one auth
  engine — but the invariant was designed for persisted data (doc edits, share
  grants) where re-authing every mutation is necessary and correct. It was NOT
  designed for 60Hz ephemeral cursor/ink data where the authorization answer
  can't change mid-stroke (the user doesn't lose collaborator status between two
  consecutive stroke points on the same connection).

**What's needed:** A "pre-authorized ephemeral channel" — the `subscribe`
capability check runs once at WS upgrade, and the connection carries a
capability set that persists for the lifetime of the connection. Presence field
mutations on an already-authorized connection skip re-auth. The auth engine is
still singular; the pre-auth is just a cached result, not a second path.

**Rank: SHOULD-FIX.** The domain works at low scale (re-authing a memoized
boolean is fast), but it's conceptually wrong for ephemeral data and hits a
scaling wall.

---

## 5. SHOULD-FIX — No undo/redo primitive on fields

**API constructs cited:** `text`, `number`, `set`, `log` — all LWW or merge;
none expose mutation history  
**Expected:** A field-level undo stack, or a `versionHistory` built-in  

**What failed:** Undo is explicitly in the requirements ("Undo"). No field type
exposes a history of values. LWW fields overwrite; `set` adds/removes with no
history; `log` is append-only with no delete. Implementing undo requires the
client to:
1. Track an undo stack of operations (move shape, delete shape, change color)
2. On undo, replay the inverse operation via the normal CRUD API

The undo stack is **per-client, not shared**. If user A deletes a shape and user B
wants to undo it, user B has no undo entry. Undo is local to the actor.

**Why it matters:** In a collaborative whiteboard, undo is expected. The
framework owning the field history would mean undo is server-enforced, shared,
and consistent — the right behavior for collaboration.

**Rank: SHOULD-FIX.** Client-side undo is a workaround that breaks collaboration
(undo is not shared).

---

## 6. NIT — `createdBy` ref lacks `from: req.user.id` auto-population

**API construct cited:** `ref('User', { readonly: true })`  
**Expected:** `ref('User', { readonly: true, from: 'req.user.id' })`  

**What failed:** Only `role: owner` triggers automatic `req.user.id` population
on create. A non-owner reference like `createdBy` must be set manually in every
POST handler (`createdBy: req.user.id`). FEATURES.md §4 mentions `from:
'req.user.id'` as a ref option, but the current API (DOMAIN-MODULES.md) does not
surface it.

**Why it matters:** Minor — the manual set is one line per create handler. But
it's ceremony the framework could absorb.

**Rank: NIT.**

---

## 7. NIT — No enum field type for `Shape.type`

**API construct cited:** `text({ default: 'rect' })`  
**Expected:** An `enum` or `oneOf` field type restricting values to
`['rect', 'ellipse', 'freedraw', 'text', 'arrow']`  

**What failed:** Invalid type values pass schema validation and are caught only
by client validation or application-level checks. The schema can't express the
constraint.

**Why it matters:** Low — validation at the app layer is adequate. But an `enum`
field is a common primitive; its absence forces repeated validation code.

**Rank: NIT.**

---

## 8. NIT — No built-in infinite-canvas coordinate space support

**API construct cited:** `number({ default: 0 })` for x, y coordinates  
**Expected:** No framework gap — `number` handles arbitrarily large values
(JavaScript doubles). The "infinite" aspect is purely client-side (panning
viewport reveals more canvas).  

**Why it matters:** None — this isn't a framework gap, it's a canvas
implementation detail. The server just stores coordinates; the client handles
rendering within the viewport.

**Rank: NIT (not a real gap — listed for completeness).**

---

## Summary

| # | Pain Point | Ranking |
|---|-----------|---------|
| 1 | `presence` may be closed to cursor/selection — no in-progress stroke surface | **BLOCKER** |
| 2 | No ordered mutable collection field (z-order layers) | SHOULD-FIX |
| 3 | No array/polyline field type (freedraw points) | SHOULD-FIX |
| 4 | Per-push re-auth for ephemeral 60Hz presence data | SHOULD-FIX |
| 5 | No undo/redo field primitive | SHOULD-FIX |
| 6 | `createdBy` ref lacks `from: req.user.id` auto-fill | NIT |
| 7 | No enum field type for shape type | NIT |
| 8 | No infinite-canvas coordinate support (not a gap) | NIT |

Three of the four SHOULD-FIX items (ordered collection, array/polyline, and
a pre-authorized ephemeral channel) are NEW field types that don't exist in the
framework. One SHOULD-FIX (undo) could be a field-level feature addition. The
BLOCKER is an API clarification question: is `presence` closed or extensible?

All pain points converge on a single theme: **the framework was designed for
text-document collaboration** (LWW text, CRDT text, sets of users, presence as
cursor/selection). The drawing canvas domain stresses vector-structured data
(ordered mutable collections, polylines of coordinate pairs, high-frequency
ephemeral ink streams) that the text-document-oriented field primitives don't
cover.
