// blob-store.mjs — durable blob storage with pending/adopted lifecycle.
//
// WRITE-COORDINATOR RED-LINE (S1/A5): blob METADATA writes enter through the
// platform write coordinator (write-queue.ts) via the CALLER'S coordinated
// transaction — never a transaction this module opens itself. `adopt` takes a
// db/txn handle and runs its UPDATE in that (already coordinated) transaction;
// `upload` is invoked from callers inside a coordinator turn (the /blobs HTTP
// route wraps it in .run; the pending-blob staged write is already inside
// .run), and `discard`/`discardPending`/`reap` are likewise called only from
// coordinated framework paths (pending-blob lifecycle, the blob reaper sweep).
// This module issues no BEGIN/COMMIT/ROLLBACK and owns no transaction control
// of its own.
//
// Upload writes atomically to a pending slot with computed hashes, then records
// a 'pending' row. Caller adopts in their txn (status → 'adopted'), then
// finalizes out-of-band (promote pending → final) via the cursor-backed
// blob-finalize consumer (blob-lifecycle.mjs) — crash recovery for a missed
// finalize replays from committed events, not from a reaper scan. The reaper
// here sweeps orphans/danglers only: bytes with no committed-event trail to
// replay from (an abandoned upload, or bytes a removed row no longer
// references).
//
// This module fuses METADATA (the BlobStore table) + LIFECYCLE (the
// pending→adopt→finalize state machine, the reaper's orphan/dangler sweep).
// The BYTE storage — where the bytes physically live — is delegated to an
// injected byte store (`bytes`), defaulting to fsBlobs (seam-review §2.2). Only
// the byte half is swappable; lifecycle + metadata are framework invariants.
// `workbench({ blobs: { root } })` constructs fsBlobs internally (back-compat —
// an explicit root, refused on overlap with the owned directory);
// `workbench({ blobs: byteStore })` accepts any conforming byte-store object
// (the deployment reality for a photos app is S3-compatible storage — a future
// `s3Blobs({...})` implements the same interface). With NO blobs config, a
// file-mode app's byte store roots under the owned directory's managed
// `blobs/` + `staging/` pair (S6/A2 relocation — inside the owned directory
// when one exists, beside the db file otherwise; a relative database path
// makes the owned directory cwd-relative, so the root can be cwd-relative in
// that case). A memory database uses the in-memory fake store (S6/A1).

import { createHash, randomUUID } from 'node:crypto';

import { fsBlobs, hasPathFor,                                            } from './fs-blobs.mjs';



const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(id         )       {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('invalid blob id');
  }
}



























                                              

































// The retired `pathFor` (S6/A2), kept ONLY behind this explicit internal/test
// handle: absent from the portable BlobStore surface, present on the concrete
// store only when the underlying byte store exposes a path key (fs path or
// memory synthetic key). No production caller may use it to authorize, read, or
// locate bytes.
















