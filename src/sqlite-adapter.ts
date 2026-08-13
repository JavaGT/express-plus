// sqlite-adapter.ts — the default SQLite adapter (epic scope#23, S1/A2).
//
// CONTRACT: an adapter opens a workbench database from LOGICAL configuration —
// a directory plus a logical name (or a memory database) — never from a
// physical filename (src/db-adapter.ts). `openSqliteAdapter(config)` owns the
// directory: restrictive layout, an OS-backed ownership lock, the centralized
// PRAGMA layer, a fail-closed quick_check at open, and checkpoint-then-close
// shutdown. `openMemoryAdapter()` preserves the same surface and lifecycle
// ordering for `:memory:` without a directory or lock.
//
// The physical db filename is DERIVED here and never exposed to the app. The
// adapter also exposes the managed-path guard (the owned directory and its
// protected subpaths) wired into static-file serving and blob-root acceptance,
// and a teardown that removes ONLY the db file, -wal/-shm, and lock sidecar —
// backups/, quarantine/, and recycle/ are owned by S1/A3/A4/A6 and survive.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  applyConnectionPragmas,
  attachDriverHelpers,
  type DbHandle,
} from './driver.ts';
import {
  capabilitiesOf,
  type DbAdapter,
  type DbAdapterConfig,
  type IntegrityFinding,
  type IntegrityReport,
  type OpenedDatabase,
  type ReadMirrorDescription,
} from './db-adapter.ts';
import { acquireDirectoryLock, type DirectoryLock } from './directory-lock.ts';

export { DB_OWNED_ERROR_CODE, DirectoryOwnedError } from './directory-lock.ts';

// Stable package-private layout under the owned root. The physical names are
// derived by the adapter; subdirectory names are the shared vocabulary the
// S1 tickets (blobs/staging here, backups/quarantine/recycle in A3/A4/A6) use.
export const SQLITE_DATA_FILENAME = 'data.sqlite';
export const SQLITE_LOCK_FILENAME = 'lock.sqlite';
export const MANAGED_SUBDIRECTORIES = Object.freeze([
  'blobs',
  'staging',
  'backups',
  'quarantine',
  'recycle',
] as const);

// Teardown removes ONLY these (db file + -wal/-shm + lock sidecar). The
// managed subdirectories and their contents are never touched here.
const TEARDOWN_FILENAMES = Object.freeze([
  'data.sqlite',
  'data.sqlite-wal',
  'data.sqlite-shm',
  'lock.sqlite',
]);

export interface OpenedSqliteDatabase extends OpenedDatabase {
  readonly mode: 'file' | 'memory';
  // The owned directory root (file mode) or null (memory). Exposed because the
  // app uses it for the managed-path guard and blob-root overlap refusal; the
  // physical db filename itself is never exposed.
  readonly root: string | null;
  // True when `p` resolves to the owned directory or any protected subpath
  // (db file, -wal/-shm, lock sidecar, blobs/, staging/, backups/, quarantine/,
  // recycle/). Always false for the memory adapter.
  isManagedPath(p: string): boolean;
  // Remove the db file, -wal/-shm, and lock sidecar. backups/, quarantine/,
  // recycle/ (S1/A3/A4/A6) and blobs//staging/ are left untouched. Closes the
  // adapter first if it is still open.
  teardown(): void;
}

// The bound adapter object (DbAdapter-conforming: async open + readMirror) plus
// the managed-path surface an app wires into serving and blob-root checks.
export interface SqliteDbAdapter extends DbAdapter {
  readonly config: DbAdapterConfig;
  readonly root: string | null;
  isManagedPath(p: string): boolean;
  open(): Promise<OpenedDatabase>;
}

export function openSqliteAdapter(config: DbAdapterConfig = {}): OpenedSqliteDatabase {
  if (config.mode === 'memory') return openMemoryAdapter();
  const directory = config.directory;
  if (!directory) {
    throw new TypeError('openSqliteAdapter requires a `directory` for file mode');
  }
  const root = createOwnedLayout(directory);
  const dbFile = path.join(root, SQLITE_DATA_FILENAME);
  const lock = acquireDirectoryLock(path.join(root, SQLITE_LOCK_FILENAME));

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbFile);
  } catch (err) {
    lock.release();
    throw err;
  }
  try {
    // Centralized PRAGMA layer — the single source of truth (driver.ts). The
    // adapter path FAILS CLOSED here; it never relies on wrapDriver's silent
    // bootstrap. quick_check is the fail-closed integrity gate at open.
    applyConnectionPragmas(db);
    quickCheck(db);
    attachDriverHelpers(db as unknown as DbHandle);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort close on the failure path */
    }
    lock.release();
    throw err;
  }

  return makeOpenedSqliteDatabase(db, lock, root, 'file');
}

