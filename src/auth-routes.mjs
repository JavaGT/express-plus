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
//
// Passkey (WebAuthn) routes: challenge issue/verify, credential registration,
// assertion verification → session minting, credential list/delete. The ceremony
// split: workbench owns challenge issue/verify + credential storage; the app owns
// the UI (button, prompt, error display).

import { router } from './app.mjs';
import { allowAnonymous, requireUser } from './route-gate.mjs';
import { User, Session, Credential, Invitation } from './auth-entities.mjs';
import { createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser } from './invitation.mjs';
import { sessionCookie, sessionTokenOf, SESSION_COOKIE } from './session.mjs';
import { config } from './config.mjs';
import { getActiveDb } from './db.mjs';
import {
  generateChallenge,
  challengeStore,
  verifyRegistration,
  verifyAuthentication,
  rpConfig,
  parseClientDataJSON,
} from './passkey.mjs';

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

  // ---- Passkey (WebAuthn) routes -------------------------------------------

  const rp = rpConfig(config);

  // GET /auth/passkey/challenge — issue a new challenge for a WebAuthn ceremony.
  // allowAnonymous: anyone may request a challenge (the ceremony itself proves
  // identity). Returns { challenge, rp: { name, id } }.
  s.get('/passkey/challenge', allowAnonymous(), (req, res) => {
    const challenge = generateChallenge();
    challengeStore.set(challenge);
    res.json({ challenge, rp: { name: rp.name, id: rp.id } });
  });

  // POST /auth/passkey/register — enroll a new passkey credential.
  // requireUser: the caller must have an existing session (password login first,
  // then enroll passkey). The credential's userId is the requesting principal's
  // id — a passkey is always bound to the authenticated user who registered it.
  s.post('/passkey/register', requireUser(), (req, res, next) => {
    const { credential } = req.body ?? {};
    if (!credential || !credential.response?.clientDataJSON || !credential.response?.attestationObject) {
      return next({ status: 400, message: 'credential with clientDataJSON and attestationObject is required' });
    }

    // Extract and consume the challenge from clientDataJSON
    let clientData;
    try {
      clientData = parseClientDataJSON(credential.response.clientDataJSON);
    } catch (err) {
      return next({ status: 400, message: `invalid clientDataJSON: ${err.message}` });
    }
    const entry = challengeStore.consume(clientData.challenge);
    if (!entry) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }

    let result;
    try {
      result = verifyRegistration(clientData.challenge, credential, rp);
    } catch (err) {
      return next({ status: 400, message: `registration failed: ${err.message}` });
    }

    const userId = req.principal.id;
    Credential.create({
      credentialId: result.credentialId,
      publicKey: result.publicKey,
      userId,
      signCount: result.signCount,
      name: credential.name || 'Passkey',
      transports: Array.isArray(credential.transports) ? credential.transports.join(',') : '',
      backedUp: credential.backedUp ? 1 : 0,
      createdAt: new Date(),
    });
    res.status(201).json({ ok: true });
  });

  // POST /auth/passkey/authenticate — sign in with a passkey.
  // allowAnonymous: the caller proves identity by demonstrating possession of the
  // private key. On successful verification, the framework mints a Session and
  // sets the `sid` cookie — the same authentication pathway as password login.
  s.post('/passkey/authenticate', allowAnonymous(), (req, res, next) => {
    const { credential } = req.body ?? {};
    if (!credential || !credential.response?.clientDataJSON || !credential.response?.authenticatorData || !credential.response?.signature) {
      return next({ status: 400, message: 'credential with clientDataJSON, authenticatorData, and signature is required' });
    }

    // Extract and consume the challenge from clientDataJSON
    let clientData;
    try {
      clientData = parseClientDataJSON(credential.response.clientDataJSON);
    } catch (err) {
      return next({ status: 400, message: `invalid clientDataJSON: ${err.message}` });
    }
    const entry = challengeStore.consume(clientData.challenge);
    if (!entry) {
      return next({ status: 400, message: 'unknown or expired challenge' });
    }

    // Look up the stored credential by credentialId
    const credId = credential.id || credential.rawId;
    if (!credId) {
      return next({ status: 400, message: 'credential id is required' });
    }
    const storedCredential = Credential.findOne(Credential.credentialId.is(credId));
    if (!storedCredential) {
      return next({ status: 400, message: 'unknown credential' });
    }

    let result;
    try {
      result = verifyAuthentication(clientData.challenge, credential, storedCredential, rp);
    } catch (err) {
      return next({ status: 401, message: `authentication failed: ${err.message}` });
    }

    // Update the counter (replay protection). The unstored query API is the
    // same trust class the login/lookup paths already use.
    getActiveDb().prepare('UPDATE Credential SET signCount = ? WHERE id = ?').run(result.signCount, storedCredential.id);

    // Look up the user
    const user = User.getOrFail(storedCredential.userId);
    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  });

  // DELETE /auth/passkey/:credentialId — remove a passkey credential.
  // requireUser: only an authenticated user can remove their own credential.
  s.delete('/passkey/:credentialId', requireUser(), (req, res, next) => {
    const { credentialId } = req.params;
    const stored = Credential.findOne(Credential.credentialId.is(credentialId));
    if (!stored) {
      return next({ status: 404, message: 'credential not found' });
    }
    // Only the owning user can delete their credential
    if (String(stored.userId) !== String(req.principal.id)) {
      return next({ status: 403, message: 'not your credential' });
    }
    Credential.delete(stored.id);
    res.sendStatus(204);
  });

  // GET /auth/passkey — list the current user's passkey credentials.
  // requireUser: an anonymous caller cannot list credentials.
  s.get('/passkey', requireUser(), (req, res, next) => {
    const userId = req.principal.id;
    Credential.findAll(Credential.userId.is(userId))
      .sort(Credential.createdAt, 'desc')
      .then((rows) => {
        res.json(rows.map((c) => ({
          credentialId: c.credentialId,
          name: c.name,
          createdAt: c.createdAt,
          backedUp: c.backedUp,
          transports: c.transports ? c.transports.split(',').filter(Boolean) : [],
        })));
      }, (err) => next({ status: 500, message: err.message }));
  });

  // ---- Invitation routes ---------------------------------------------------

  // POST /auth/invitation/create — create an invitation.
  // requireUser: only an authenticated user may invite. The creator is the
  // requesting principal. Body: { targetEntity, targetId, role, targetUser?,
  // maxUses?, expiresAt? }. Returns the invitation with its token.
  s.post('/invitation/create', requireUser(), (req, res, next) => {
    const { targetEntity, targetId, role, targetUser, maxUses, expiresAt } = req.body ?? {};
    if (!targetEntity || !targetId || !role) {
      return next({ status: 400, message: 'targetEntity, targetId, and role are required' });
    }
    try {
      const invitation = createInvitation({
        targetEntity,
        targetId,
        role,
        targetUser,
        maxUses,
        expiresAt,
        createdBy: req.principal.id,
      });
      res.status(201).json({
        token: invitation.token,
        targetEntity: invitation.targetEntity,
        targetId: invitation.targetId,
        role: invitation.role,
        targetUser: invitation.targetUser,
        maxUses: invitation.maxUses,
        useCount: invitation.useCount,
        expiresAt: invitation.expiresAt,
        createdBy: invitation.createdBy,
        createdAt: invitation.createdAt,
      });
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // POST /auth/invitation/:token/accept — accept an invitation by token.
  // requireUser: an anonymous caller cannot accept. Validates the token,
  // grants membership on the target entity. Returns { targetEntity, targetId, role }.
  s.post('/invitation/:token/accept', requireUser(), (req, res, next) => {
    const { token } = req.params;
    try {
      const result = acceptInvitation(token, req.principal);
      res.json(result);
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // POST /auth/invitation/:token/reject — reject a direct invitation.
  // requireUser: an anonymous caller cannot reject. Removes the direct
  // invitation row if the rejecting user matches the target.
  s.post('/invitation/:token/reject', requireUser(), (req, res, next) => {
    const { token } = req.params;
    try {
      rejectInvitation(token, req.principal);
      res.sendStatus(204);
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // GET /auth/invitation — list pending invitations for the current user.
  // requireUser: an anonymous caller has no invitations. Returns both direct
  // invitations (targetUser === principal) and open link invitations.
  s.get('/invitation', requireUser(), (req, res, next) => {
    try {
      const invitations = listInvitationsForUser(req.principal);
      res.json(invitations.map((inv) => ({
        token: inv.token,
        targetEntity: inv.targetEntity,
        targetId: inv.targetId,
        role: inv.role,
        targetUser: inv.targetUser,
        maxUses: inv.maxUses,
        useCount: inv.useCount,
        expiresAt: inv.expiresAt,
        createdBy: inv.createdBy,
        createdAt: inv.createdAt,
      })));
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  return s;
}

// Re-exported so an app mounting its own auth router can reach the cookie name
// without `workbench/internal` — one public surface (AGENTS: retire the
// internal-import habit). `app.auth()` is the supported path; this export is for
// apps that hand-roll the boundary like `projects/session.mjs`.
export { SESSION_COOKIE };
