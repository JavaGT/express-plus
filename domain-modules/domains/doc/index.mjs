// domains/doc/index.mjs — the whole Doc bounded context (full power-user form).
//
// Schema + auth + rooms + routes + hooks + cross-domain wiring co-located.
// Authorization lives WITH the data it protects. The auth triad — predicates,
// grant, per-field access — are TOP-LEVEL PEERS of `schema`, so the three
// controls read at a glance; `schema` is a clean field listing.
//
// Everything below the field list is OPTIONAL. Delete `grant` and the framework
// default (owner ⇒ all, else hide) applies because `owner()` exists. Delete
// `rooms` and you get one default room. Delete `routes` and you get auto-CRUD.
// This file is the ceiling; hello.mjs is the floor; same constructor, additive.
import { module, text, number, crdt, ref, date,
         requireAuth, owner, grant, deny, hide } from 'express-plus';
import { feed, home, bumpUpdatedAt } from './routes/handlers.mjs';
import shareRoutes from './routes/shares.mjs';

export default module('Doc', {
  // `schema` is PURELY fields. `owner()` is sugar for
  // ref('User', { from: 'req.user.id', readonly: true }) that also marks the
  // ownership relation — see the auth note below.
  schema: {
    title:     text({ max: 200, default: 'Untitled' }),
    wordCount: number({ derived: (doc) => doc.body.split(' ').length, readonly: true }),
    body:      crdt.text({
      // Per-field access — always a function, authoritative for THIS field.
      // Declaring access two ways (static + function) errors at schema load.
      access: ({ is }, base) =>
        is.payer() ? deny('billing accounts cannot view document content') : base,
    }),
    owner:     owner(),                              // → ownerId ref + predicates.owner
    projectId: ref('Project', { required: true }),
    createdAt: date({ default: () => new Date(), readonly: true }),
    updatedAt: date({ readonly: true }),
  },

  // This Doc's notion of owner/share/payer — NOT a universal one (Project
  // defines its own). `predicates.owner` here OVERRIDES the one `owner()` would
  // generate; kept verbatim so the relation is explicit. Surfaced as `is.*`,
  // request-memoized; all DB access goes through `lookup`.
  predicates: {
    owner:          ({ doc, user }) => owner(doc, user),
    sharedWith:     ({ doc, user, lookup }) =>
                      lookup('shares', { docId: doc.id, userId: user.id }).then(r => r.exists),
    payer:          ({ doc, user, lookup }) =>
                      lookup('payers', { docId: doc.id, userId: user.id }).then(r => r.exists),
    projectManager: async ({ doc, user, load }) =>
                      (await load(doc.projectId)).can('write', user),
  },

  // BASE grant — default capability for every field that doesn't override.
  // Delete this block and you get the framework default (owner ⇒ all, else
  // hide) for free, because `owner()` / predicates.owner exists.
  grant: async ({ is }) => {
    if (is.owner())                return grant({ read: true, write: true, room: true, admin: true });
    if (await is.projectManager()) return grant({ read: true, write: true, room: true, admin: true });
    if (await is.sharedWith())     return grant({ read: true, write: true, room: true });
    if (await is.payer())          return grant({ read: true, write: false });
    return hide();
  },

  // Side effects that LEAVE the doc. Field-to-field derivation stays in `derived`.
  hooks: { afterSave: ({ doc, user }, app) => app.emit('Doc.touched', { doc, by: user }) },

  // Routes live INSIDE the domain that owns the resource. Verbs-as-methods
  // (invariant 6) — `r` is the same router() used everywhere. Declaring `routes`
  // suppresses auto-CRUD; opt back in explicitly with r.resource(). Sub-resources
  // mount with r.use(). A single route opts out of `require` with the `public`
  // middleware (imported when needed); not used here.
  routes: (r) => {
    r.resource();                                    // /docs CRUD through grant/access
    r.get('/feed', feed);                            // owned + shared, product view
    r.get('/home', home);                            // HTML file-list page
    r.use('/:docId', bumpUpdatedAt);                 // bump to top on any save
    r.use('/:docId/shares', shareRoutes);            // sub-resource, owner-gated
  },

  // Default collaborative room at /docs/:docId, PLUS the per-user inbox.
  rooms: [
    { path: '/docs/:docId', require: requireAuth, load: 'Doc',
      presence: { cursor: true, selection: true, name: 'user.username' }, chat: true },
    { path: '/me/inbox', require: requireAuth,
      events: ['share:added', 'share:revoked', 'doc:renamed', 'doc:deleted'] },
  ],

  // Cross-domain wiring — receives `app`, no closure capture, imports clean.
  on: (app) => {
    app.on('Doc.share', ({ doc, invitee, by }) =>
      app.emitTo(invitee.id, 'share:added', {
        id: doc.id, title: doc.title,
        sharedBy: { id: by.id, username: by.username }, at: Date.now() }));
    app.on('Doc.unshare', ({ doc, user }) =>
      app.emitTo(user.id, 'share:revoked', { id: doc.id }));
  },
});
