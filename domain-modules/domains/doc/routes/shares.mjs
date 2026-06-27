// domains/doc/routes/shares.mjs — invite/list/revoke collaborators on a doc.
//
// A sub-resource of Doc, mounted via r.use in index.mjs at /:docId/shares. The
// parent's :docId is loaded onto req.doc by the framework. Plain verbs-as-methods
// handlers; the factory receives the entity class for the owner check.
//
// NO app.db, NO app.emit, NO magic strings:
//  - The owner check is an instance method derived from the `checks` block:
//    `req.doc.isOwner(req.user)`.
//  - The share list is a Set field: `req.doc.shares.add/remove/map`. Mutating it
//    auto-emits `Doc:<id>:shares:added:<userId>` / `:removed:<userId>`, so the
//    recipient's client (subscribed to that event filtered to its user) gets
//    notified live — no hand-written `on(app)` wiring, no `'Doc.share'` string.
import { router } from 'express-plus';
import { User } from 'express-plus';

export default function shareRoutes(Document) {
  const shares = router({ mergeParams: true });

  // List who has access to this doc (owner only). FK auto-fill: iterating
  // `req.doc.shares` yields populated User rows.
  shares.get('/', async (req, res) => {
    if (!req.doc.isOwner(req.user)) return res.sendStatus(403);
    const rows = await req.doc.shares.map((u) => `${u.username} <${u.email}>`);
    res.json({ shares: rows });
  });

  // Share with a user by username. Adding to the set auto-emits the live event.
  shares.post('/', async (req, res, next) => {
    if (!req.doc.isOwner(req.user)) return res.sendStatus(403);
    const invitee = await User.findOne({ username: req.body.username });
    if (!invitee) return next({ status: 404, message: 'no such user' });
    await req.doc.shares.add(invitee.id);   // → emits Doc:<id>:shares:added:<inviteeId>
    res.status(201).json({ sharedWith: { id: invitee.id, username: invitee.username } });
  });

  // Revoke a share. Removing from the set auto-emits the live event.
  shares.delete('/:userId', async (req, res) => {
    if (!req.doc.isOwner(req.user)) return res.sendStatus(403);
    await req.doc.shares.remove(req.params.userId); // → emits Doc:<id>:shares:removed:<userId>
    res.sendStatus(204);
  });

  return shares;
}
