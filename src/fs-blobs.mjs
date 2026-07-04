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
//     Promote the pending slot to the final slot, durably. After this returns,
//     the bytes MUST survive a process restart (an adopted blob's final bytes
//     are the product of a committed dispatch). Idempotent: if there is no
//     pending slot (already finalized, or never uploaded), it is a no-op — the
//     reaper and the post-commit finalize consumer both rely on this (they
//     swallow the missing-pending case rather than treating it as an error).
//
//   readRange(id, [start, end])
//     Return the bytes in `[start, end)` as a Buffer. If no final slot exists,
//     fall back to the pending slot (a blob is readable while still pending —
//     the upload route hands back the id before adoption). `end` clamps to the
//     byte length; an open-ended range reads to EOF. Bounds are validated by
//     the implementation and rejected cleanly (negative / non-finite / inverted
//     → throw), never passed to the underlying store to misbehave with.
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

function safeId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

export function fsBlobs({ root }) {
  mkdirSync(root, { recursive: true });

  function pathFor(id, { pending } = {}) {
    return path.join(root, id + (pending ? '.pending' : ''));
  }

  function writePending(id, bytes) {
    safeId(id);
    writeFileSync(pathFor(id, { pending: true }), bytes);
  }

  function finalizePending(id) {
    safeId(id);
    const pendingPath = pathFor(id, { pending: true });
    const finalPath = pathFor(id);
    try {
      renameSync(pendingPath, finalPath);
    } catch (err) {
      // Idempotent: no pending slot (already finalized / never uploaded) is a
      // no-op, not an error. Anything else surfaces — a permission or disk
      // failure must not be swallowed.
      if (err.code !== 'ENOENT') throw err;
    }
    return finalPath;
  }

  function resolveSlot(id) {
    const finalPath = pathFor(id);
    if (existsSync(finalPath)) return finalPath;
    const pendingPath = pathFor(id, { pending: true });
    if (existsSync(pendingPath)) return pendingPath;
    throw new Error('blob not found');
  }

  function readRange(id, [start, end] = []) {
    safeId(id);
    const filePath = resolveSlot(id);
    const fileSize = statSync(filePath).size;

    start = start ?? 0;
    // Reject bogus bounds cleanly rather than handing a negative position to
    // readSync (which reads from the current offset instead of throwing) or a
    // negative / non-finite length to Buffer.alloc. The upper bound still
    // clamps to the file size, so `null`/`undefined` end (and open-ended → EOF
    // via Infinity) mean "to the end".
    if (!Number.isFinite(start) || start < 0 || !Number.isInteger(start)) {
      throw new Error('invalid blob range: start');
    }
    end = end == null ? fileSize : Math.min(end, fileSize);
    if (!Number.isFinite(end) || end < 0 || !Number.isInteger(end)) {
      throw new Error('invalid blob range: end');
    }
    if (end < start) {
      throw new Error('invalid blob range: end < start');
    }

    const length = end - start;
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      // sync fds are raw OS descriptors Node will NOT GC — close deterministically.
      closeSync(fd);
    }
    return buffer;
  }

  function remove(id, { pending } = {}) {
    safeId(id);
    const filePath = pathFor(id, { pending });
    try {
      unlinkSync(filePath);
    } catch (err) {
      // Idempotent: a slot that is already gone is a no-op.
      if (err.code !== 'ENOENT') throw err;
    }
  }

  function exists(id, { pending } = {}) {
    safeId(id);
    return existsSync(pathFor(id, { pending }));
  }

  return {
    safeId,
    writePending,
    finalizePending,
    readRange,
    remove,
    exists,
    pathFor,
  };
}
