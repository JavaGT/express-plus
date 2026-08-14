// migrations.mjs — public migration surface (S2/A4, workbench#90).
//
// The implementation lives in migration-ledger.ts; this module re-exports the
// namespaced ledger API under the established import paths (server.ts,
// sqlite-schema.ts, app.ts, framework-table-names.ts and the census all reach
// it here). The legacy global `_Migration` integer lane is gone: applications
// declare namespaced migrations via A1's `migrations` field, and the runner
// records them in the single (namespace, version) ledger.
//
// WRITE-COORDINATOR RED-LINE (S1/A5): the migration lane is the DOCUMENTED
// stop-the-world boot exception to the platform write coordinator
// (write-queue.ts). runMigrations runs pre-traffic during schema preparation,
// BEFORE the app serves — when no concurrent writer can exist — so it opens
// its own begin/commit/rollback transaction instead of a write-queue turn. It
// is explicitly NOT a second mutex: it is a boot-time one-shot that never
// overlaps a live writer.
//
// Migrations run at STARTUP, pre-traffic, stop-the-world for writes (gating to
// pre-traffic makes a long backfill acceptable — it would otherwise hold the
// single-writer mutex and block every concurrent write). The framework owns the
// mechanism; the app declares the migration list, namespaced.

export {
  MIGRATION_LEDGER_TABLE,
  RESERVED_NAMESPACE,
  MIGRATION_DDL,
  checksumOf,
  ensureMigrationTable,
  ledgerRows,
  appliedVersionsByNamespace,
  migrationLedgerStateOf,
  validateMigrations,
  runMigrations,
  isReservedNamespace,
  type Migration,
  type MigrationRunOptions,
  type AppliedLedgerRow,
  type LedgerEntry,
  type MigrationLedgerState,
} from './migration-ledger.ts';
