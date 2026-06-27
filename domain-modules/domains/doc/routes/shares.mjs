// domains/doc/routes/shares.mjs — invite/list/revoke collaborators on a doc.
//
// A sub-resource of Doc, mounted via r.use in index.mjs at /:docId/shares. The
// parent's :docId is loaded onto req.doc by the framework (param-binding rule:
// `:<entity>Id` → `req.<entity>` through the route gate; no mergeParams needed).
// Plain verbs-as-methods handlers; the factory receives the entity class for
// the owner check.
//
// NO app.db, NO app.emit, NO magic strings:
//  - The owner check is an instance method derived from `checks` (and, for
//    `isOwner`, auto-derived from the `role: owner` FK): `req.doc.isOwner(req.user)`.
//  - The share list is a Set field: `req.doc.shares.add/remove`. Mutating it
//    auto-emits `Doc:<id>:shares:added:<userId>` / `:removed:<userId>`, so the
//    recipient's client gets notified live — no hand-written `on(app)` wiring,
//    no `'Doc.share'` string.
//
// INVITE-NOTIFICATION LIFECYCLE (the two halves behave differently — this is
// deliberate, not a bug):
//  - `:added` — the recipient subscribes to a USER-SCOPED pattern across all
//    Docs ("shares:added where target === me"), backed by the reverse membership
//    index over the live stream. At delivery time the invitee IS now a
//    collaborator (the granting mutation is its own auth), so re-auth passes.
//  - `:removed` — at delivery time the invitee has JUST been removed, so
//    re-auth (`is.collaborator()` → hide) would block the push. Rather than add
//    a second auth path to force it through, removal notifications are deferred
//    to the email-style inbox (decision 14) and discovered by fetch. ONE auth
//    engine, no bypass.
import { router, User } from 'express-plus';

export default function shareRoutes(Document) {
  const shares = router();

  // List who has access to this doc (owner only). FK auto-fill: the set's
  // `.toArray()` is async (FK population is a DB query) — never pretend a Set
  // field is synchronous.
  shares.get('/', async (req, res) => {
    if (!req.doc.isOwner(req.user)) return res.sendStatus(403);
    const rows = (await req.doc.shares.toArray()).map((u) => `${u.username} <${u.email}>`);
    res.json({ shares: rows });
  });

  // Share with a user by username. Adding to the set auto-emits the live event.
  // Typed field handle in the lookup — no magic string for `username`.
  shares.post('/', async (req, res, next) => {
    if (!req.doc.isOwner(req.user)) return res.sendStatus(403);
    const invitee = await User.findOne(User.username.is(req.body.username));
    if (!invitee) return next({ status: 404, message: 'no such user' });
    await req.doc.shares.add(invitee.id);   // → emits Doc:<id>:shares:added:<inviteeId>
    res.status(201).json({ sharedWith: { id: invitee.id, username: invitee.username } });
  });

  // Revoke a share. Removing from the set auto-emits `:removed:<userId>`; the
  // push delivery for the un-shared user is intentionally deferred (see above).
  shares.delete('/:userId', async (req, res) => {
    if (!req.doc.isOwner(req.user)) return res.sendStatus(403);
    await req.doc.shares.remove(req.params.userId);
    res.sendStatus(204);
  });

  return shares;
}
