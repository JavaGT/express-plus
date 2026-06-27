// session.mjs — the auth boundary. Auth is CROSS-CUTTING, not a persisted
// product entity, so it's plain Express-style routers (not an `entity`). The
// route gate (requireAuth) is default-on for every route; `open` opts the
// login and link-redemption routes out — the two legitimate unauthenticated
// endpoints (they MINT a principal). `User` and `Session` are framework-provided.
//
// Principals: login mints a `user` principal; link-share redemption mints a
// `link` principal; scheduled transitions and ticks attribute to a `system`
// principal. One shape feeds grant, queryScope, and latched-auth.
import { router, open, User, Session } from 'express-plus';
import { Doc } from './doc.mjs';

export function sessionRoutes() {
  const s = router();

  // login: find-or-create user, verify password against the `hash()` field,
  // mint a session. `open` opts out of the fail-closed auth default.
  s.post('/', open, async (req, res, next) => {
    const { username, password } = req.body;
    let user = await User.findOne(User.username.is(username));
    if (!user) {
      user = await User.create({ username, password });   // `password: hash()` field digests on write
    } else if (!user.password.verify(password)) {
      return next({ status: 401, message: 'bad credentials' });
    }
    const session = await Session.create({ userId: user.id });  // createdAt auto-set; no hand-pass
    res.status(201).json({ token: session.token, user: { id: user.id, username: user.username } });
  });

  // link-share redemption: exchange a Doc share token for a `link` principal.
  // `open` — no user session. This is the MINTING path the uniform-principal
  // story needs: a `link` principal is evaluated by Doc.grant.can for both
  // row visibility and capability tiering (linkShare.tiers). Without this route,
  // the `link` principal is consumed in grant but never created.
  s.post('/link', open, async (req, res, next) => {
    const { token } = req.body;
    const doc = await Doc.findOne(Doc.linkShare.token.is(token));
    if (!doc) return next({ status: 404, message: 'no such share link' });
    // Mint a link-scoped session; on subsequent requests the framework hydrates
    // req.principal = { type: 'link', attributes: { token } } from it.
    const session = await Session.create({ kind: 'link', token });
    res.status(200).json({ token: session.token, tier: doc.linkShare.tier });
  });

  // logout: inherits requireAuth. Session.delete runs through the pipeline; a
  // framework-provided Session entity's grant scopes deletion to the owner.
  s.delete('/:id', async (req, res) => {
    await Session.delete(req.params.id);
    res.sendStatus(204);
  });

  return s;
}

export function userRoutes() {
  const u = router();
  u.get('/', async (req, res) => {
    const users = await User.findAll().select(User.id, User.username);   // typed-handle projection
    res.json({ users });
  });
  u.get('/:id', async (req, res) => {
    const user = await User.getOrFail(req.params.id);                    // baked-in 404
    res.json({ id: user.id, username: user.username });
  });
  return u;
}