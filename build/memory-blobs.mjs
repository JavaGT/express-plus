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
// The shared contract's durability MUST (finalizePending's bytes survive a
// process restart) is scoped to `durability: 'durable'` backends. This backend
// conforms STRUCTURALLY — finalizePending atomically promotes pending → final
// within the process, is idempotent, and leaves readable final bytes — and
// documents its loss semantics honestly: the final bytes do NOT survive a
// process boundary, which is the declared price of `ephemeral`.
//
// The backing Maps are injectable, so the shared contract suite and later
// crash-point/replacement tests can recreate a store over the SAME backing (an
// in-process restart) or start a fresh backing (a process boundary). NOT a
// production store: bytes never survive a process exit.

import { Readable } from 'node:stream';


import { abortError, BlobSlotNotFoundError, validateBlobRange } from './fs-blobs.mjs';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(id         )       {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

// The storage a store operates on. Injectable so a NEW store can be bound to
// the same backing (simulating an in-process restart) or to a fresh one
// (simulating a process boundary).










export function memoryBlobs({ backing }                     = {})                                       {
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
  // filesystem path). Retired from the portable contract alongside
  // fsBlobs.pathFor (S6/A2); present only on the concrete store as the
  // test/debug-only introspection handle.
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

  function readRange(id        , range                                 )         {
    safeId(id);
    const buf = final.get(id);
    if (!buf) throw new BlobSlotNotFoundError();
    return readSlot(buf, range);
  }

  function readPending(id        , range                                 )         {
    safeId(id);
    const buf = pending.get(id);
    if (!buf) throw new BlobSlotNotFoundError();
    return readSlot(buf, range);
  }

  function readSlot(buf        , range                                            )         {
    const { start, end } = validateBlobRange(buf.length, range ?? []);
    // Copy, never a live view: mutating the returned buffer must not corrupt
    // the stored bytes (fsBlobs returns a fresh Buffer on every read).
    return Buffer.from(buf.subarray(start, end));
  }

  function readRangeStream(
    id        ,
    range                                 ,
    { signal }                           = {},
  )           {
    safeId(id);
    const buf = final.get(id);
    if (!buf) throw new BlobSlotNotFoundError();
    const { start, end } = validateBlobRange(buf.length, range ?? []);
    if (signal?.aborted) {
      const stream = Readable.from([]);
      stream.destroy(abortError());
      return stream;
    }
    const stream = Readable.from([Buffer.from(buf.subarray(start, end))]);
    if (signal) {
      signal.addEventListener('abort', () => stream.destroy(abortError()), { once: true });
    }
    return stream;
  }

  // Streaming pending-slot read (#738 W1): mirrors readRangeStream over the
  // pending Map. The typed missing-slot error throws synchronously, before any
  // stream exists — the shared collapse-before-streaming guarantee.
  function readPendingStream(
    id        ,
    range                                 ,
    { signal }                           = {},
  )           {
    safeId(id);
    const buf = pending.get(id);
    if (!buf) throw new BlobSlotNotFoundError();
    const { start, end } = validateBlobRange(buf.length, range ?? []);
    if (signal?.aborted) {
      const stream = Readable.from([]);
      stream.destroy(abortError());
      return stream;
    }
    const stream = Readable.from([Buffer.from(buf.subarray(start, end))]);
    if (signal) {
      signal.addEventListener('abort', () => stream.destroy(abortError()), { once: true });
    }
    return stream;
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
    readPending,
    readRangeStream,
    readPendingStream,
    remove,
    exists,
    pathFor,
  };
}