export function openMemoryAdapter(): OpenedSqliteDatabase {
  const db = new DatabaseSync(':memory:');
  try {
    applyConnectionPragmas(db);
    quickCheck(db);
    attachDriverHelpers(db as unknown as DbHandle);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort close on the failure path */
    }
    throw err;
  }
  return makeOpenedSqliteDatabase(db, null, null, 'memory');
}

// A self-contained adapter bound to its config, ready for app wiring: the app
// can refuse managed paths / blob-root overlap before calling open(). open()
// returns the contract's Promise<OpenedDatabase> shape (the underlying work is
// synchronous).
export function createSqliteAdapter(config: DbAdapterConfig = {}): SqliteDbAdapter {
  const root = config.mode === 'memory' || !config.directory ? null : path.resolve(config.directory);
  return {
    config,
    root,
    isManagedPath: (p) => isUnderRoot(root, p),
    open: () => Promise.resolve(openSqliteAdapter(config)),
    readMirror(): ReadMirrorDescription {
      const dbFile = root ? path.join(root, SQLITE_DATA_FILENAME) : ':memory:';
      return {
        kind: 'read-mirror',
        mode: 'read-only',
        readOnly: true,
        connectionString: `file:${dbFile}?mode=ro`,
      };
    },
  };
}

// ---- internals -----------------------------------------------------------

// Create the owned directory (restrictive 0o700) and the stable package-private
// subdirectory layout under one root.
function createOwnedLayout(directory: string): string {
  const root = path.resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const sub of MANAGED_SUBDIRECTORIES) {
    mkdirSync(path.join(root, sub), { recursive: true, mode: 0o700 });
  }
  return root;
}

// Fail-closed integrity gate at open. A fresh or healthy database answers the
// quick scan with a single 'ok' row; any other answer means the file is
// corrupt and the open must not proceed.
function quickCheck(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (!row || row.quick_check !== 'ok') {
    throw new Error('database failed quick_check integrity verification at open');
  }
}

function isUnderRoot(root: string | null, p: string): boolean {
  if (!root) return false;
  const abs = path.resolve(p);
  return abs === root || abs.startsWith(root + path.sep);
}

function makeOpenedSqliteDatabase(
  db: DatabaseSync,
  lock: DirectoryLock | null,
  root: string | null,
  mode: 'file' | 'memory',
): OpenedSqliteDatabase {
  let closed = false;
  const handle = db as unknown as DbHandle;
  const capabilities = capabilitiesOf({
    transactionalDdl: true,
    onlineBackup: true,
    readOnlyConnections: true,
    integrityCheck: true,
    maintenance: true,
  });

  const checkpoint = (): void => {
    if (mode === 'file') db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  };

  // Checkpoint-then-close: clean shutdown truncates the WAL into the main db
  // file before the handle (and then the ownership lock) goes away. Idempotent.
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (mode === 'file') {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* best-effort checkpoint — a handle already closed by the caller still closes cleanly */
      }
    }
    try {
      db.close();
    } catch {
      /* already closed by the caller */
    }
    lock?.release();
  };

  const integrityCheck = (): IntegrityReport => {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const findings: IntegrityFinding[] = [];
    for (const row of rows) {
      if (row.integrity_check !== 'ok') {
        findings.push({ severity: 'error', message: row.integrity_check });
      }
    }
    return { ok: findings.length === 0, checkedAt: new Date().toISOString(), findings };
  };

  const teardown = (): void => {
    if (!closed) close();
    if (!root) return;
    for (const filename of TEARDOWN_FILENAMES) {
      rmSync(path.join(root, filename), { force: true });
    }
  };

  return {
    handle,
    capabilities,
    mode,
    root,
    isManagedPath: (p) => isUnderRoot(root, p),
    close,
    checkpoint,
    integrityCheck,
    teardown,
  };
}
