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
//   - Materialization is CONTAINED and ATOMIC. The destination blob directory
//     itself must be a real directory (never a pre-existing symlink — a
//     symlinked destination would redirect both materializers outside the
//     intended blob dir), and a generation's byte file + sidecar are written to
//     temp names unique to ONE materialize invocation (a fresh random token per
//     call) and renamed into place only after BOTH writes succeed, so a failing
//     sidecar write never leaves a byte file observable without its sidecar (no
//     partial generation is ever present as complete). One writer may
//     materialize a destination at a time (a per-destination lock keyed by the
//     destination's resolved realpath; a genuinely-contended destination fails
//     closed), and a mid-sequence failure rolls back exactly the files THAT
//     invocation created — a losing concurrent materializer never deletes the
//     winner's temps or finals.
//
// The seam's own digest verification at `materialize` time is against the
// BlobStore's recorded sha256 (the digests the manifest's census links to);
// after the bytes land in a backup, the sidecar is the self-contained digest
// the recovery/recycle sides verify against — the backup never depends on the
// live database's metadata to prove its bytes.

import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DbHandle } from './driver.ts';
import type { BlobCensus } from './blob-census.ts';
import type { BlobStore } from './blob-store.ts';
import type { MaterializedBlobFile } from './backup.ts';
import type { BackupBlobSource } from './backup.ts';
import type { RecoveryBlobSeam } from './recovery.ts';
import type { RecycleBlobSeam } from './backup/recycle.ts';

// The stable generation-layout version (spec 6): backup, recovery, and recycle
// agree on the file naming below. Bump this when the layout changes so the
// three consumers can detect a mismatch instead of guessing.
export const BLOB_GENERATION_LAYOUT_VERSION = 1 as const;

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
export function blobGenerationFileName(generation: string): string {
  return validateGeneration(generation);
}

/** The digest-sidecar file name for a generation under `blobs/`. */
export function blobGenerationDigestFileName(generation: string): string {
  return `${validateGeneration(generation)}${DIGEST_SUFFIX}`;
}

// The per-materialize temp-name token: a safe single path segment (hex/word
// chars), never a separator, so the temp names stay flat inside the
// destination directory.
const TEMP_TOKEN = /^[A-Za-z0-9_]{1,64}$/;

function validateTempToken(token: unknown): string {
  if (typeof token !== 'string' || !TEMP_TOKEN.test(token)) {
    throw new TypeError('invalid blob temp token — expected 1-64 of [A-Za-z0-9_]');
  }
  return token;
}

/**
 * The temp file names one materialize invocation will use for a generation's
 * byte file and digest sidecar inside the destination `blobs/` directory. The
 * token is fresh per invocation (see {@link BlobSeamsOptions.tempToken}), so
 * two concurrent materializers to the same destination can never share a temp
 * path — a losing materializer rolls back only the temps it created and can
 * never delete the winner's files.
 */
export function blobGenerationTempNames(
  generation: string,
  token: string,
): Readonly<{ byte: string; sidecar: string }> {
  const name = blobGenerationFileName(generation);
  const sidecarName = blobGenerationDigestFileName(generation);
  const safeToken = validateTempToken(token);
  return { byte: `.${name}.${safeToken}.tmp`, sidecar: `.${sidecarName}.${safeToken}.tmp` };
}

// ---- per-destination materialize lock -------------------------------------
//
// Two materializers writing the same destination blob directory at the same
// time would interleave temp writes and final renames; the per-destination
// lock serializes them (a lock/mutex keyed by the destination's resolved
// realpath). The materialize path is synchronous on one thread, so within a
// single context the lock is never observed held; the acquire FAILS CLOSED
// rather than blocking, so a genuinely-contended destination (a parallel
// context sharing the lock buffer — e.g. worker threads materializing the same
// directory) aborts the second writer cleanly instead of corrupting the first.
// Separate processes never share the buffer; their materializers are kept
// collision-free by the unique temp names + ownership-aware rollback below.

/** The number of lock slots in the per-destination materialize lock buffer. */
export const BLOB_MATERIALIZE_LOCK_SLOTS = 64 as const;

/** A new SharedArrayBuffer sized for the per-destination materialize lock. */
export function blobMaterializeLockBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * BLOB_MATERIALIZE_LOCK_SLOTS);
}

