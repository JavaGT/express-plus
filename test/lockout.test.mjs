// lockout.test.mjs — pure function tests for login and TOTP lockout logic.
// No HTTP, no DB. These test the decision functions in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockout, loginLockoutDecision, totpLockoutDecision } from '../src/auth/lockout.mjs';

test('loginLockoutDecision returns null below threshold', () => {
  assert.equal(loginLockoutDecision({ attempts: 0 }), null);
  assert.equal(loginLockoutDecision({ attempts: 2 }), null);
});

test('loginLockoutDecision locks at threshold with base backoff', () => {
  const now = 1_000_000;
  const d = loginLockoutDecision({ attempts: 3, now });
  assert.ok(d.locked);
  assert.equal(d.lockedUntil, now + 30_000);
  assert.equal(d.retryAfterMs, 30_000);
});

test('loginLockoutDecision escalates exponentially', () => {
  const now = 1_000_000;
  const d4 = loginLockoutDecision({ attempts: 4, now });
  assert.equal(d4.lockedUntil, now + 60_000);
  const d5 = loginLockoutDecision({ attempts: 5, now });
  assert.equal(d5.lockedUntil, now + 120_000);
});

test('loginLockoutDecision caps at maxMs', () => {
  const now = 1_000_000;
  const d = loginLockoutDecision({ attempts: 20, now, maxMs: 86_400_000 });
  assert.ok(d.lockedUntil - now <= 86_400_000);
});

test('loginLockoutDecision respects custom threshold and base', () => {
  const now = 1_000_000;
  const d = loginLockoutDecision({ attempts: 5, now, threshold: 5, baseMs: 60_000 });
  assert.ok(d.locked);
  assert.equal(d.lockedUntil, now + 60_000);
});

test('totpLockoutDecision returns null below threshold', () => {
  assert.equal(totpLockoutDecision({ attempts: 0 }), null);
  assert.equal(totpLockoutDecision({ attempts: 4 }), null);
});

test('totpLockoutDecision locks at threshold', () => {
  const now = 1_000_000;
  const d = totpLockoutDecision({ attempts: 5, now });
  assert.ok(d.locked);
  assert.equal(d.lockedUntil, now + 35_000);
  assert.equal(d.retryAfterMs, 35_000);
});

test('totpLockoutDecision respects custom threshold and duration', () => {
  const now = 1_000_000;
  const d = totpLockoutDecision({ attempts: 3, now, threshold: 3, durationMs: 10_000 });
  assert.ok(d.locked);
  assert.equal(d.lockedUntil, now + 10_000);
});

test('checkLockout returns null for no lockout', () => {
  assert.equal(checkLockout(null), null);
  assert.equal(checkLockout(undefined), null);
});

test('checkLockout returns null for expired lockout', () => {
  const now = 1_000_000;
  assert.equal(checkLockout(now - 1000, now), null);
});

test('checkLockout returns active for current lockout', () => {
  const now = 1_000_000;
  const active = checkLockout(now + 10_000, now);
  assert.ok(active.locked);
  assert.equal(active.retryAfterMs, 10_000);
});
