// recycle.ts — S1/A6 the backup recycling bin: deleted/privacy-erased content
// that still lives in retained backups (epic scope#23; library/API + tests
// only — no scheduler, no timer, no cron).
//
// CONTRACT: the recycling bin is the SINGLE deletion path for content whose
// bytes exist in a retained backup (owner decision #4). When a delete —
// INCLUDING privacy erasure — targets content, `bin()` moves each affected
// generation's bytes out of every retained backup that references it and into
// the user-accessible `recycle/` directory, then RE-MARKS that backup's
// manifest (content no longer reachable from the backup). Nothing is destroyed
// silently, and the path is uniform: there is one bin, no erasure-specific bin
// states, no per-backup `erasureAffected` markers. The deleted-content
// DETECTION (Scope's delete/erasure machinery, S8) and S6's blob-generation
// enumeration feed `bin()` through the declared `RecycleDeletion` interface —
// none of that detection lives here.
//
// The bin is reversible and operator-visible (directory + API): `list()`
// enumerates binned content, `restore()` moves bytes back into the origin
// backup and un-marks it, and `purge()` removes it. `purge()` sweeps the
// default recovery period (7 days, configurable via `retentionDays`, never
// hardcoded); `purge({ backupId })` and `purge({ generation })` force-delete
// earlier.
//
// FAIL-CLOSED BINNING: per backup, bytes move first and the re-marked manifest
// is written LAST — the manifest is the commit marker, mirroring backup
// creation (src/backup.ts). A disk-full/permission failure, a generation whose
// bytes cannot be located, or a manifest write that throws ROLLS THE BACKUP
// BACK: every generation whose bytes already moved is MOVED BACK to its origin
// blobs/ path (the same atomic rename in reverse, never a delete), no re-mark
// is written, and the backup is reported FAILED — a failed bin leaves the
// backup + bytes exactly as before, never cleaned. A backup carrying blob
// bytes whose generation files cannot be resolved refuses fail-closed (a
// recycle manager without the optional resolution seam never guesses at file
// names).
//
// CRASH WINDOW (documented, not defended against — same stance as backup.ts):
// between the byte rename into `recycle/<backupId>/<generation>/` and the
// re-marked manifest write, a crash leaves orphaned bin bytes whose backup
// manifest still claims the content reachable. The bytes are NOT lost (they sit
// in the operator-visible bin directory, listed by their entry when the
// entry.json write also landed) and the next `bin()` of the same generation
// fails closed rather than silently re-reporting the backup clean. Recovery
// refuses the re-marked backup until the binned generation is restored (its
// bytes are absent from the backup's blobs/ dir, exactly as the re-mark says).

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getLog } from '../log.mjs';
import { BACKUP_FORMAT_VERSION,                                                  } from '../backup.mjs';

export const RECYCLE_FORMAT_VERSION = 1         ;

// The default recovery period: binned content is destroyed by the `purge()`
// expiry sweep once it has been in the bin this long. Configurable via
// `retentionDays`, never hardcoded into a decision.
export const DEFAULT_RECYCLE_RETENTION_DAYS = 7;

// The stable backup directory naming (mirrors src/backup.ts): recycle/ keys
// bin entries by the origin backup's <timestamp>-<id> so an operator can trace
// binned content to the backup it came from.
const BACKUP_NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-([0-9a-f]+)$/;

// Generation ids are bounded token identifiers (blob-store safeId pattern) and
// double as the bin's per-backup subdirectory names.
const GENERATION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

// The S1/A6 deleted-content interface (what Scope's delete/erasure machinery
// S8 and S6's blob-generation enumeration feed). Content is identified by the
// content-addressed blob generations being deleted; the recycle module locates
// and bins those bytes wherever a retained backup still holds them.
                                        
                                          
   

