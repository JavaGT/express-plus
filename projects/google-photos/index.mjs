// projects/google-photos/index.mjs — MediaItem, Album, and FaceCluster entities.
//
// A photo library is NOT a set of reactive collaborative fields. It's an indexed
// store with background jobs (thumbnail gen, face clustering, OCR indexing),
// full-text + metadata search, time/place grouping, and sharing semantics that
// differ from document collaboration (link-share, co-owner, view-only).
//
// This exemplar stress-tests the express-plus entity API against those needs.
// Where a construct is missing, we WORKAROUND it and document the gap in
// PAIN-POINTS.md — but we never invent new framework exports or pretend
// they exist.
import { entity, text, number, date, ref, set,
          grant, deny, hide,
          read, write, subscribe, admin } from 'express-plus';
import albumRoutes from './routes/albums.mjs';
import mediaRoutes from './routes/media.mjs';
import searchRoutes from './routes/search.mjs';

// -----------------------------------------------------------------------------
// MediaItem — a single photo or video.
//
// Every field uses a framework-provided constructor. Where an ideal field type
// does not exist (blob, geo-point, boolean, fulltext-index, JSONB), we store
// the data as `text` (or split across two `number` fields) and flag the gap.
// -----------------------------------------------------------------------------
export const MediaItem = entity('MediaItem', {
  fields: {
    // === BINARY STORAGE (PAIN POINT: no blob field type) ===
    //
    // The framework has text / number / date / ref / set / presence / log /
    // hash. There is NO blob or binary field constructor. For a photo library,
    // this means the original file and thumbnails live outside the framework's
    // field system — we store opaque storage URLs (S3 presigned, local path,
    // CDN URL) instead. The framework cannot: (a) stream binary content,
    // (b) enforce access control on the binary body itself, (c) manage storage
    // replication, (d) auto-generate thumbnails. We treat these as external
    // references.
    blobRef:       text({ required: true }),   // storage URL of the original
    thumbnailSm:   text(),                       // 200px thumbnail URL
    thumbnailLg:   text(),                       // 1600px thumbnail URL

    // === METADATA ===
    mimeType:      text({ required: true }),     // image/jpeg, video/mp4, etc.
    filename:      text({ required: true }),
    sizeBytes:     number({ readonly: true }),

    // === IMAGE DIMENSIONS (readonly — set from EXIF at upload) ===
    width:         number({ readonly: true }),
    height:        number({ readonly: true }),

    // === CAPTURE TIME ===
    // EXIF DateTimeOriginal — the canonical temporal key for "Memories" grouping
    // and timeline browsing.
    capturedAt:    date(),

    // === GEO LOCATION (PAIN POINT: no geo-point field type) ===
    //
    // There is no lat/lng or point field constructor. Geo-radius queries
    // ("photos within 5km of (48.8, 2.3)") are impossible within the typed-
    // handle predicate system. We store coordinates as plain numbers but
    // cannot query them with geo predicates.
    latitude:      number(),
    longitude:     number(),

    // === TEXT FIELDS ===
    description:   text({ max: 2000 }),          // user-written caption
    ocrText:       text(),                        // OCR-extracted text from image

    // === OWNERSHIP (pattern: ref('User', { role: owner })) ===
    owner:         ref('User', { role: owner, readonly: true }),

    // === ALBUM MEMBERSHIP ===
    // A MediaItem belongs to zero or one album (the FK is nullable). When
    // attached, `album` is the owning container.
    album:         ref('Album'),                   // FK, nullable

    // === TIMESTAMPS ===
    uploadedAt:    date({ default: () => new Date(), readonly: true }),
    updatedAt:     date({ touch: true, readonly: true }),
  },

  // === CHECKS (is.* surfaced in grant/access) ===
  checks: {
    owner:        ({ entity, user }) => entity.owner === user.id,
    // A collaborator on the parent album can see the media item.
    albumMember:  async ({ entity, user, load }) => {
      if (!entity.album) return false;
      const album = await load(entity.album);
      return album.isCollaborator(user);
    },
  },

  // === GRANT ===
  //
  // NOTE: the link-share check for "anyone with the album link can view"
  // requires loading the parent album and checking a token field. The framework
  // has no built-in token/link-share concept — this is a custom predicate.
  grant: async ({ is }) => {
    if (is.owner())        return grant(read, write, subscribe, admin);
    if (await is.albumMember()) return grant(read, subscribe);
    return hide();
  },

  // === ROUTES ===
  routes: (r, Media) => {
    r.resource();                                // auto-CRUD at /media, through grant
    r.use('/:mediaItemId/faces', faceRoutes(Media)); // sub-resource: face clusters
  },
});