export function createBlobStore({ root, stagingRoot, db, bytes }                  )            {
  // The byte store owns where bytes live (node:fs by default; S3 later). It is
  // the ONLY seam for byte storage — every read/write/remove/finalize goes
  // through it. `root` is accepted for back-compat (`blobs: { root }`): when no
  // byte store is injected, fsBlobs({ root }) is the default. `bytes` may also
  // be passed directly as `root`'s replacement once a caller hands a store in.
  const store            = bytes
    ?? fsBlobs(stagingRoot ? { root: root          , stagingRoot } : { root: root           });
  const { writePending, finalizePending, readRange, readPending, readRangeStream, remove } = store;

  function upload({ bytes: uploadBytes, mime, id }                    = { bytes: undefined          }) {
    let blobId = id ?? randomUUID();
    safeId(blobId);

    if (typeof uploadBytes === 'string') {
      uploadBytes = Buffer.from(uploadBytes);
    }

    const md5Hash = createHash('md5');
    const sha256Hash = createHash('sha256');
    md5Hash.update(uploadBytes);
    sha256Hash.update(uploadBytes);
    const md5 = md5Hash.digest('hex');
    const sha256 = sha256Hash.digest('hex');

    writePending(blobId, uploadBytes);

    const now = new Date().toISOString();
    const mimeValue = mime ?? null;
    db.prepare(
      'INSERT INTO BlobStore (id, status, md5, sha256, size, mime, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(blobId, 'pending', md5, sha256, uploadBytes.length, mimeValue, now);

    return { id: blobId, md5, sha256, size: uploadBytes.length, mime: mimeValue };
  }

  // adopt runs the metadata UPDATE in the CALLER'S transaction. It touches NO
  // bytes — the in-txn part of the lifecycle is metadata-only, so it can live
  // inside a BEGIN IMMEDIATE…COMMIT bracket with no await (an async byte store
  // would break that; adopt deliberately does not delegate).
  function adopt(dbOrTxn                           , id        )                      {
    safeId(id);
    const stmt = dbOrTxn.prepare('UPDATE BlobStore SET status = ? WHERE id = ? AND status = ?');
    const { changes } = stmt.run('adopted', id, 'pending');
    return { adopted: changes };
  }

  // finalize promotes the pending slot to the final slot via the byte store,
  // post-commit. Idempotent (the byte store swallows a missing pending slot) so
  // the post-commit finalize consumer and its boot-time recovery sweep can both
  // call it without racing each other.
  function finalize(id        )         {
    safeId(id);
    return finalizePending(id);
  }

  function readRangeBytes(id        , range                                 )         {
    safeId(id);
    return readRange(id, range);
  }

  // Pending-slot reads funnel to the byte store, but the ONLY production caller
  // is the pending-blob claim machinery (its durable state transition has
  // already selected a claimed generation). Not an application escape hatch —
  // the /blobs upload route returns the id, and that alone never admits a read.
  function readPendingBytes(id        , range                                 )         {
    safeId(id);
    return readPending(id, range);
  }

  function readRangeStreamBytes(id        , range                                 , options                           )           {
    safeId(id);
    return readRangeStream(id, range, options);
  }

  // Pending-blob lifecycle owns removal of staged generations. This is not an
  // application escape hatch: only the package lifecycle invokes it after its
  // durable state transition has selected an unclaimed generation.
  function discardPending(id        )       {
    safeId(id);
    remove(id, { pending: true });
    db.prepare('DELETE FROM BlobStore WHERE id = ? AND status = ?').run(id, 'pending');
  }

  // Pending-blob deletion is package-owned. Remove both locations because a
  // deletion request may race finalization and either slot may be present.
  function discard(id        )       {
    safeId(id);
    remove(id, { pending: true });
    remove(id, { pending: false });
    db.prepare('DELETE FROM BlobStore WHERE id = ?').run(id);
  }

  function reap({ ttl, census }                 )                                        {
    const now = Date.now();
    let orphans = 0;
    let danglers = 0;

    // 1. Orphan sweep: stale pending blobs (uploaded, never adopted by any
    // committed dispatch — no committed event exists to recover them from).
    const staleDate = new Date(now - ttl).toISOString();
    const pendingRows = db.prepare(
      'SELECT id, createdAt FROM BlobStore WHERE status = ? AND createdAt < ?',
    ).all('pending', staleDate)                                            ;
    for (const row of pendingRows) {
      if (db.prepare('SELECT 1 FROM _PendingBlob WHERE blobId = ?').get(row.id)) continue;
      remove(row.id, { pending: true });
      db.prepare('DELETE FROM BlobStore WHERE id = ? AND status = ?').run(row.id, 'pending');
      orphans++;
    }

    // 2. Refcount sweep: adopted blobs with no references, driven by the
    // COMPILED census (S6/A3) — no runtime scan derives blob columns anymore.
    // Each reference's existence query is prepared once per sweep; a declared
    // table that is not (yet) provisioned holds no rows and so references
    // nothing (skipped after one catalog check). Matching content hashes never
    // merge ownership (#7): every id is checked against its own references.
    const adoptedForRefcount = db.prepare('SELECT id FROM BlobStore WHERE status = ?').all('adopted')                         ;
    if (adoptedForRefcount.length > 0) {
      const existingTables = new Set        ();
      const tableStmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
      for (const ref of census.references) {
        if (!existingTables.has(ref.table) && tableStmt.get(ref.table)) existingTables.add(ref.table);
      }
      const referenceQueries = census.references
        .filter((ref) => existingTables.has(ref.table))
        .map((ref) => ({ query: db.prepare(`SELECT 1 FROM "${ref.table}" WHERE "${ref.column}" = ? LIMIT 1`) }));
      for (const row of adoptedForRefcount) {
        if (db.prepare("SELECT 1 FROM _PendingBlob WHERE blobId = ? AND status IN ('claimed', 'finalized', 'recovery-failed', 'delete-requested')").get(row.id)) continue;
        let referenced = false;
        for (const { query } of referenceQueries) {
          if (query.get(row.id)) {
            referenced = true;
            break;
          }
        }
        if (!referenced) {
          remove(row.id, { pending: false });
          db.prepare('DELETE FROM BlobStore WHERE id = ?').run(row.id);
          danglers++;
        }
      }
    }

    return { orphans, danglers };
  }

  function stat(id        )                           {
    safeId(id);
    const row = db.prepare('SELECT id, status, md5, sha256, size, mime, createdAt FROM BlobStore WHERE id = ?').get(id)                            ;
    return row;
  }

  const internalHandle                          = {};
  if (hasPathFor(store)) internalHandle._pathFor = store.pathFor;

  return {
    safeId,
    upload,
    adopt,
    finalize,
    readRange: readRangeBytes,
    readPending: readPendingBytes,
    readRangeStream: readRangeStreamBytes,
    discardPending,
    discard,
    reap,
    stat,
    capabilities: store.capabilities,
    ...internalHandle,
  };
}
