// blob-seams.ts — S6/A6 the concrete backup/recovery/recycle blob seams
// (workbench#97, epic scope#23). Implements `BackupBlobSource` (backup.ts),
// `RecoveryBlobSeam` (recovery.ts), and `RecycleBlobSeam` (backup/recycle.ts)
// over the S6/A3 compiled blob-reference census (blob-census.ts) + the blob
// store (blob-store.ts). S1 declared these seams and implemented nothing behind
// them; this module is the real enumeration, materialization, verification, and
// name resolution they consume.
//
// GENERATION-LAYOUT CONTRACT (the stable byte-store generation layout backup,
// recovery, and recycle all agree on):
//
//   BLOB_GENERATION_LAYOUT_VERSION = 1
//
//   - A "generation" is a content-addressed blob id: an ADOPTED `BlobStore`
//     row reachable from committed DB state through the compiled census.
//     `census()` returns exactly those generations — referenced AND adopted.
//     A generation whose row is 'pending' (never adopted into committed state)
//     is never censused (its bytes are not content-addressed yet). An adopted
//     generation whose bytes are missing IS censused — its reference is
//     recorded — and then fails at materialize time: the seam throws (fail
//     closed) rather than silently dropping a referenced blob from the backup
//     or restore.
//
//   - The stable file name under a `blobs/` directory for a generation's
//     immutable bytes IS the generation id itself (already the fsBlobs final
//     slot layout `<blobsRoot>/<generation>`):
//         live final slot:         <blobsRoot>/<generation>
//         backup copy:             backups/<ts>-<id>/blobs/<generation>
//         restore target:          <targetRoot>/blobs/<generation>
//     `materialize` writes this name, `resolveBackupBlobName` resolves exactly
//     it, and recycle bins exactly it — one file name, three seams.
//
//   - `blobs/<generation>.sha256` is the DIGEST SIDECAR: the hex sha256 of the
//     generation's bytes, written by `materialize` as integrity metadata.
//     `verifyBackupGeneration`, `censusAfterRestore`, and
//     `resolveBackupBlobName` all verify the byte file against it, so a
//     corrupted or truncated byte file fails closed in backup, restore, and
//     recycle. The sidecar is never reported to the backup manager (it is not
//     a blob byte), never binned (recycle moves only the byte file), and never
//     an authorization token — content hashes are integrity metadata only
//     (S6 consideration #24).
//
// The seam's own digest verification at `materialize` time is against the
// BlobStore's recorded sha256 (the digests the manifest's census links to);
// after the bytes land in a backup, the sidecar is the self-contained digest
// the recovery/recycle sides verify against — the backup never depends on the
// live database's metadata to prove its bytes.

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';








// The stable generation-layout version (spec 6): backup, recovery, and recycle
// agree on the file naming below. Bump this when the layout changes so the
// three consumers can detect a mismatch instead of guessing.
export const BLOB_GENERATION_LAYOUT_VERSION = 1         ;

// Generation ids are bounded token identifiers (the same pattern the blob
// store and the recycle module enforce) and double as safe file names.
const GENERATION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

// The digest sidecar suffix for a generation's byte file.
const DIGEST_SUFFIX = '.sha256';

// The framework blob-metadata ledger. Adopted rows here are the ONLY
// generations the census may record (spec 2).
const BLOB_METADATA_LEDGER = 'BlobStore';

// Defense in depth: census reference identifiers are interpolated into SQL, so
// they must be SQL identifiers. The compiled census validates declared
// references at compile time; entity-derived names are checked here too before
// any statement is built (fail closed, never a guessed identifier).
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The stable file name holding a generation's immutable bytes under `blobs/`. */
export function blobGenerationFileName(generation        )         {
  return validateGeneration(generation);
}

/** The digest-sidecar file name for a generation under `blobs/`. */
export function blobGenerationDigestFileName(generation        )         {
  return `${validateGeneration(generation)}${DIGEST_SUFFIX}`;
}










