// Legacy better-auth hash compatibility bridge.
// better-auth uses the same salt:digest envelope as Workbench's native hash
// strategy but with a historical scrypt profile (r=16, NFKC normalization).
// This module encapsulates the fallback verification so the main verifyHash
// function stays clean — the compatibility reader is a narrow bridge, not a
// second storage format.

import { scryptSync, timingSafeEqual } from 'node:crypto';

// Try verifying a password hash using better-auth's legacy scrypt profile.
// Called only after the native scrypt profile has already failed.
export function tryBetterAuthHash(candidate: string, stored: string, expected: Buffer): boolean {
  const sep = stored.indexOf(':');
  const legacy = scryptSync(candidate.normalize('NFKC'), stored.slice(0, sep), expected.length, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return timingSafeEqual(legacy, expected);
}
