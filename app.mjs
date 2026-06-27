// app.mjs — product wiring only. Sensible defaults (security, body, sessions,
// req.user hydration, rate limit, cors, logs, views, static, error handling,
// graceful shutdown) are baked into express-plus, so there is nothing to apply.
// One auth concept — requireAuth — works on both HTTP routes and WS rooms.
import expressPlus, { router, requireAuth, owner, shared, grant, deny, hide } from 'express-plus';
import { config } from './config.mjs';
import { notFound, errorHandler, trapProcess } from './errors.mjs';

import sessionRoutes from './routes/sessions.mjs';
import docRoutes from './routes/docs.mjs';
import shareRoutes from './routes/shares.mjs';

const app = expressPlus();

// Verbs are methods with varargs handlers (Express/Fastify/Hono idiom).
// Routers mount bare with app.use(path, router).
app.get('/', userList);
app.use('/sessions', sessionRoutes);

const users = router();
users.get('/', requireAuth, userList);
users.get('/:id', userPage);
app.use('/users', users);

const docs = router();
docs.use(requireAuth);
docs.use('/', docRoutes);
docs.use('/:docId/shares', shareRoutes);
app.use('/docs', docs);

app.use(notFound);
app.use(errorHandler);

// Document type — framework auto-generates CRUD + history + CRDT room from this.
//
// Authorization is always a FUNCTION, never a magic value:
//   - `grant(ctx)` returns the BASE capability for the whole doc (the default
//     every field inherits when it has no `access` of its own).
//   - A field MAY declare `access: (ctx, base) => Capability` — always a
//     function. When present, it is AUTHORITATIVE for that field: the base no
//     longer applies to it (no composing, no widen/narrow — so no power-vs-
//     safety question). `base` is passed in only as a convenience the function
//     may return to say "inherit." If a field declares access in two ways
//     (e.g. a static capability AND an `access` function), the framework
//     ERRORS at schema load — one mechanism per field.
// Returns are built from three constructors, not booleans:
//   grant({...})  allow, optionally partial (e.g. read of some fields)
//   deny(reason) 403 carrying a human reason
//   hide()       404 — existence not leaked (an empty capability set)
// `is` is a context of the schema's own predicates (see `predicates:` below),
// closed over (doc, user) and request-memoized — calling is.payer() from
// `grant` then again from body.access runs the predicate once, one DB hit.
// `lookup` memoizes the in-flight PROMISE per (collection, query) across the
// whole request, so listing 50 docs that share a project hits it once.
app.doc('Doc', {
  title:     expressPlus.text({ max: 200, default: 'Untitled' }),
  wordCount: expressPlus.number({ derived: (doc) => doc.body.split(' ').length, readonly: true }),
  body:      expressPlus.crdt.text({
    // Per-field access — always a function, authoritative for this field.
    // Payer got read:true in the base; here we revoke body specifically, so a
    // payer sees title + wordCount (metadata) but never the content. Everyone
    // else inherits `base` unchanged.
    access: ({ is }, base) =>
      is.payer() ? deny('billing accounts cannot view document content') : base,
  }),
  ownerId:   expressPlus.ref('User', { from: 'req.user.id', readonly: true }),
  projectId: expressPlus.ref('Project', { required: true }),
  createdAt: expressPlus.date({ default: () => new Date(), readonly: true }),
  updatedAt: expressPlus.date({ readonly: true }),

  // Schema-level helper functions — this Doc's notion of owner/share/payer,
  // NOT a universal one (Project defines its own). Surfaced as `is.*` in
  // `grant` and field `access`. All DB access goes through `lookup` so the
  // same query across predicates + fields fires once per request.
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
  // hide) for free, because `predicates.owner` exists. Zero-to-one: no grant,
  // no access, just fields.
  grant: async ({ is }) => {
    if (is.owner())                 return grant({ read: true, write: true, room: true, admin: true });
    if (await is.projectManager())  return grant({ read: true, write: true, room: true, admin: true });
    if (await is.sharedWith())      return grant({ read: true, write: true, room: true });
    if (await is.payer())           return grant({ read: true, write: false }); // body carved out by its own access
    return hide();                  // 404 — existence not leaked
  },

  // Side effects that LEAVE the doc. Field-to-field derivation stays in `derived`.
  hooks: {
    afterSave: ({ doc, user }) => app.emit('Doc.touched', { doc, by: user }),
  },
});

app.room('/docs/:docId', {
  require: requireAuth,
  load: 'Doc',
  presence: { cursor: true, selection: true, name: 'user.username' },
  chat: true,
});

// Per-user inbox: the file-list page subscribes here for live share updates.
app.room('/me/inbox', {
  require: requireAuth,
  events: ['share:added', 'share:revoked', 'doc:renamed', 'doc:deleted'],
});

// Lifecycle listeners — side effects, no next() ceremony. emitTo routes to a
// user's subscribed rooms without touching the raw socket layer.
app.on('Doc.share', ({ doc, invitee, by }) =>
  app.emitTo(invitee.id, 'share:added', {
    id: doc.id, title: doc.title,
    sharedBy: { id: by.id, username: by.username }, at: Date.now(),
  }));

app.on('Doc.unshare', ({ doc, user }) =>
  app.emitTo(user.id, 'share:revoked', { id: doc.id }));

const server = app.listen(config.port, () =>
  console.log(`gdocs-clone on http://localhost:${config.port} [${config.env}]`));
trapProcess(server);
