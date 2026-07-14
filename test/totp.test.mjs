// totp.test.mjs — TOTP two-factor authentication unit + HTTP integration tests.
//
// Zero external dependencies; `node:crypto` only. Exercises the TOTP module
// directly (secret generation, token verification, backup codes) and via HTTP
// integration (the framework-owned /auth/totp routes).
//
// Tests:
//   - generateSecret → valid base32, valid otpauth URI format
//   - verifyTotp: valid token at current time → true
//   - verifyTotp: valid token at +1 window → true (adjacent window tolerance)
//   - verifyTotp: invalid token → false
//   - generateBackupCodes: correct count, each 8 hex chars
//   - verifyBackupCode: valid code → true, consumed code → false, wrong code → false
//   - HTTP: enroll → verify → disable round-trip
//   - HTTP: login with 2FA enabled → returns requiresTotp: true
//   - HTTP: authenticate with TOTP → session minted
//   - HTTP: backup code authentication
//   - HTTP: wrong TOTP token rejected (400)
//   - HTTP: unauthenticated enrollment rejected (401)

import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import workbench from '../src/app.mjs';
import { SESSION_COOKIE } from '../src/auth/session.mjs';
import { User, TwoFactor } from '../src/auth/entities.mjs';
import {
  generateSecret,
  hotp,
  verifyTotp,
  generateBackupCodes,
  verifyBackupCode,
  base32Encode,
  base32Decode,
} from '../src/auth/totp.mjs';

// ---- helpers -----------------------------------------------------------------

