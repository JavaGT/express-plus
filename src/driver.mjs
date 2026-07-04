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

// ---- SQLite default implementations (the fallback + the wrapped-handle body) ----

async function sqliteTxn(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    result = await fn();
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back or txn unusable */ }
    throw err;
  }
  db.exec('COMMIT');
  return result;
}

function sqliteBegin(db) { db.exec('BEGIN IMMEDIATE'); }
function sqliteCommit(db) { db.exec('COMMIT'); }
function sqliteRollback(db) { db.exec('ROLLBACK'); }

// ONE upsert helper covering both idioms the codebase used to carry
// (ON CONFLICT ... DO UPDATE and INSERT OR REPLACE). All three former call sites
// target tables with a composite PRIMARY KEY and NO foreign keys / triggers, so
// REPLACE's delete-then-reinsert cascade was never depended upon — ON CONFLICT
// DO UPDATE (in-place update, no delete) is semantically equivalent and is the
// single upsert path now.
function sqliteUpsert(db, { table, keyColumns, columns = [], values }) {
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

export async function txn(db, fn) {
  if (typeof db.txn === 'function') return db.txn(fn);
  return sqliteTxn(db, fn);
}

export function begin(db) {
  if (typeof db.begin === 'function') return db.begin();
  sqliteBegin(db);
}

export function commit(db) {
  if (typeof db.commit === 'function') return db.commit();
  sqliteCommit(db);
}

export function rollback(db) {
  if (typeof db.rollback === 'function') return db.rollback();
  sqliteRollback(db);
}

export function upsert(db, opts) {
  if (typeof db.upsert === 'function') return db.upsert(opts);
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
export function wrapDriver(dbOrDriver) {
  if (dbOrDriver == null) return dbOrDriver;
  const isConformingDriver =
    typeof dbOrDriver.txn === 'function' && typeof dbOrDriver.upsert === 'function';
  if (isConformingDriver) return dbOrDriver;
  // Attach the SQLite defaults. `this` inside the arrow closures is lexical, so
  // we bind to the handle explicitly by closure (not `this`).
  dbOrDriver.txn = (fn) => sqliteTxn(dbOrDriver, fn);
  dbOrDriver.begin = () => sqliteBegin(dbOrDriver);
  dbOrDriver.commit = () => sqliteCommit(dbOrDriver);
  dbOrDriver.rollback = () => sqliteRollback(dbOrDriver);
  dbOrDriver.upsert = (opts) => sqliteUpsert(dbOrDriver, opts);
  if (typeof dbOrDriver.exec === 'function') {
    try {
      dbOrDriver.exec('PRAGMA journal_mode = WAL');
      dbOrDriver.exec('PRAGMA foreign_keys = ON');
      dbOrDriver.exec('PRAGMA synchronous = NORMAL');
      dbOrDriver.exec('PRAGMA busy_timeout = 5000');
    } catch { /* mock/stub db — no-op */ }
  }
  return dbOrDriver;
}