// -----------------------------------------------------------------------------
// Album — a named collection of MediaItems, shareable.
//
// Albums have TWO sharing paths: (a) named-user shares via `shares: set(ref('User'))`
// mirroring Doc shares, and (b) link sharing — anyone with a URL token. The
// framework has no link-share primitive; we model it as an optional text field.
// -----------------------------------------------------------------------------
export const Album = entity('Album', {
  fields: {
    title:         text({ max: 200, required: true }),
    description:   text({ max: 2000 }),

    // === COVER PHOTO ===
    coverItem:     ref('MediaItem'),

    // === OWNERSHIP ===
    owner:         ref('User', { role: owner, readonly: true }),

    // === NAMED-USER SHARES (mirrors Doc shares pattern) ===
    // PAIN POINT: there is no permission-level distinction. All collaborators
    // get the same grant computed by `grant`. Real photo sharing has tiers:
    // view-only, can-add-photos, co-owner. Here, co-owners are also just
    // entries in `shares` — we'd need a per-share metadata field (not available)
    // or multiple sets to encode roles.
    shares:        set(ref('User')),

    // === LINK SHARING (PAIN POINT: no framework primitive) ===
    //
    // Google Photos allows sharing via a URL: anyone with the link can view.
    // The framework has no concept of "unauthenticated access via token."
    // We model it with a nullable text field that behaves as an opaque token.
    // The grant function checks this token from the request context (custom
    // middleware would extract it from a query param or path segment).
    linkShareToken: text(),                       // null = link sharing off

    // === TIMESTAMPS ===
    createdAt:     date({ default: () => new Date(), readonly: true }),
    updatedAt:     date({ touch: true, readonly: true }),
  },

  // === CHECKS ===
  checks: {
    owner:          ({ entity, user }) => entity.owner === user.id,
    collaborator:   ({ entity, user }) => entity.owner === user.id || entity.shares.has(user.id),
    // PAIN POINT: link-share check needs access to the HTTP request context
    // (query param or header) to compare the presented token against
    // entity.linkShareToken. This is NOT a pure entity+user check — it's a
    // request-context check. The `checks` API only receives `{ entity, user,
    // lookup, load }` — there is no `req` parameter.
    // WORKAROUND: this check is pushed to a middleware layer that sets a
    // synthetic property on the user context, which is fragile.
    linkViewer:     async ({ entity, user, lookup }) => {
      // Cannot implement here — needs req.query.token from the request.
      // This check exists as a placeholder to document the gap.
      return false;
    },
  },

  // === GRANT ===
  grant: async ({ is }) => {
    if (is.owner())                  return grant(read, write, subscribe, admin);
    if (await is.collaborator())     return grant(read, write, subscribe);
    // PAIN POINT: link viewers need read+subscribe but the check in `is`
    // cannot access the request token (see checks.linkViewer above).
    if (await is.linkViewer())       return grant(read, subscribe);
    return hide();
  },

  // === ROUTES ===
  routes: (r, Album) => {
    r.resource();                                   // auto-CRUD at /albums, through grant
    r.use('/:albumId/shares', shareRoutes(Album));   // sub-resource: named-user shares
    r.use('/:albumId/media', mediaRoutes(Album));     // sub-resource: list/add/remove media
  },
});

