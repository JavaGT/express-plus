// comment.mjs — a child entity of Doc. Demonstrates abstraction #5: the
// authorization compiler follows the typed FK `doc: ref('Doc')` so a Comment's
// grant INHERITS its parent Doc's grant. `inheritDoc` contributes BOTH the
// parent's compiled read scope (joined through `doc` into the child's WHERE)
// AND the parent's `.can` — one contribution, both halves.
//
// A Comment author can edit or delete their own comment; everyone else admitted
// by the inherited Doc-scope gets read/subscribe only. The Doc's link-tier
// (view/comment/edit) flows through automatically: a `view`-only link holder
// can read comments, a `comment`-tier holder can create them.
import { entity, text, date, ref, boolean, grant, read, write, subscribe, inherit, router } from 'workbench';
import { Doc } from './doc.mjs';

// Declarative inherit directive: the compiler resolves it through `doc`,
// pulling in the parent Doc's read scope (compiled WHERE join) AND its `.can`.
const inheritDoc = inherit(Doc, { via: 'doc' });

export const Comment = entity('Comment', {
  fields: {
    doc: ref('Doc', { required: true }),        // typed FK → parent; grant inherits through this
    author: ref('User', { role: 'author', readonly: true }),  // auto-populates req.principal.id
    body: text({ validate: (v) => v.length <= 5000 || 'comment too long' })
      // Fluent field access (Note 2): the author gets write on their own row;
      // everyone else admitted by the inherited Doc-scope gets read/subscribe
      // only — NOT the Doc editor-tier, so a Doc editor can't edit someone
      // else's comment. Every is.* is awaited. Non-author read is granted (not
      // withheld) so the body is visible to all Doc-readers.
      .can(async ({ is }) =>
        (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe)),
    resolved: boolean({ default: false })
      .can(async ({ is }) =>
        (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe)),
    createdAt: date({ default: () => new Date() }),
  },

  // Grant inheritance: Comment follows the parent Doc grant through the typed FK
  // (joins Comment→Doc in the WHERE), inheriting row read-scope + base
  // capability for fields without an explicit `.can` override.
  grant: inheritDoc,

  // `author` is auto-derived from `author: ref('User', { role: 'author' })` —
  // the field is the single source of truth, so checks.author is NOT redeclared
  // here (redeclaring a ref-role-derived check name is a load-time error;
  // DECISIONLOG #54). It is awaitable via is.author() inside `.can`.

  routes: (r) => {
    r.resource();                                    // CRUD; :docId on the parent path auto-loads req.doc
  },
});

export function commentRoutes() {
  const r = router({ mergeParams: true });
  r.mount('/', Comment);                             // child mounted under /:docId/comments
  return r;
}