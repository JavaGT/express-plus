// memory-blobs.ts — an in-memory byte-store backend: blob bytes in a Map pair,
// no filesystem.
//
// Conforming implementation of the ByteStore contract (src/fs-blobs.ts carries
// the full guarantees; this module must keep every one of them). Capabilities
// are declared HONESTLY: durability is `ephemeral` — bytes live only in the
// process that owns the backing, so a process restart loses them. Atomic
// promotion, range support, delete verification (nothing can fail in-memory,
// so a failed erasure is never reported complete), and consistency match
// fsBlobs.
//
// The backing Maps are injectable, so the shared contract suite and later
// crash-point/replacement tests can recreate a store over the SAME backing (an
// in-process restart) or start a fresh backing (a process boundary). NOT a
// production store: bytes never survive a process exit.

                                                                      

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(id         )       {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

// The storage a store operates on. Injectable so a NEW store can be bound to
// the same backing (simulating an in-process restart) or to a fresh one
// (simulating a process boundary).
                                    
                               
                             
 

                                     
                                                                              
                              
 

export function memoryBlobs({ backing }                     = {})            {
  const pending = backing?.pending ?? new Map                ();
  const final = backing?.final ?? new Map                ();

  const capabilities                        = {
    durability: 'ephemeral',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  };

  // Synthetic key (an S3 driver would do the same — object storage has no
  // filesystem path). test/debug-only, like fsBlobs.pathFor.
  function pathFor(id        , { pending: p }                        = {})         {
    return `mem://blobs/${id}${p ? '.pending' : ''}`;
  }

  function writePending(id        , bytes            )       {
    safeId(id);
    // Copy: mutating the caller's buffer afterwards must not corrupt the store.
    pending.set(id, Buffer.from(bytes));
  }

  function finalizePending(id        )         {
    safeId(id);
    const staged = pending.get(id);
    if (staged !== undefined) {
      final.set(id, staged);
      pending.delete(id);
    }
    return pathFor(id);
  }

  function readRange(id        , [start, end]                                 = [])         {
    safeId(id);
    const buf = final.get(id) ?? pending.get(id);
    if (!buf) throw new Error('blob not found');

    const startValue = start ?? 0;
    if (!Number.isFinite(startValue) || startValue < 0 || !Number.isInteger(startValue)) {
      throw new Error('invalid blob range: start');
    }
    const endValue = end == null ? buf.length : Math.min(end, buf.length);
    if (!Number.isFinite(endValue) || endValue < 0 || !Number.isInteger(endValue)) {
      throw new Error('invalid blob range: end');
    }
    if (endValue < startValue) {
      throw new Error('invalid blob range: end < start');
    }

    const length = endValue - startValue;
    if (length === 0) return Buffer.alloc(0);
    // Copy, never a live view: mutating the returned buffer must not corrupt
    // the stored bytes (fsBlobs returns a fresh Buffer on every read).
    return Buffer.from(buf.subarray(startValue, endValue));
  }

  function remove(id        , { pending: p }                       = { pending: false })       {
    safeId(id);
    if (p) pending.delete(id);
    else final.delete(id);
  }

  function exists(id        , { pending: p }                       = { pending: false })          {
    safeId(id);
    return p ? pending.has(id) : final.has(id);
  }

  return {
    capabilities,
    writePending,
    finalizePending,
    readRange,
    remove,
    exists,
    pathFor,
  };
}
