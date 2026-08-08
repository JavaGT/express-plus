// login-challenge.mjs — pending-login challenge store for the second-factor
// step of a password login (the TOTP authenticate route).
//
// Mirror of the passkey challenge lifecycle (passkey.mjs createChallengeStore:
// in-memory Map + TTL sweep) but for the login-continuation ceremony, with the
// properties that ceremony needs:
//   - user-bound: each challenge records the user it was issued for, and the
//     authenticate route derives the user FROM the challenge — a client never
//     names a user to finish a login.
//   - attempt-counted: at most maxAttempts failed second-factor submissions
//     before the challenge is destroyed and the login must start over.
//   - single-use: a successful consume removes the challenge atomically.
//   - short-lived: 5-minute TTL, swept by an unref'd interval like the passkey
//     store.
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

// generateLoginChallenge(length) → base64url-encoded random bytes. 32 bytes
// (256 bits) makes the challenge cryptographically unguessable.
export function generateLoginChallenge(length = 32): string {
  return crypto.randomBytes(length).toString('base64url');
}

// createLoginChallengeStore(ttlMs, maxAttempts) → { set, get, registerFailure, consume, destroy }.
// An in-memory Map with TTL-based expiry (entries older than ttlMs are dropped)
// plus user binding and attempt counting:
//   - set(userId) → issues a fresh challenge bound to userId and returns it.
//   - get(challenge) → the live entry or null (expired entries are dropped).
//   - registerFailure(challenge) → records one failed second-factor attempt and
//     destroys the challenge when maxAttempts is reached; returns whether the
//     challenge remains usable (false when unknown, expired, or exhausted).
//   - consume(challenge, userId) → single-use success read: succeeds only for a
//     live challenge bound to userId and deletes it (cannot be replayed).
export function createLoginChallengeStore(ttlMs = DEFAULT_TTL_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const store = new Map<string, LoginChallengeEntry>();

  // Periodic cleanup sweeps expired entries every 60 seconds. The interval is
  // unref'd so it doesn't keep the process alive.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [challenge, entry] of store) {
      if (now - entry.created > ttlMs) store.delete(challenge);
    }
  }, 60_000);
  cleanup.unref();

  function getLive(challenge: string): LoginChallengeEntry | null {
    const entry = store.get(challenge);
    if (!entry) return null;
    if (Date.now() - entry.created > ttlMs) {
      store.delete(challenge);
      return null;
    }
    return entry;
  }

  return {
    set(userId: string): string {
      const challenge = generateLoginChallenge();
      store.set(challenge, { userId, attempts: 0, created: Date.now() });
      return challenge;
    },
    get(challenge: string): LoginChallengeEntry | null {
      return getLive(challenge);
    },
    registerFailure(challenge: string): boolean {
      const entry = getLive(challenge);
      if (!entry) return false;
      entry.attempts += 1;
      if (entry.attempts >= maxAttempts) {
        store.delete(challenge);
        return false;
      }
      return true;
    },
    consume(challenge: string, userId: string): boolean {
      const entry = getLive(challenge);
      if (!entry) return false;
      if (String(entry.userId) !== String(userId)) return false;
      store.delete(challenge);
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