// The process-wide default lock buffer: every seam instance without an explicit
// buffer shares it, so seam instances in the same process serialize on the same
// slots. Separate processes (and worker threads given a distinct buffer) never
// share it — their materializers stay collision-free via unique temp names.
const defaultLockBuffer = blobMaterializeLockBuffer();

// FNV-1a (32-bit): a stable, allocation-free hash mapping a resolved realpath
// to a lock slot. A hash collision merely serializes two distinct destinations
// — always safe, never a correctness hazard.
function lockSlot(realPath: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < realPath.length; i++) {
    hash ^= realPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % BLOB_MATERIALIZE_LOCK_SLOTS;
}

function tryAcquireDestinationLock(slots: Int32Array, realPath: string): boolean {
  return Atomics.compareExchange(slots, lockSlot(realPath), 0, 1) === 0;
}

function releaseDestinationLock(slots: Int32Array, realPath: string): void {
  const wasHeld = Atomics.compareExchange(slots, lockSlot(realPath), 1, 0);
  if (wasHeld !== 1) {
    throw new Error('blob materialize lock released without being held');
  }
}

export type BlobSeamsOptions = {
  /** The live committed DB state reader (queries the census reference tables + BlobStore). */
  readonly db: DbHandle;
  /** The S6/A3 compiled blob-reference census. */
  readonly census: BlobCensus;
  /** The blob store (metadata + byte reads) the live generations live in. */
  readonly blobs: BlobStore;
  /**
   * TEST SEAM: the per-materialize temp-name token source (defaults to a fresh
   * random token per invocation so concurrent materializers never share a temp
   * path). Tests override it with a fixed token to predict the temp names and
   * force a mid-sequence failure deterministically. Production code must never
   * pass this.
   */
  readonly tempToken?: () => string;
  /**
   * The SharedArrayBuffer backing the per-destination materialize lock,
   * keyed by the destination's resolved realpath. Defaults to a module-level
   * buffer. Pass the SAME buffer to every context (e.g. worker threads) that
   * materializes into the same destination directories so they serialize on
   * it; contexts with separate buffers stay collision-free via the unique
   * per-invocation temp names.
   */
  readonly lockBuffer?: SharedArrayBuffer;
};

/** The one object satisfying all three seam contracts the managers consume. */
export type BlobSeams = BackupBlobSource & RecoveryBlobSeam & RecycleBlobSeam;

// ---- internals -----------------------------------------------------------

function validateGeneration(generation: unknown): string {
  if (typeof generation !== 'string' || !GENERATION_NAME.test(generation)) {
    throw new TypeError('invalid blob generation id — expected 1-128 of [A-Za-z0-9_-]');
  }
  return generation;
}

function sha256hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// Verify a file under `dir` is a genuine, contained, regular file (lstat +
// realpath, the same containment discipline as the backup/recovery managers):
// a symlink, a path escape, a missing file, or a non-file is refused.
type Containment = Readonly<{ ok: true; size: number }> | Readonly<{ ok: false; reason: string }>;

function verifyContainedRegularFile(dir: string, name: string): Containment {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return { ok: false, reason: `invalid blob file name: ${name}` };
  }
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, reason: `the blob directory does not exist: ${dir}` };
  }
  const filePath = path.join(dir, name);
  let stat: ReturnType<typeof statSync>;
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
function assertDestinationClear(dir: string, name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    throw new Error(`blob destination is not a safe single path segment: ${name}`);
  }
  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`blob destination ${name} is not writable`);
  }
  if (link.isSymbolicLink()) {
    throw new Error(`blob destination ${name} is a symlink — refusing to write outside the blob directory`);
  }
  throw new Error(`blob destination ${name} already exists — refusing to overwrite (fail closed)`);
}

