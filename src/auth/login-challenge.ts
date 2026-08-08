// login-challenge.mjs — pending-login challenge store for the second-factor
// step of a password login (the TOTP authenticate route).
//
// Mirror of the passkey challenge lifecycle (passkey.mjs createChallengeStore:
// in-memory Map + TTL sweep) but for the login-continuation ceremony, with the
// properties that ceremony needs:
//   - user-bound: each challenge records the user it was issued for, and the
//     authenticate route derives the user FROM the challenge claim — a client
//     never names a user to finish a login.
//   - attempt-counted: at most maxAttempts failed second-factor submissions
//     before the challenge is destroyed and the login must start over.
//   - single-use: a successful settle deletes the challenge.
//   - short-lived: 5-minute TTL, swept by an unref'd interval like the passkey
//     store.
//
// ONE settlement protocol, no parallel path: a challenge moves
//   available → reserved (exclusive claim) → finalized (deleted) or released
//   (back to available, or deleted when expired). `reserve` is the ONLY way a
//   consumer acquires a challenge, and `finalize` / `release` / `fail` are the
//   ONLY ways it settles one — there is no separate get+consume route. The
//   authenticate route reserves before any SQL, settles the claim only after
//   the transaction outcome is CONFIRMED, and builds its response only after
//   finalization.
//
// Reserved challenges are never swept or reopened by a later request: a
// reservation made before nominal expiry may settle after it, and the sweep
// skips reserved entries (only release/fail re-check the TTL).
//
// Deliberately NOT the passkey challengeStore — that store's lifecycle is the
// WebAuthn ceremony (issued anonymously, consumed once, no attempt count), so a
// login challenge that reused it would inherit the wrong guarantees.

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 5;

export interface LoginChallengeEntry {
  userId: string;
  attempts: number;
  created: number;
}

// A reserved challenge's settlement handle. Opaque to consumers: the route
// reads only `userId` (identity is derived from the claim, never the request),
// and the store verifies the claim's token against the CURRENT reservation
// before finalize/release/fail touch anything.
export interface LoginChallengeClaim {
  challenge: string;
  userId: string;
  createdAt: number;
  token: string;
}

// The stored record: the public entry plus the reservation state. `reservedBy`
// holds the per-reservation token when the challenge is claimed, null when it
// is available.
interface ChallengeRecord extends LoginChallengeEntry {
  reservedBy: string | null;
}

// generateLoginChallenge(length) → base64url-encoded random bytes. 32 bytes
// (256 bits) makes the challenge cryptographically unguessable.
export function generateLoginChallenge(length = 32): string {
  return crypto.randomBytes(length).toString('base64url');
}

// createLoginChallengeStore(ttlMs, maxAttempts, now) → { set, get, reserve,
// finalize, release, fail, destroy }.
//
// An in-memory Map with TTL-based expiry plus user binding and attempt
// counting. `now` is a clock seam (defaults to Date.now) so tests can drive
// expiry deterministically instead of sleeping.
//
//   - set(userId) → issues a fresh AVAILABLE challenge bound to userId.
//   - get(challenge) → the live available entry or null (reserved, expired,
//     exhausted, and unknown challenges all read as null).
//   - reserve(challengeId) → the exclusive claim, or null. Atomic: unknown,
//     expired, exhausted, and already-reserved challenges all reject. The
//     first reserve wins; a second request for the same challenge is rejected
//     before any SQL.
//   - finalize(claim) → delete after a CONFIRMED commit. A mismatched claim
//     fails closed and INVALIDATES (deletes) — it never releases.
//   - release(claim) → after a confirmed no-commit, return to available only
//     before the ORIGINAL expiry, otherwise delete. No attempt increment.
//   - fail(claim) → an invalid/locked outcome: increment attempts, then return
//     to available only while live and below the cap, otherwise delete.
//   - destroy() → stop the sweep and drop all state (test teardown).
export function createLoginChallengeStore(
  ttlMs = DEFAULT_TTL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now: () => number = Date.now,
) {
  const store = new Map<string, ChallengeRecord>();

  // Periodic cleanup sweeps EXPIRED AVAILABLE entries every 60 seconds. A
  // reserved challenge is never swept: the reservation holder may settle after
  // nominal expiry, and only release/fail re-check the TTL.
  const cleanup = setInterval(() => {
    const current = now();
    for (const [challenge, entry] of store) {
      if (entry.reservedBy === null && current - entry.created > ttlMs) {
        store.delete(challenge);
      }
    }
  }, 60_000);
  cleanup.unref();

  // The live available record for a challenge, or null. Reserved entries are
  // invisible here — they belong to a claim until settled.
  function getAvailable(challenge: string): ChallengeRecord | null {
    const entry = store.get(challenge);
    if (!entry) return null;
    if (entry.reservedBy !== null) return null;
    if (now() - entry.created > ttlMs) {
      store.delete(challenge);
      return null;
    }
    return entry;
  }

  return {
    set(userId: string): string {
      const challenge = generateLoginChallenge();
      store.set(challenge, { userId, attempts: 0, created: now(), reservedBy: null });
      return challenge;
    },
    get(challenge: string): LoginChallengeEntry | null {
      return getAvailable(challenge);
    },
    reserve(challengeId: string): LoginChallengeClaim | null {
      const entry = store.get(challengeId);
      if (!entry) return null; // unknown or already settled
      if (entry.reservedBy !== null) return null; // already reserved
      if (now() - entry.created > ttlMs) {
        store.delete(challengeId);
        return null;
      }
      if (entry.attempts >= maxAttempts) {
        // Exhausted — defensive (fail deletes at the cap).
        store.delete(challengeId);
        return null;
      }
      const token = crypto.randomBytes(16).toString('hex');
      entry.reservedBy = token;
      return { challenge: challengeId, userId: entry.userId, createdAt: entry.created, token };
    },
    finalize(claim: LoginChallengeClaim): boolean {
      const entry = store.get(claim.challenge);
      if (!entry) return false;
      if (entry.reservedBy !== claim.token) {
        // Claim mismatch: fail closed and invalidate — never release.
        store.delete(claim.challenge);
        return false;
      }
      store.delete(claim.challenge);
      return true;
    },
    release(claim: LoginChallengeClaim): boolean {
      const entry = store.get(claim.challenge);
      if (!entry) return false;
      if (entry.reservedBy !== claim.token) return false; // mismatch — leave untouched
      if (now() - entry.created > ttlMs) {
        store.delete(claim.challenge);
        return true;
      }
      entry.reservedBy = null;
      return true;
    },
    fail(claim: LoginChallengeClaim): boolean {
      const entry = store.get(claim.challenge);
      if (!entry) return false;
      if (entry.reservedBy !== claim.token) return false; // mismatch — leave untouched
      entry.attempts += 1;
      if (entry.attempts >= maxAttempts || now() - entry.created > ttlMs) {
        store.delete(claim.challenge);
        return false;
      }
      entry.reservedBy = null;
      return true;
    },
    destroy() {
      clearInterval(cleanup);
      store.clear();
    },
  };
}

// The default singleton login challenge store — used by the built-in auth
// routes. Module-level so a login challenge survives in the single process that
// issued it (the framework is single-node; an in-memory store is the right
// durability for a 5-minute handoff that already depends on the issuer).
export const loginChallengeStore = createLoginChallengeStore();
