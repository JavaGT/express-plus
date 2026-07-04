// The framework-owned auth battery — the routes `projects/session.mjs` hand-rolls,
// PLUS the Set-Cookie handling that sample omits (the 0→1 auth bug: a client
// following the exemplar is anonymous on every subsequent request because
// `sessionPrincipalOf` reads ONLY the cookie the exemplar never sets).
//
// `.auth()` mounts this router at `/auth`. Auth is the framework's concern, not
// the app's (`auth-entities.mjs:5-7`); following that argument to its conclusion
// means the framework provides the *routes*, not just the entities. The routes
// are built from the SAME public primitives an app would use to write its own
// (`router`, `allowAnonymous`, `User`, `Session`, `sessionCookie`) — there is no
// private second auth path here. An app that needs bespoke login behavior mounts
// its own router instead; this is the smooth default.
//
// The token travels in the fail-closed `sid` cookie, never the JSON body. The
// cookie is HttpOnly (never readable by client JS), SameSite=Lax (CSRF-resistant),
// Path=/, and Secure only in production — plain-http local dev must work, so
// `secure` follows `config.env` (sessionCookie refuses secure:false in
// production, so the dev drop is the only non-TLS path and it cannot leak into
// prod). Login/link mint a principal, so they `allowAnonymous()`; logout inherits
// the default-on `requireUser` gate — you cannot log out a session you don't have.

import { router } from './app.mjs';
import { allowAnonymous } from './route-gate.mjs';
import { User, Session } from './auth-entities.mjs';
import { sessionCookie, sessionTokenOf, SESSION_COOKIE } from './session.mjs';
import { config } from './config.mjs';

// Build the `/auth` router. `secure` follows the app env (true only in
// production) so the same fail-closed cookie attributes apply on login and
// logout, and plain-http dev works. The router is mounted at `/auth` by
// `app.auth()`; the paths below are the suffixes under that mount.
export function authRoutes({ secure = config.env === 'production' } = {}) {
  const s = router();

  // login: find-or-create user (create on first login, else verify the password
  // against the `hash()` field's `.verify()`), mint a Session, and SET THE
  // COOKIE — the piece the exemplar omits. `allowAnonymous` opts out of the
  // fail-closed default gate because login MINTS a principal. The response body
  // carries only the public user shape; the token is in the cookie, never the
  // body (a body-borne token leaves the client anonymous to sessionPrincipalOf).
  s.post('/login', allowAnonymous(), async (req, res, next) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return next({ status: 400, message: 'username and password are required' });
    }
    let user = User.findOne(User.username.is(username));
    if (!user) {
      // `password: hash()` digests on write; the plaintext is never stored.
      user = User.create({ username, password });
    } else if (!user.password.verify(password)) {
      // wrong password → 401 and NO cookie (fail closed: no session minted).
      return next({ status: 401, message: 'bad credentials' });
    }
    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  });

  // logout: inherits the default-on `requireUser` gate, so a caller without a
  // valid session is denied at the gate before reaching here. Read the opaque
  // sid token from the cookie, delete that Session row, and clear the cookie
  // with the SAME attributes plus Max-Age=0 so the browser drops it. 204.
  s.post('/logout', async (req, res) => {
    const token = sessionTokenOf(req);
    if (token) {
      const row = Session.findOne(Session.token.is(token));
      if (row) Session.delete(row.id);
    }
    // Max-Age=0 expires the cookie immediately; the attributes match login so
    // the browser scopes the deletion to the same cookie (Path/Domain match).
    res.setHeader('set-cookie', `${sessionCookie('', { secure })}; Max-Age=0`);
    res.sendStatus(204);
  });

  return s;
}

// Re-exported so an app mounting its own auth router can reach the cookie name
// without `workbench/internal` — one public surface (AGENTS: retire the
// internal-import habit). `app.auth()` is the supported path; this export is for
// apps that hand-roll the boundary like `projects/session.mjs`.
export { SESSION_COOKIE };
