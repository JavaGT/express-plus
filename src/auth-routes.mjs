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
import { User, Session, Credential, Invitation, ApiKey, TwoFactor } from './auth-entities.mjs';
import { createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser } from './invitation.mjs';
import { sessionCookie, sessionTokenOf, SESSION_COOKIE } from './session.mjs';
import { config } from './config.mjs';
import { getActiveDb } from './db.mjs';
import { verifyTotp, verifyBackupCode } from './totp.mjs';
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
//
// `identifyBy` declares which User field(s) a login credential is matched
// against, in order. Defaults to `['username']` (the built-in shape). An app
// whose users log in by email passes `identifyBy: ['email', 'username']` so a
// posted credential is looked up by email first, then username. The credential
// always travels in the body's `username` slot (kept for backward
// compatibility); only the lookup columns change. Every named field MUST exist
// on the User entity — a typo fails closed at first login with a thrown lookup.
export function authRoutes({ secure = config.env === 'production', identifyBy = ['username'] } = {}) {
  const s = router();
  const identityFields = Array.isArray(identifyBy) && identifyBy.length > 0 ? identifyBy : ['username'];

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
    // Resolve the credential against the configured identity field(s). The
    // first field that matches a row wins; a credential that matches no row
    // falls through to find-or-create on the PRIMARY (first) field so existing
    // first-login create-on-sign-up behavior is preserved.
    let user;
    for (let i = 0; i < identityFields.length; i++) {
      const field = User[identityFields[i]];
      if (!field) {
        return next({ status: 500, message: `identifyBy references unknown User field '${identityFields[i]}'` });
      }
      user = User.findOne(field.is(username));
      if (user) break;
    }
    if (!user) {
      // `password: hash()` digests on write; the plaintext is never stored.
      // Create against the primary identity field so the credential is stored
      // where a subsequent login will find it.
      const primary = User[identityFields[0]];
      user = primary ? User.create({ [identityFields[0]]: username, password }) : User.create({ username, password });
    } else if (!user.password.verify(password)) {
      // wrong password → 401 and NO cookie (fail closed: no session minted).
      return next({ status: 401, message: 'bad credentials' });
    }
    // Two-factor check: if the user has an enabled TOTP enrollment, do NOT mint a
    // session yet — return the userId so the client can prompt for the TOTP token
    // and call /auth/totp/authenticate to complete authentication.
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(user.id));
    if (twoFactor && twoFactor.enabled === 1) {
      return res.json({ requiresTotp: true, userId: user.id });
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

  // ---- API Key routes -------------------------------------------------------

  // POST /auth/api-key/create — mint a new API key. The plain token is returned
  // ONCE in the response body and never stored. Only the SHA-256 hash is stored.
  // requireUser: only an authenticated user may create keys.
  s.post('/api-key/create', requireUser(), (req, res, next) => {
    const { name, entityName, role, expiresAt } = req.body ?? {};
    if (!name) {
      return next({ status: 400, message: 'name is required' });
    }
    try {
      const result = ApiKey.create({
        name,
        entityName: entityName ?? null,
        role: role ?? null,
        expiresAt: expiresAt ?? null,
        createdBy: req.principal.id,
      });
      res.status(201).json({
        id: result.id,
        prefix: result.prefix,
        name: result.name,
        token: result.plainToken,
      });
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // GET /auth/api-key — list the current user's API keys (prefix + name only,
  // no hashes, no plain tokens).
  // requireUser: an anonymous caller cannot list keys.
  s.get('/api-key', requireUser(), (req, res, next) => {
    try {
      const userId = req.principal.id;
      const keys = ApiKey.findAll(ApiKey.createdBy.is(userId))
        .sort(ApiKey.createdAt, 'desc')
        .then((rows) => {
          res.json(rows.map((k) => ({
            id: k.id,
            prefix: k.prefix,
            name: k.name,
            entityName: k.entityName,
            role: k.role,
            expiresAt: k.expiresAt,
            createdAt: k.createdAt,
          })));
        }, (err) => next({ status: 500, message: err.message }));
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // DELETE /auth/api-key/:id — revoke (delete) an API key. Only the key's
  // creator may revoke it.
  // requireUser: an anonymous caller cannot revoke keys.
  s.delete('/api-key/:id', requireUser(), (req, res, next) => {
    const { id } = req.params;
    try {
      const key = ApiKey.getOrFail(id);
      if (String(key.createdBy) !== String(req.principal.id)) {
        return next({ status: 403, message: 'not your key' });
      }
      ApiKey.delete(id);
      res.sendStatus(204);
    } catch (err) {
      if (err.message?.includes('not found')) {
        return next({ status: 404, message: 'key not found' });
      }
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // ---- TOTP (two-factor authentication) routes ------------------------------

  // POST /auth/totp/enroll — enroll in TOTP two-factor authentication.
  // requireUser: only an authenticated user can enroll. Generates a secret
  // (base32-encoded), backup codes, and a TwoFactor row. Returns the secret
  // URI (for QR code) and backup codes ONCE — they are never stored in plaintext.
  s.post('/totp/enroll', requireUser(), (req, res, next) => {
    const userId = req.principal.id;
    // One enrollment per user — reject if already enrolled.
    const existing = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (existing) {
      return next({ status: 409, message: 'TOTP already enrolled' });
    }
    const user = User.getOrFail(userId);
    try {
      const result = TwoFactor.create({ userId, username: user.username });
      res.status(201).json({
        secret: result.secret,
        uri: result.uri,
        backupCodes: result.backupCodes,
      });
    } catch (err) {
      return next({ status: err.status ?? 500, message: err.message });
    }
  });

  // POST /auth/totp/verify — verify a TOTP token against the stored secret.
  // requireUser: only an authenticated user can verify. On the first successful
  // verify after enrollment, sets enabled=1 and verifiedAt=now. Returns
  // { verified: true } or 400.
  s.post('/totp/verify', requireUser(), (req, res, next) => {
    const { token } = req.body ?? {};
    if (!token) {
      return next({ status: 400, message: 'token is required' });
    }
    const userId = req.principal.id;
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (!twoFactor) {
      return next({ status: 400, message: 'TOTP not enrolled' });
    }
    if (!verifyTotp(twoFactor.secret, token)) {
      return next({ status: 400, message: 'invalid TOTP token' });
    }
    // First successful verification: flip enabled to 1 and set verifiedAt.
    const db = getActiveDb();
    if (twoFactor.enabled === 0) {
      db.prepare('UPDATE TwoFactor SET enabled = 1, verifiedAt = ? WHERE id = ?')
        .run(new Date().toISOString(), twoFactor.id);
    }
    res.json({ verified: true });
  });

  // POST /auth/totp/disable — remove the TOTP enrollment.
  // requireUser: only an authenticated user can disable. Requires a valid TOTP
  // token OR a backup code to confirm the action.
  s.post('/totp/disable', requireUser(), (req, res, next) => {
    const { token } = req.body ?? {};
    if (!token) {
      return next({ status: 400, message: 'token is required' });
    }
    const userId = req.principal.id;
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (!twoFactor) {
      return next({ status: 400, message: 'TOTP not enrolled' });
    }
    const backupCodes = JSON.parse(twoFactor.backupCodes || '[]');
    const isTotpValid = verifyTotp(twoFactor.secret, token);
    const isBackupValid = verifyBackupCode(backupCodes, token);
    if (!isTotpValid && !isBackupValid) {
      return next({ status: 400, message: 'invalid token or backup code' });
    }
    // If it was a backup code, persist the consumed code before deleting.
    if (isBackupValid) {
      getActiveDb().prepare('UPDATE TwoFactor SET backupCodes = ? WHERE id = ?')
        .run(JSON.stringify(backupCodes), twoFactor.id);
    }
    TwoFactor.delete(twoFactor.id);
    res.sendStatus(204);
  });

  // POST /auth/totp/authenticate — complete login with TOTP 2FA.
  // allowAnonymous: the caller has already provided a password via /auth/login,
  // which returned { requiresTotp: true, userId }. This route verifies the TOTP
  // token (or backup code), mints a Session, and sets the sid cookie — the same
  // authentication pathway as password login.
  s.post('/totp/authenticate', allowAnonymous(), (req, res, next) => {
    const { userId, token } = req.body ?? {};
    if (!userId || !token) {
      return next({ status: 400, message: 'userId and token are required' });
    }
    const twoFactor = TwoFactor.findOne(TwoFactor.userId.is(userId));
    if (!twoFactor || twoFactor.enabled !== 1) {
      return next({ status: 400, message: 'TOTP not enabled for this user' });
    }
    const backupCodes = JSON.parse(twoFactor.backupCodes || '[]');
    const isTotpValid = verifyTotp(twoFactor.secret, token);
    const isBackupValid = verifyBackupCode(backupCodes, token);
    if (!isTotpValid && !isBackupValid) {
      return next({ status: 400, message: 'invalid token or backup code' });
    }
    // If it was a backup code, persist the consumed code.
    if (isBackupValid) {
      getActiveDb().prepare('UPDATE TwoFactor SET backupCodes = ? WHERE id = ?')
        .run(JSON.stringify(backupCodes), twoFactor.id);
    }
    const user = User.getOrFail(userId);
    const session = Session.create({ userId: user.id });
    res.setHeader('set-cookie', sessionCookie(session.token, { secure }));
    res.status(201).json({ user: { id: user.id, username: user.username } });
  });

  return s;
}

// Re-exported so an app mounting its own auth router can reach the cookie name
// without `workbench/internal` — one public surface (AGENTS: retire the
// internal-import habit). `app.auth()` is the supported path; this export is for
// apps that hand-roll the boundary like `projects/session.mjs`.
export { SESSION_COOKIE };
