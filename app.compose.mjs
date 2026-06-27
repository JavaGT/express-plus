// app.compose.mjs — OPTION 2: plugin pipeline (no central app object).
//
// Thesis: there is no `app` object with methods. The app is an ordered pipeline
// of self-contained feature units — httpDefaults, router, declareDoc,
// declareRoom, on. Boot order is explicit and reads top-to-bottom. Third parties
// extend by adding a pipeline arg. This is the ONLY option that keeps the
// verbs-as-methods varargs idiom fully native (Option 1 sacrifices it).
//
// Auth is FUNCTIONS — unchanged. The schema body is identical to app.mjs.
import { compose, httpDefaults, router, declareDoc, declareRoom, on,
         requireAuth, text, number, crdt, ref, date,
         owner, grant, deny, hide } from 'express-plus';
import { config } from './config.mjs';
import sessionRoutes from './routes/sessions.mjs';
import docRoutes from './routes/docs.mjs';
import shareRoutes from './routes/shares.mjs';

export default compose(
  // Baked-in defaults + error handling + graceful shutdown, as one unit. You
  // declare you want them; you do not hand-mount notFound/errorHandler/trapProcess.
  httpDefaults({ port: config.port, env: config.env }),

  // Verbs-as-methods preserved exactly — varargs chains feel native here.
  router((r) => {
    r.get('/', userList);
    r.use('/sessions', sessionRoutes);
    const users = router((u) => { u.get('/', requireAuth, userList);
                                  u.get('/:id', userPage); });
    r.use('/users', users);
    r.use('/docs', requireAuth, (d) => { d.use('/', docRoutes);
                                         d.use('/:docId/shares', shareRoutes); });
  }),

  declareDoc('Doc', {
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

    hooks: { afterSave: ({ doc, user }, app) => app.emit('Doc.touched', { doc, by: user }) },
  }),

  declareRoom('/docs/:docId', {
    require: requireAuth, load: 'Doc',
    presence: { cursor: true, selection: true, name: 'user.username' },
    chat: true,
  }),

  declareRoom('/me/inbox', {
    require: requireAuth,
    events: ['share:added', 'share:revoked', 'doc:renamed', 'doc:deleted'],
  }),

  on('Doc.share', ({ doc, invitee, by }, app) =>
    app.emitTo(invitee.id, 'share:added', {
      id: doc.id, title: doc.title,
      sharedBy: { id: by.id, username: by.username }, at: Date.now() })),

  on('Doc.unshare', ({ doc, user }, app) =>
    app.emitTo(user.id, 'share:revoked', { id: doc.id })),
).listen();