// Validate the destination blob DIRECTORY before any write. mkdirSync with
// {recursive:true} follows a pre-existing symlink, so a symlinked destBlobDir
// would redirect both materializers OUTSIDE the intended blob directory: the
// directory itself must be a real directory (lstat), never a link, and is
// created only when absent. Returns the resolved realpath — every subsequent
// write targets it, so even a later swap of the original path for a symlink
// cannot redirect materialization.
function resolveBlobDestinationDir(destBlobDir: string): string {
  let link: ReturnType<typeof lstatSync> | undefined;
  try {
    link = lstatSync(destBlobDir);
    if (link.isSymbolicLink()) {
      throw new Error(
        `blob destination directory is a symlink — refusing to write outside the blob directory: ${destBlobDir}`,
      );
    }
    if (!link.isDirectory()) {
      throw new Error(`blob destination is not a directory: ${destBlobDir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(destBlobDir, { recursive: true, mode: 0o700 });
    // A recursive mkdir could have created through a planted symlink; confirm
    // what now exists at the destination is a real directory, not a link.
    link = lstatSync(destBlobDir);
    if (link.isSymbolicLink() || !link.isDirectory()) {
      throw new Error(`blob destination directory is not a real directory: ${destBlobDir}`);
    }
  }
  try {
    return realpathSync(destBlobDir);
  } catch {
    throw new Error(`blob destination directory could not be resolved: ${destBlobDir}`);
  }
}

// Materialize one generation's byte file + digest sidecar ATOMICALLY into an
// already-validated destination directory (the realpath from
// resolveBlobDestinationDir). One writer may materialize a destination at a
// time (the per-destination lock, keyed by the resolved realpath — a contended
// destination fails closed rather than interleaving). Both files are written to
// temp names unique to THIS invocation (a fresh random token) and renamed into
// their final names only after BOTH writes succeed, so a failing sidecar write
// never leaves a byte file in place without its sidecar — no partial generation
// is observable as complete. A mid-sequence failure rolls back exactly the
// files THIS invocation created: its own temps (unique names, so a concurrent
// materializer's files can never be removed here) and a byte file it had
// already renamed into place. A temp name this invocation failed to create (an
// exclusive 'wx' open that lost a create race) is never deleted, and the 'wx'
// opens also refuse any pre-existing path — a leftover temp or a planted file
// fails closed instead of being overwritten or silently adopted.
function writeGenerationAtomically(
  destRealDir: string,
  generation: string,
  bytes: Buffer,
  tempToken: () => string,
  lockSlots: Int32Array,
): void {
  if (!tryAcquireDestinationLock(lockSlots, destRealDir)) {
    throw new Error(
      `blob destination ${destRealDir} is being materialized by another writer — refusing to interleave (fail closed)`,
    );
  }
  try {
    const name = blobGenerationFileName(generation);
    const sidecarName = blobGenerationDigestFileName(generation);
    assertDestinationClear(destRealDir, name);
    assertDestinationClear(destRealDir, sidecarName);
    const temps = blobGenerationTempNames(generation, tempToken());
    const byteTmp = path.join(destRealDir, temps.byte);
    const sidecarTmp = path.join(destRealDir, temps.sidecar);
    const byteFinal = path.join(destRealDir, name);
    const sidecarFinal = path.join(destRealDir, sidecarName);
    let byteCreated = false;
    let sidecarCreated = false;
    let byteRenamed = false;
    try {
      writeFileSync(byteTmp, bytes, { flag: 'wx', mode: 0o600 });
      byteCreated = true;
      writeFileSync(sidecarTmp, `${sha256hex(bytes)}\n`, { flag: 'wx', mode: 0o600 });
      sidecarCreated = true;
      renameSync(byteTmp, byteFinal);
      byteRenamed = true;
      renameSync(sidecarTmp, sidecarFinal);
    } catch (err) {
      // Ownership-aware rollback: remove only the files this invocation
      // created/renamed — never another materializer's temp or final.
      for (const leftover of [
        byteCreated ? byteTmp : '',
        sidecarCreated ? sidecarTmp : '',
        byteRenamed ? byteFinal : '',
      ]) {
        if (leftover) {
          try {
            rmSync(leftover, { force: true });
          } catch {
            /* best-effort rollback of the partial generation */
          }
        }
      }
      throw err;
    }
  } finally {
    releaseDestinationLock(lockSlots, destRealDir);
  }
}

// Read + shape-check the digest sidecar for a generation. The sidecar is
// containment-checked exactly like the byte file (lstat + realpath inside the
// blob dir): a symlinked sidecar pointing outside the backup/target must never
// be trusted as the generation's digest. A missing or malformed sidecar is a
// verification failure (the byte file cannot be trusted without its recorded
// digest).
function readSidecar(
  dir: string,
  generation: string,
): { readonly ok: true; readonly digest: string } | { readonly ok: false; readonly reason: string } {
  const sidecarName = blobGenerationDigestFileName(generation);
  const contained = verifyContainedRegularFile(dir, sidecarName);
  if (!contained.ok) {
    return { ok: false, reason: `the digest sidecar for ${generation} is not a contained regular file: ${contained.reason}` };
  }
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, sidecarName), 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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
function verifyGenerationBytes(generation: string, blobsDir: string): { ok: true; name: string; size: number } | { ok: false; reason: string } {
  const name = blobGenerationFileName(generation);
  const bytes = verifyContainedRegularFile(blobsDir, name);
  if (!bytes.ok) return { ok: false, reason: bytes.reason };
  const sidecar = readSidecar(blobsDir, generation);
  if (!sidecar.ok) return { ok: false, reason: sidecar.reason };
  let actual: string;
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

export function createBlobSeams(options: BlobSeamsOptions): BlobSeams {
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

  // The per-invocation temp-name token source (unique per materialize call) and
  // the per-destination lock buffer. Both default to safe values; tests may
  // pin the token to predict temp names or share the lock buffer across worker
  // threads (see BlobSeamsOptions).
  const materializeToken = options.tempToken ?? (() => randomBytes(6).toString('hex'));
  const lockSlots = new Int32Array(options.lockBuffer ?? defaultLockBuffer);

  // ---- backup side (BackupBlobSource) ------------------------------------

  // Enumerate every referenced content-addressed generation from the committed
  // DB state: the DISTINCT ids the census references' tables/columns hold that
  // also have an ADOPTED BlobStore row. Deterministic (sorted) and stable
  // (same committed state → same census). Runs inside the backup manager's
  // single write-coordinator turn, so it observes one committed prefix.
  async function enumerateGenerations(): Promise<readonly string[]> {
    const referenced = new Set<string>();
    const existingTables = new Set<string>();
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
        .all() as Array<{ generation: string }>;
      for (const row of rows) {
        if (typeof row.generation === 'string' && row.generation.length > 0) referenced.add(row.generation);
      }
    }
    const adopted = new Set<string>();
    if (tableStmt.get(BLOB_METADATA_LEDGER)) {
      const rows = db.prepare('SELECT id FROM BlobStore WHERE status = ?').all('adopted') as Array<{ id: string }>;
      for (const row of rows) adopted.add(row.id);
    }
    return [...referenced].filter((id) => adopted.has(id)).sort();
  }

  // Write ONE generation's immutable bytes into the backup's blobs/ dir at the
  // stable file name (the same name resolveBackupBlobName resolves), plus the
  // digest sidecar. Reports { name, size } for the backup manager's disk
  // verification. Throws when the generation is pending (never adopted), has no
  // metadata row, has no bytes, or fails digest verification — fail closed.
  function materializeGeneration(generation: string, destBlobDir: string): readonly MaterializedBlobFile[] {
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
    let bytes: Buffer;
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
    const destRealDir = resolveBlobDestinationDir(destBlobDir);
    writeGenerationAtomically(destRealDir, generation, bytes, materializeToken, lockSlots);
    return [{ name, size: bytes.length }];
  }

  // ---- recovery side (RecoveryBlobSeam) ----------------------------------

  // Verify the backup holds verified bytes for one referenced generation
  // (contained regular file + matching digest sidecar). Throws → the restore
  // aborts with the backup left untouched.
  function verifyBackupGenerationBytes(generation: string, backupBlobsDir: string): void {
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
    generation: string,
    backupBlobsDir: string,
    destBlobDir: string,
  ): readonly MaterializedBlobFile[] {
    const verified = verifyGenerationBytes(generation, backupBlobsDir);
    if (!verified.ok) {
      throw new Error(`backup blob generation '${generation}' is unavailable: ${verified.reason}`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(backupBlobsDir, verified.name));
    } catch (err) {
      throw new Error(
        `backup blob generation '${generation}' bytes could not be read for restore: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const destRealDir = resolveBlobDestinationDir(destBlobDir);
    writeGenerationAtomically(destRealDir, generation, bytes, materializeToken, lockSlots);
    return [{ name: verified.name, size: bytes.length }];
  }

  // Confirm every referenced generation is available in the target's blob
  // store before the app may serve (census-before-serve). Throws on a missing
  // or corrupt generation — the restore is not marked complete (fail closed).
  // Extra, unreferenced files in the target do not fail the census.
  function verifyCensusAfterRestore(generations: readonly string[], targetRoot: string): void {
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
  function resolveBackupBlobName(generation: string, backupBlobsDir: string): string {
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
