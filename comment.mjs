// comment.mjs — a child entity of Doc. Demonstrates abstraction #5: the
// authorization compiler follows the typed FK `doc: ref('Doc')` so a Comment's
// grant INHERITS its parent Doc's grant. No hand-copied parent-visibility logic
// in this `checks` block — `grant.visible = inherit(Doc)` compiles through FK.
//
// A Comment author can edit or delete their own comment; everyone else admitted
// by the inherited Doc-grant gets read/subscribe only. The Doc's link-tier
// (view/comment/edit) flows through automatically: a `view`-only link holder
// can read comments, a `comment`-tier holder can create them.
import {
  entity, text, date, ref, boolean, grant, read, write, subscribe,
  inherit, router,
} from 'express-plus';

// Declarative inherit directive: reused across grant.visible, grant.can, and
// the non-author access fallback. The compiler resolves it through `doc`.
const inheritDoc = inherit('Doc', { via: 'doc' });

export const Comment = entity('Comment', {
  fields: {
    doc:      ref('Doc', { required: true }),        // typed FK → parent; grant inherits through this
    author:   ref('User', { role: 'author', readonly: true }),  // auto-populates req.principal.id
    body:     text({ validate: (v) => v.length <= 5000 || 'comment too long' }),
    resolved: boolean({ default: false }),
    createdAt: date({ default: () => new Date() }),
  },

  // Grant split: visibility compiles through the typed FK (joins Comment→Doc in
  // the WHERE — exact pagination, no N+1); capability inherits the Doc tier for
  // fields without an explicit access override.
  grant: {
    visible: inheritDoc,
    can:     inheritDoc,
  },

  // Capability is composed per-field on top of the inherited visibility: the
  // author gets write on their own row; everyone else (owner, editor, viewer,
  // link holder) gets read/subscribe only — NOT the Doc editor-tier, so an
  // editor of the Doc cannot edit someone else's comment.
  checks: {
    author: ({ entity, principal }) => entity.author === principal.id,
  },

  access: {
    // `can` per-field; visibility is inherited from grant.visible. Every is.*
    // is awaited — the Phase-0 unawaited-call guard is satisfied.
    body:     { can: async ({ is }) =>
                  (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe) },
    resolved: { can: async ({ is }) =>
                  (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe) },
  },

  routes: (r) => {
    r.resource();                                    // CRUD; :docId on the parent path auto-loads req.doc
  },
});

export function commentRoutes() {
  const r = router({ mergeParams: true });
  r.mount('/', Comment);                             // child mounted under /:docId/comments
  return r;
}