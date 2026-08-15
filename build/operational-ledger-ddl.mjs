// operational-ledger-ddl.ts — the DDL declaration source for the package's
// operational ledgers that are created lazily OUTSIDE generateFrameworkDDL().
//
// Three tables are framework-owned shared operational state (search staleness,
// derived-resource durability, schema-maintenance checkpoints) but cannot live
// in the framework DDL generators: each lifecycle module materializes its
// table lazily on first use, so a bridge that never fires must not create
// tables. They are still package-owned — no individual plugin owns them — so
// they are declared HERE, in one dependency-free source that both the census
// (framework-table-names.ts, schema-table-census.ts) and the three lifecycle
// modules that execute the DDL import. Declaring is NOT creating: the census
// reads these strings to know the tables are framework-owned before any
// lifecycle phase runs, and the lifecycle modules run the same strings on
// first use.
//
// This module imports nothing (and exports only strings/functions of strings)
// so the security-sensitive framework-table-names module and the auth compile
// graph can both import it without an initialization cycle.

export const SEARCH_STALENESS_TABLE_NAME = '_SearchStaleness';
export const DERIVED_RESOURCE_TABLE_NAME = '_DerivedResource';
export const SCHEMA_MAINTENANCE_TABLE_NAME = '_SchemaMaintenance';

// The search-staleness bridge allows a custom ledger table name at
// construction; the census declares the canonical name below.
export function renderSearchStalenessDdl(tableName        )         {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  sourceResource TEXT NOT NULL,
  sourceKey TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  affected TEXT NOT NULL,
  payload TEXT NOT NULL,
  tier TEXT,
  changedAt TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (sourceResource, sourceKey)
);`;
}

export const SEARCH_STALENESS_LEDGER_DDL = renderSearchStalenessDdl(SEARCH_STALENESS_TABLE_NAME);

export const DERIVED_RESOURCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DERIVED_RESOURCE_TABLE_NAME} (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  lastError TEXT,
  updatedAt TEXT NOT NULL
)`;

export const SCHEMA_MAINTENANCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${SCHEMA_MAINTENANCE_TABLE_NAME} (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  state TEXT NOT NULL,
  progress TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  lastError TEXT
)`;

// The full operational-ledger DDL set, consumed by the framework census and
// reserved-namespace registry so these tables are framework-owned from the
// first boot (before any lifecycle phase materializes them).
export const OPERATIONAL_LEDGER_DDL                    = Object.freeze([
  SEARCH_STALENESS_LEDGER_DDL,
  DERIVED_RESOURCE_TABLE_DDL,
  SCHEMA_MAINTENANCE_TABLE_DDL,
]);
