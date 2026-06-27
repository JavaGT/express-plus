// routes/shares.mjs — invite a collaborator to a doc, and list/revoke shares.
import expressPlus, { owner } from 'express-plus';

const router = expressPlus.Router({ mergeParams: true });

// List who has access to this doc (admin only).
router.get('/', async (req, res, next) => {
  if (!owner(req.doc, req.user)) return res.sendStatus(403);
  const shares = await app.db.shares.where({ docId: req.doc.id }).populate('userId').exec();
  res.json({ shares });
});

// Share with a user by username. Fires Doc.share -> pushes to their inbox live.
router.post('/', async (req, res, next) => {
  if (!owner(req.doc, req.user)) return res.sendStatus(403);
  const invitee = await app.db.users.where({ username: req.body.username }).one();
  if (!invitee) return next({ status: 404, message: 'no such user' });

  await app.db.shares.create({ docId: req.doc.id, userId: invitee.id, sharedById: req.user.id });
  app.emit('Doc.share', { doc: req.doc, invitee, by: req.user });
  res.status(201).json({ sharedWith: { id: invitee.id, username: invitee.username } });
});

// Revoke a share. Fires Doc.unshare -> removes from their inbox live.
router.delete('/:userId', async (req, res, next) => {
  if (!owner(req.doc, req.user)) return res.sendStatus(403);
  await app.db.shares.delete({ docId: req.doc.id, userId: req.params.userId });
  const victim = await app.db.users.find(req.params.userId);
  app.emit('Doc.unshare', { doc: req.doc, user: victim });
  res.sendStatus(204);
});

export default router;