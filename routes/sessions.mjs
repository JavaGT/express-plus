// routes/sessions.mjs — login / logout.
import expressPlus, { requireAuth } from 'express-plus';

const router = expressPlus.Router();

router.post('/', async (req, res, next) => {
  const { username, password } = req.body;
  let user = await app.db.users.where({ username }).one();
  if (!user) {
    user = await app.db.users.create({ username, password });
  } else if (user.password !== password) {
    return next({ status: 401, message: 'bad credentials' });
  }
  const session = await app.db.sessions.create({ userId: user.id, createdAt: Date.now() });
  res.status(201).json({ token: session.token, user: { id: user.id, username: user.username } });
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  await app.db.sessions.delete(req.params.id);
  res.sendStatus(204);
});

export default router;