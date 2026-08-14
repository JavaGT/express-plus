// schema-report.ts — a stable, machine-readable account of the settled schema.
// It reports identifiers and lifecycle metadata only; it never reads table rows.

import { migrationLedgerStateOf,                           } from './migration-ledger.mjs';



























function phaseOf(entry             )                       {
  if (entry.kind === 'framework') return 'framework-bases';
  if (entry.kind === 'plugin' || entry.kind === 'sqlite-artifact') return 'plugin-derived-resources';
  if (entry.objectKind === 'index' || entry.objectKind === 'trigger') return 'indexes-and-constraints';
  if (entry.kind === 'entity' && entry.name !== entry.owner) return 'entity-side-tables';
  return 'entity-roots';
}

/** Build the support/pin-verification report from the SQLite catalog and census. */
export function createSchemaReport(db                , census                                  )               {
  const observed = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')").all()
    .map((row) => ({
      name: String(row.name),
      kind: (String(row.type) === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row.sql ?? '')) ? 'virtual-table' : String(row.type))                             ,
    }));
  const present = new Set(observed.map((entry) => `${entry.kind}:${entry.name.toLowerCase()}`));
  const reported = new Set        ();
  const objects                       = [...census.values()]
    .map                    ((entry) => ({
      name: entry.name,
      kind: entry.objectKind,
      ownerKind: entry.kind,
      owner: entry.owner,
      lifecyclePhase: phaseOf(entry),
      state: present.has(`${entry.objectKind}:${entry.name.toLowerCase()}`) ? 'present'          : 'absent'         ,
    }))
    .concat(observed.flatMap((entry) => {
      const key = `${entry.kind}:${entry.name.toLowerCase()}`;
      if (census.has(key) || (entry.kind === 'table' && census.has(`virtual-table:${entry.name.toLowerCase()}`)) || reported.has(key)) return [];
      reported.add(key);
      return [{ name: entry.name, kind: entry.kind, ownerKind: 'undeclared'         , owner: 'undeclared', lifecyclePhase: 'undeclared'         , state: 'present'          }];
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return Object.freeze({ objects: Object.freeze(objects), ledger: migrationLedgerStateOf(db         ) });
}
