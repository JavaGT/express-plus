// rate-limit.mjs — per-key fixed-window rate limiter.
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

export function createRateLimiter(
  { ip: { windowMs: ipWindowMs, max: ipMax }, session = null, now = Date.now }: RateLimitOptions = {} as RateLimitOptions,
): { check(input: { ip: string; sessionId?: string }): RateLimitResult } {
  const ipBuckets = new Map<string, RateBucket>();
  const sessionBuckets = new Map<string, RateBucket>();
  const sessionWindowMs = session?.windowMs;
  const sessionMax = session?.max;

  function pruneBuckets(buckets: Map<string, RateBucket>, currentWindow: number) {
    for (const [key, bucket] of buckets) {
      if (bucket.window < currentWindow) {
        buckets.delete(key);
      }
    }
  }

  function checkBucket(buckets: Map<string, RateBucket>, key: string, windowMs: number, max: number): BucketCheck {
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

  function check({ ip, sessionId }: { ip: string; sessionId?: string }): RateLimitResult {
    const ipResult = checkBucket(ipBuckets, ip, ipWindowMs, ipMax);

    if (!ipResult.allowed) {
      return { ...ipResult, scope: 'ip' };
    }

    if (session && sessionId) {
      const sessionResult = checkBucket(sessionBuckets, sessionId, sessionWindowMs!, sessionMax!);
      if (!sessionResult.allowed) {
        return { ...sessionResult, scope: 'session' };
      }
    }

    return { ...ipResult, scope: 'ip' };
  }

  return { check };
}