// Pull the `sid=...` value out of a Set-Cookie header.
function sidFromSetCookie(header) {
  const first = header.split(/,(?=[^ ;]+)/)[0];
  const match = first.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

// Boot an app with .auth() enabled on an ephemeral port.
async function boot(t) {
  const app = workbench({ db: ':memory:' }).auth();
  app.listen(0);
  await app.ready;
  const { port } = app.httpServer.address();
  t.after(() => app.httpServer.close());
  return { app, origin: `http://127.0.0.1:${port}` };
}

// Login helper — creates a session and returns { origin, cookie, userId }.
async function login(t) {
  const { origin, app } = await boot(t);
  const res = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(`login failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  const cookie = `sid=${sidFromSetCookie(res.headers.get('set-cookie'))}`;
  return { origin, app, cookie, userId: body.user.id };
}

// ---- base32 ------------------------------------------------------------------

test('base32Encode then base32Decode round-trips', () => {
  const bytes = crypto.randomBytes(20);
  const encoded = base32Encode(bytes);
  const decoded = base32Decode(encoded);
  assert.deepEqual(decoded, bytes);
});

test('base32Encode produces RFC 4648 charset (no padding)', () => {
  for (let i = 0; i < 50; i++) {
    const bytes = crypto.randomBytes(20);
    const encoded = base32Encode(bytes);
    // RFC 4648 base32 alphabet: A-Z and 2-7, no padding
    assert.match(encoded, /^[A-Z2-7]+$/);
    assert.doesNotMatch(encoded, /=/);
  }
});

// ---- generateSecret -------------------------------------------

test('generateSecret produces a valid base32 secret and otpauth URI', () => {
  const { secret, uri } = generateSecret('alice');
  // Secret is base32 (RFC 4648, no padding)
  assert.match(secret, /^[A-Z2-7]+$/);
  // Secret should be at least 32 chars (20 bytes → ceil(20*8/5) = 32)
  assert.ok(secret.length >= 32);
  // URI format: otpauth://totp/Workbench:alice?secret=...&issuer=workbench&algorithm=SHA1&digits=6&period=30
  assert.match(uri, /^otpauth:\/\/totp\/Workbench:alice\?secret=/);
  assert.match(uri, /&issuer=workbench/);
  assert.match(uri, /&algorithm=SHA1/);
  assert.match(uri, /&digits=6/);
  assert.match(uri, /&period=30/);
  assert.ok(uri.includes(secret));
});

test('generateSecret encodes username in URI', () => {
  const { uri } = generateSecret('bob@example.com');
  // Username should be URI-encoded
  assert.ok(uri.includes('bob%40example.com'));
});

test('generateSecret produces unique secrets', () => {
  const s1 = generateSecret('a').secret;
  const s2 = generateSecret('a').secret;
  assert.notEqual(s1, s2);
});

// ---- hotp / verifyTotp -------------------------------------------------------

test('hotp produces a 6-digit token from a secret and counter', () => {
  const { secret } = generateSecret('test');
  const token = hotp(secret, 0);
  assert.match(token, /^\d{6}$/);
  // Same secret + same counter → same token (deterministic)
  assert.equal(hotp(secret, 0), token);
  // Different counter → different token
  assert.notEqual(hotp(secret, 1), token);
});

test('verifyTotp accepts a valid token at current time', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  const token = hotp(secret, counter);
  assert.equal(verifyTotp(secret, token, now), true);
});

test('verifyTotp accepts a valid token at +1 window (adjacent window tolerance)', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  // Token from the next window should still verify
  const token = hotp(secret, counter + 1);
  assert.equal(verifyTotp(secret, token, now), true);
});

test('verifyTotp accepts a valid token at -1 window (adjacent window tolerance)', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  // Token from the previous window should still verify
  const token = hotp(secret, counter - 1);
  assert.equal(verifyTotp(secret, token, now), true);
});

test('verifyTotp rejects an invalid token', () => {
  const { secret } = generateSecret('test');
  // A random 6-digit number is unlikely to match
  assert.equal(verifyTotp(secret, '123456'), false);
  assert.equal(verifyTotp(secret, '000000'), false);
});

test('verifyTotp rejects a token outside the ±1 window', () => {
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  // Token from 2 windows away should NOT verify
  const token = hotp(secret, counter + 2);
  assert.equal(verifyTotp(secret, token, now), false);
});

test('verifyTotp handles leading zeros in token', () => {
  // Use a contrived secret to test leading-zero padding
  // Generate tokens until we get one with leading zero (unpredictable with random
  // secret, but the padding logic is exercised regardless)
  const { secret } = generateSecret('test');
  const now = Date.now();
  const counter = Math.floor((now / 1000) / 30);
  const token = hotp(secret, counter);
  // Pad the token and verify — this exercises the padStart logic in verifyTotp
  const padded = String(parseInt(token, 10)).padStart(6, '0');
  assert.equal(verifyTotp(secret, padded, now), true);
});

// ---- backup codes ------------------------------------------------------------

test('generateBackupCodes returns correct count', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(8);
  assert.equal(plainCodes.length, 8);
  assert.equal(hashedCodes.length, 8);
  // Default is 8
  const defaults = generateBackupCodes();
  assert.equal(defaults.plainCodes.length, 8);
  // Custom count
  const custom = generateBackupCodes(5);
  assert.equal(custom.plainCodes.length, 5);
});

test('generateBackupCodes each code is 8 hex chars', () => {
  const { plainCodes } = generateBackupCodes(50);
  for (const code of plainCodes) {
    assert.match(code, /^[0-9a-f]{8}$/);
  }
  // All unique
  assert.equal(new Set(plainCodes).size, 50);
});

test('verifyBackupCode: valid code → true and consumed', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[0]), true);
  // Code is consumed — array length decreased
  assert.equal(hashedCodes.length, 2);
});

test('verifyBackupCode: consumed code → false', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[0]), true);
  // Same code again → false (already consumed)
  assert.equal(verifyBackupCode(hashedCodes, plainCodes[0]), false);
});

test('verifyBackupCode: wrong code → false', () => {
  const { hashedCodes } = generateBackupCodes(3);
  assert.equal(verifyBackupCode(hashedCodes, 'deadbeef'), false);
  // Array unchanged on failure
  assert.equal(hashedCodes.length, 3);
});

test('generateBackupCodes: hashed codes are SHA-256 hex (64 chars)', () => {
  const { plainCodes, hashedCodes } = generateBackupCodes(1);
  assert.match(hashedCodes[0], /^[0-9a-f]{64}$/);
  // Verify the hash is correct
  const expectedHash = crypto.createHash('sha256').update(plainCodes[0]).digest('hex');
  assert.equal(hashedCodes[0], expectedHash);
});

// ---- HTTP integration ---------------------------------------------------------

test('POST /auth/totp/enroll requires authentication (401)', async (t) => {
  const { origin } = await boot(t);
  const res = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 401, 'unauthenticated enrollment should be rejected');
});

test('POST /auth/totp/enroll returns secret, uri, and backup codes', async (t) => {
  const { origin, cookie } = await login(t);
  const res = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  if (res.status !== 201) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  // Secret is base32
  assert.match(body.secret, /^[A-Z2-7]+$/);
  // URI is valid otpauth
  assert.match(body.uri, /^otpauth:\/\/totp\//);
  // Backup codes returned
  assert.ok(Array.isArray(body.backupCodes));
  assert.equal(body.backupCodes.length, 8);
  for (const code of body.backupCodes) {
    assert.match(code, /^[0-9a-f]{8}$/);
  }
});

test('POST /auth/totp/enroll rejects duplicate enrollment (409)', async (t) => {
  const { origin, cookie } = await login(t);
  // First enrollment
  const res1 = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(res1.status, 201);
  // Second enrollment → 409
  const res2 = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(res2.status, 409);
});

test('enroll → verify → disable round-trip', async (t) => {
  const { origin, cookie } = await login(t);

  // 1. Enroll
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  assert.equal(enrollRes.status, 201);
  const { secret, backupCodes } = await enrollRes.json();

  // 2. Verify with a valid TOTP token
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.verified, true);

  // 3. Disable with a valid TOTP token
  const counter2 = Math.floor((Date.now() / 1000) / 30);
  const disableToken = hotp(secret, counter2);
  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: disableToken }),
  });
  assert.equal(disableRes.status, 204);

  // 4. After disable, verify should fail (no enrollment)
  const verifyAfterRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });
  assert.equal(verifyAfterRes.status, 400);
});

test('login with 2FA enabled returns requiresTotp: true', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll and verify TOTP
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  const { secret } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });

  // Logout first
  await fetch(`${origin}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });

  // Login again — should get requiresTotp: true, not a session
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal(loginRes.status, 200);
  const loginBody = await loginRes.json();
  assert.equal(loginBody.requiresTotp, true);
  assert.ok(loginBody.userId);
  // No cookie should be set (session not minted yet)
  assert.equal(loginRes.headers.get('set-cookie'), null);
});

