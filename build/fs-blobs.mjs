// fs-blobs.mjs — the default byte-store plugin: blob bytes on node:fs.
//
// blob-store.mjs fuses three concerns — byte storage, metadata rows (the
// BlobStore table), and the pending→adopt→finalize lifecycle. Only the BYTE
// half should swap (deployment reality for a photos app is S3-compatible
// storage); lifecycle + metadata are framework invariants. This module is the
// narrow seam: it owns the bytes, nothing else. A future `s3Blobs({...})`
// implements the same interface.
//
// THE BYTE-STORE INTERFACE (what blob-store.mjs delegates to). Each method's
// guarantee is part of the contract — any conforming implementation must keep
// it, because the lifecycle around it depends on these semantics:
//
//   writePending(id, bytes)
//     Write `bytes` to the pending slot for `id`. Must be atomic enough that a
//     crash mid-write leaves NO partial final blob (a torn pending write is
//     fine — the reaper sweeps it; a torn FINAL write is not). `bytes` is a
//     Buffer (callers normalize strings). Synchronous here; may be async in
//     other implementations (the only call site is the /blobs upload HTTP
//     handler, already async — see app.mjs/serve.mjs).
//
//   finalizePending(id)
//     Promote the pending slot to the final slot. The durability MUST of this
//     call is scoped by `capabilities.durability`: on a `durable` backend,
//     after this returns the bytes MUST survive a process restart (an adopted
//     blob's final bytes are the product of a committed dispatch). An
//     `ephemeral` backend (memoryBlobs) conforms STRUCTURALLY — atomic
//     promotion, idempotence, readable final bytes — and documents that its
//     bytes live only in the owning process; losing them at a process boundary
//     is the declared price of `ephemeral`. Idempotent: if there is no pending
//     slot (already finalized, or never uploaded), it is a no-op — the reaper
//     and the post-commit finalize consumer both rely on this (they swallow the
//     missing-pending case rather than treating it as an error).
//
//   readRange(id, [start, end])
//     Return the bytes in `[start, end)` as a Buffer. If no final slot exists,
//     fall back to the pending slot (a blob is readable while still pending —
//     the upload route hands back the id before adoption). `end` clamps to the
//     byte length; `Infinity` (or an absent/null `end`) is the accepted EOF
//     sentinel — an open-ended range reads to EOF. `start` stays strictly
//     validated: negative / non-finite / inverted bounds are rejected cleanly
//     (→ throw), never passed to the underlying store to misbehave with.
//
//   remove(id, { pending })
//     Delete the pending (`pending: true`) or final (`pending: false`) slot.
//     Idempotent: a missing slot is a no-op (ENOENT swallowed) — the reaper
//     sweeps slots that may already be gone, and a rolled-back dispatch's
//     pending file is reaped without racing a concurrent finalize.
//
//   exists(id, { pending })
//     True iff the pending / final slot has bytes. Used by the reaper to
//     reconcile (an adopted blob whose pending slot still exists needs
//     finalizing) and by tests.
//
//   pathFor(id, { pending })
//     The physical path of a slot — exposed so tests (and the in-process
//     atomicity fixtures) can assert on the filesystem. An S3 implementation
//     has no path; it may return a synthetic key or throw if called. Callers
//     that must be driver-portable do not use it.
//
//   capabilities
//     A queryable, honest declaration of what this backend guarantees:
//     durability (durable | ephemeral), atomicPromotion, rangeSupport,
//     deleteVerification (a verified backend throws on a failed remove — it
//     never reports an erasure that did not happen, #16), and a consistency
//     tag. Callers (createBlobStore) surface it; a backend must not overstate
//     it. fsBlobs declares durable + atomic + range + verified.
//
// SYNC / ASYNC: every method here is synchronous because node:fs sync APIs are
// the right tool for blob-sized writes under the single-writer discipline, and
// because `adopt` (which does NOT touch bytes — it runs the metadata UPDATE in
// the caller's transaction) must stay synchronous to live inside a BEGIN/COMMIT
// bracket with no await. The byte call sites that COULD be async (the /blobs
// upload handler, the post-commit finalize consumer, the reaper under
// writeQueue) are async at their own layer; an async implementation is a
// conforming interface as long as `adopt`-adjacent byte ops are not awaited
// inside a metadata transaction. The interface therefore permits async
// implementations; fsBlobs itself returns sync functions.

