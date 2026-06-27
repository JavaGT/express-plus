// domains/doc/routes/shares.mjs — invite/list/revoke collaborators on a doc.
//
// A sub-resource of Doc, so it lives WITH the Doc domain (mounted via r.use in
// index.mjs). The parent's :docId is loaded onto req.doc; bodies unchanged from
// the baseline routes/shares.mjs.
import { router, owner } from 'express-plus';
import { app } from 'express-plus';

const shares = router({ mergeParams: true });

// List who has access to this doc (admin only).
shares.get('/', async (req, res, next) => {
  if (!owner(req.doc, req.user)) return res.sendStatus(403);
  const rows = await app.db.shares.where({ docId: req.doc.id }).populate('userId').exec();
  res.json({ shares: rows });
});

// Share with a user by username. Fires Doc.share -> pushes to their inbox live.
shares.post('/', async (req, res, next) => {
  if (!owner(req.doc, req.user)) return res.sendStatus(403);
  const invitee = await app.db.users.where({ username: req.body.username }).one();
  if (!invitee) return next({ status: 404, message: 'no such user' });

  await app.db.shares.create({ docId: req.doc.id, userId: invitee.id, sharedById: req.user.id });
  app.emit('Doc.share', { doc: req.doc, invitee, by: req.user });
  res.status(201).json({ sharedWith: { id: invitee.id, username: invitee.username } });
});

// Revoke a share. Fires Doc.unshare -> removes from their inbox live.
shares.delete('/:userId', async (req, res, next) => {
  if (!owner(req.doc, req.user)) return res.sendStatus(403);
  await app.db.shares.delete({ docId: req.doc.id, userId: req.params.userId });
  const victim = await app.db.users.find(req.params.userId);
  app.emit('Doc.unshare', { doc: req.doc, user: victim });
  res.sendStatus(204);
});

export default shares;
