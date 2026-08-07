// Pure lockout decision logic for login and TOTP rate-limiting.
// No DB, no HTTP — inject timestamps and get a decision.
// Each function is independently testable without standing up the server.

export interface LockoutActive {
  locked: true;
  lockedUntil?: number;
  retryAfterMs: number;
}

interface LoginLockoutOptions {
  attempts: number;
  now?: number;
  threshold?: number;
  baseMs?: number;
  maxMs?: number;
}

interface TotpLockoutOptions {
  attempts: number;
  now?: number;
  threshold?: number;
  durationMs?: number;
}

// Login lockout: after `threshold` consecutive failures, lock for
// `baseMs * 2^(attempts - threshold)` ms, capped at `maxMs`.
// Returns { locked, lockedUntil, retryAfterMs } when locked, or null when not.
export function loginLockoutDecision(opts: LoginLockoutOptions = {} as LoginLockoutOptions): LockoutActive | null {
  const { attempts, now = Date.now(), threshold = 3, baseMs = 30_000, maxMs = 86_400_000 } = opts;
  if (attempts < threshold) return null;
  const backoff = baseMs * Math.pow(2, attempts - threshold);
  const duration = Math.min(backoff, maxMs);
  return { locked: true, lockedUntil: now + duration, retryAfterMs: duration };
}

// TOTP lockout: after `threshold` consecutive failed TOTP verifications, lock
// for `durationMs` ms (linear, not exponential — the 30-second TOTP window is
// the natural throttle). Returns { locked, lockedUntil, retryAfterMs } or null.
export function totpLockoutDecision(opts: TotpLockoutOptions = {} as TotpLockoutOptions): LockoutActive | null {
  const { attempts, now = Date.now(), threshold = 5, durationMs = 35_000 } = opts;
  if (attempts < threshold) return null;
  return { locked: true, lockedUntil: now + durationMs, retryAfterMs: durationMs };
}

// Check whether a lockout is still active. Returns { locked, retryAfterMs }
// when the lockout has not expired, or null when the lockout has expired
// (caller may proceed, and should reset the attempt counter).
export function checkLockout(lockedUntil: number | null | undefined, now: number = Date.now()): { locked: true; retryAfterMs: number } | null {
  if (lockedUntil == null) return null;
  if (now < lockedUntil) return { locked: true, retryAfterMs: lockedUntil - now };
  return null;
}
