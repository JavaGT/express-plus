// gdoc.mjs — a SIMPLE collaborative document, for API review.
//
// This is the deliberately-small counterpart to doc.mjs (the "ceiling" exemplar
// that piles on link-share, a state machine, chat, presence, scheduled
// auto-archive and cross-entity effects). Here we keep only what a basic Google
// Doc needs, so the proposed API is readable at a glance:
//
//   - a CRDT body that syncs live (collaborative editing),
//   - an owner and a set of collaborators with viewer/editor roles,
//   - read admission compiled to SQL, capabilities decided per row.
//
// REVIEW EXEMPLAR: imports from the (not-yet-built) `express-plus` package.

import expressPlus, {
  entity, text, number, date, ref, map,
  grant, deny, read, write, subscribe, admin, scope, anyOf,
} from 'express-plus';

// Capability tiers, named once. `subscribe` is a peer of `read` (sustained live
// push vs one-shot fetch); `admin` is reserved for the owner (manage sharing).
const VIEWER = [read, subscribe];
const EDITOR = [read, write, subscribe];
const OWNER  = [read, write, subscribe, admin];

export const Doc = entity('Doc', {
  fields: {
    title: text({ validate: (v) => v.length <= 200 || 'title too long' }),

    // The collaborative body. `text.crdt()` is a CRDT field: it owns its own
    // live sync and emits change/delta events through the baked-in WS stream —
    // the app writes no socket code.
    body: text.crdt(),

    // A pure pull-derived field: recomputed from `body` on read, never stored,
    // never hand-maintained.
    wordCount: number({
      derived: (d) => d.body ? d.body.trim().split(/\s+/).filter(Boolean).length : 0,
    }),

    owner: ref('User', { role: 'owner', readonly: true }),  // auto-derives checks.owner

    // Sharing: a valued set keyed by User (unique by construction), each member
    // carrying a role. The field owns its capability rule — only the owner may
    // change who can see or edit the document.
    collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} })
      .can(async ({ is }) =>
        (await is.owner()) ? grant(...OWNER)
                           : deny('only the owner may manage sharing')),

    createdAt: date({ default: () => new Date() }),
    updatedAt: date({ touch: true }),   // auto-bumps on any mutation
  },

  // Plain functions — facts about a row. They grant nothing until a grant calls
  // them. `owner` and `collaborator` are compilable (FK equality, set
  // membership), so they may be used in `scope`. `editor`/`viewer` read the
  // member's role off the payload — a runtime fact — so they are `.can`-only.
  checks: {
    collaborator: ({ Doc, principal }) => Doc.collaborators.has(principal.id),
    editor: ({ entity, principal }) =>
      entity.collaborators.get(principal.id)?.role === 'editor',
    viewer: ({ entity, principal }) =>
      entity.collaborators.get(principal.id)?.role === 'viewer',
  },

  // The single authority, in two halves on a performance boundary:
  //   scope(...) — read admission, the ONLY half compiled to a SQL WHERE so the
  //                DB never returns a row this principal can't read.
  //   .can(...)  — every other capability, decided per row at runtime.
  // A principal not admitted by `scope` never reaches `.can`; their rows are
  // simply absent from the result set (there is no separate visibility axis).
  grant: () => [
    scope(({ is }) => anyOf(is.owner(), is.collaborator()))
      .can(async ({ is }) => {
        if (await is.owner())  return grant(...OWNER);
        if (await is.editor()) return grant(...EDITOR);
        if (await is.viewer()) return grant(...VIEWER);
        return deny('no capability for this principal');
      }),
  ],

  // Fields with no `.can` (title, body, wordCount, dates) STRONG-INHERIT the row
  // grant: readable exactly when the row is readable, editable up to the row's
  // write capability. No per-field ceremony for the common case.

  routes: (r) => {
    r.resource();                                  // CRUD through the grant
    r.use('/:docId/shares', shareRoutes());        // sub-resource for the roster
  },
});

// Sharing routes: no hand-rolled owner checks. Reading and mutating the
// `collaborators` field runs through the field's `.can()`, which 403s a
// non-owner — one auth engine, no second path.
function shareRoutes() {
  const r = expressPlus.router({ mergeParams: true });

  r.get('/', async (req, res) => {
    const rows = await req.doc.collaborators.toArray();   // FK population is a DB query
    res.json({ shares: rows.map(([u, role]) => ({ id: u.id, username: u.username, role })) });
  });

  r.post('/', async (req, res) => {
    await req.doc.collaborators.set(req.body.userId, { role: req.body.role });
    res.status(201).json({ sharedWith: { id: req.body.userId, role: req.body.role } });
  });

  r.delete('/:userId', async (req, res) => {
    await req.doc.collaborators.remove(req.params.userId);
    res.sendStatus(204);
  });

  return r;
}

// Only auto-start when run directly (not imported by test suites).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  expressPlus().mount('/docs', Doc).listen(3000);
}
