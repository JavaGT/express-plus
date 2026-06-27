// domains/doc.mjs — OPTION 3: the whole Doc bounded context.
//
// Schema + auth + rooms + hooks co-located. Authorization lives WITH the data
// it protects — no hunting through app.mjs. Import this module and test
// grant()/predicates as plain functions in isolation.
//
// Auth is FUNCTIONS — unchanged. Explicit mount (not filesystem auto-discovery)
// keeps registration greppable.
import { module, text, number, crdt, ref, date,
         requireAuth, owner, grant, deny, hide } from 'express-plus';

export default module('Doc', {
  schema: {
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
  },

  rooms: [
    { path: '/docs/:docId', require: requireAuth, load: 'Doc',
      presence: { cursor: true, selection: true, name: 'user.username' }, chat: true },
    { path: '/me/inbox', require: requireAuth,
      events: ['share:added', 'share:revoked', 'doc:renamed', 'doc:deleted'] },
  ],

  // hooks receive app — no closure capture, module imports without side effects.
  on: (app) => {
    app.on('Doc.share', ({ doc, invitee, by }) =>
      app.emitTo(invitee.id, 'share:added', {
        id: doc.id, title: doc.title,
        sharedBy: { id: by.id, username: by.username }, at: Date.now() }));
    app.on('Doc.unshare', ({ doc, user }) =>
      app.emitTo(user.id, 'share:revoked', { id: doc.id }));
  },
});
