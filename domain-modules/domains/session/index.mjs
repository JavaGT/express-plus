// domains/session/index.mjs — the Session/Account bounded context.
//
// A domain may be SCHEMA-ONLY, ROUTES-ONLY, or both. This one is ROUTES-ONLY:
// no `schema`, no `grant`, no rooms. It is the auth-minting context, so it
// CANNOT require auth — `require: null` opts the whole module out of the
// fail-closed default. Individual routes opt back IN with requireAuth (logout,
// user pages). This is the one legitimate use of `require: null`.
//
// /sessions  → login (POST) + logout (DELETE)        — bodies unchanged
// /users     → list (authed) + user page             — bodies unchanged
import { module, router, requireAuth } from 'express-plus';
import { app } from 'express-plus';
import { userList, userPage } from './handlers.mjs';

export default module('Session', {
  require: null,                                     // auth-minting: opt out of fail-closed

  routes: (r) => {
    r.use('/sessions', sessionRoutes());
    r.use('/users', userRoutes());
  },
});

function sessionRoutes() {
  const s = router();

  // login: find-or-create user, mint a session token.
  s.post('/', async (req, res, next) => {
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

  // logout: requires auth even though the module does not.
  s.delete('/:id', requireAuth, async (req, res, next) => {
    await app.db.sessions.delete(req.params.id);
    res.sendStatus(204);
  });

  return s;
}

function userRoutes() {
  const u = router();
  u.get('/', requireAuth, userList);
  u.get('/:id', userPage);
  return u;
}
