// Pure lockout decision logic for login and TOTP rate-limiting.
// No DB, no HTTP — inject timestamps and get a decision.
// Each function is independently testable without standing up the server.

// Login lockout: after `threshold` consecutive failures, lock for
// `baseMs * 2^(attempts - threshold)` ms, capped at `maxMs`.
// Returns { locked, lockedUntil, retryAfterMs } when locked, or null when not.
export function loginLockoutDecision({ attempts, now = Date.now(), threshold = 3, baseMs = 30_000, maxMs = 86_400_000 } = {}) {
  if (attempts < threshold) return null;
  const backoff = baseMs * Math.pow(2, attempts - threshold);
  const duration = Math.min(backoff, maxMs);
  return { locked: true, lockedUntil: now + duration, retryAfterMs: duration };
}

// TOTP lockout: after `threshold` consecutive failed TOTP verifications, lock
// for `durationMs` ms (linear, not exponential — the 30-second TOTP window is
// the natural throttle). Returns { locked, lockedUntil, retryAfterMs } or null.
export function totpLockoutDecision({ attempts, now = Date.now(), threshold = 5, durationMs = 35_000 } = {}) {
  if (attempts < threshold) return null;
  return { locked: true, lockedUntil: now + durationMs, retryAfterMs: durationMs };
}

// Check whether a lockout is still active. Returns { locked, retryAfterMs }
// when the lockout has not expired, or null when the lockout has expired
// (caller may proceed, and should reset the attempt counter).
export function checkLockout(lockedUntil, now = Date.now()) {
  if (lockedUntil == null) return null;
  if (now < lockedUntil) return { locked: true, retryAfterMs: lockedUntil - now };
  return null;
}