import {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

                                    
                    
 

// ─── capability declaration ────────────────────────────────────────────────

// Durability of a byte store: `durable` bytes survive a process restart;
// `ephemeral` bytes live only within the owning process.
                                                          

// Consistency tag a backend declares for its byte storage. `single-node-strong`
// is the only tag shipped; multi-node backends would declare a different one.
                                                        

// A backend's closed, queryable declaration of what it guarantees. A backend
// must declare honestly — lifecycle code and callers can branch on it.
                                        
                                           
                                    
                                 
                                       
                                             
 

// ─── the byte-store contract ────────────────────────────────────────────────
// Each method's guarantee is PART OF THE TYPE: any conforming implementation
// must keep it, because the lifecycle in blob-store.ts depends on these
// semantics. See the module header for the narrative version.

                            
                                                                                   
                                               

     
                                                                           
                                                                               
                                                                               
                            
     
                                                    

     
                                                                              
                                                                             
                                                                                
                                                                               
                                                                          
                                                                          
                                                                            
                                                                              
                                                                               
          
     
                                      

     
                                                                              
                                                                             
                                                                             
                                                                          
                                                                             
                                                            
     
                                                                        

     
                                                                           
                                                                             
                                                                           
                                                              
     
                                                          

     
                                                                       
                                                                     
                              
     
                                                             

     
                                                                             
                                                                             
                                                                                
     
                                                           
 

function safeId(id         )       {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

export function fsBlobs({ root }                  )            {
  mkdirSync(root, { recursive: true });

  const capabilities                        = {
    durability: 'durable',
    atomicPromotion: true,
    rangeSupport: true,
    deleteVerification: true,
    consistency: 'single-node-strong',
  };

  function pathFor(id        , { pending }                    = {})         {
    return path.join(root, id + (pending ? '.pending' : ''));
  }

  function writePending(id        , bytes            )       {
    safeId(id);
    writeFileSync(pathFor(id, { pending: true }), bytes);
  }

  function finalizePending(id        )         {
    safeId(id);
    const pendingPath = pathFor(id, { pending: true });
    const finalPath = pathFor(id);
    try {
      renameSync(pendingPath, finalPath);
    } catch (err) {
      // Idempotent: no pending slot (already finalized / never uploaded) is a
      // no-op, not an error. Anything else surfaces — a permission or disk
      // failure must not be swallowed.
      if ((err                         ).code !== 'ENOENT') throw err;
    }
    return finalPath;
  }

  function resolveSlot(id        )         {
    const finalPath = pathFor(id);
    if (existsSync(finalPath)) return finalPath;
    const pendingPath = pathFor(id, { pending: true });
    if (existsSync(pendingPath)) return pendingPath;
    throw new Error('blob not found');
  }

  function readRange(id        , [start, end]                                 = [])         {
    safeId(id);
    const filePath = resolveSlot(id);
    const fileSize = statSync(filePath).size;

    const startValue = start ?? 0;
    // Reject bogus bounds cleanly rather than handing a negative position to
    // readSync (which reads from the current offset instead of throwing) or a
    // negative / non-finite length to Buffer.alloc. The upper bound still
    // clamps to the file size, so `null`/`undefined` end (and open-ended → EOF
    // via Infinity) mean "to the end".
    if (!Number.isFinite(startValue) || startValue < 0 || !Number.isInteger(startValue)) {
      throw new Error('invalid blob range: start');
    }
    const endValue = end == null ? fileSize : Math.min(end, fileSize);
    if (!Number.isFinite(endValue) || endValue < 0 || !Number.isInteger(endValue)) {
      throw new Error('invalid blob range: end');
    }
    if (endValue < startValue) {
      throw new Error('invalid blob range: end < start');
    }

    const length = endValue - startValue;
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, startValue);
    } finally {
      // sync fds are raw OS descriptors Node will NOT GC — close deterministically.
      closeSync(fd);
    }
    return buffer;
  }

  function remove(id        , { pending }                       = { pending: false })       {
    safeId(id);
    const filePath = pathFor(id, { pending });
    try {
      unlinkSync(filePath);
    } catch (err) {
      // Idempotent: a slot that is already gone is a no-op.
      if ((err                         ).code !== 'ENOENT') throw err;
    }
  }

  function exists(id        , { pending }                       = { pending: false })          {
    safeId(id);
    return existsSync(pathFor(id, { pending }));
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