// -----------------------------------------------------------------------------
// FaceCluster — a group of MediaItems by detected face.
//
// Face clusters are produced by BACKGROUND JOBS (pain point: no job queue or
// async pipeline construct). In a real implementation, an ML pipeline detects
// faces on upload, computes embeddings, groups similar embeddings into clusters,
// and writes the cluster assignments back. The framework has only synchronous
// `derived` fields — there is no trigger-on-create that fires async work.
// -----------------------------------------------------------------------------
export const FaceCluster = entity('FaceCluster', {
  fields: {
    label:         text({ max: 100, default: 'Unknown' }),  // user-assigned or auto
    owner:         ref('User', { role: owner, readonly: true }),
    members:       set(ref('MediaItem')),                   // photos with this face
    createdAt:     date({ default: () => new Date(), readonly: true }),
  },

  checks: {
    owner: ({ entity, user }) => entity.owner === user.id,
  },

  grant: async ({ is }) => {
    if (is.owner()) return grant(read, write, subscribe, admin);
    return hide();
  },

  routes: (r, Cluster) => {
    r.resource();
  },
});

// -----------------------------------------------------------------------------
// Sub-resource route loaders — factory functions that receive the entity class
// to avoid circular imports, following the pattern from doc/routes/shares.mjs.
// -----------------------------------------------------------------------------

import { router as Router, User } from 'express-plus';

// shareRoutes — invite/list/revoke collaborators on an album.
// Mirrors the doc/routes/shares.mjs pattern exactly.
function shareRoutes(AlbumEntity) {
  const r = Router();

  r.get('/', async (req, res) => {
    if (!req.album.isOwner(req.user)) return res.sendStatus(403);
    const rows = (await req.album.shares.toArray()).map((u) => `${u.username} <${u.email}>`);
    res.json({ shares: rows });
  });

  r.post('/', async (req, res, next) => {
    if (!req.album.isOwner(req.user)) return res.sendStatus(403);
    const invitee = await User.findOne(User.username.is(req.body.username));
    if (!invitee) return next({ status: 404, message: 'no such user' });
    await req.album.shares.add(invitee.id);
    res.status(201).json({ sharedWith: { id: invitee.id, username: invitee.username } });
  });

  r.delete('/:userId', async (req, res) => {
    if (!req.album.isOwner(req.user)) return res.sendStatus(403);
    await req.album.shares.remove(req.params.userId);
    res.sendStatus(204);
  });

  return r;
}

// mediaRoutes — list/add/remove media items within an album.
function mediaRoutes(AlbumEntity) {
  const r = Router();

  r.get('/', async (req, res) => {
    // PAIN POINT: no geo/datetime/fulltext predicates. We use typed-handle
    // exact-match only. Sorting by capturedAt is available; filtering by
    // date range is NOT — there is no `.between()` or `.gte()` on date fields.
    const items = await MediaItem.findAll(MediaItem.album.is(req.album.id))
      .sort(MediaItem.capturedAt, 'desc')
      .limit(100);
    res.json({ items });
  });

  r.post('/', async (req, res) => {
    // PAIN POINT: `album.addPhoto(itemId)` would ideally be a method on the
    // set field, but MediaItem owns its album FK, not Album. We set it on the
    // media item instead. There's no "reverse set" concept to add to a set from
    // the other end.
    const item = await MediaItem.getOrFail(req.body.mediaItemId);
    // Ownership check: you can only add your own photos to an album.
    if (!item.isOwner(req.user)) return res.sendStatus(403);
    item.album = req.album.id;  // field mutation auto-persists — no .save() needed
    res.status(201).json({ added: item.id });
  });

  r.delete('/:mediaItemId', async (req, res) => {
    const item = await MediaItem.getOrFail(req.params.mediaItemId);
    if (item.album !== req.album.id) return res.sendStatus(404);
    if (!item.isOwner(req.user) && !req.album.isOwner(req.user))
      return res.sendStatus(403);
    item.album = null;           // field mutation auto-persists
    res.sendStatus(204);
  });

  return r;
}

// faceRoutes — list face clusters associated with a media item.
function faceRoutes(MediaEntity) {
  const r = Router();

  r.get('/', async (req, res) => {
    // PAIN POINT: to find clusters containing this media item, we must scan
    // FaceCluster and check `members.has()`. The reverse index ("which clusters
    // contain media item X?") is not auto-derived from the set field — the
    // framework maintains a reverse membership index for user-share notifications
    // on `set(ref('User'))`, but there's no documented equivalent for
    // `set(ref('Entity'))` in the general case. We use the typed-handle query.
    const clusters = await FaceCluster.findAll(
      FaceCluster.members.has(req.mediaItem.id)
    );
    res.json({ clusters });
  });

  return r;
}