/** The one object satisfying all three seam contracts the managers consume. */


// ---- internals -----------------------------------------------------------

function validateGeneration(generation         )         {
  if (typeof generation !== 'string' || !GENERATION_NAME.test(generation)) {
    throw new TypeError('invalid blob generation id — expected 1-128 of [A-Za-z0-9_-]');
  }
  return generation;
}

function sha256hex(value                     )         {
  return createHash('sha256').update(value).digest('hex');
}

// Verify a file under `dir` is a genuine, contained, regular file (lstat +
// realpath, the same containment discipline as the backup/recovery managers):
// a symlink, a path escape, a missing file, or a non-file is refused.


function verifyContainedRegularFile(dir        , name        )              {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return { ok: false, reason: `invalid blob file name: ${name}` };
  }
  let realDir        ;
  try {
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, reason: `the blob directory does not exist: ${dir}` };
  }
  const filePath = path.join(dir, name);
  let stat                             ;
  try {
    const link = lstatSync(filePath);
    if (link.isSymbolicLink()) {
      return { ok: false, reason: `blob file is a symlink: ${name}` };
    }
    const resolved = realpathSync(filePath);
    if (resolved !== realDir && !resolved.startsWith(realDir + path.sep)) {
      return { ok: false, reason: `blob file resolves outside the blob directory: ${name}` };
    }
    stat = statSync(resolved);
  } catch {
    return { ok: false, reason: `blob file was not found: ${name}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: `blob path is not a regular file: ${name}` };
  }
  return { ok: true, size: stat.size };
}

// Refuse to write into an occupied destination before materializing a
// generation: a pre-existing file, directory, or (critically) symlink at the
// stable generation path must never be overwritten or followed — a symlink
// planted at the path would redirect the write OUTSIDE the blob directory.
// Combined with the exclusive (O_EXCL) writes below, this is a
// no-write-outside guarantee, not a check-then-write race.
function assertDestinationClear(dir        , name        )       {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    throw new Error(`blob destination is not a safe single path segment: ${name}`);
  }
  let link                              ;
  try {
    link = lstatSync(path.join(dir, name));
  } catch (err) {
    if ((err                         ).code === 'ENOENT') return;
    throw new Error(`blob destination ${name} is not writable`);
  }
  if (link.isSymbolicLink()) {
    throw new Error(`blob destination ${name} is a symlink — refusing to write outside the blob directory`);
  }
  throw new Error(`blob destination ${name} already exists — refusing to overwrite (fail closed)`);
}

// Read + shape-check the digest sidecar for a generation. The sidecar is
// containment-checked exactly like the byte file (lstat + realpath inside the
// blob dir): a symlinked sidecar pointing outside the backup/target must never
// be trusted as the generation's digest. A missing or malformed sidecar is a
// verification failure (the byte file cannot be trusted without its recorded
// digest).
function readSidecar(
  dir        ,
  generation        ,
)                                                                                                   {
  const sidecarName = blobGenerationDigestFileName(generation);
  const contained = verifyContainedRegularFile(dir, sidecarName);
  if (!contained.ok) {
    return { ok: false, reason: `the digest sidecar for ${generation} is not a contained regular file: ${contained.reason}` };
  }
  let raw        ;
  try {
    raw = readFileSync(path.join(dir, sidecarName), 'utf8').trim();
  } catch (err) {
    if ((err                         ).code === 'ENOENT') {
      return { ok: false, reason: `the digest sidecar for ${generation} is missing` };
    }
    return { ok: false, reason: `the digest sidecar for ${generation} is unreadable` };
  }
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    return { ok: false, reason: `the digest sidecar for ${generation} is malformed` };
  }
  return { ok: true, digest: raw };
}

// Verify a generation's byte file + sidecar inside a `blobs/` directory and
// return the byte file name. Shared by verifyBackupGeneration, censusAfterRestore,
// and resolveBackupBlobName — one verification, three consumers.
function verifyGenerationBytes(generation        , blobsDir        )                                                                           {
  const name = blobGenerationFileName(generation);
  const bytes = verifyContainedRegularFile(blobsDir, name);
  if (!bytes.ok) return { ok: false, reason: bytes.reason };
  const sidecar = readSidecar(blobsDir, generation);
  if (!sidecar.ok) return { ok: false, reason: sidecar.reason };
  let actual        ;
  try {
    actual = sha256hex(readFileSync(path.join(blobsDir, name)));
  } catch {
    return { ok: false, reason: 'the generation bytes could not be read for digest verification' };
  }
  if (actual !== sidecar.digest) {
    return { ok: false, reason: `the generation bytes failed digest verification (recorded ${sidecar.digest}, found ${actual})` };
  }
  return { ok: true, name, size: bytes.size };
}

export function createBlobSeams(options                  )            {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createBlobSeams requires an options object');
  }
  const { db, census: compiledCensus, blobs } = options;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('blob seams require a database handle exposing prepare()');
  }
  if (!compiledCensus || typeof compiledCensus.references === 'undefined') {
    throw new TypeError('blob seams require the compiled blob census (compileBlobCensus)');
  }
  if (!blobs || typeof blobs.stat !== 'function' || typeof blobs.readRange !== 'function') {
    throw new TypeError('blob seams require a blob store exposing stat() and readRange()');
  }

  // ---- backup side (BackupBlobSource) ------------------------------------

  // Enumerate every referenced content-addressed generation from the committed
  // DB state: the DISTINCT ids the census references' tables/columns hold that
  // also have an ADOPTED BlobStore row. Deterministic (sorted) and stable
  // (same committed state → same census). Runs inside the backup manager's
  // single write-coordinator turn, so it observes one committed prefix.
  async function enumerateGenerations()                             {
    const referenced = new Set        ();
    const existingTables = new Set        ();
    const tableStmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    for (const ref of compiledCensus.references) {
      if (!SQL_IDENTIFIER.test(ref.table) || !SQL_IDENTIFIER.test(ref.column)) {
        throw new Error(
          `blob census: reference ${ref.table}.${ref.column} is not a SQL identifier — refusing to enumerate (fail closed)`,
        );
      }
      if (!existingTables.has(ref.table)) {
        if (!tableStmt.get(ref.table)) continue;
        existingTables.add(ref.table);
      }
      const rows = db
        .prepare(`SELECT DISTINCT "${ref.column}" AS generation FROM "${ref.table}" WHERE "${ref.column}" IS NOT NULL AND "${ref.column}" <> ''`)
        .all()                                 ;
      for (const row of rows) {
        if (typeof row.generation === 'string' && row.generation.length > 0) referenced.add(row.generation);
      }
    }
    const adopted = new Set        ();
    if (tableStmt.get(BLOB_METADATA_LEDGER)) {
      const rows = db.prepare('SELECT id FROM BlobStore WHERE status = ?').all('adopted')                         ;
      for (const row of rows) adopted.add(row.id);
    }
    return [...referenced].filter((id) => adopted.has(id)).sort();
  }

  // Write ONE generation's immutable bytes into the backup's blobs/ dir at the
  // stable file name (the same name resolveBackupBlobName resolves), plus the
  // digest sidecar. Reports { name, size } for the backup manager's disk
  // verification. Throws when the generation is pending (never adopted), has no
  // metadata row, has no bytes, or fails digest verification — fail closed.
  function materializeGeneration(generation        , destBlobDir        )                                  {
    const name = blobGenerationFileName(generation);
    const row = blobs.stat(generation);
    if (!row) {
      throw new Error(`blob generation '${generation}' is missing from the blob store metadata — its bytes cannot be materialized`);
    }
    if (row.status !== 'adopted') {
      throw new Error(
        `blob generation '${generation}' is '${row.status}', not adopted — its bytes are pending or unavailable (fail closed)`,
      );
    }
    let bytes        ;
    try {
      bytes = blobs.readRange(generation);
    } catch (err) {
      throw new Error(
        `blob generation '${generation}' bytes are missing from the byte store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const digest = sha256hex(bytes);
    if (digest !== row.sha256) {
      throw new Error(
        `blob generation '${generation}' failed digest verification against the blob store metadata — refusing to materialize corrupt bytes`,
      );
    }
    mkdirSync(destBlobDir, { recursive: true, mode: 0o700 });
    assertDestinationClear(destBlobDir, name);
    assertDestinationClear(destBlobDir, blobGenerationDigestFileName(generation));
    writeFileSync(path.join(destBlobDir, name), bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(destBlobDir, blobGenerationDigestFileName(generation)), `${digest}\n`, { flag: 'wx', mode: 0o600 });
    return [{ name, size: bytes.length }];
  }

  // ---- recovery side (RecoveryBlobSeam) ----------------------------------

  // Verify the backup holds verified bytes for one referenced generation
  // (contained regular file + matching digest sidecar). Throws → the restore
  // aborts with the backup left untouched.
  function verifyBackupGenerationBytes(generation        , backupBlobsDir        )       {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`backup blob generation '${generation}' is unavailable: ${verified.reason}`);
    }
  }

  // Materialize one verified generation's bytes from the backup's blobs/ into
  // the target's blobs/ layout (the same stable name), plus its digest sidecar,
  // so censusAfterRestore can verify the target without the backup. Returns the
  // files written for the recovery manager's disk verification.
  function materializeRestoredGeneration(
    generation        ,
    backupBlobsDir        ,
    destBlobDir        ,
  )                                  {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`backup blob generation '${generation}' is unavailable: ${verified.reason}`);
    }
    let bytes        ;
    try {
      bytes = readFileSync(path.join(backupBlobsDir, verified.name));
    } catch (err) {
      throw new Error(
        `backup blob generation '${generation}' bytes could not be read for restore: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    mkdirSync(destBlobDir, { recursive: true, mode: 0o700 });
    assertDestinationClear(destBlobDir, verified.name);
    assertDestinationClear(destBlobDir, blobGenerationDigestFileName(generation));
    writeFileSync(path.join(destBlobDir, verified.name), bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(destBlobDir, blobGenerationDigestFileName(generation)), `${sha256hex(bytes)}\n`, { flag: 'wx', mode: 0o600 });
    return [{ name: verified.name, size: bytes.length }];
  }

  // Confirm every referenced generation is available in the target's blob
  // store before the app may serve (census-before-serve). Throws on a missing
  // or corrupt generation — the restore is not marked complete (fail closed).
  // Extra, unreferenced files in the target do not fail the census.
  function verifyCensusAfterRestore(generations                   , targetRoot        )       {
    const destBlobDir = path.join(targetRoot, 'blobs');
    for (const generation of generations) {
      const verified = verifyGenerationBytes(generation, destBlobDir);
      if (!verified.ok) {
        throw new Error(`referenced blob generation '${generation}' is unavailable in the restored store: ${verified.reason}`);
      }
    }
  }

  // ---- recycle side (RecycleBlobSeam) ------------------------------------

  // Resolve the exact stable file name `materialize` wrote for a generation in
  // a backup's blobs/ dir. Throws when the generation's bytes are missing,
  // pending, or unverifiable — the recycle module never guesses at file names.
  function resolveBackupBlobName(generation        , backupBlobsDir        )         {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`blob generation '${generation}' cannot be resolved: ${verified.reason}`);
    }
    return verified.name;
  }

  return Object.freeze({
    census: enumerateGenerations,
    materialize: materializeGeneration,
    verifyBackupGeneration: verifyBackupGenerationBytes,
    materializeRestoreGeneration: materializeRestoredGeneration,
    censusAfterRestore: verifyCensusAfterRestore,
    resolveBackupBlobName,
  });
}
