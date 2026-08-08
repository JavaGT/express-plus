// lockout.test.mjs — pure function tests for login and TOTP lockout logic.
// No HTTP, no DB. These test the decision functions in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLockout, nextFailedAttemptCount, loginLockoutDecision, totpLockoutDecision } from '../src/auth/lockout.mjs';

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

test('evaluateLockout is clear for no lock', () => {
  assert.deepEqual(evaluateLockout(null, null), { locked: false, resetAttempts: false });
  assert.deepEqual(evaluateLockout(0, undefined, 1_000_000), { locked: false, resetAttempts: false });
});

test('evaluateLockout reports an expired lock and a stale counter that must reset', () => {
  const now = 1_000_000;
  // Lock expired but the pre-lock failed-attempt counter is still stored: the
  // next invalid token must count from 0 or it would instantly relock.
  assert.deepEqual(evaluateLockout(5, now - 1000, now), { locked: false, resetAttempts: true });
});

test('evaluateLockout reports an expired lock with nothing to reset', () => {
  const now = 1_000_000;
  assert.deepEqual(evaluateLockout(null, now - 1000, now), { locked: false, resetAttempts: false });
  assert.deepEqual(evaluateLockout(0, now - 1000, now), { locked: false, resetAttempts: false });
});

test('evaluateLockout reports an active lock', () => {
  const now = 1_000_000;
  const active = evaluateLockout(5, now + 10_000, now);
  assert.ok(active.locked);
  assert.equal(active.retryAfterMs, 10_000);
});

test('nextFailedAttemptCount counts from the stored counter when no lock existed', () => {
  assert.equal(nextFailedAttemptCount(false, 2), 3);
  assert.equal(nextFailedAttemptCount(false, null), 1);
});

test('nextFailedAttemptCount restarts from 0 when the previous lock expired', () => {
  assert.equal(nextFailedAttemptCount(true, 5), 1);
});
