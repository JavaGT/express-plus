// projects/google-photos/PAIN-POINTS.md
//
// Documenting the gaps when applying the express-plus entity API to a Google
// Photos-style media library. Each entry cites a specific construct that failed
// or was absent, ranks the severity, and describes the workaround attempted.
//
// Rankings: BLOCKER (cannot build the feature without framework change),
//           SHOULD-FIX (framework change substantially improves the DX),
//           NIT (awkward but workable).

# 1. No blob/binary field type — BLOCKER

**Cite**: `fields` in DOMAIN-MODULES.md L24-41 lists `text`, `number`, `date`,
`ref`, `set`, `presence`, `log`, `hash`. There is no `blob` or binary field
constructor.

**Impact**: The original photo/video file, generated thumbnails, and any
binary derivative must live OUTSIDE the framework's field system. We store
off-grid storage URLs (S3 presigned URL, CDN path) as `text` fields. The
framework cannot: (a) stream or serve binary content with access control
enforcement, (b) deduplicate or replicate binary storage, (c) handle
multipart uploads natively, (d) apply field-level `access` to the binary
body itself — the URL is just a string and the access check gates the string,
not the bytes at that URL.

**Workaround**: `blobRef: text()` holding a storage URL.

**Rank**: BLOCKER

---

# 2. No full-text search predicate — BLOCKER

**Cite**: handlers.mjs L17-18 shows typed-handle queries:
`Document.findAll(Document.owner.is(me))`. The only predicates demonstrated
are `.is(val)` (equality) and `.has(id)` (set membership). There is NO
`.match('paris')`, `.contains('dog')`, fulltext index declaration, or
text-search operator in the framework.

**Impact**: "Find photos from Paris 2023 with a dog" — the core search
primitive of a photo library — requires full-text search over `description`,
`ocrText`, and `filename`. Without a framework construct, you must:
(a) install Postgres full-text search or Elasticsearch, (b) write raw SQL/
query strings bypassing the typed-handle predicate system, (c) violate the
"no magic strings for field references" rule (AGENTS.md L50).

**Workaround**: Use an external search index (Elasticsearch) and call it from
a custom route handler. The typed-handle query system is never used for
search — it becomes a second query path, violating the AGENTS.md rule
"Prefer a singular system. One way to do a thing."

**Rank**: BLOCKER

---

# 3. No background-job or async-pipeline construct — BLOCKER

**Cite**: `derived` fields (DOMAIN-MODULES.md L36, doc/index.mjs L36) are
synchronous: `number({ derived: (e) => e.body ? ..., readonly: true })`.
The framework has no `queue`, `pipeline`, `trigger`, `afterCreate` hook,
or async-job dispatch mechanism.

**Impact**: A photo library requires three async pipelines triggered on
upload: (a) thumbnail generation (resize original blob → write thumbnail
URLs to `thumbnailSm`/`thumbnailLg`), (b) face clustering (detect faces →
compute embeddings → group into clusters → write back to FaceCluster),
(c) OCR indexing (extract text from image → write to `ocrText`). Without a
native pipeline construct, ALL of this must live in an external job runner
(bull, pg-boss, etc.) that polls for unprocessed rows or listens to DB
change feeds. The framework's `derived` can't express "compute this value
in the background and write it back when done" — it can only express
immediate synchronous recomputation from source fields.

**Workaround**: External job-queue entirely outside the framework. No
framework integration with upload lifecycle.

**Rank**: BLOCKER

---

# 4. No geo-point field type — SHOULD-FIX

**Cite**: Same field-type listing as above. No `point` or `geography` field
constructor.

**Impact**: Geo-radius queries ("photos within 5km of (48.8, 2.3)") are a
core photo-library feature. We store lat/lng as two `number` fields but cannot
query them spatially through the typed-handle predicate system. Combined with
the lack of range predicates (point 8), this means ALL spatial queries must
bypass the framework entirely.

**Workaround**: Store `latitude: number()` + `longitude: number()` but all
spatial queries use raw SQL against these columns.

**Rank**: SHOULD-FIX

---

# 5. No link-sharing primitive — SHOULD-FIX

**Cite**: `shares: set(ref('User'))` (DOMAIN-MODULES.md L65) is the only
sharing construct. `checks` (doc/index.mjs L88-93) receives
`{ entity, user, lookup, load }` — there is no `req` parameter, so a check
cannot inspect the HTTP request context (e.g., `req.query.token`).

