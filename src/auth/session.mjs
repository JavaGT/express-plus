// session.mjs — session/auth wiring (SPEC §3, §572, §660).
//
// The principal a request carries is built SERVER-SIDE from its session. The
// client sends only an opaque session token in a cookie; the identity (type, id)
// is looked up in the Session table and constructed by the framework. The client
// cannot supply its own identity — a forged or unknown token is `anonymous`, and
// the default-on route gate then denies it (fail closed).
//
// This is the source of the `principalOf(req)` function the HTTP transport calls
// per request — the SAME admission path as the bare `() => anonymous` default it
// replaces, never a second auth path. When an app is constructed with a db
// (`workbench({ db })`), session hydration becomes the default principal source.

import { principal, anonymous } from '../principal.mjs';
import { config } from '../config.mjs';
import { createHash } from 'node:crypto';

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// The session cookie name. The cookie value is an opaque token; it never carries
// identity, only a key into the Session table.
export const SESSION_COOKIE = 'sid';

// Parse a raw `Cookie` request header (`name=value; name2=value2`) into a
// name→value map. Values are url-decoded. A missing/empty header is an empty map.
// Zero-dependency: node:http exposes the raw header string, nothing parses it.
// Malformed percent-escapes are skipped (fail closed) — never throw 500 (cso M1).
export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding — skip this cookie (fail closed, anonymous)
    }
  }
  return cookies;
}

// Build the `Set-Cookie` header value for a session token. Fail-closed defaults:
// HttpOnly (never readable by client JS), SameSite=Lax (CSRF-resistant), Secure
// (TLS-only), Path=/. `secure` may be dropped for a non-TLS context (local dev /
// tests over plain http); HttpOnly and SameSite are never dropped.
// cso M2: In production, secure:false is refused — tokens must be TLS-only.
export function sessionCookie(token, { secure = true, env = config.env } = {}) {
  if (env === 'production' && !secure) {
    throw new Error('sessionCookie secure:false is not permitted in production');
  }
  const attributes = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

// Read the opaque session token from the request's `sid` cookie, or undefined
// when there is none. Pure (no DB): the rate-limit stack reads this to key a
// per-session window cheaply and BEFORE principal hydration (eng-review: rate
// limiting rejects a flood before any DB lookup or write lock). The token is the
// stable per-session key — a single client cannot rotate another user's token,
// and the IP gate (which runs first) is the non-spoofable base that holds when no
// cookie is present. sessionPrincipalOf reuses this same read.
export function sessionTokenOf(req) {
  return parseCookies(req.headers?.cookie)[SESSION_COOKIE] || undefined;
}

// Build the `principalOf(req)` function for a given db. It reads the session
// cookie, looks the token up in the Session table, and constructs the principal
// SERVER-SIDE from the stored identity. Any failure — no cookie, no token, no
// matching row, or a malformed stored type — yields `anonymous` (fail closed).
export function sessionPrincipalOf(db) {
  return (req) => {
    const token = sessionTokenOf(req);
    if (!token) return anonymous;
    try {
      // The lookup is prepared per request rather than at construction so a
      // broken db fails CLOSED (anonymous) on each request instead of throwing at
      // listen time. The identity comes entirely from the server-side Session
      // row; the client supplied only the token. principal() re-validates the
      // closed type union, so a corrupt stored type is anonymous too.
      const row = db
        .prepare('SELECT principalType AS type, principalId AS id FROM Session WHERE token = ?')
        .get(token);
      if (!row) return anonymous;
      // A link session's principalId IS the share token (auth-entities.mjs). The
      // linkHolder check reads `principal.attributes.token`, so a link principal
      // must carry it here — otherwise scope binds the token param to NULL and
      // the link principal reads nothing (fail-closed by accident, not by the
      // token match the session was minted to grant).
      const attributes = row.type === 'link' ? { token: row.id } : {};
      return principal({ type: row.type, id: row.id, attributes });
    } catch {
      return anonymous;
    }
  };
}

// Build an apiKey principal resolver from a Bearer token. Reads the
// `Authorization: Bearer <token>` header, hashes the token, looks up the ApiKey
// row by tokenHash, checks expiration, and returns an apiKey principal.
// Any failure — no header, no matching row, expired — yields `anonymous`
// (fail closed). The resolution runs through the SAME authorization engine as
// session principals — no second auth path.
export function apiKeyPrincipalOf(db) {
  return (req) => {
    const auth = (req.headers?.authorization ?? '').trim();
    if (!auth) return anonymous;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return anonymous;
    const token = match[1];
    if (!token) return anonymous;
    try {
      const tokenHash = sha256hex(token);
      const row = db.prepare('SELECT * FROM ApiKey WHERE tokenHash = ? LIMIT 1').get(tokenHash);
      if (!row) return anonymous;
      // Expiration: an expired key is anonymous.
      if (row.expiresAt != null && row.expiresAt <= Date.now()) return anonymous;
      return principal({
        type: 'apiKey',
        id: row.id,
        attributes: {
          entityName: row.entityName ?? undefined,
          role: row.role ?? undefined,
        },
      });
    } catch {
      return anonymous;
    }
  };
}
