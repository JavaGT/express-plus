// schema-report.ts — a stable, machine-readable account of the settled schema.
// It reports identifiers and lifecycle metadata only; it never reads table rows.

import { migrationLedgerStateOf, type MigrationLedgerState } from './migration-ledger.ts';
import type { CensusEntry } from './schema-census.ts';

export type SchemaLifecyclePhase =
  | 'framework-bases'
  | 'entity-roots'
  | 'entity-side-tables'
  | 'indexes-and-constraints'
  | 'plugin-derived-resources';

export interface SchemaReportObject {
  readonly name: string;
  readonly kind: CensusEntry['objectKind'];
  readonly ownerKind: CensusEntry['kind'];
  readonly owner: string;
  readonly lifecyclePhase: SchemaLifecyclePhase;
  readonly state: 'present' | 'absent';
}

export interface SchemaReport {
  readonly objects: readonly SchemaReportObject[];
  readonly ledger: MigrationLedgerState;
}

interface SchemaReportDb {
  prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
}

function phaseOf(entry: CensusEntry): SchemaLifecyclePhase {
  if (entry.kind === 'framework') return 'framework-bases';
  if (entry.kind === 'plugin' || entry.kind === 'sqlite-artifact') return 'plugin-derived-resources';
  if (entry.objectKind === 'index' || entry.objectKind === 'trigger') return 'indexes-and-constraints';
  if (entry.kind === 'entity' && entry.name !== entry.owner) return 'entity-side-tables';
  return 'entity-roots';
}

/** Build the support/pin-verification report from the SQLite catalog and census. */
export function createSchemaReport(db: SchemaReportDb, census: ReadonlyMap<string, CensusEntry>): SchemaReport {
  const present = new Set(
    db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
      .map((row) => `${String(row.type) === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? '')) ? 'virtual-table' : String(row.type)}:${String(row.name).toLowerCase()}`),
  );
  const objects = [...census.values()]
    .map((entry) => ({
      name: entry.name,
      kind: entry.objectKind,
      ownerKind: entry.kind,
      owner: entry.owner,
      lifecyclePhase: phaseOf(entry),
      state: present.has(`${entry.objectKind}:${entry.name.toLowerCase()}`) ? 'present' as const : 'absent' as const,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return Object.freeze({ objects: Object.freeze(objects), ledger: migrationLedgerStateOf(db as never) });
}