**Impact**: Google Photos supports "get link" — anyone with the URL can view
(before the link is disabled). This requires: (a) an unauthenticated
pathway (the viewer has no User ID), (b) a check that compares the presented
token against `album.linkShareToken`, (c) the ability to grant access without
a user object. The `grant` function and `checks` are user-centric — the user
MUST be authenticated. A link viewer has no session and no User row.

**Workaround**: Store `linkShareToken: text()` and check it in a custom route
middleware that bypasses `requireAuth` (using `open`, as in session/routes.mjs
L22). The middleware loads the album by token and attaches it to `req`. This
creates a SECOND AUTH PATH — the route gate is bypassed and the grant engine
never runs for link viewers (it needs a user). This directly violates
DOMAIN-MODULES.md: "no second auth path."

**Rank**: SHOULD-FIX

---

# 6. No date-range or comparison predicates — SHOULD-FIX

**Cite**: handlers.mjs L17-18 uses `.sort(Document.updatedAt, 'desc')` and
`.limit(10)`. Neither `.gte()`, `.lte()`, `.between()`, nor any comparison
predicate is shown or documented.

**Impact**: "Photos taken in December 2023" or "last 30 days" — fundamental
timeline queries — cannot be expressed in the typed-handle predicate language
without `.gte(capturedAt, new Date('2023-12-01'))` and `.lte(capturedAt, ...)`.
This is adjacent to the full-text and geo gaps: together they mean ALL
non-trivial queries drop to raw SQL.

**Workaround**: Raw SQL for any date range filter.

**Rank**: SHOULD-FIX

---

# 7. No boolean field type — NIT

**Cite**: Field type listing (same as point 1). No `bool` or `boolean`
constructor.

**Impact**: `isLinkShared`, `isProcessed`, `isVideo` — common boolean
metadata. We use `text()` or `number()` as a stand-in, losing semantic
clarity and risking invalid states (null, empty string, "maybe").

**Workaround**: `text({ default: 'false' })` or `number({ default: 0 })`.

**Rank**: NIT

---

# 8. No permission-level distinction on set(ref('User')) — SHOULD-FIX

**Cite**: `shares: set(ref('User'))` in DOMAIN-MODULES.md L65. A share is a
binary membership (in-set or not). There is no per-entry metadata on the set
relationship — no `role: 'viewer' | 'contributor' | 'co-owner'`.

**Impact**: Real photo sharing has tiers. View-only sees the album but cannot
add photos. Contributor can add photos but cannot rename or share further.
Co-owner has full control. Modeling this requires either: (a) three separate
`set(ref('User'))` fields (viewers / contributors / coOwners), which is
verbose and risks a user being in multiple sets, or (b) a standalone
entity with a role field, violating the "collection owned by one side is
a field on that entity" pattern.

**Workaround**: Multiple set fields with distinct checks per role, checked
in order in `grant`.

**Rank**: SHOULD-FIX

---

# 9. No reverse-set traversal for entity-to-entity sets — NIT

**Cite**: DOMAIN-MODULES.md L145-152 describes reverse membership index for
`set(ref('User'))` — the framework auto-derives "docs shared with me" from
the `shares` field. But `set(ref('MediaItem'))` on FaceCluster has NO
documented reverse lookup capability.

**Impact**: "Which clusters contain media item X?" — we use
`FaceCluster.findAll(FaceCluster.members.has(mediaItemId))` which works as
a forward index scan (acceptable for the small number of clusters per
user). However, the User-set pattern sets the expectation that reverse
indices are available; the asymmetry is surprising.

**Workaround**: Forward scan using `.has()` on the set field.

**Rank**: NIT

---

# 10. No EXIF/metadata field type (JSON-like) — NIT

**Cite**: Field types are scalar or set-of-refs. There is no structured
object/JSON field for arbitrary key-value metadata like EXIF tags
(ISO, aperture, focal length, camera model, GPS).

**Impact**: Storing EXIF as individual `number`/`text` fields per tag
explodes the field list (aperture, shutterSpeed, iso, focalLength,
cameraModel, make, lens, flash, orientation, gpsAltitude, gpsDirection...).
A structured `metadata: object()` or `metadata: json()` field would hold
this as an opaque blob. Currently, you serialize it into `text` with JSON
and lose the ability to query individual EXIF keys through the typed-handle
system.

**Workaround**: `text` field holding a JSON string. Individual EXIF values
are unqueryable through the typed predicate system unless you flatten them
into separate fields.

**Rank**: NIT
