import { type DbHandle } from './driver.ts';
import { applicationTable as resolveApplicationTable } from './application-table-guard.ts';

// The protected-artefact store: a transaction-bound authority for an authorized
// registered action to write and permanently erase declared application-owned
// protected artefacts atomically with its own commit. The store is the declaring
// action's bounded table allowlist — the capability reaches nothing else: no
// Workbench package tables, no undeclared application tables, no second mutation
// path (AGENTS.md: singular system).
//
// Protected payloads (for example immutable speaker voice vectors) written here
// are deliberately excluded from _Log, receipts, snapshots, live delivery, undo
// history, and exports. The action's EVENT data and its returned canonicalPayload
// carry only the non-sensitive IDs and provenance needed to reference the
// artefact; erasure is a permanent hard DELETE from the declared store.

export interface ProtectedArtefactWriteCapability {
  /** Insert a row into a declared application-owned protected table, atomically with this action's commit. */
  write(table: string, values: Readonly<Record<string, unknown>>): number;
  /** Permanently delete rows from a declared protected table by equality predicate, atomically with this action's commit. */
  erase(table: string, where: Readonly<Record<string, unknown>>): number;
}

export interface ProtectedArtefactCapability extends ProtectedArtefactWriteCapability {
  close(): void;
}

function fail(message: string): never {
  throw new TypeError(`invalid protected artefact store: ${message}`);
}

function columns(record: unknown, name: string): Array<[string, unknown]> {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length === 0) {
    fail(`${name} must be a non-empty record`);
  }
  return Object.entries(record as Record<string, unknown>);
}

function identifiers(entries: Array<[string, unknown]>): string {
  return entries.map(([name]) => `"${name.replaceAll('"', '""')}"`).join(', ');
}

function predicate(entries: Array<[string, unknown]>): string {
  return entries.map(([name]) => `"${name.replaceAll('"', '""')}" = ?`).join(' AND ');
}

// Validate the bounded declaration on a registered action. Returns the frozen
// table allowlist, or an empty array when the action declares no protected store.
export function validateProtectedArtefactsDeclaration(declaration: unknown, label: string): readonly string[] {
  if (declaration === undefined) return Object.freeze([]);
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new TypeError(`registered action '${label}' protectedArtefacts must be an object`);
  }
  const keys = Object.keys(declaration);
  if (keys.some((key) => key !== 'tables')) {
    throw new TypeError(`registered action '${label}' protectedArtefacts has unknown keys '${keys.join(', ')}'`);
  }
  const tables = (declaration as { tables?: unknown }).tables;
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new TypeError(`registered action '${label}' protectedArtefacts requires a non-empty tables array`);
  }
  for (const table of tables) {
    if (typeof table !== 'string' || table.length === 0) {
      throw new TypeError(`registered action '${label}' protectedArtefacts tables must be non-empty strings`);
    }
  }
  return Object.freeze([...tables]) as readonly string[];
}

// Build the transaction-bound store authority for one dispatch. `tables` is the
// declaring action's frozen allowlist; the capability is live only until
// close(), so the handler must use it inside its owning transaction and can
// never retain write access past it.
export function protectedArtefactCapability(db: DbHandle, tables: readonly string[]): ProtectedArtefactCapability {
  const allowedTables = new Set(tables);
  let active = true;
  const open = () => { if (!active) fail('writes are available only within the owning action transaction'); };
  const write: ProtectedArtefactWriteCapability['write'] = (table, values) => {
    open();
    const entries = columns(values, 'values');
    return db.prepare(`INSERT INTO ${resolveApplicationTable(db, table, allowedTables, 'writes', fail)} (${identifiers(entries)}) VALUES (${entries.map(() => '?').join(', ')})`)
      .run(...entries.map(([, value]) => value)).changes;
  };
  const erase: ProtectedArtefactWriteCapability['erase'] = (table, where) => {
    open();
    const filters = columns(where, 'where');
    return db.prepare(`DELETE FROM ${resolveApplicationTable(db, table, allowedTables, 'writes', fail)} WHERE ${predicate(filters)}`)
      .run(...filters.map(([, value]) => value)).changes;
  };
  return Object.freeze({
    write, erase,
    close() { active = false; },
  });
}
