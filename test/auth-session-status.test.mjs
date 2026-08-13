// S5/A1 — session→principal resolution threads status (src/auth/session.ts).
//
// The invariants under test: when the Session row exposes a `status` cell it is
// carried onto the constructed principal (so the audit/diagnostic context can
// tell revoked from disabled from expired); a table WITHOUT the column keeps
// resolving exactly as before; the forged/unknown-token path stays the
// canonical `anonymous` (always `'active'`) — no status leak to an
// unauthenticated caller; a corrupt stored status fails closed to anonymous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { sessionPrincipalOf, SESSION_COOKIE } from '../build/auth/session.mjs';
import { anonymous, statusOf } from '../build/principal.mjs';

const NOW = Date.now();

// A Session table WITH a status column — the downstream shape that exposes
// revoked/disabled/expired sessions.
function seedWithStatus() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE Session (id TEXT PRIMARY KEY, token TEXT, principalType TEXT, principalId TEXT, createdAt INTEGER, status TEXT)',
  );
  const insert = db.prepare(
    'INSERT INTO Session (id, token, principalType, principalId, createdAt, status) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('s-revoked', 'revoked-token', 'user', 'alice', NOW, 'revoked');
  insert.run('s-disabled', 'disabled-token', 'user', 'bob', NOW, 'disabled');
  insert.run('s-expired', 'expired-token', 'user', 'carol', NOW, 'expired');
  insert.run('s-active', 'active-token', 'user', 'dave', NOW, 'active');
  insert.run('s-null', 'null-status-token', 'user', 'erin', NOW, null);
  return db;
}

// A legacy Session table WITHOUT a status column (existing deployments).
function seedWithoutStatus() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE Session (id TEXT PRIMARY KEY, token TEXT, principalType TEXT, principalId TEXT, createdAt INTEGER)',
  );
  db.prepare(
    'INSERT INTO Session (id, token, principalType, principalId, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run('s-alice', 'alice-token', 'user', 'alice', NOW);
  return db;
}

test('session resolution threads status from the Session row', () => {
  const db = seedWithStatus();
  const principalOf = sessionPrincipalOf(db);
  const req = (token) => ({ headers: { cookie: `${SESSION_COOKIE}=${token}` } });

  const revoked = principalOf(req('revoked-token'));
  assert.equal(revoked.type, 'user');
  assert.equal(revoked.id, 'alice');
  assert.equal(revoked.status, 'revoked');
  assert.equal(statusOf(revoked), 'revoked');

  const disabled = principalOf(req('disabled-token'));
  assert.equal(disabled.status, 'disabled');

  const expired = principalOf(req('expired-token'));
  assert.equal(expired.status, 'expired');

  const active = principalOf(req('active-token'));
  assert.equal(active.status, 'active');
  db.close();
});

test('a stored NULL status resolves to an active principal (default applies)', () => {
  const db = seedWithStatus();
  const principalOf = sessionPrincipalOf(db);
  const who = principalOf({ headers: { cookie: `${SESSION_COOKIE}=null-status-token` } });
  assert.equal(who.id, 'erin');
  assert.equal(who.status, 'active');
  db.close();
});

test('a Session table without a status column still resolves (legacy shape unchanged)', () => {
  const db = seedWithoutStatus();
  const principalOf = sessionPrincipalOf(db);
  const who = principalOf({ headers: { cookie: `${SESSION_COOKIE}=alice-token` } });
  assert.equal(who.type, 'user');
  assert.equal(who.id, 'alice');
  assert.equal(who.status, 'active');
  db.close();
});

test('a forged/unknown token still resolves to anonymous with no status leak', () => {
  const db = seedWithStatus();
  const principalOf = sessionPrincipalOf(db);
  const forged = principalOf({ headers: { cookie: `${SESSION_COOKIE}=forged-token` } });
  assert.equal(forged, anonymous);
  assert.equal(forged.status, 'active');
  // The unauthenticated caller cannot distinguish a revoked user's session from
  // an unknown token: both are the canonical active anonymous (no status oracle).
  assert.equal(statusOf(forged), 'active');
  db.close();
});

test('a missing cookie resolves to anonymous with no status leak', () => {
  const db = seedWithStatus();
  const principalOf = sessionPrincipalOf(db);
  assert.equal(principalOf({ headers: {} }), anonymous);
  db.close();
});

test('a corrupt stored status fails closed to anonymous', () => {
  const db = seedWithStatus();
  db.prepare('UPDATE Session SET status = ? WHERE token = ?').run('banned', 'active-token');
  const principalOf = sessionPrincipalOf(db);
  const who = principalOf({ headers: { cookie: `${SESSION_COOKIE}=active-token` } });
  assert.equal(who, anonymous);
  db.close();
});

test('timestamp expiry still yields anonymous for a status-column table', () => {
  const db = seedWithStatus();
  db.prepare('UPDATE Session SET createdAt = ? WHERE token = ?').run(1000, 'active-token');
  const principalOf = sessionPrincipalOf(db, { durationMs: 7000, now: () => 8000 });
  assert.equal(principalOf({ headers: { cookie: `${SESSION_COOKIE}=active-token` } }), anonymous);
  db.close();
});
