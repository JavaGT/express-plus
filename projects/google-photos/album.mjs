// album.mjs — Google Photos clone: an album entity grouping photos,
// with per-member collaborator roles and link-share for non-users.
// Exercises the `map` plugin for valued-set membership and the `link`
// field type for non-user principals.
import {
  entity, text, date, ref, map, link,
  grant, deny, read, write, subscribe, admin, anyOf, never, scope,
  router, User,
} from 'express-plus';
import { Photo } from './photo.mjs';

const VIEWER     = [read, subscribe];
const CONTRIBUTOR = [read, write, subscribe];  // can add photos, not rename
const CO_OWNER   = [read, write, subscribe, admin];
const OWNER      = [read, write, subscribe, admin];

export const Album = entity('Album', {
  fields: {
    title:       text({ validate: (v) => v.length <= 200 || 'title too long' }),
    description: text(),
    coverPhoto:  ref('Photo', { optional: true }),

    // Owner — auto-derives checks.owner from `role: 'owner'`
    owner: ref('User', { role: 'owner', readonly: true }),

    // ===================================================================
    // Per-album collaborator roles — EXPRESSIBLE with the `map` plugin
    //
    // The grilled `map` plugin (doc.mjs L36-40) supports:
    //   - keyed-by-User membership (uniqueness-by-construction)
    //   - per-member payload (here: role = 'viewer'|'contributor'|'coOwner')
    //   - fluent `.can()` for field-level access control
    //
    // This dissolves the pre-grill problem of modeling tiered sharing
    // with three separate `set(ref('User'))` fields (prior finding #8).
    // The `map` plugin is a RESOLVED prior finding.
    // ===================================================================
    collaborators: map(ref('User'), {
      role: ['viewer', 'contributor', 'coOwner'],
      default: {},
    }).can(async ({ is }) =>
      (await is.owner()) ? grant(...OWNER) : deny('only owner may manage collaborators')),

    // ===================================================================
    // Link-share for non-users — MOSTLY EXPRESSIBLE
    //
    // The `link` field type (doc.mjs L46-48) supports:
    //   - non-user principal (type: 'link') with a token
    //   - single tier per link (e.g. 'view')
    //   - grant reads the tier to pick capabilities
    //
    // This RESOLVES prior finding #5 (no link-sharing primitive).
    //
    // SHARP EDGE: the `link` field has ONE tier per link. Google Photos
    // models link shares as per-member: share with alice@gmail.com as
    // "viewer", bob@gmail.com as "contributor". To express per-member
    // link tiers, you'd need:
    //   linkMembers: map(linkIdentity, { role: ['view','comment','edit'] })
    // ...but `map` only accepts `ref('User')`, not link principals.
    //
    // WORKAROUND: create one link per tier (one view-only link, one
    // edit link). Crude but functional — each member gets a different
    // link URL at the tier they need.
    //
    // IDEALIZED (hits the wall — map with link principals):
    //   linkMembers: map(linkIdentity, {
    //     role: ['view', 'comment', 'edit'],
    //     default: {},
    //   }).can(async ({ is }) => (await is.owner()) ? grant(...OWNER)
    //                            : deny('only owner may manage link shares')),
    // ===================================================================
    linkShare: link({ tiers: ['view', 'comment', 'edit'], tier: 'view', token: 'autogen' })
      .can(async ({ is }) =>
        (await is.owner()) ? grant(...OWNER) : deny('only owner may manage link sharing')),

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),
  },

  checks: {
    // Auto-derived from `owner: ref('User', { role: 'owner' })`
    owner:        ({ Album, principal }) => Album.owner.is(principal.id),

    // Membership check — compilable (a set membership SQL check)
    collaborator: ({ Album, principal }) => Album.collaborators.has(principal.id),

    // Link holder — uses `never()` for non-link principals
    linkHolder:   ({ Album, principal }) =>
                    principal.type === 'link'
                      ? Album.linkShare.token.is(principal.attributes?.token)
                      : never(),

    // =================================================================
    // Runtime-only role lookups (CANNOT be in scope)
    //
    // These check the per-member `role` payload on the collaborators map.
    // They cannot compile to SQL (role is in the map payload, not a
    // direct column) — placing them in `scope` would be a load-time error.
    // Used only in `.can`.
    // =================================================================
    contributor: ({ Album, principal }) =>
                   Album.collaborators.get(principal.id)?.role === 'contributor',
    coOwner:     ({ Album, principal }) =>
                   Album.collaborators.get(principal.id)?.role === 'coOwner',
  },

  grant: ({ principal }) => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator(), is.linkHolder()))
      .can(async ({ is, entity }) => {
        if (await is.owner())       return grant(...OWNER);
        if (await is.coOwner())     return grant(...CO_OWNER);
        if (await is.contributor()) return grant(...CONTRIBUTOR);
        if (await is.collaborator()) return grant(...VIEWER);
        if (await is.linkHolder()) {
          const tier = entity.linkShare.tier;
          if (tier === 'edit')    return grant(...CONTRIBUTOR);
          if (tier === 'comment') return grant(...VIEWER);
          return grant(...VIEWER);
        }
        return deny('no capability for this principal');
      }),
  ],

  // ===================================================================
  // Effects — expressible for notification (like doc.mjs)
  //
  // When a collaborator is added, notify them via Inbox.
  // Same pattern as doc.mjs L185-188.
  // ===================================================================
  effects: {
    [collaborators.onAdded]: { mutate: Inbox, with: {
      recipient: delta.member, album: entity.id, kind: 'albumInvite',
    } },
  },

  routes: (r, Album) => {
    r.resource();  // CRUD through grant

    // Per-album collaborator management (same pattern as doc.mjs shareRoutes)
    r.get('/collaborators', async (req, res) => {
      const rows = await req.album.collaborators.toArray();
      res.json({ collaborators: rows.map(([u, payload]) => ({ id: u.id, username: u.username, role: payload.role })) });
    });

    r.post('/collaborators', async (req, res) => {
      const invitee = await User.getOrFail(req.body.userId);
      await req.album.collaborators.set(invitee.id, { role: req.body.role });
      res.status(201).json({ sharedWith: { id: invitee.id, role: req.body.role } });
    });

    r.delete('/collaborators/:userId', async (req, res) => {
      await req.album.collaborators.remove(req.params.userId);
      res.sendStatus(204);
    });

    // =================================================================
    // Album photo listing — EXPRESSIBLE but SHARP EDGE on compound queries
    //
    // The `.is()`/`.has()` predicate system can express "photos in this
    // album" (`Photo.album.is(albumId)`). But combined predicates like
    // "photos in album X AND tagged 'dog' AND taken in December" require
    // `.and()` chaining — planned (Phase 1 step 6) but not in exemplars.
    // =================================================================
    r.get('/photos', async (req, res) => {
      const photos = await Photo.findAll(Photo.album.is(req.album.id))
        .sort(Photo.capturedAt, 'desc').limit(50);
      res.json(photos);
    });
    // IDEALIZED compound query (needs .and(), .gte(), .lte()):
    //   const photos = await Photo.findAll(
    //     Photo.album.is(req.album.id)
    //       .and(Photo.capturedAt.gte(new Date(from)))
    //       .and(Photo.capturedAt.lte(new Date(to)))
    //   ).sort(Photo.capturedAt, 'desc');

    // =================================================================
    // SHARP EDGE: no way to express "photos NOT in any album" (orphans)
    //
    // The predicate system has `.is()`, `.has()`, `.and()`/`.not()` (planned).
    // `.not(Photo.album.is(undefined))` would need `.is(undefined)` to
    // compile to SQL `IS NULL` — but ADR #7 says `.is(undefined)` ALWAYS
    // compiles to SQL FALSE (never SQL IS NULL, to prevent anonymous link
    // token matching null tokens). For nullable fields, you'd need a
    // separate `.isNull()` predicate that is distinct from `.is(undefined)`.
    // =================================================================
  },
});
