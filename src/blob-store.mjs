// blob-store.mjs — durable blob storage with pending/adopted lifecycle.
//
// Upload writes atomically to <id>.pending with computed hashes, then records
// a 'pending' row. Caller adopts in their txn (status → 'adopted'), then
// finalizes out-of-band (rename .pending → final). Reaper reconciles crashes
// and sweeps orphans/danglers.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}

export function createBlobStore({ root, db }) {
  mkdirSync(root, { recursive: true });
  
  function pathFor(id, { pending } = {}) {
    return path.join(root, id + (pending ? '.pending' : ''));
  }
  
  function upload({ bytes, mime, id } = {}) {
    id = id ?? randomUUID();
    safeId(id);
    
    if (typeof bytes === 'string') {
      bytes = Buffer.from(bytes);
    }
    
    const md5Hash = createHash('md5');
    const sha256Hash = createHash('sha256');
    md5Hash.update(bytes);
    sha256Hash.update(bytes);
    const md5 = md5Hash.digest('hex');
    const sha256 = sha256Hash.digest('hex');
    
    const pendingPath = pathFor(id, { pending: true });
    writeFileSync(pendingPath, bytes);
    
    const now = new Date().toISOString();
    const mimeValue = mime ?? null;
    db.prepare(
      'INSERT INTO BlobStore (id, status, md5, sha256, size, mime, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, 'pending', md5, sha256, bytes.length, mimeValue, now);
    
    return { id, md5, sha256, size: bytes.length, mime: mimeValue };
  }
  
  function adopt(dbOrTxn, id) {
    safeId(id);
    const stmt = dbOrTxn.prepare('UPDATE BlobStore SET status = ? WHERE id = ? AND status = ?');
    const { changes } = stmt.run('adopted', id, 'pending');
    return { adopted: changes };
  }
  
  function finalize(id) {
    safeId(id);
    const pendingPath = pathFor(id, { pending: true });
    const finalPath = pathFor(id);
    try {
      renameSync(pendingPath, finalPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return finalPath;
  }
  
  function readRange(id, [start, end] = []) {
    safeId(id);
    let filePath = pathFor(id);
    if (!existsSync(filePath)) {
      const pendingPath = pathFor(id, { pending: true });
      if (existsSync(pendingPath)) {
        filePath = pendingPath;
      }
    }

    const fileStat = statSync(filePath);
    const fileSize = fileStat.size;

    start = start ?? 0;
    // Reject bogus bounds cleanly rather than handing a negative position to
    // readSync (which reads from the current offset instead of throwing) or a
    // negative / non-finite length to Buffer.alloc. The upper bound still clamps
    // to the file size, so `null`/`undefined` end (and open-ended → EOF via
    // Infinity) mean "to the end".
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
  
  function reap({ ttl, blobColumns }) {
    const now = Date.now();
    let reconciled = 0;
    let orphans = 0;
    let danglers = 0;
    
    // 1. Reconcile: adopted blobs with .pending files → finalize
    const adoptedRows = db.prepare('SELECT id FROM BlobStore WHERE status = ?').all('adopted');
    for (const row of adoptedRows) {
      const pendingPath = pathFor(row.id, { pending: true });
      if (existsSync(pendingPath)) {
        finalize(row.id);
        reconciled++;
      }
    }
    
    // 2. Orphan sweep: stale pending blobs
    const staleDate = new Date(now - ttl).toISOString();
    const pendingRows = db.prepare(
      'SELECT id, createdAt FROM BlobStore WHERE status = ? AND createdAt < ?',
    ).all('pending', staleDate);
    for (const row of pendingRows) {
      const pendingPath = pathFor(row.id, { pending: true });
      try {
        unlinkSync(pendingPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      db.prepare('DELETE FROM BlobStore WHERE id = ? AND status = ?').run(row.id, 'pending');
      orphans++;
    }
    
    // 3. Refcount sweep: adopted blobs with no references
    const adoptedForRefcount = db.prepare('SELECT id FROM BlobStore WHERE status = ?').all('adopted');
    for (const row of adoptedForRefcount) {
      let referenced = false;
      for (const { table, column } of blobColumns) {
        const ref = db.prepare(`SELECT 1 FROM "${table}" WHERE "${column}" = ? LIMIT 1`).get(row.id);
        if (ref) {
          referenced = true;
          break;
        }
      }
      if (!referenced) {
        const finalPath = pathFor(row.id);
        try {
          unlinkSync(finalPath);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        db.prepare('DELETE FROM BlobStore WHERE id = ?').run(row.id);
        danglers++;
      }
    }
    
    return { orphans, danglers, reconciled };
  }
  
  function stat(id) {
    safeId(id);
    const row = db.prepare('SELECT id, status, md5, sha256, size, mime, createdAt FROM BlobStore WHERE id = ?').get(id);
    return row;
  }
  
  return {
    safeId,
    upload,
    adopt,
    finalize,
    readRange,
    reap,
    stat,
    pathFor,
  };
}
