// app.defineApp.mjs — OPTION 1: one declarative config object.
//
// Thesis: the app is a single object with four exhaustive keys (routes, docs,
// rooms, hooks). There is no `app` object to call methods on, so the framework
// owns boot, defaults, and error handling — you literally cannot re-import
// notFound/errorHandler/trapProcess or hand-mount auto-generated CRUD. The
// four-bucket shape ENFORCES the "declare, don't plumb" philosophy by structure.
//
// Auth is FUNCTIONS — grant, predicates, body.access, hooks are all real
// functions, identical to app.mjs. Only the entry-point WIRING changes.
import { defineApp, router, requireAuth, text, number, crdt, ref, date,
         owner, grant, deny, hide } from 'express-plus';
import { config } from './config.mjs';
import sessionRoutes from './routes/sessions.mjs';
import docRoutes from './routes/docs.mjs';     // product-only views (/feed, /home)
import shareRoutes from './routes/shares.mjs';

export default defineApp({
  port: config.port,
  env:  config.env,

  // Verbs-as-methods preserved via router() for product HTTP. The four-bucket
  // shape forbids app.use(notFound)/app.use(errorHandler) — framework adds them.
  routes: {
    '/':         { get: userList },
    '/sessions': sessionRoutes,
    '/users':    (() => { const r = router();
                          r.get('/', requireAuth, userList);
                          r.get('/:id', userPage);
                          return r; })(),
    '/docs':     { use: [requireAuth], mount: [['/', docRoutes],
                                               ['/:docId/shares', shareRoutes]] },
  },

  docs: {
    Doc: {
      title:     text({ max: 200, default: 'Untitled' }),
      wordCount: number({ derived: (doc) => doc.body.split(' ').length, readonly: true }),
      body:      crdt.text({
        access: ({ is }, base) =>
          is.payer() ? deny('billing accounts cannot view document content') : base,
      }),
      ownerId:   ref('User', { from: 'req.user.id', readonly: true }),
      projectId: ref('Project', { required: true }),
      createdAt: date({ default: () => new Date(), readonly: true }),
      updatedAt: date({ readonly: true }),

      predicates: {
        owner:          ({ doc, user }) => owner(doc, user),
        sharedWith:     ({ doc, user, lookup }) =>
                          lookup('shares', { docId: doc.id, userId: user.id }).then(r => r.exists),
        payer:          ({ doc, user, lookup }) =>
                          lookup('payers', { docId: doc.id, userId: user.id }).then(r => r.exists),
        projectManager: async ({ doc, user, load }) =>
                          (await load(doc.projectId)).can('write', user),
      },

      grant: async ({ is }) => {
        if (is.owner())                return grant({ read: true, write: true, room: true, admin: true });
        if (await is.projectManager()) return grant({ read: true, write: true, room: true, admin: true });
        if (await is.sharedWith())     return grant({ read: true, write: true, room: true });
        if (await is.payer())          return grant({ read: true, write: false });
        return hide();
      },

      // hooks receive `app` as a parameter — no closure over a module-level app,
      // so the schema is testable in isolation.
      hooks: { afterSave: ({ doc, user }, app) => app.emit('Doc.touched', { doc, by: user }) },
    },
  },

  rooms: {
    '/docs/:docId': { require: requireAuth, load: 'Doc',
                      presence: { cursor: true, selection: true, name: 'user.username' },
                      chat: true },
    '/me/inbox':    { require: requireAuth,
                      events: ['share:added', 'share:revoked', 'doc:renamed', 'doc:deleted'] },
  },

  hooks: {
    'Doc.share':   ({ doc, invitee, by }, app) =>
                     app.emitTo(invitee.id, 'share:added', {
                       id: doc.id, title: doc.title,
                       sharedBy: { id: by.id, username: by.username }, at: Date.now() }),
    'Doc.unshare': ({ doc, user }, app) => app.emitTo(user.id, 'share:revoked', { id: doc.id }),
  },
});