// The pluggable seam that resolves a generation to the relative file name that
// holds its immutable bytes inside a backup's blobs/ directory — the name S6's
// `materialize` reported when the backup was created (src/backup.ts
// BackupBlobSource). MUST throw when the generation's bytes are missing,
// pending, or unlocatable, so binning fails closed instead of guessing. S6
// provides the concrete implementation; without it a recycle manager refuses
// to bin any backup that carries blob bytes.
                               
                                                                            
  

                                        
                            
                              
                        
                        
                            
   

                                            
                            
                                          
   

                                            
                            
                                          
                         
   

                                         
                       
                                                  
                                                  
   

                                                                                                        

                                                                                                        

                                           
                           
                                               
   

                                  
                                                                                        
                                           

                                     
                                                                               
                                                                              
                                                   
                        
                                                                           
                                                                               
                                                                        
                                        
                                          
                                                                          
                                                                        
               
                                  
                            
  

                              
                                                                            
                                                                              
                                                                           
                                                                          
                                                                               
                                                            
                                                                              
                          
                                     
                                                                            
                                                                             
                                                                             
                                                                       
                                                                             
                                                                               
                                                                         
                                                          
                                                                  
                                 
                                                                            
                                                                              
                        
  

// The one entry.json field set that identifies a binned generation. `name` is
// validated to be a bare file name; `binnedAt` is the canonical UTC instant.
                           
                                                        
                            
                              
                        
                        
                            
  

