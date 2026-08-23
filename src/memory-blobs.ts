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

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { ByteStore, ByteStoreCapabilities, ByteStoreTestDebugHandle } from './fs-blobs.ts';
import { abortError, BlobSlotNotFoundError, BlobTooLargeError, validateBlobRange } from './fs-blobs.ts';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(id: unknown): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

// The storage a store operates on. Injectable so a NEW store can be bound to
// the same backing (simulating an in-process restart) or to a fresh one
// (simulating a process boundary).
export interface MemoryBlobBacking {
  pending: Map<string, Buffer>;
  final: Map<string, Buffer>;
}

export interface MemoryBlobsOptions {
  /** Existing backing to bind to; a fresh backing is created when omitted. */
  backing?: MemoryBlobBacking;
}

export function memoryBlobs({ backing }: MemoryBlobsOptions = {}): ByteStore & ByteStoreTestDebugHandle {
  const pending = backing?.pending ?? new Map<string, Buffer>();
  const final = backing?.final ?? new Map<string, Buffer>();

  const capabilities: ByteStoreCapabilities = {
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
  function pathFor(id: string, { pending: p }: { pending?: boolean } = {}): string {
    return `mem://blobs/${id}${p ? '.pending' : ''}`;
  }

  function writePending(id: string, bytes: Uint8Array): void {
    safeId(id);
    if (pending.has(id) || final.has(id)) throw new Error(`blob id '${id}' already exists`);
    // Copy: mutating the caller's buffer afterwards must not corrupt the store.
    pending.set(id, Buffer.from(bytes));
  }

  // The streaming pending-slot write (#738 W2): same contract as fsBlobs —
  // hash-while-write, mid-stream maxBytes abort (typed BlobTooLargeError),
  // torn slot never left behind. As an EPHEMERAL backend it may concatenate
  // chunks into one buffer; that materialization is the declared price of
  // ephemeral storage, not the production media path.
  async function writePendingStream(
    id: string,
    bytes: AsyncIterable<Uint8Array>,
    { maxBytes }: { maxBytes?: number } = {},
  ): Promise<{ byteLength: number; sha256: string; md5: string }> {
    safeId(id);
    if (pending.has(id) || final.has(id)) throw new Error(`blob id '${id}' already exists`);
    if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes < 0)) {
      throw new Error('invalid maxBytes');
    }
    const md5Hash = createHash('md5');
    const sha256Hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of bytes) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('streamed blob chunk must be Uint8Array');
      const size = byteLength + chunk.length;
      if (maxBytes !== undefined && size > maxBytes) throw new BlobTooLargeError(maxBytes, size);
      byteLength = size;
      md5Hash.update(chunk);
      sha256Hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    pending.set(id, Buffer.concat(chunks));
    return { byteLength, sha256: sha256Hash.digest('hex'), md5: md5Hash.digest('hex') };
  }

  function finalizePending(id: string): string {
    safeId(id);
    const staged = pending.get(id);
    if (staged !== undefined) {
      if (final.has(id)) throw new Error(`blob id '${id}' has conflicting pending and final slots`);
      final.set(id, staged);
      pending.delete(id);
    }
    return pathFor(id);
  }

  function readRange(id: string, range?: [start?: number, end?: number]): Buffer {
    safeId(id);
    const buf = final.get(id);
    if (!buf) throw new BlobSlotNotFoundError();
    return readSlot(buf, range);
  }

  function readPending(id: string, range?: [start?: number, end?: number]): Buffer {
    safeId(id);
    const buf = pending.get(id);
    if (!buf) throw new BlobSlotNotFoundError();
    return readSlot(buf, range);
  }

  function readSlot(buf: Buffer, range: [start?: number, end?: number] | undefined): Buffer {
    const { start, end } = validateBlobRange(buf.length, range ?? []);
    // Copy, never a live view: mutating the returned buffer must not corrupt
    // the stored bytes (fsBlobs returns a fresh Buffer on every read).
    return Buffer.from(buf.subarray(start, end));
  }

  function readRangeStream(
    id: string,
    range?: [start?: number, end?: number],
    { signal }: { signal?: AbortSignal } = {},
  ): Readable {
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
    id: string,
    range?: [start?: number, end?: number],
    { signal }: { signal?: AbortSignal } = {},
  ): Readable {
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

  function remove(id: string, { pending: p }: { pending: boolean } = { pending: false }): void {
    safeId(id);
    if (p) pending.delete(id);
    else final.delete(id);
  }

  function exists(id: string, { pending: p }: { pending: boolean } = { pending: false }): boolean {
    safeId(id);
    return p ? pending.has(id) : final.has(id);
  }

  return {
    capabilities,
    writePending,
    writePendingStream,
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
