# Google Photos Clone — Stress-Test Findings

> **Persona**: The Storage Architect — concerned with binary storage, async derived
> data (thumbnails), rich query (geo, full-text), and link-share for non-users.
> Skeptical of a framework whose query language is `.is()`/`.has()` and whose
> derived fields recompute on every read.
>
> **Date**: 2026-06-28  
> **Tested against**: grilled workbench API (ADR #1–#7, doc.mjs + comment.mjs exemplars)

---

## Attempted entity shape

Two entities were attempted (full source in `projects/google-photos/`):

- **`photo.mjs`** — a media entity with blob storage, async thumbnails, structured
  EXIF, geo-location, full-text search, and link-share. Shows what the grilled API
  CAN and CANNOT express.
- **`album.mjs`** — a collection entity with per-member collaborator roles (via
  `map`), link-share for non-users, and per-album role tiers.

The idealized code is present as comments wherever the API hits a wall; the
running code uses workarounds (text URLs for blobs, flattened EXIF fields, scalar
GPS coordinates).

---

## Pain points

### BLOCKER #1 — No `blob` field type for binary storage

> **SETTLED (blob field shipped):** `blob` is now exported from `workbench`
> (`src/field.mjs`) — `import { blob } from 'workbench'` resolves and the field
> constructor is available. The field-type omission this blocker recorded is
> closed. (The `storedDerived` async-thumbnail gap in BLOCKER #2 is separate and
> remains open.) Historical text kept below for context.

**What fails**: Binary storage is the *primitive* of a photo app — the original
image file IS the entity's reason for existing. The grilled field-type catalog
has `text`, `number`, `date`, `ref`, `map`, `presence`, `log`, `state`, `link`,
`boolean` — no `blob`.

```js
// IDEALIZED — cannot express:
original: blob({ store: 's3', accept: ['image/*', 'video/*'], maxSize: '50MB' })
  .can(async ({ is }, defaults) =>
    (await is.owner()) ? defaults : deny('only owner may download original')),

// WORKAROUND — gates the string, not the bytes:
blobUrl: text({ readonly: true }),
```

Without `blob`, the framework cannot: (a) stream or serve binary content with
access-control enforcement at the byte level, (b) handle multipart upload through
the mutation pipeline, (c) validate content-type at field-declaration time,
(d) deduplicate or replicate binary storage. Upload becomes a custom route that
bypasses the mutation pipeline entirely — it writes to S3, then creates the
Photo row with a URL string. The access-check gates the *string*, not the bytes
at that URL. **Second query path created — singular-system violation.**

**ADR tested**: None directly — this is an omission in the field-type catalog.
The IMPLEMENTATION-PLAN lists `blob` as a Phase 2 deliverable (step 12:
"`blob` + `array` built-in plugins"). Recognized but not yet designed.

**Severity**: BLOCKER. A photo app without binary storage is a metadata database.

---

### BLOCKER #2 — No `storedDerived` field type for async thumbnails

**What fails**: Thumbnails must be computed ASYNCHRONOUSLY (resize is external
I/O), ONCE on upload (not recomputed on every read), and PERSISTED + INDEXED
(so queries can use them). The grilled API has two mechanisms, both wrong:

- **`derived(fn)`** — synchronous, recompute-on-read. Right shape, wrong timing.
  A thumbnail that re-runs ImageMagick on every fetch is a non-starter.
- **`effects: { mutate, with }`** — in-transaction data mutations (`{set}`/
  `{create}` through the pipeline). These CANNOT shell out to ImageMagick/sharp;
  they mutate rows with data from the trigger delta + origin row, not from an
  async computation result.

```js
// IDEALIZED — cannot express:
thumbnailSm: storedDerived({
  from: 'original',
  processor: 'image.resize',
  options: { width: 400, height: 400, fit: 'cover' },
  eager: true,  // compute on upload, not on first read
}),

// WORKAROUND — external job queue entirely outside the framework:
//   **SETTLED (job queue shipped):** `createJobQueue` is now exported from
//   `workbench/server` (`src/job-queue.mjs`) — durable background work no
//   longer needs an external pg-boss/bull. The narrower `storedDerived`
//   (eager async compute+persist) primitive below remains open.
thumbnailSmUrl: text({ optional: true }),
isProcessed: boolean({ default: false }),
```

The IMPLEMENTATION-PLAN Phase 3 step 14 defers stored-derived as "the genuinely
large async-pipeline design — deferred deliberately." For a photo app, this is
THE core upload workflow. Without it, thumbnail generation requires an external
job queue (pg-boss, bull) that polls for unprocessed rows — no integration with
the mutation pipeline, no composed event, no effect principal. **The entire
upload → process → serve pipeline lives outside the framework.**

**ADR tested**: ADR #5 (Effects). Effects are bounded, in-transaction,
effect-principal reentrancy — the right home for async pipelines, but the
`{ mutate, with }` primitive can only do data mutations, not external
computation. FEATURES.md §7 explicitly acknowledges: "Out-of-band side effects
(webhooks, emails, external HTTP) — NOT yet designed." This is that gap.

**Severity**: BLOCKER. Without stored-derived, the framework owns the read path
but none of the write path for the app's most expensive operation.

---

### BLOCKER #3 — No geo/spatial predicates

**What fails**: The typed-handle predicate system has `.is(val)` (equality) and
`.has(id)` (set membership). No `.near()`, `.within()`, `.distance()` for
geo-radius queries. Combined with the lack of a `point` field type, ALL spatial
queries must bypass the framework with raw SQL/PostGIS.

```js
// IDEALIZED — cannot express:
Photo.findAll(
  Photo.location.near({ lat: 48.8, lng: 2.3, radiusKm: 5 })
    .and(Photo.owner.is(req.principal.id))
).sort(Photo.capturedAt, 'desc').limit(50);

// WORKAROUND — raw SQL bypassing the entire typed-handle system:
// SELECT * FROM photos WHERE ST_DWithin(location, ST_MakePoint(?, ?), ?)
```

**ADR tested**: None — the predicate language simply doesn't cover spatial types.
The IMPLEMENTATION-PLAN lists "Full-text search; geo / spatial predicates" as
"Deferred / plugin territory." For a photo app, "photos near here" is a core
primitive — not an exotic edge case.

**Severity**: BLOCKER. Spatial queries are table-stakes for a photo library.

---

### BLOCKER #4 — No full-text search predicates

**What fails**: Same predicate-language gap as geo. No `.match()`, `.search()`,
`.contains()`, `.textSearch()` for full-text queries. "Find photos of dogs in
Paris" requires an external search index (Elasticsearch/Lucene) queried from a
custom route — a second query path that violates AGENTS.md's "prefer a singular
system" principle.

```js
// IDEALIZED — cannot express:
Photo.findAll(
  Photo.searchIndex.match('dog paris')
    .and(Photo.owner.is(req.principal.id))
).sort(Photo.capturedAt, 'desc').limit(50);

// WORKAROUND — external Elasticsearch index queried outside the predicate system.
```

**ADR tested**: None. Also in "Deferred / plugin territory." The gap is the same
structural issue as BLOCKER #3: the predicate language is closed; extending it
requires the framework, not the app.

**Severity**: BLOCKER. Without full-text search, the app can't answer "find my
photos of X."

---

### SHOULD-FIX #1 — No structured sub-object field type (`json`)

**What fails**: EXIF data is naturally structured: `{ iso, aperture, focalLength,
cameraModel, gpsLat, gpsLng, ... }`. No `json` or `object` field type exists.
Without it, you must flatten 20+ EXIF tags into individual fields (schema
explosion) or serialize to a `text` field as JSON (losing typed-handle query
capability on individual keys, breaking the "no magic strings" rule).

```js
// IDEALIZED — cannot express:
exif: json({
  iso: number(), aperture: number(), shutterSpeed: text(),
  focalLength: number(), cameraModel: text(), make: text(),
  lens: text(), flash: boolean(), orientation: number(),
  gpsLatitude: number(), gpsLongitude: number(),
  gpsAltitude: number(), dateTaken: date(),
}),

// WORKAROUND — 20+ flat fields that should be one structured sub-object:
exifIso: number({ optional: true }),
exifAperture: number({ optional: true }),
exifShutterSpeed: text({ optional: true }),
// ... 10 more fields ...
```

The flattening workaround has cascading problems: (a) you can't iterate EXIF
keys as a single unit ("show all EXIF data" requires enumerating 20 fields),
(b) new EXIF tags from new camera models require schema migrations, (c) the
field list is noise — the reader can't tell which fields are EXIF and which are
domain metadata without a naming convention.

**ADR tested**: None — field-type catalog omission. Unlike `blob` and
`storedDerived`, there's no mention of this in the IMPLEMENTATION-PLAN roadmap.

**Severity**: SHOULD-FIX. Every photo app has structured metadata; 20+ flattened
fields is self-inflicted tech debt from day one.

---

### SHOULD-FIX #2 — Link-share cannot express per-member tiers

**What fails**: The grilled `link` field type (doc.mjs L46-48) supports ONE tier
per link: `link({ tiers: ['view','comment','edit'], tier: 'view' })`. The `map`
plugin (doc.mjs L36-40) supports per-member payload but ONLY for `ref('User')`—
not for link principals. Google Photos models link shares as per-member: share
with alice@gmail.com as "viewer", bob@gmail.com as "contributor."

```js
// IDEALIZED — cannot express (map with link principals):
linkMembers: map(linkIdentity, {
  role: ['view', 'comment', 'edit'],
  default: {},
}).can(async ({ is }) =>
  (await is.owner()) ? grant(...OWNER) : deny('only owner may manage link shares')),

// WORKAROUND — one link per tier, crude but functional:
linkShareView: link({ tiers: ['view'], tier: 'view', token: 'autogen' }),
linkShareEdit: link({ tiers: ['edit'], tier: 'edit', token: 'autogen' }),
```

The workaround is functional but semantically impoverished: the framework
can't express "this link was shared with alice@gmail.com" — it only knows a
token exists at a tier. For an app that needs to list "who has this link" or
revoke a specific recipient, the framework offers no help.

**ADR tested**: ADR #2 (`scope(...).can(...)` grammar). The `map` plugin
already demonstrates the right pattern (per-key payload); extending it to
link principals would add a `linkIdentity` key type without adding a third
grant method. The design surface exists; it's just not connected.

**Severity**: SHOULD-FIX. Single-tier-per-link works for basic sharing but
doesn't match Google Photos' "share with specific people at specific levels"
model.

---

### SHOULD-FIX #3 — No `.gte`/`.lte` comparison predicates

**What fails**: The predicate system has `.is()` (equality) and `.has()` (set
membership). No `.gte()`, `.lte()`, `.lt()`, `.gt()`, `.between()` for range
queries. "Photos taken in December 2023" or "photos from the last 30 days" —
fundamental timeline queries — cannot be expressed.

```js
// IDEALIZED — cannot express:
Photo.findAll(
  Photo.capturedAt.gte(new Date('2023-12-01'))
    .and(Photo.capturedAt.lte(new Date('2023-12-31')))
).sort(Photo.capturedAt, 'desc');

// WORKAROUND — raw SQL for any date range filter.
```

The IMPLEMENTATION-PLAN Phase 3 step 13 plans ".gte/.lte/.lt/range + cursor
pagination" but defers it behind the correctness and performance phases. For
a photo app, date-range queries are not exotic — they're the primary browsing
axis. (Prior finding #6, STILL-OPEN but with a roadmap commitment.)

**Severity**: SHOULD-FIX. Time-based browsing is the second most important
query axis after ownership.

---

### SHOULD-FIX #4 — No `array` field type for tags

**What fails**: User-applied tags are naturally a list of strings: `['vacation',
'paris', '2024']`. No `array` field type exists. You can't model this as `set`
(set contains entity refs, not primitive values) or `map` (needs a key).

```js
// IDEALIZED — cannot express:
tags: array(text()),

// WORKAROUND — comma-separated string, loses typed-handle queries:
tags: text({ optional: true }),  // 'vacation,paris,2024'
```

The IMPLEMENTATION-PLAN Phase 2 step 12 mentions `array` alongside `blob`.
Recognized, not yet designed.

**Severity**: SHOULD-FIX. A photo app without tags is a file browser.

---

### SHARP EDGE #1 — Cross-entity check resolution ambiguity

**What's awkward**: A Photo's grant depends on Album membership. The check
`Photo.album.collaborators.get(principal.id)?.role` requires the authorization
compiler to resolve the typed FK `album` to the Album row and then look up the
map payload. The grilled design doesn't specify whether the check's `{ entity }`
context includes traversed FK fields at runtime.

```js
// Works IF the framework resolves typed FKs in check context:
albumEditor: ({ Photo, principal }) =>
  Photo.album.collaborators.get(principal.id)?.role === 'editor'
  || Photo.album.collaborators.get(principal.id)?.role === 'contributor',
```

The IMPLEMENTATION-PLAN abstraction #5 (typed-FK traversal in the authorization
compiler) covers the compiled `scope` case (producing a SQL JOIN). Whether it
also covers the runtime `.can` case (providing the loaded FK row to the check
function) is unspecified.

**Severity**: SHARP EDGE. Might work, but the contract is undefined.

---

### SHARP EDGE #2 — No `.isNull()` predicate for nullable FK queries

**What's awkward**: ADR #7 mandates that `.is(undefined)` ALWAYS compiles to
SQL FALSE (never SQL `IS NULL`, which would let an anonymous link's undefined
token match rows with a null `linkShare.token`). But for a nullable FK like
`album`, you might genuinely want to find "photos not in any album" — which
requires `album IS NULL`. There is no predicate for this.

```js
// CANNOT express — .is(undefined) compiles to FALSE per ADR #7:
Photo.findAll(Photo.album.is(undefined));  // returns 0 rows, always

// NEEDED — a distinct .isNull() that compiles to SQL IS NULL:
Photo.findAll(Photo.album.isNull());
```

The framework's reasoning is sound (confidentiality fail-closed for link tokens),
but it leaves no way to query nullable fields. A separate `.isNull()`/
`.isNotNull()` predicate pair would resolve this without weakening the ADR.

**Severity**: SHARP EDGE. Blocks one specific query pattern (find orphans).

---

### SHARP EDGE #3 — Compound queries require `.and()` not yet demonstrated

**What's awkward**: The grilled exemplars (doc.mjs L207-209) only show
single-predicate queries: `Doc.findAll(Doc.owner.is(me))`. The
IMPLEMENTATION-PLAN Phase 1 step 6 plans `.and`/`.not`/`.is`/`.in` predicate
operators, but they're not in any exemplar. Without `.and()`, you can't express
"photos in album X AND owned by me AND taken in December" — you'd need to fetch
and post-filter in JS, losing the SQL compilation benefit.

```js
// IDEALIZED — requires .and() (planned, not demonstrated):
Photo.findAll(
  Photo.album.is(albumId)
    .and(Photo.owner.is(me))
    .and(Photo.capturedAt.gte(from))
    .and(Photo.capturedAt.lte(to))
);
```

**Severity**: SHARP EDGE. Single-predicate queries are the floor; compound
queries are the ceiling. Without them, the compiled-WHERE benefit degrades to
single-column filtering.

---

### SHARP EDGE #4 — `effects` cannot express external computation

**What's awkward**: The grilled `effects` are `{ mutate, with }` —
in-transaction data mutations only. Thumbnail generation requires external I/O
(ImageMagick, sharp). EXIF extraction requires external I/O (exiftool). Face
detection requires external ML. ALL of these must use an external job queue
outside the framework.

```js
// CANNOT express with grilled effects — external computation:
effects: {
  [original.onUploaded]: { mutate: PhotoProcessor, with: {
    photoId: entity.id,
    actions: ['generateThumbnail', 'extractExif'],
  } },
}
```

Even if `effects` COULD route to an external pipeline, there's a subtler
problem: the `{ mutate, with }` template receives data from the trigger delta +
origin row — but a thumbnail's data comes from an async computation RESULT.
`storedDerived` (BLOCKER #2) is the right primitive for self-mutating async
computation; effects are the right primitive for cross-entity notification.
The two are conflated in the design because they're both "declarative
reactions" — but their data flows are opposite directions.

**Severity**: SHARP EDGE. Recognized gap (FEATURES.md §7), deferred deliberately.
Without it, the upload pipeline is 100% external to the framework.

---

## Prior findings re-checked

| # | Prior Finding | Status | Why |
|---|---------------|--------|-----|
| 1 | No blob/binary field type | **SETTLED** | `blob` now exported from `workbench` (`src/field.mjs`); `import { blob } from 'workbench'` resolves. The field type shipped. (Historical: was STILL-OPEN / Phase 2 step 12.) |
| 2 | No full-text search predicate | **STILL-OPEN** | Listed as "Deferred / plugin territory." No `.match()`/`.search()` predicate exists. |
| 3 | No background-job or async-pipeline | **PARTIALLY-SETTLED** | `effects` solves in-transaction cross-entity mutation (ADR #5). A background job queue has since shipped (`createJobQueue` from `workbench/server`, `src/job-queue.mjs`) — durable out-of-band work now has a primitive. The broader `storedDerived` (async compute+persist, eager-on-write) design for thumbnails remains deferred to Phase 3. The external-job-queue gap narrowed further but the eager async-pipeline didn't close. |
| 4 | No geo-point field type | **STILL-OPEN** | Listed as "Deferred / plugin territory." No `point` constructor, no `.near()` predicate. |
| 5 | No link-sharing primitive | **RESOLVED** | The `link` field type + link principal in doc.mjs fully addresses the basic case. Per-member link tiers is a new gap (SHOULD-FIX #2) but the primitive EXISTS. |
| 6 | No date-range or comparison predicates | **STILL-OPEN** | Planned (Phase 3 step 13 — `.gte`/`.lte`/`.lt`) but not yet in exemplars. Has a roadmap commitment. |
| 7 | No boolean field type | **RESOLVED** | `boolean` appears in comment.mjs L32: `boolean({ default: false })`. |
| 8 | No permission-level distinction on `set(ref('User'))` | **RESOLVED** | `map` plugin with per-member `role` payload (doc.mjs L36-40). Dissolves the three-separate-set-fields workaround. |
| 9 | No reverse-set traversal | **NEW-ANGLE** | Typed-FK traversal (abstraction #5) covers auth compiler traversal; reverse lookup still not demonstrated for non-User sets. Milder gap now. |
| 10 | No EXIF/metadata field type (JSON-like) | **STILL-OPEN** | No `json`/`object` constructor exists. Not mentioned in the IMPLEMENTATION-PLAN at all. 20+ flattened fields is the only workaround. |

---

## Summary

- **4 BLOCKERS** (~~blob~~ [SETTLED — `blob` shipped, `src/field.mjs`], storedDerived, geo, full-text) — the core storage, processing, and query primitives of a photo app require constructs the framework doesn't have.
- **4 SHOULD-FIX** (json field, per-member link tiers, comparison predicates, array field) — each forces a workaround that loses typed-handle queryability or creates schema debt.
- **4 SHARP EDGES** (cross-entity check resolution, nullable FK queries, compound `.and()`, external computation via effects) — ambiguous contracts or planned-but-not-shown features.
- **4 of 10 prior findings RESOLVED** by the grilled ADRs (link sharing, boolean, valued-set tiers, half of the async-pipeline gap).
- **The biggest risk**: the upload → process → serve pipeline (BLOCKERS #1 + #2) is 100% external to the framework. The framework owns read — the app owns all of write. This is not a DX gap; it's a structural boundary that makes the framework a read-only shell for the app's most important operation.
