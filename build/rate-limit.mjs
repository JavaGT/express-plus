// rate-limit.mjs — per-key fixed-window rate limiters.
// Buckets keyed by floor(now / windowMs); stale buckets dropped on access.

                                                    
                                                                             

                                              

                               
                   
                       
                
                        
  

                                
                                        
                                                     
                     
  

// The generic keyed fixed-window limiter (S5/A4). Keys an arbitrary string to
// its own bucket with max hits per window — the engine the denial log keys per
// (actor, reasonCode). Exists alongside the request limiter so transports and
// the denial log share one bucketing implementation.
                                                                                             

                                   
                                           
 

                                     
                   
              
                     
  

function pruneBuckets(buckets                         , currentWindow        ) {
  for (const [key, bucket] of buckets) {
    if (bucket.window < currentWindow) {
      buckets.delete(key);
    }
  }
}

function checkBucket(buckets                         , key        , windowMs        , max        , now              )              {
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
  { ip: { windowMs: ipWindowMs, max: ipMax }, session = null, now = Date.now }                   = {}                    ,
)                                                                        {
  const ipBuckets = new Map                    ();
  const sessionBuckets = new Map                    ();
  const sessionWindowMs = session?.windowMs;
  const sessionMax = session?.max;

  function check({ ip, sessionId }                                    )                  {
    const ipResult = checkBucket(ipBuckets, ip, ipWindowMs, ipMax, now);

    if (!ipResult.allowed) {
      return { ...ipResult, scope: 'ip' };
    }

    if (session && sessionId) {
      const sessionResult = checkBucket(sessionBuckets, sessionId, sessionWindowMs , sessionMax , now);
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
  { windowMs, max, now = Date.now }                        = {}                         ,
)                   {
  const buckets = new Map                    ();

  function check(key        )                       {
    return checkBucket(buckets, key, windowMs, max, now);
  }

  return Object.freeze({ check });
}
