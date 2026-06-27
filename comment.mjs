// comment.mjs — a child entity of Doc. Demonstrates abstraction #5: the
// authorization compiler follows the typed FK `doc: ref('Doc')` so a Comment's
// grant INHERITS its parent Doc's grant. `inheritDoc` contributes BOTH the
// parent's compiled scope (joined through `doc` into the child's WHERE) AND
// the parent's `.can` — one contribution, both axes.
//
// A Comment author can edit or delete their own comment; everyone else admitted
// by the inherited Doc-scope gets read/subscribe only. The Doc's link-tier
// (view/comment/edit) flows through automatically: a `view`-only link holder
// can read comments, a `comment`-tier holder can create them.
import {
  entity, text, date, ref, boolean, grant, read, write, subscribe,
  inherit, router,
} from 'express-plus';

// Declarative inherit directive: the compiler resolves it through `doc`,
// pulling in the parent Doc's scope (compiled WHERE join) AND its `.can`.
const inheritDoc = inherit('Doc', { via: 'doc' });

export const Comment = entity('Comment', {
  fields: {
    doc: ref('Doc', { required: true }),        // typed FK → parent; grant inherits through this
    author: ref('User', { role: 'author', readonly: true }),  // auto-populates req.principal.id
    body: text({ validate: (v) => v.length <= 5000 || 'comment too long' })
      // Fluent field access (Note 2): the author gets write on their own row;
      // everyone else admitted by the inherited Doc-scope gets read/subscribe
      // only — NOT the Doc editor-tier, so a Doc editor can't edit someone
      // else's comment. Every is.* is awaited — the Phase-0 unawaited-call
      // guard is satisfied.
      .can(async ({ is }) =>
        (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe)),
    resolved: boolean({ default: false })
      .can(async ({ is }) =>
        (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe)),
    createdAt: date({ default: () => new Date() }),
  },

  // Grant inheritance: Comment follows the parent Doc grant through the typed FK
  // (joins Comment→Doc in the WHERE), inheriting row visibility + base
  // capability for fields without an explicit `.can` override.
  grant: inheritDoc,

  // `author` is a runtime-only check (awaitable via is.*) — NOT `admits(...)`,
  // since Comment's row visibility comes from the inherited Doc-scope, not from
  // this check. A plain check can never admit a row on its own.
  checks: {
    author: ({ entity, principal }) => entity.author === principal.id,
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