// driver.mjs — the db driver contract (seam-review §2.1, priority #7).
//
// CONTRACT: a workbench db driver is a SYNCHRONOUS EMBEDDED single-writer handle
// with this shape:
//
//   {
//     prepare(sql) -> { run(...args), get(...args), all(...args) },
//     exec(sql),
//     txn(fn)      -> async; BEGIN IMMEDIATE / await fn() / COMMIT, ROLLBACK on throw,
//     begin(),       commit(),       rollback(),       // sync primitives for callers
//                                                   // that cannot use the callback form
//     upsert({ table, keyColumns, columns, values }),
//   }
//
// - `prepare` returns a statement whose `run` returns `{ changes }`, whose `get`
//   returns `undefined` when no row matches, and whose `all` returns an array.
//   BOTH `:name` named params and `?` positional params must work.
// - The driver is SYNCHRONOUS and EMBEDDED (node:sqlite DatabaseSync, a file,
//   :memory:, or a sync libSQL bridge). ASYNC / NETWORK drivers are OUT OF
//   CONTRACT: the writeQueue + in-transaction admission rely on single-writer
//   semantics — commitEvents brackets `await`s (projection consumers, blob adopt,
//   admission, effect recursion) inside ONE open BEGIN..COMMIT, and an async
//   driver would yield the writer mutex mid-transaction, letting a second
//   dispatch interleave inside the same txn and breaking the single-writer
//   kernel. There is no async driver path; do not add one.
//
// The framework never calls `BEGIN`/`COMMIT`/`ROLLBACK` literals or hand-rolled
// upsert SQL itself. Call sites go through the dispatcher functions below
// (`txn`, `begin`, `commit`, `rollback`, `upsert`), which route to the driver's
// own methods when present and otherwise fall back to the SQLite defaults
// implemented here. That fallback is what lets a raw node:sqlite DatabaseSync
// (the shape ~29 test files pass straight to createServer) work unchanged: it is
// a valid driver because wrapDriver attaches the defaults to it.

// Loose, Workbench-like db surface. A conforming driver may provide its own
// txn/upsert; a raw handle falls back to the SQLite defaults wrapped here.
export type DbStatement = {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Record<string, unknown>[];
};

export type DbHandle = {
  prepare(sql: string): DbStatement;
  exec(sql: string): unknown;
  txn?: (fn: () => Promise<unknown> | unknown) => Promise<unknown>;
  begin?: () => void;
  commit?: () => void;
  rollback?: () => void;
  upsert?: (opts: UpsertOptions) => void;
};

export type UpsertOptions = {
  table: string;
  keyColumns: string[];
  columns?: string[];
  values: Record<string, unknown>;
};

// ---- SQLite default implementations (the fallback + the wrapped-handle body) ----

async function sqliteTxn(db: DbHandle, fn: () => unknown): Promise<unknown> {
  db.exec('BEGIN IMMEDIATE');
  let result: unknown;
  try {
    result = await fn();
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back or txn unusable */
    }
    throw err;
  }
  db.exec('COMMIT');
  return result;
}

function sqliteBegin(db: DbHandle) {
  db.exec('BEGIN IMMEDIATE');
}
function sqliteCommit(db: DbHandle) {
  db.exec('COMMIT');
}
function sqliteRollback(db: DbHandle) {
  db.exec('ROLLBACK');
}

// ONE upsert helper covering both idioms the codebase used to carry
// (ON CONFLICT ... DO UPDATE and INSERT OR REPLACE). All three former call sites
// target tables with a composite PRIMARY KEY and NO foreign keys / triggers, so
// REPLACE's delete-then-reinsert cascade was never depended upon — ON CONFLICT
// DO UPDATE (in-place update, no delete) is semantically equivalent and is the
// single upsert path now.
function sqliteUpsert(
  db: DbHandle,
  { table, keyColumns, columns = [], values }: UpsertOptions,
) {
  const allCols = [...keyColumns, ...columns];
  const placeholders = allCols.map((c) => ':' + c).join(', ');
  const conflictTarget = keyColumns.join(', ');
  const setClause = columns.length
    ? columns.map((c) => `${c} = excluded.${c}`).join(', ')
    : null;
  const sql =
    `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${placeholders})` +
    ` ON CONFLICT(${conflictTarget})` +
    (setClause ? ` DO UPDATE SET ${setClause}` : ' DO NOTHING');
  db.prepare(sql).run(values);
}

// ---- Dispatchers: route to the driver's own method or the SQLite fallback ----
// A raw handle (no txn/upsert attached) falls through to the SQLite defaults;
// a wrapped app.db (helpers attached by wrapDriver) calls the attached method;
// a conforming custom driver calls its own implementation. All three uniform.

export async function txn(db: DbHandle, fn: () => unknown): Promise<unknown> {
  if (typeof db.txn === 'function') return db.txn(fn);
  return sqliteTxn(db, fn);
}

export function begin(db: DbHandle) {
  if (typeof db.begin === 'function') {
    db.begin();
    return;
  }
  sqliteBegin(db);
}

export function commit(db: DbHandle) {
  if (typeof db.commit === 'function') {
    db.commit();
    return;
  }
  sqliteCommit(db);
}

export function rollback(db: DbHandle) {
  if (typeof db.rollback === 'function') {
    db.rollback();
    return;
  }
  sqliteRollback(db);
}

export function upsert(db: DbHandle, opts: UpsertOptions) {
  if (typeof db.upsert === 'function') {
    db.upsert(opts);
    return;
  }
  sqliteUpsert(db, opts);
}

// ---- wrapDriver: attach the SQLite defaults (and PRAGMA bootstrap) to a raw
// handle, or pass a conforming custom driver through untouched. The driver IS
// the raw handle with helpers attached (object expansion, not a wrapper proxy),
// so `app.db.prepare` keeps working — entity code and tests reach it everywhere.
//
// A conforming custom driver (already provides txn AND upsert) owns its own
// bootstrap, so NO PRAGMAs run for it — it may not even be SQLite. PRAGMAs run
// only on the default path (raw DatabaseSync or a bare object) and are guarded
// so a mock/stub db without a working .exec is a no-op.
export function wrapDriver(dbOrDriver: DbHandle | null | undefined): DbHandle | null | undefined {
  if (dbOrDriver == null) return dbOrDriver;
  const isConformingDriver =
    typeof dbOrDriver.txn === 'function' && typeof dbOrDriver.upsert === 'function';
  if (isConformingDriver) return dbOrDriver;
  // Attach the SQLite defaults. `this` inside the arrow closures is lexical, so
  // we bind to the handle explicitly by closure (not `this`).
  dbOrDriver.txn = (fn) => sqliteTxn(dbOrDriver, fn);
  dbOrDriver.begin = () => sqliteBegin(dbOrDriver!);
  dbOrDriver.commit = () => sqliteCommit(dbOrDriver!);
  dbOrDriver.rollback = () => sqliteRollback(dbOrDriver!);
  dbOrDriver.upsert = (opts) => sqliteUpsert(dbOrDriver!, opts);
  if (typeof dbOrDriver.exec === 'function') {
    try {
      dbOrDriver.exec('PRAGMA journal_mode = WAL');
      dbOrDriver.exec('PRAGMA foreign_keys = ON');
      dbOrDriver.exec('PRAGMA synchronous = NORMAL');
      dbOrDriver.exec('PRAGMA busy_timeout = 5000');
    } catch {
      /* mock/stub db — no-op */
    }
  }
  return dbOrDriver;
}
