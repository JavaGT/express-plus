import {               } from './driver.mjs';
import { applicationTable as resolveApplicationTable } from './application-table-guard.mjs';

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












function fail(message        )        {
  throw new TypeError(`invalid protected artefact store: ${message}`);
}

function columns(record         , name        )                           {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length === 0) {
    fail(`${name} must be a non-empty record`);
  }
  return Object.entries(record                           );
}

function identifiers(entries                          )         {
  return entries.map(([name]) => `"${name.replaceAll('"', '""')}"`).join(', ');
}

function predicate(entries                          )         {
  return entries.map(([name]) => `"${name.replaceAll('"', '""')}" = ?`).join(' AND ');
}

// Validate the bounded declaration on a registered action. Returns the frozen
// table allowlist, or an empty array when the action declares no protected store.
export function validateProtectedArtefactsDeclaration(declaration         , label        )                    {
  if (declaration === undefined) return Object.freeze([]);
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new TypeError(`registered action '${label}' protectedArtefacts must be an object`);
  }
  const keys = Object.keys(declaration);
  if (keys.some((key) => key !== 'tables')) {
    throw new TypeError(`registered action '${label}' protectedArtefacts has unknown keys '${keys.join(', ')}'`);
  }
  const tables = (declaration                        ).tables;
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new TypeError(`registered action '${label}' protectedArtefacts requires a non-empty tables array`);
  }
  for (const table of tables) {
    if (typeof table !== 'string' || table.length === 0) {
      throw new TypeError(`registered action '${label}' protectedArtefacts tables must be non-empty strings`);
    }
  }
  return Object.freeze([...tables])                     ;
}

// Build the transaction-bound store authority for one dispatch. `tables` is the
// declaring action's frozen allowlist; the capability is live only until
// close(), so the handler must use it inside its owning transaction and can
// never retain write access past it.
export function protectedArtefactCapability(db          , tables                   )                              {
  const allowedTables = new Set(tables);
  let active = true;
  const open = () => { if (!active) fail('writes are available only within the owning action transaction'); };
  const write                                            = (table, values) => {
    open();
    const entries = columns(values, 'values');
    return db.prepare(`INSERT INTO ${resolveApplicationTable(db, table, allowedTables, 'writes', fail)} (${identifiers(entries)}) VALUES (${entries.map(() => '?').join(', ')})`)
      .run(...entries.map(([, value]) => value)).changes;
  };
  const erase                                            = (table, where) => {
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
