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

// A lockout-fence verdict. One evaluation shared by the login and TOTP routes:
//   - { locked: true, retryAfterMs } — the lock is still active; reject.
//   - { locked: false, resetAttempts: false } — no lock was ever set (or the
//     counter is already clear): the next failure counts from the stored value.
//   - { locked: false, resetAttempts: true } — the previous lock has EXPIRED
//     but the stale failed-attempt counter still holds the pre-lock value. The
//     next failure must count from 0, or one invalid token after expiry would
//     instantly relock (the stale counter alone would trip the threshold).
export type LockoutVerdict =
  | { locked: true; retryAfterMs: number }
  | { locked: false; resetAttempts: boolean };

export function evaluateLockout(
  failedAttempts: number | null | undefined,
  lockedUntil: number | null | undefined,
  now: number = Date.now(),
): LockoutVerdict {
  if (lockedUntil == null) return { locked: false, resetAttempts: false };
  if (now < lockedUntil) return { locked: true, retryAfterMs: lockedUntil - now };
  return { locked: false, resetAttempts: (failedAttempts ?? 0) > 0 };
}

// The next failed-attempt count to record for a clear fence (a locked verdict
// is rejected by the caller before counting): the stored counter when no lock
// existed, or 0 when an expired lock's stale counter must not relock instantly.
export function nextFailedAttemptCount(resetAttempts: boolean, failedAttempts: number | null | undefined): number {
  return (resetAttempts ? 0 : (failedAttempts ?? 0)) + 1;
}
