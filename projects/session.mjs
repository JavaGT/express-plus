// session.mjs — the auth boundary. Auth is CROSS-CUTTING, not a persisted
// product entity, so it's plain Express-style routers (not an `entity`). The
// route gate (requireAuth) is default-on for every route; `allowAnonymous`
// opts the login and link-redemption routes out — the two legitimate unauthenticated
// endpoints (they MINT a principal). `User` and `Session` are framework-provided.
//
// Principals: login mints a `user` principal; link-share redemption mints a
// `link` principal; scheduled transitions and ticks attribute to a `system`
// principal. One shape feeds grant, queryScope, and latched-auth.
import { router, allowAnonymous, User, Session, sessionCookie } from 'workbench';
import { Doc } from './doc.mjs';

export function sessionRoutes({ secure = process.env.NODE_ENV === 'production' } = {}) {
  const s = router();

  // login: find-or-create user, verify password against the `hash()` field,
  // mint a session. `allowAnonymous` opts out of the fail-closed auth default.
  // The token travels in the fail-closed `sid` cookie (HttpOnly, SameSite=Lax,
  // Path=/, Secure in production) so sessionPrincipalOf — which reads ONLY the
  // cookie — hydrates a user principal on the NEXT request. The body still
  // echoes the token for non-browser clients, but the cookie is what makes a
  // browser session stick (the 0→1 bug this fixes: a body-only login leaves the
  // client anonymous forever).
  s.post('/', allowAnonymous(), async (req, res, next) => {
    const { username, password } = req.body;
    let user = await User.findOne(User.username.is(username));
    if (!user) {
      user = await User.create({ username, password });   // `password: hash()` field digests on write
    } else if (!user.password.verify(password)) {
      return next({ status: 401, message: 'bad credentials' });
    }
    const session = await Session.create({ userId: user.id });  // createdAt auto-set; no hand-pass
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(201).json({ token: session.token, user: { id: user.id, username: user.username } });
  });

  // link-share redemption: exchange a Doc share token for a `link` principal.
  // `allowAnonymous` — no user session. This is the MINTING path the uniform-principal
  // story needs: a `link` principal is evaluated by Doc.grant.can for both
  // row visibility and capability tiering (linkShare.tiers). Without this route,
  // the `link` principal is consumed in grant but never created. The cookie is
  // set with the same fail-closed attributes as login so the link principal
  // hydrates on subsequent requests the same way a user principal does.
  s.post('/link', allowAnonymous(), async (req, res, next) => {
    const { token } = req.body;
    const doc = await Doc.findOne(Doc.linkShare.token.is(token));
    if (!doc) return next({ status: 404, message: 'no such share link' });
    // Mint a link-scoped session; on subsequent requests the framework hydrates
    // req.principal = { type: 'link', attributes: { token } } from it.
    const session = await Session.create({ kind: 'link', token });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(200).json({ token: session.token, tier: doc.linkShare.tier });
  });

  // logout: inherits requireAuth. Read the sid cookie, delete that session, and
  // clear the cookie (same attributes + Max-Age=0) so the browser drops it.
  s.delete('/:id', async (req, res) => {
    await Session.delete(req.params.id);
    res.setHeader('set-cookie', `${sessionCookie('', { secure })}; Max-Age=0`);
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