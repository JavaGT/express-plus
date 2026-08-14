// rate-limit.mjs — per-key fixed-window rate limiters.
// Buckets keyed by floor(now / windowMs); stale buckets dropped on access.

type RateBucket = { window: number; count: number };
type BucketCheck = { allowed: boolean; retryAfterMs: number; limit: number };

export type RateLimitScope = 'ip' | 'session';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
  limit: number;
  scope: RateLimitScope;
};

export type RateLimitOptions = {
  ip: { windowMs: number; max: number };
  session?: { windowMs: number; max: number } | null;
  now?: () => number;
};

// The generic keyed fixed-window limiter (S5/A4). Keys an arbitrary string to
// its own bucket with max hits per window — the engine the denial log keys per
// (actor, reasonCode). Exists alongside the request limiter so transports and
// the denial log share one bucketing implementation.
export type KeyedRateLimitResult = { allowed: boolean; retryAfterMs: number; limit: number };

export interface KeyedRateLimiter {
  check(key: string): KeyedRateLimitResult;
}

export type KeyedRateLimitOptions = {
  windowMs: number;
  max: number;
  now?: () => number;
};

function pruneBuckets(buckets: Map<string, RateBucket>, currentWindow: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.window < currentWindow) {
      buckets.delete(key);
    }
  }
}

function checkBucket(buckets: Map<string, RateBucket>, key: string, windowMs: number, max: number, now: () => number): BucketCheck {
  const currentWindow = Math.floor(now() / windowMs);
  pruneBuckets(buckets, currentWindow);

  let bucket = buckets.get(key);
  if (!bucket || bucket.window !== currentWindow) {
    bucket = { window: currentWindow, count: 0 };
    buckets.set(key, bucket);
  }

  const allowed = bucket.count < max;
  if (allowed) bucket.count++;
  const nextWindowStart = (currentWindow + 1) * windowMs;
  const retryAfterMs = nextWindowStart - now();
  return { allowed, retryAfterMs, limit: max };
}

export function createRateLimiter(
  { ip: { windowMs: ipWindowMs, max: ipMax }, session = null, now = Date.now }: RateLimitOptions = {} as RateLimitOptions,
): { check(input: { ip: string; sessionId?: string }): RateLimitResult } {
  const ipBuckets = new Map<string, RateBucket>();
  const sessionBuckets = new Map<string, RateBucket>();
  const sessionWindowMs = session?.windowMs;
  const sessionMax = session?.max;

  function check({ ip, sessionId }: { ip: string; sessionId?: string }): RateLimitResult {
    const ipResult = checkBucket(ipBuckets, ip, ipWindowMs, ipMax, now);

    if (!ipResult.allowed) {
      return { ...ipResult, scope: 'ip' };
    }

    if (session && sessionId) {
      const sessionResult = checkBucket(sessionBuckets, sessionId, sessionWindowMs!, sessionMax!, now);
      if (!sessionResult.allowed) {
        return { ...sessionResult, scope: 'session' };
      }
    }

    return { ...ipResult, scope: 'ip' };
  }

  return { check };
}

// A generic single-key bucket family: one bucket per arbitrary string key, max
// hits per window. The denial log uses max=1 so exactly one representative per
// window survives a flood.
export function createKeyedRateLimiter(
  { windowMs, max, now = Date.now }: KeyedRateLimitOptions = {} as KeyedRateLimitOptions,
): KeyedRateLimiter {
  const buckets = new Map<string, RateBucket>();

  function check(key: string): KeyedRateLimitResult {
    return checkBucket(buckets, key, windowMs, max, now);
  }

  return Object.freeze({ check });
}
