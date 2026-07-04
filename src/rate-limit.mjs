// rate-limit.mjs — per-key fixed-window rate limiter.
// Buckets keyed by floor(now / windowMs); stale buckets dropped on access.

export function createRateLimiter({ ip: { windowMs: ipWindowMs, max: ipMax }, session = null, now = Date.now } = {}) {
  const ipBuckets = new Map();
  const sessionBuckets = new Map();
  const sessionWindowMs = session?.windowMs;
  const sessionMax = session?.max;
  
  function pruneBuckets(buckets, windowMs, currentWindow) {
    const staleWindow = currentWindow - 1;
    for (const [key, bucket] of buckets) {
      if (bucket.window === staleWindow) {
        buckets.delete(key);
      }
    }
  }
  
  function checkBucket(buckets, key, windowMs, max) {
    const currentWindow = Math.floor(now() / windowMs);
    pruneBuckets(buckets, windowMs, currentWindow);
    
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
  
  function check({ ip, sessionId }) {
    const ipResult = checkBucket(ipBuckets, ip, ipWindowMs, ipMax);
    
    if (!ipResult.allowed) {
      return { ...ipResult, scope: 'ip' };
    }
    
    if (session && sessionId) {
      const sessionResult = checkBucket(sessionBuckets, sessionId, sessionWindowMs, sessionMax);
      if (!sessionResult.allowed) {
        return { ...sessionResult, scope: 'session' };
      }
    }
    
    return { ...ipResult, scope: 'ip' };
  }
  
  return { check };
}