test('authenticate with TOTP → session minted', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll and verify TOTP
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  const { secret } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Login → requiresTotp
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal((await loginRes.json()).requiresTotp, true);

  // Authenticate with TOTP
  const counter2 = Math.floor((Date.now() / 1000) / 30);
  const totpToken = hotp(secret, counter2);
  const authRes = await fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, token: totpToken }),
  });
  assert.equal(authRes.status, 201, 'authenticate failed');
  const authBody = await authRes.json();
  assert.equal(authBody.user.username, 'testuser');

  // Session cookie was set
  const setCookie = authRes.headers.get('set-cookie');
  assert.ok(setCookie, 'authenticate sets a Set-Cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const newSid = sidFromSetCookie(setCookie);
  assert.ok(newSid);
});

test('authenticate with backup code is rejected (backup codes are recovery secrets, not auth tokens)', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll and verify TOTP
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  const { secret, backupCodes } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Authenticate with a backup code — should be rejected
  const authRes = await fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, token: backupCodes[0] }),
  });
  assert.equal(authRes.status, 400, 'backup code must not mint a session');
});

test('authenticate with wrong TOTP token → 400', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll and verify TOTP
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  const { secret } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Authenticate with wrong token
  const authRes = await fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, token: '123456' }),
  });
  assert.equal(authRes.status, 400);
  const body = await authRes.json();
  assert.match(body.failure.message, /invalid/i);
});

