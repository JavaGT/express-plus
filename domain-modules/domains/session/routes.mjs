// domains/session/routes.mjs — the auth boundary: login / logout / users.
//
// Auth is CROSS-CUTTING, not a persisted product entity, so it's plain
// Express-style routers mounted at the app level (not an `entity`). The route
// gate (requireAuth) is default-on for every route; `open` opts the login route
// out — the one legitimate unauthenticated endpoint (it mints the session).
// `User` and `Session` are framework-provided entities (auth default-on).
import { router, open, User, Session } from 'express-plus';
import { userList, userPage } from './handlers.mjs';

export function sessionRoutes() {
  const s = router();

  // login: find-or-create user, mint a session token. `open` opts out of the
  // fail-closed auth default — this is the auth-minting endpoint.
  s.post('/', open, async (req, res, next) => {
    const { username, password } = req.body;
    let user = await User.findOne({ username });
    if (!user) {
      user = await User.create({ username, password });
    } else if (user.password !== password) {
      return next({ status: 401, message: 'bad credentials' });
    }
    const session = await Session.create({ userId: user.id, createdAt: Date.now() });
    res.status(201).json({ token: session.token, user: { id: user.id, username: user.username } });
  });

  // logout: inherits the fail-closed auth default (requireAuth).
  s.delete('/:id', async (req, res) => {
    await Session.delete(req.params.id);
    res.sendStatus(204);
  });

  return s;
}

export function userRoutes() {
  const u = router();
  u.get('/', userList);    // inherits requireAuth
  u.get('/:id', userPage); // inherits requireAuth
  return u;
}
