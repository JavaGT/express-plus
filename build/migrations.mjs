// migrations.mjs — versioned schema migrations (eng-review spec #9, #17, D9).
//
// Migrations run at STARTUP, pre-traffic, stop-the-world for writes (gating to
// pre-traffic makes a long backfill acceptable — it would otherwise hold the
// single-writer mutex and block every concurrent write). The framework owns the
// mechanism; the app declares the migration list.
//
// Atomicity: a migration's DDL and its meta-version bump land in ONE
// transaction. node:sqlite DDL (ALTER TABLE, CREATE INDEX) is transactional, so
// a mid-flight crash before COMMIT rolls BOTH back — no half-migrated schema. On
// restart the meta-version is unchanged, so the pending migration re-runs; a
// migration's `up` must therefore be safe to re-apply against the rolled-back
// state (CREATE INDEX IF NOT EXISTS, or rely on the prior rollback having
// undone the ALTER). A failed migration (e.g. a unique index on duplicate data)
// throws, rolls back, and leaves the schema + meta table untouched.
//
// Out of scope (documented): non-transactional statements such as VACUUM cannot
// run inside the migration transaction — a migration that needs one should run
// it after its own COMMIT (accepted: it is no longer atomic with the bump, so
// the migration must be authored to tolerate that).

import { begin, commit, rollback,               } from './driver.mjs';

                         
                  
                             
  

export const MIGRATION_DDL = `CREATE TABLE IF NOT EXISTS _Migration (
  version INTEGER PRIMARY KEY,
  appliedAt TEXT NOT NULL
)`;

export function ensureMigrationTable(db          ) {
  db.exec(MIGRATION_DDL);
}

export function appliedVersion(db          )         {
  ensureMigrationTable(db);
  const row = db
    .prepare('SELECT MAX(version) AS v FROM _Migration')
    .get()                              ;
  return row?.v ?? 0;
}

export function runMigrations(
  db          ,
  migrations              = [],
  { now = () => new Date().toISOString() } = {},
) {
  ensureMigrationTable(db);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = appliedVersion(db);
  for (const m of sorted) {
    if (m.version <= current) continue;
    // SYNC begin/commit/rollback primitives (not the async txn callback):
    // runMigrations is synchronous and callers assert synchronously after it
    // returns, so the transaction control stays synchronous. The driver
    // dispatcher routes to the handle's own methods or the SQLite fallback.
    begin(db);
    try {
      m.up(db);
      db.prepare('INSERT INTO _Migration (version, appliedAt) VALUES (?, ?)').run(
        m.version,
        now(),
      );
      commit(db);
    } catch (err) {
      try {
        rollback(db);
      } catch {
        /* already rolled back or txn unusable */
      }
      throw new Error(
        `migration ${m.version} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