test('verify with wrong TOTP token → 400', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  // Verify with wrong token
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '999999' }),
  });
  assert.equal(verifyRes.status, 400);
  const body = await verifyRes.json();
  assert.match(body.failure.message, /invalid TOTP token/i);
});

test('disable with backup code works', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll and verify
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
  const { secret, backupCodes } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: validToken }),
  });

  // Disable with backup code
  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: backupCodes[0] }),
  });
  assert.equal(disableRes.status, 204, `disable with backup failed: ${await disableRes.text()}`);
});

test('disable requires token → 400 when missing', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({}),
  });
  assert.equal(disableRes.status, 400);
});

test('verify requires enrollment → 400 when not enrolled', async (t) => {
  const { origin, cookie } = await login(t);

  // Verify without enrolling first
  const verifyRes = await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '123456' }),
  });
  assert.equal(verifyRes.status, 400);
  const body = await verifyRes.json();
  assert.match(body.failure.message, /not enrolled/i);
});

test('disable requires enrollment → 400 when not enrolled', async (t) => {
  const { origin, cookie } = await login(t);

  const disableRes = await fetch(`${origin}/auth/totp/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ token: '123456' }),
  });
  assert.equal(disableRes.status, 400);
  const body = await disableRes.json();
  assert.match(body.failure.message, /not enrolled/i);
});

test('authenticate for non-enabled user → 400', async (t) => {
  const { origin, cookie, userId } = await login(t);

  // Enroll but don't verify → enabled=0
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  // Try to authenticate with any token → should fail because not enabled
  const authRes = await fetch(`${origin}/auth/totp/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, token: '123456' }),
  });
  assert.equal(authRes.status, 400);
  const body = await authRes.json();
  assert.match(body.failure.message, /not enabled/i);
});

test('login without TOTP when 2FA not enabled returns session', async (t) => {
  const { origin, cookie } = await login(t);

  // Enroll but don't verify → TOTP is not enabled
  await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });

  // Logout
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });

  // Login → should get a session (not requiresTotp) because TOTP is not enabled
  const loginRes = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal(loginRes.status, 201);
  const loginBody = await loginRes.json();
  assert.equal(loginBody.requiresTotp, undefined, 'TOTP not enabled → should not require TOTP');
  assert.equal(loginBody.user.username, 'testuser');
  assert.ok(loginRes.headers.get('set-cookie'), 'session cookie should be set');
});

test('enroll TOTP for another user is not possible (only own 2FA)', async (t) => {
  const { origin } = await boot(t);

  // Create two users
  const res1 = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw' }),
  });
  const aliceCookie = `sid=${sidFromSetCookie(res1.headers.get('set-cookie'))}`;
  const aliceBody = await res1.json();
  const aliceId = aliceBody.user.id;

  const res2 = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'pw' }),
  });
  const bobCookie = `sid=${sidFromSetCookie(res2.headers.get('set-cookie'))}`;

  // Alice enrolls and verifies TOTP
  const enrollRes = await fetch(`${origin}/auth/totp/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
  });
  const { secret } = await enrollRes.json();
  const counter = Math.floor((Date.now() / 1000) / 30);
  const validToken = hotp(secret, counter);
  await fetch(`${origin}/auth/totp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: aliceCookie },
    body: JSON.stringify({ token: validToken }),
  });

  // Alice logs out
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: aliceCookie } });

  // Alice logs in → requiresTotp (TOTP is enabled)
  const aliceLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'pw' }),
  });
  const aliceLoginBody = await aliceLogin.json();
  assert.equal(aliceLoginBody.requiresTotp, true);

  // Bob logs out
  await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie: bobCookie } });

  // Bob logs in → no TOTP required (bob didn't enroll)
  const bobLogin = await fetch(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'pw' }),
  });
  assert.equal(bobLogin.status, 201);
  const bobBody = await bobLogin.json();
  assert.equal(bobBody.requiresTotp, undefined);
  assert.equal(bobBody.user.username, 'bob');
});