export function createRecycleManager(options                       )                 {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createRecycleManager requires an options object');
  }
  if (typeof options.root !== 'string' || options.root.length === 0) {
    throw new TypeError('recycle manager requires an owned root directory (source.root) with backups/ and recycle/ under it');
  }
  const retentionDays = validateRetentionDays(options.retentionDays);
  const blobs = options.blobs ?? null;
  if (blobs !== null && typeof blobs.resolveBackupBlobName !== 'function') {
    throw new TypeError('recycle blobs seam must expose resolveBackupBlobName(generation, backupBlobsDir)');
  }
  const now = options.now ?? (() => new Date());

  const root = path.resolve(options.root);
  const backupsDir = path.join(root, 'backups');
  const recycleDir = path.join(root, 'recycle');
  const backupIdPattern = new RegExp(BACKUP_NAME.source);

  function validateBackupId(backupId         )         {
    if (typeof backupId !== 'string' || !backupIdPattern.test(backupId)) {
      throw new TypeError('invalid backupId — expected <ISO-timestamp>-<hex> (e.g. 2026-01-01T00-00-00.000Z-abcd1234ef567890)');
    }
    return backupId;
  }

  function validateGeneration(generation         )         {
    if (typeof generation !== 'string' || !GENERATION_NAME.test(generation)) {
      throw new TypeError('invalid blob generation id — expected 1-128 of [A-Za-z0-9_-]');
    }
    return generation;
  }

  function entryDir(backupId        , generation        )         {
    return path.join(recycleDir, backupId, generation);
  }

  function isDirectory(p        )          {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  // readdirSafe: a missing directory is an empty listing, everything else
  // throws (the caller fails closed rather than pretending a directory was
  // read).
  function readdirSafe(p        )           {
    try {
      return readdirSync(p);
    } catch (err) {
      if ((err                         ).code === 'ENOENT') return [];
      throw err;
    }
  }

  // The result of reading a backup's manifest. A backup is genuinely complete
  // and bin-eligible iff its manifest exists, parses, and records a complete
  // status — the same gate the backup module uses (manifest written last). The
  // READ is FAIL-CLOSED (review #85 finding 2): a missing, unreadable, or
  // unparseable manifest cannot prove a backup does NOT hold the deleted
  // content, so binning reports it as a per-backup failure rather than
  // silently skipping it. `incomplete` is the one honest exception — the
  // manifest parsed and is a known format, but the backup never committed
  // (status !== 'complete'), so it is not a retained backup (the backup module
  // quarantines it) and binning skips it rather than binning from it.
                     
                                                              
                                                                                                  

  function readManifestState(dir        )               {
    let raw        ;
    try {
      raw = readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    } catch (err) {
      if ((err                         ).code === 'ENOENT') {
        return { ok: false, kind: 'unreadable', reason: 'the backup has no manifest.json — its contents cannot be verified' };
      }
      return { ok: false, kind: 'unreadable', reason: `the backup manifest.json is unreadable: ${sanitizeError(err)}` };
    }
    let parsed         ;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, kind: 'unreadable', reason: 'the backup manifest.json is unparseable — its contents cannot be verified' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, kind: 'unreadable', reason: 'the backup manifest.json does not hold a manifest object — its contents cannot be verified' };
    }
    const manifest = parsed                  ;
    if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      return {
        ok: false,
        kind: 'unreadable',
        reason: `the backup manifest has an unsupported format (${typeof manifest.formatVersion === 'number' ? manifest.formatVersion : 'unknown'}) — its contents cannot be verified`,
      };
    }
    if (manifest.status !== 'complete') {
      return {
        ok: false,
        kind: 'incomplete',
        reason: `the backup manifest declares status '${typeof manifest.status === 'string' ? manifest.status : 'unknown'}' — not a retained backup`,
      };
    }
    // SHAPE VALIDATION (review #85 finding 5): a manifest that parses can still
    // be structurally malformed — the required blobGenerations census missing or
    // not an array of strings, or a binnedGenerations re-mark that is not an
    // array of well-formed records. bin()/restore()/purge() read both fields, so
    // a malformed value gets the SAME fail-closed answer as an unreadable
    // manifest: the backup is reported a per-backup failure, never ok:true for
    // that backup, and never a thrown bin()/restore().
    if (!isStringArray(manifest.blobGenerations)) {
      return {
        ok: false,
        kind: 'unreadable',
        reason: 'the backup manifest is malformed: blobGenerations must be an array of generation ids — its contents cannot be verified',
      };
    }
    if (manifest.binnedGenerations !== undefined && !isBinnedGenerationArray(manifest.binnedGenerations)) {
      return {
        ok: false,
        kind: 'unreadable',
        reason: 'the backup manifest is malformed: binnedGenerations must be an array of binned-generation records — its contents cannot be verified',
      };
    }
    return { ok: true, manifest };
  }

  // Re-marking writes the manifest last (the commit marker) via temp+rename so
  // a torn write can never masquerade as a re-mark.
  function writeManifest(dir        , manifest                )       {
    const manifestPath = path.join(dir, 'manifest.json');
    const tmpPath = path.join(dir, `manifest.json.tmp-${process.pid}`);
    writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, manifestPath);
  }

  // Replace (or drop, when empty) the binned-generations re-mark on a manifest.
  function remarkManifest(manifest                , binned                                   )                 {
    if (binned.length === 0) {
      const next                                                                             = { ...manifest };
      delete next.binnedGenerations;
      return next;
    }
    return { ...manifest, binnedGenerations: binned };
  }

  function readEntry(dir        , backupId        , generation        )                         {
    let record                             ;
    try {
      record = JSON.parse(readFileSync(path.join(dir, 'entry.json'), 'utf8'))                               ;
    } catch (err) {
      // A missing entry is the routine "not binned" answer, not a failure; only
      // a genuinely unreadable entry is worth a warning.
      if ((err                         ).code !== 'ENOENT') {
        getLog().warn('system', 'recycle entry unreadable, skipping', { backupId, generation });
      }
      return null;
    }
    if (
      record.formatVersion !== RECYCLE_FORMAT_VERSION ||
      record.backupId !== backupId ||
      record.generation !== generation ||
      typeof record.name !== 'string' ||
      record.name === '' ||
      record.name === '.' ||
      record.name === '..' ||
      record.name.includes('/') ||
      record.name.includes('\\') ||
      path.isAbsolute(record.name) ||
      typeof record.size !== 'number' ||
      !Number.isInteger(record.size) ||
      record.size < 0 ||
      typeof record.binnedAt !== 'string' ||
      Number.isNaN(Date.parse(record.binnedAt))
    ) {
      getLog().warn('system', 'recycle entry malformed, skipping', { backupId, generation });
      return null;
    }
    return {
      backupId,
      generation,
      name: record.name,
      size: record.size,
      binnedAt: record.binnedAt,
    };
  }

  function listEntries()                    {
    const entries                    = [];
    for (const backupId of readdirSafe(recycleDir)) {
      if (!isDirectory(path.join(recycleDir, backupId))) continue;
      if (!backupIdPattern.test(backupId)) continue;
      for (const generation of readdirSafe(path.join(recycleDir, backupId))) {
        const dir = path.join(recycleDir, backupId, generation);
        if (!isDirectory(dir)) continue;
        if (!GENERATION_NAME.test(generation)) continue;
        const entry = readEntry(dir, backupId, generation);
        if (entry !== null) entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.binnedAt.localeCompare(b.binnedAt));
  }

  // Verify a seam-resolved blob file is a genuine, contained, regular file
  // inside the backup's blobs/ directory (lstat + realpath, the same
  // containment discipline as backup verification): a symlink, a path escape,
  // a missing file, or a non-file can never be binned.
  function verifyBinnedFile(
    generation        ,
    blobsDir        ,
    name        ,
  )                                                             {
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
      return { ok: false, reason: `blob seam resolved an invalid file name for ${generation}` };
    }
    let realBlobsDir        ;
    try {
      realBlobsDir = realpathSync(blobsDir);
    } catch {
      return { ok: false, reason: `backup blobs directory for ${generation} is missing` };
    }
    const filePath = path.join(blobsDir, name);
    let stat                             ;
    try {
      const link = lstatSync(filePath);
      if (link.isSymbolicLink()) {
        return { ok: false, reason: `generation ${generation} resolved to a symlink, which cannot be binned` };
      }
      const resolved = realpathSync(filePath);
      if (resolved !== realBlobsDir && !resolved.startsWith(realBlobsDir + path.sep)) {
        return { ok: false, reason: `generation ${generation} resolved outside the backup blobs directory` };
      }
      stat = statSync(resolved);
    } catch {
      return { ok: false, reason: `generation ${generation} bytes were not found in the backup blobs directory` };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: `generation ${generation} resolved to a non-file` };
    }
    return { ok: true, size: stat.size };
  }

  // TRUE ROLLBACK (review #85 finding 1): every generation whose bytes were
  // already moved out of the backup is MOVED BACK to its origin blobs/ path —
  // the same atomic rename in reverse (source and target live on one
  // filesystem, so renameSync is the safe primitive; a failed bin must leave
  // the backup + bytes exactly as before, so moved bytes are NEVER deleted
  // here). A bin entry dir created but never filled (the byte rename failed)
  // is removed once empty, the dropped entry.json of a successfully-returned
  // generation is removed (stale — its bytes are back in the backup), and the
  // now-empty per-backup parent is tidied. Whatever survives a rollback
  // failure keeps its entry.json and stays in the operator-visible bin so it
  // can be restored or purged by hand. Returns a short description of any
  // rollback failure for the caller's diagnostic.
  function rollbackBin(
    backupId        ,
    blobsDir        ,
    createdDirs                   ,
    moved                                                 ,
  )         {
    const failures           = [];
    const returned = new Set        ();
    for (const { generation, name } of [...moved].reverse()) {
      const dir = entryDir(backupId, generation);
      try {
        renameSync(path.join(dir, name), path.join(blobsDir, name));
        returned.add(dir);
      } catch (err) {
        // The bytes stay in the bin (WITH their entry.json, so they remain
        // listable); the manifest was never re-marked, so the backup still
        // claims them reachable — an operator can restore by hand.
        failures.push(`could not return ${generation} bytes to ${backupId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const dir of [...createdDirs].reverse()) {
      if (returned.has(dir)) {
        try {
          rmSync(path.join(dir, 'entry.json'), { force: true });
        } catch {
          /* nothing to drop */
        }
      }
      try {
        rmdirSync(dir);
      } catch {
        /* not empty — the generation's bytes could not be returned, so the
           entry stays in the bin for manual recovery */
      }
      try {
        rmdirSync(path.dirname(dir));
      } catch {
        /* not empty — another entry still lives there */
      }
    }
    return failures.join('; ');
  }

  // BIN ONE BACKUP. Returns the generations actually binned, or the failure
  // (its manifest untouched and bytes returned).
  function binBackup(
    backupId        ,
    backupDir        ,
    manifest                ,
    generations                   ,
  )                                                                                                              {
    const blobsDir = path.join(backupDir, 'blobs');
    const already = new Set((manifest.binnedGenerations ?? []).map((record) => record.generation));
    const todo = generations.filter((generation) => !already.has(generation));
    if (todo.length === 0) return { ok: true, generations: [] };

    // Fail closed: without a resolution seam the module cannot locate the
    // generation's bytes, so it must not guess at file names or report a
    // cleanup it could not perform.
    if (blobs === null) {
      return {
        ok: false,
        generations: todo,
        error:
          'backup references blob bytes but the recycle manager has no blob seam (resolveBackupBlobName) to locate generation files — refusing to bin blindly',
      };
    }

    const createdDirs           = [];
    const moved                                                                              = [];
    try {
      // Resolve + verify EVERY generation before any byte moves — a generation
      // that cannot be located must fail the whole backup, not leave it
      // half-cleaned.
      const resolved                                                            = [];
      for (const generation of todo) {
        const name = blobs.resolveBackupBlobName(generation, blobsDir);
        const verified = verifyBinnedFile(generation, blobsDir, name);
        if (!verified.ok) throw new Error(verified.reason);
        resolved.push({ generation, name, size: verified.size });
      }
      for (const { generation, name, size } of resolved) {
        const dir = entryDir(backupId, generation);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          chmodSync(dir, 0o700);
        } catch {
          /* best-effort tightening */
        }
        // Track the directory BEFORE the byte rename so a rename failure (disk
        // full/permission) still rolls the empty directory away.
        createdDirs.push(dir);
        const target = path.join(dir, name);
        if (existsSync(target)) {
          throw new Error(`a recycle entry already exists for ${backupId}/${generation}`);
        }
        // Byte rename is atomic; entry.json follows, so a crash cannot leave a
        // listed entry whose bytes are missing.
        const binnedAt = now().toISOString();
        renameSync(path.join(blobsDir, name), target);
        moved.push({ generation, name, size, binnedAt });
        const record                     = {
          formatVersion: RECYCLE_FORMAT_VERSION,
          backupId,
          generation,
          name,
          size,
          binnedAt,
        };
        writeFileSync(path.join(dir, 'entry.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      }
    } catch (err) {
      const rollbackFailures = rollbackBin(backupId, blobsDir, createdDirs, moved);
      const base = sanitizeError(err);
      return {
        ok: false,
        generations: todo,
        error: rollbackFailures === '' ? base : `${base}; rollback incomplete: ${rollbackFailures}`,
      };
    }

    // RE-MARK the manifest LAST — the commit marker. A re-mark write that
    // throws rolls the byte moves back so the backup is untouched, never a
    // silently-unreachable backup.
    const records                           = [
      ...(manifest.binnedGenerations ?? []),
      ...moved.map(({ generation, name, size, binnedAt }) => ({ generation, name, size, binnedAt })),
    ];
    try {
      writeManifest(backupDir, remarkManifest(manifest, records));
    } catch (err) {
      const rollbackFailures = rollbackBin(backupId, blobsDir, createdDirs, moved);
      const base = sanitizeError(err);
      return {
        ok: false,
        generations: todo,
        error: rollbackFailures === '' ? base : `${base}; rollback incomplete: ${rollbackFailures}`,
      };
    }

    return { ok: true, generations: todo };
  }

  async function bin(deletion                 )                            {
    if (!deletion || typeof deletion !== 'object' || !Array.isArray(deletion.generations)) {
      throw new TypeError('recycle bin requires a deletion identifying the deleted content as { generations: string[] }');
    }
    const generations = [...new Set(deletion.generations.map(validateGeneration))];

    const binned                        = [];
    const failed                        = [];
    for (const entry of readdirSafe(backupsDir)) {
      const dir = path.join(backupsDir, entry);
      if (!isDirectory(dir)) continue;
      if (!backupIdPattern.test(entry)) continue;
      const state = readManifestState(dir);
      if (!state.ok) {
        // FAIL-CLOSED (review #85 finding 2): a backup whose manifest cannot
        // be read or understood may still hold the deleted generation — it is
        // reported failed, never silently skipped and never ok:true. The one
        // exception is a parsed-but-incomplete backup: it is not a retained
        // backup (the backup module quarantines it), so it is skipped, never
        // binned from.
        if (state.kind === 'unreadable') {
          failed.push({ backupId: entry, generations, error: state.reason });
        }
        continue;
      }
      const present = generations.filter((generation) => state.manifest.blobGenerations.includes(generation));
      if (present.length === 0) continue;
      const outcome = binBackup(entry, dir, state.manifest, present);
      if (outcome.ok) {
        binned.push({ backupId: entry, generations: outcome.generations });
      } else {
        failed.push({ backupId: entry, generations: outcome.generations, error: outcome.error });
      }
    }
    return { ok: failed.length === 0, binned, failed };
  }

  function list()                             {
    return listEntries();
  }

  async function restore(target                      )                                {
    const backupId = validateBackupId(target?.backupId);
    const generation = validateGeneration(target?.generation);
    const dir = entryDir(backupId, generation);
    const entry = readEntry(dir, backupId, generation);
    if (entry === null) {
      return { ok: false, error: `no binned entry for ${backupId}/${generation}` };
    }
    const backupDir = path.join(backupsDir, backupId);
    const state = readManifestState(backupDir);
    if (!state.ok) {
      return {
        ok: false,
        error: `origin backup '${backupId}' no longer exists or cannot be verified (${state.reason}) — refusing to restore into it`,
      };
    }
    const manifest = state.manifest;
    // FAIL CLOSED on stale/inconsistent bin metadata (review #85 finding 4):
    // the origin manifest must actually record this generation as binned (with
    // the same file name the entry claims), or the un-mark would rewrite a
    // manifest that never marked it — moving bytes back while the backup still
    // claims them binned.
    const binnedRecord = (manifest.binnedGenerations ?? []).find((record) => record.generation === generation);
    if (binnedRecord === undefined || binnedRecord.name !== entry.name) {
      return {
        ok: false,
        error: `origin backup '${backupId}' has no matching binned-generation record for '${generation}' (entry '${entry.name}') — the bin entry and the backup manifest disagree; refusing to restore`,
      };
    }
    const sourcePath = path.join(dir, entry.name);
    if (!existsSync(sourcePath)) {
      return { ok: false, error: `binned bytes for ${backupId}/${generation} are missing from the bin` };
    }
    const destPath = path.join(backupDir, 'blobs', entry.name);
    if (existsSync(destPath)) {
      return { ok: false, error: `backup '${backupId}' already holds a file named '${entry.name}' — refusing to overwrite` };
    }
    const verified = verifyBinnedFile(generation, path.dirname(sourcePath), entry.name);
    if (!verified.ok) {
      return { ok: false, error: `binned bytes for ${backupId}/${generation} cannot be restored: ${verified.reason}` };
    }
    if (verified.size !== entry.size) {
      // The entry records the canonical size; tampered/truncated bin bytes are
      // refused rather than returned as a partial blob (review #85 finding 3).
      return {
        ok: false,
        error: `binned bytes for ${backupId}/${generation} are corrupted: the entry records ${entry.size} bytes but the bin holds ${verified.size} — refusing to restore`,
      };
    }
    try {
      mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
      // Bytes back first, then the manifest un-mark LAST (the commit marker) —
      // a failed un-mark rolls the bytes back into the bin so the state stays
      // "binned".
      renameSync(sourcePath, destPath);
      const records = (manifest.binnedGenerations ?? []).filter((record) => record.generation !== generation);
      writeManifest(backupDir, remarkManifest(manifest, records));
    } catch (err) {
      if (existsSync(destPath) && !existsSync(sourcePath)) {
        try {
          renameSync(destPath, sourcePath);
        } catch {
          /* best-effort rollback */
        }
      }
      return { ok: false, error: sanitizeError(err) };
    }
    // The entry directory is removed only AFTER the un-mark committed — a
    // leftover here is stale bookkeeping, never a lost byte (the bytes are
    // already back in the backup and the manifest already un-marked).
    try {
      rmSync(dir, { recursive: true, force: false });
    } catch (err) {
      getLog().warn('system', 'restore left a stale recycle entry directory behind', {
        error: sanitizeError(err),
        backupId,
        generation,
      });
    }
    try {
      rmdirSync(path.dirname(dir));
    } catch {
      /* not empty — another entry still lives there */
    }
    return { ok: true, backupId, generation, entry };
  }

  async function purge(target                     )                              {
    let selected = listEntries();
    if (target && (target.backupId !== undefined || target.generation !== undefined)) {
      if (target.backupId !== undefined) {
        const backupId = validateBackupId(target.backupId);
        selected = selected.filter((entry) => entry.backupId === backupId);
      }
      if (target.generation !== undefined) {
        const generation = validateGeneration(target.generation);
        selected = selected.filter((entry) => entry.generation === generation);
      }
    } else {
      // The default recovery period sweep: only entries binned at or before
      // `now - retentionDays` (i.e. in the bin at least the full period).
      const cutoff = new Date(now().getTime() - retentionDays * 86_400_000).toISOString();
      selected = selected.filter((entry) => entry.binnedAt <= cutoff);
    }
    for (const entry of selected) {
      // Fail closed: a removal that cannot complete (permission, disk) throws
      // and rejects the whole purge — it never reports success.
      const dir = entryDir(entry.backupId, entry.generation);
      rmSync(dir, { recursive: true, force: false });
      // Tidy the now-possibly-empty per-backup directory so the bin does not
      // accumulate empty parents (best-effort: another entry may still live in
      // it).
      try {
        rmdirSync(path.dirname(dir));
      } catch {
        /* not empty — another entry still lives there */
      }
      try {
        markPurged(entry);
      } catch (err) {
        getLog().warn('system', 'recycle purge destroyed binned bytes but could not update the origin backup re-mark', {
          error: sanitizeError(err),
          backupId: entry.backupId,
          generation: entry.generation,
        });
      }
    }
    return { removed: selected.length, entries: selected };
  }

  // Record the destruction on the origin backup's manifest so an operator can
  // tell destroyed content from restorable content. The origin backup may
  // already be gone (retention trim) — then there is nothing to re-mark.
  function markPurged(entry                 )       {
    const backupDir = path.join(backupsDir, entry.backupId);
    const state = readManifestState(backupDir);
    if (!state.ok) return;
    const manifest = state.manifest;
    const purgedAt = now().toISOString();
    const records = (manifest.binnedGenerations ?? []).map((record) =>
      record.generation === entry.generation ? { ...record, purgedAt } : record,
    );
    writeManifest(backupDir, remarkManifest(manifest, records));
  }

  return Object.freeze({
    bin,
    list,
    restore,
    purge,
    retentionDays,
    root: recycleDir,
  });
}

// ---- internals -----------------------------------------------------------

function validateRetentionDays(retentionDays                    )         {
  const days = retentionDays ?? DEFAULT_RECYCLE_RETENTION_DAYS;
  if (!Number.isInteger(days) || days < 1) {
    throw new TypeError('recycle retentionDays must be a positive integer (the recovery period before the expiry sweep destroys binned content)');
  }
  return days;
}

// A complete manifest records the blob-generation census as an array of
// generation-id strings (src/backup.ts BackupManifest); anything else is a
// malformed manifest and must fail closed wherever it is read.
function isStringArray(value         )          {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// The binned-generations re-mark is written only by this module: an array of
// records carrying a generation id, a bare blob file name, the byte size, and
// canonical UTC timestamps (purgedAt appears once the bytes were destroyed).
// A record that does not match this shape is malformed — fail closed instead of
// letting bin/restore/purge guess at its fields or throw while scanning it.
function isBinnedGenerationArray(value         )          {
  return Array.isArray(value) && value.every(isBinnedGenerationRecord);
}

function isBinnedGenerationRecord(record         )          {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  const r = record                                     ;
  return (
    typeof r.generation === 'string' &&
    r.generation !== '' &&
    typeof r.name === 'string' &&
    r.name !== '' &&
    r.name !== '.' &&
    r.name !== '..' &&
    !r.name.includes('/') &&
    !r.name.includes('\\') &&
    !path.isAbsolute(r.name) &&
    typeof r.size === 'number' &&
    Number.isInteger(r.size) &&
    r.size >= 0 &&
    typeof r.binnedAt === 'string' &&
    !Number.isNaN(Date.parse(r.binnedAt)) &&
    (r.purgedAt === undefined || (typeof r.purgedAt === 'string' && !Number.isNaN(Date.parse(r.purgedAt))))
  );
}

// Errors can carry content-bearing payloads; a bounded, control-character-
// stripped, long-token-redacted message keeps recycle diagnostics to identifiers
// and a short reason (the same discipline as the backup module).
const MAX_DIAGNOSTIC_ERROR_LENGTH = 500;
const MAX_TOKEN_LENGTH = 128;

function sanitizeError(err         )         {
  const message = err instanceof Error ? err.message : String(err);
  const singleLine = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const redacted = singleLine.replace(new RegExp(`\\S{${MAX_TOKEN_LENGTH + 1},}`, 'g'), (run) => `<redacted-${run.length}>`);
  return redacted.slice(0, MAX_DIAGNOSTIC_ERROR_LENGTH);
}
