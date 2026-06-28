// photo.mjs — Google Photos clone: a media entity with blob storage,
// stored-derived thumbnails, structured EXIF, geo-location, full-text
// search, and link-share principals. Demonstrates where the grilled
// express-plus API expresses each concept and where it hits a wall.
//
// IMPORTS: the framework exports we WISH existed are imported with a
// "MISSING" comment — these are the gaps this stress-test documents.
import {
  entity, text, number, date, ref, link, map, boolean,
  grant, deny, read, write, subscribe, admin, anyOf, never, scope,
  router, User,
  // --- MISSING imports (gaps documented in PAIN-POINTS.md) ---
  // blob,          // BLOCKER: no binary field type
  // storedDerived, // BLOCKER: no async computed + persisted field type
  // json,          // SHOULD-FIX: no structured sub-object field type
  // point,         // SHOULD-FIX: no geo-point field type
  // fulltext,      // BLOCKER: no full-text index/predicate
  // array,         // SHOULD-FIX: array field for tags
} from 'express-plus';

// ==========================================================================
// Capability sets
// ==========================================================================
const VIEWER  = [read, subscribe];
const EDITOR  = [read, write, subscribe];
const OWNER   = [read, write, subscribe, admin];

// ==========================================================================
// Photo entity — the core media item
// ==========================================================================
export const Photo = entity('Photo', {
  fields: {
    // ===================================================================
    // BLOCKER: No blob field type
    //
    // Binary storage is the primitive of a photo app — the original image
    // file IS the entity's reason for existing. No framework construct for:
    //   - streaming/multipart upload through the mutation pipeline
    //   - byte-level access control (the URL is gated; the bytes are not)
    //   - deduplication or replication of binary storage
    //   - content-type validation at the field level
    //
    // IDEALIZED (hits the wall):
    //   original: blob({ store: 's3', accept: ['image/*','video/*'], maxSize: '50MB' })
    //     .can(async ({ is }, defaults) =>
    //       (await is.owner() || await is.albumEditor()) ? defaults
    //         : deny('only owner may download original')),
    //
    // WORKAROUND: store an S3/CDN URL as text — the field gates the string,
    // not the bytes at that URL.
    // ===================================================================
    blobUrl: text({ readonly: true }),

    // ===================================================================
    // BLOCKER: No stored-derived field type
    //
    // Thumbnails must be computed ASYNCHRONOUSLY (resize is external I/O),
    // ONCE on upload (not recomputed on every read), and PERSISTED + INDEXED
    // (so queries can use them). The grilled API has:
    //
    //   - `derived(fn)` — synchronous, recompute-on-read. Wrong timing.
    //   - `effects: { mutate, with }` — in-transaction data mutations,
    //     cannot shell out to ImageMagick/sharp. External side effects are
    //     explicitly "NOT yet designed" per FEATURES.md §7.
    //
    // The IMPLEMENTATION-PLAN Phase 3 defers stored-derived as "the
    // genuinely large async-pipeline design — deferred deliberately."
    // For a photo app, this is THE core upload workflow.
    //
    // IDEALIZED (hits the wall):
    //   thumbnailSm: storedDerived({
    //     from: 'original',
    //     processor: 'image.resize',
    //     options: { width: 400, height: 400, fit: 'cover' },
    //     eager: true,  // compute on upload, not on first read
    //   }),
    //   thumbnailLg: storedDerived({
    //     from: 'original',
    //     processor: 'image.resize',
    //     options: { width: 1600, height: 1600, fit: 'inside' },
    //     eager: true,
    //   }),
    //
    // WORKAROUND: external job queue (pg-boss, bull) polls for unprocessed
    // rows, calls ImageMagick, writes thumbnailUrl back. Entirely outside
    // the framework — no integration with the mutation pipeline, no composed
    // event, no effect principal.
    // ===================================================================
    thumbnailSmUrl: text({ optional: true }),
    thumbnailLgUrl: text({ optional: true }),
    isProcessed: boolean({ default: false }),
    processingError: text({ optional: true }),

    // ===================================================================
    // SHOULD-FIX: No structured sub-object field type (json/object)
    //
    // EXIF data is naturally structured: { iso, aperture, focalLength,
    // cameraModel, gpsLat, gpsLng, ... }. No `json` or `object` field type
    // exists. Without it you must either:
    //
    //   (a) Flatten into 20+ individual fields — schema explosion,
    //       impossible to iterate keys, can't query sub-keys as typed handles.
    //   (b) Serialize to text as JSON — loses typed-handle query capability
    //       on individual EXIF keys, breaks the "no magic strings" rule.
    //
    // IDEALIZED (hits the wall):
    //   exif: json({
    //     iso: number(), aperture: number(), shutterSpeed: text(),
    //     focalLength: number(), cameraModel: text(), make: text(),
    //     lens: text(), flash: boolean(), orientation: number(),
    //     gpsLatitude: number(), gpsLongitude: number(),
    //     gpsAltitude: number(), dateTaken: date(),
    //   }),
    //
    // WORKAROUND: flatten every EXIF tag into a separate field (below).
    // 20+ fields that should be one structured sub-object.
    // ===================================================================
    exifIso:           number({ optional: true }),
    exifAperture:      number({ optional: true }),
    exifShutterSpeed:  text({ optional: true }),
    exifFocalLength:   number({ optional: true }),
    exifCameraModel:   text({ optional: true }),
    exifMake:          text({ optional: true }),
    exifLens:          text({ optional: true }),
    exifFlash:         boolean({ optional: true }),
    exifOrientation:   number({ optional: true }),
    // GPS — SHOULD-FIX: no point field type; these are just scalars
    gpsLatitude:       number({ optional: true }),
    gpsLongitude:      number({ optional: true }),
    gpsAltitude:       number({ optional: true }),
    dateTaken:         date({ optional: true }),

    // ===================================================================
    // Core metadata — works fine with existing field types
    // ===================================================================
    caption:     text({ validate: (v) => v.length <= 5000 || 'caption too long' }),
    description: text(),
    filename:    text({ readonly: true }),
    mimeType:    text({ readonly: true }),
    fileSize:    number({ readonly: true }),

    // ===================================================================
    // Tags — SHOULD-FIX: no array field type for user-applied tags
    //
    // IDEALIZED:
    //   tags: array(text()),
    //
    // WORKAROUND: comma-separated string — loses typed-handle queries.
    // ===================================================================
    tags: text({ optional: true }),

    // ===================================================================
    // Ownership & relations — expressible with existing ref + link fields
    // ===================================================================
    owner: ref('User', { role: 'owner', readonly: true }),
    album: ref('Album', { optional: true }),

    // Link-share for direct photo links — the `link` field type handles
    // single-tier-per-link well. For per-member tiers (share with
    // multiple non-users at different tiers), see Album.linkShare
    // discussion in PAIN-POINTS.md.
    linkShare: link({ tiers: ['view', 'download'], tier: 'view', token: 'autogen' })
      .can(async ({ is }) =>
        (await is.owner()) ? grant(...OWNER) : deny('only owner may manage link sharing')),

    // ===================================================================
    // Dates — fully expressible
    // ===================================================================
    capturedAt: date({ optional: true }),
    uploadedAt: date({ default: () => new Date() }),
    updatedAt:  date({ touch: true }),
  },

  // ==========================================================================
  // Checks
  // ==========================================================================
  checks: {
    // Auto-derived from `owner: ref('User', { role: 'owner' })`:
    //   owner: ({ Photo, principal }) => Photo.owner.is(principal.id)
    owner:       ({ Photo, principal }) => Photo.owner.is(principal.id),

    // Cross-entity typed-FK traversal: asks "is principal a member of
    // this photo's album?" The authorization compiler must traverse
    // Photo.album → Album.collaborators. The grilled plan covers this
    // as abstraction #5 (typed-FK traversal in auth compiler), Phase 1.
    //
    // CAN this be in scope? It compiles to:
    //   EXISTS (SELECT 1 FROM album_collaborators ac
    //           WHERE ac.album_id = photo.album_id AND ac.user_id = ?)
    // That's a compilable subquery — should be fine IF typed-FK traversal
    // is implemented.
    albumMember: ({ Photo, principal }) => Photo.album.collaborators.has(principal.id),

    // Link holder — uses `never()` for non-link principals (compiles to
    // SQL FALSE, per ADR #7).
    linkHolder:  ({ Photo, principal }) =>
                   principal.type === 'link'
                     ? Photo.linkShare.token.is(principal.attributes?.token)
                     : never(),

    // ===================================================================
    // Runtime-only role lookups (CANNOT be in scope — would be load-time
    // error if placed there). These depend on per-member payload on the
    // Album.collaborators map. Used only in `.can`, not `scope`.
    //
    // SHARP EDGE: cross-entity role resolution. `Photo.album.collaborators
    // .get(principal.id)?.role` requires resolving the typed FK `album` to
    // the Album row first. The grilled design doesn't specify whether the
    // check's `{ entity }` context includes traversed FK fields at runtime.
    // ===================================================================
    albumEditor: ({ Photo, principal }) =>
                   Photo.album.collaborators.get(principal.id)?.role === 'editor'
                   || Photo.album.collaborators.get(principal.id)?.role === 'contributor',
    albumCoOwner: ({ Photo, principal }) =>
                    Photo.album.collaborators.get(principal.id)?.role === 'coOwner',
  },

  // ==========================================================================
  // Grant
  //
  // scope = who can READ (compiled to SQL WHERE)
  // .can  = every other capability (runtime, per-row)
  // ==========================================================================
  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.owner(), is.albumMember(), is.linkHolder()))
      .can(async ({ is, entity }) => {
        if (await is.owner())         return grant(...OWNER);
        if (await is.albumCoOwner())  return grant(...OWNER);
        if (await is.albumEditor())   return grant(...EDITOR);
        if (await is.albumMember())   return grant(...VIEWER);
        if (await is.linkHolder()) {
          const tier = entity.linkShare.tier;
          return tier === 'download' ? grant(...EDITOR) : grant(...VIEWER);
        }
        return deny('no capability for this principal');
      }),
  ],

  // ==========================================================================
  // Effects — BLOCKER: cannot express async external computation
  //
  // Thumbnail generation + EXIF extraction require external I/O (shelling
  // out to ImageMagick/sharp/exiftool). The grilled effects are
  // `{ mutate, with }` — in-transaction data mutations only. External side
  // effects are explicitly "NOT yet designed" (FEATURES.md §7). Without
  // them, thumbnail generation requires an external job queue that polls
  // for unprocessed rows — entirely outside the framework.
  //
  // IDEALIZED (hits the wall — effects can't call external processors):
  //   effects: {
  //     [original.onUploaded]: { mutate: PhotoProcessor, with: {
  //       photoId: entity.id,
  //       actions: ['generateThumbnail', 'extractExif'],
  //     } },
  //   },
  //
  // Even if effects COULD express this, there's a subtler problem: the
  // effect is "mutate self with async-computed data" — the grilled
  // `mutate` template data comes from the trigger delta + origin row,
  // not from an async computation result. storedDerived is the right
  // primitive, not effects.
  // ==========================================================================
  effects: {
    // No effects declared — thumbnail/EXIF processing lives in an external
    // job queue. This is the single largest framework bypass in the app.
  },

  // ==========================================================================
  // Routes
  // ==========================================================================
  routes: (r, Photo) => {
    r.resource();  // CRUD through grant

    // ===================================================================
    // GEO QUERY — BLOCKER: no spatial predicates
    //
    // The typed-handle predicate system has `.is(val)` (equality) and
    // `.has(id)` (set membership). There is no `.near()`, `.within()`,
    // `.distance()` for geo-radius queries. Combined with the lack of a
    // `point` field type (gpsLat/gpsLng are just scalars), ALL spatial
    // queries must bypass the framework entirely with raw SQL/PostGIS.
    //
    // IDEALIZED (hits the wall — no .near predicate, no point field):
    //   r.get('/nearby', async (req, res) => {
    //     const { lat, lng, radiusKm } = req.query;
    //     const photos = await Photo.findAll(
    //       Photo.location.near({ lat, lng, radiusKm })
    //         .and(Photo.owner.is(req.principal.id))
    //     ).sort(Photo.capturedAt, 'desc').limit(50);
    //     res.json(photos);
    //   });
    // ===================================================================

    // ===================================================================
    // FULL-TEXT SEARCH — BLOCKER: no full-text predicates
    //
    // Same gap: `.is()` and `.has()` can't express "match 'dog'" or
    // "contains 'paris'". No `.match()`, `.search()`, `.contains()`,
    // `.textSearch()` predicate exists. A full-text index cannot be
    // declared at the field level.
    //
    // IDEALIZED (hits the wall — no .match predicate):
    //   r.get('/search', async (req, res) => {
    //     const { q } = req.query;
    //     const photos = await Photo.findAll(
    //       Photo.searchIndex.match(q)
    //     ).sort(Photo.capturedAt, 'desc').limit(50);
    //     res.json(photos);
    //   });
    // ===================================================================

    // Date-range query — SHOULD-FIX: no comparison predicates yet.
    // The IMPLEMENTATION-PLAN Phase 3 step 13 plans `.gte`/`.lte`/`.lt`.
    r.get('/timeline', async (req, res) => {
      const { from, to } = req.query;
      // IDEALIZED (requires .gte/.lte — planned but not in exemplars):
      //   const photos = await Photo.findAll(
      //     Photo.capturedAt.gte(new Date(from)).and(
      //     Photo.capturedAt.lte(new Date(to)))
      //   ).sort(Photo.capturedAt, 'desc');
      res.json({ note: 'date-range query requires .gte/.lte predicates (planned Phase 3)' });
    });

    // Upload endpoint — must bypass the framework's mutation pipeline
    // because blob fields don't exist. A custom route handles multipart
    // upload, uploads to S3, then creates the Photo row with the URL.
    r.post('/upload', async (req, res) => {
      // BLOCKER: no blob field → multipart upload handled outside framework
      res.json({ note: 'upload requires blob field type (BLOCKER #1)' });
    });
  },
});
