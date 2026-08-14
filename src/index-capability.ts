// index-capability.ts — census-authorized search-plugin owned-index access.
//
// Plugins receive statements, never a database handle. SQLite's authorizer is
// installed only while Workbench prepares and executes one of those statements,
// making the settled ownership census the execution authority.

import { constants } from 'node:sqlite';
import { txn, type DbHandle } from './driver.ts';
import type { CensusEntry } from './schema-census.ts';
import type { SearchOwnedIndex } from './search-plugin.ts';

export interface SearchIndexStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export interface SearchIndexAuthorizerHandle extends DbHandle {
  setAuthorizer(callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null): void;
}

export interface SearchOwnedIndexCapabilityOptions {
  readonly db: SearchIndexAuthorizerHandle;
  readonly census: ReadonlyMap<string, CensusEntry>;
  readonly writeCoordinator: { run<T>(fn: () => T | Promise<T>): Promise<T> };
  readonly fenceOf: (pluginId: string) => number;
  readonly maxStatements?: number;
  readonly maxRows?: number;
}

const DENIED_ACTIONS = new Set<number>([
  constants.SQLITE_ALTER_TABLE, constants.SQLITE_ANALYZE, constants.SQLITE_ATTACH,
  constants.SQLITE_CREATE_INDEX, constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE, constants.SQLITE_CREATE_TEMP_TRIGGER, constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER, constants.SQLITE_CREATE_VIEW, constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DETACH, constants.SQLITE_DROP_INDEX, constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX, constants.SQLITE_DROP_TEMP_TABLE, constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW, constants.SQLITE_DROP_TRIGGER, constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_VTABLE, constants.SQLITE_PRAGMA, constants.SQLITE_REINDEX,
  constants.SQLITE_SAVEPOINT, constants.SQLITE_TRANSACTION,
]);

function ownedBy(census: ReadonlyMap<string, CensusEntry>, pluginId: string, name: string | null): boolean {
  if (name === null) return false;
  for (const kind of ['table', 'virtual-table', 'index', 'trigger'] as const) {
    const entry = census.get(`${kind}:${name.toLowerCase()}`);
    if (entry?.owner === pluginId && (entry.kind === 'plugin' || entry.kind === 'sqlite-artifact')) return true;
  }
  return false;
}

function isOwnedVirtualTable(census: ReadonlyMap<string, CensusEntry>, pluginId: string, name: string | null): boolean {
  if (name === null) return false;
  const entry = census.get(`virtual-table:${name.toLowerCase()}`);
  return entry?.kind === 'plugin' && entry.owner === pluginId;
}

function assertStatement(statement: SearchIndexStatement): void {
  if (!statement || typeof statement.sql !== 'string' || statement.sql.length === 0) {
    throw new TypeError('owned-index statement requires non-empty SQL');
  }
  if (statement.params !== undefined && !Array.isArray(statement.params)) {
    throw new TypeError('owned-index statement params must be an array');
  }
}

// Creates per-plugin facades after the lifecycle census has settled. There is no
// fallback for drivers without SQLite's authorizer: capability binding fails
// closed rather than attempting incomplete SQL inspection.
export function createSearchOwnedIndexCapability(options: SearchOwnedIndexCapabilityOptions): (pluginId: string) => SearchOwnedIndex {
  const { db, census, writeCoordinator, fenceOf } = options;
  const maxStatements = options.maxStatements ?? 128;
  const maxRows = options.maxRows ?? 10_000;
  if (typeof db.setAuthorizer !== 'function') {
    throw new Error('owned-index capability requires a SQLite statement authorizer');
  }
  if (!Number.isSafeInteger(maxStatements) || maxStatements < 1) {
    throw new TypeError('owned-index capability maxStatements must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError('owned-index capability maxRows must be a positive safe integer');
  }

  function execute<T>(pluginId: string, mode: 'query' | 'write', statement: SearchIndexStatement, run: () => T): T {
    assertStatement(statement);
    // FTS5 asks SQLite for the connection data version while it applies a
    // virtual-table operation. Permit that one engine-internal pragma only after
    // its census-owned virtual table has been selected for the operation.
    let virtualTableOperation = false;
    db.setAuthorizer((actionCode, arg1, _arg2, dbName) => {
      if (dbName !== null && dbName !== 'main') return constants.SQLITE_DENY;
      if (actionCode === constants.SQLITE_PRAGMA) {
        return virtualTableOperation && arg1 === 'data_version' ? constants.SQLITE_OK : constants.SQLITE_DENY;
      }
      if (DENIED_ACTIONS.has(actionCode)) return constants.SQLITE_DENY;
      if (actionCode === constants.SQLITE_READ) {
        if (isOwnedVirtualTable(census, pluginId, arg1)) virtualTableOperation = true;
        return ownedBy(census, pluginId, arg1) ? constants.SQLITE_OK : constants.SQLITE_DENY;
      }
      if (actionCode === constants.SQLITE_INSERT || actionCode === constants.SQLITE_UPDATE || actionCode === constants.SQLITE_DELETE) {
        if (mode === 'write' && isOwnedVirtualTable(census, pluginId, arg1)) virtualTableOperation = true;
        return mode === 'write' && ownedBy(census, pluginId, arg1) ? constants.SQLITE_OK : constants.SQLITE_DENY;
      }
      // SELECT and scalar functions (including FTS5 bm25/snippet) do not name a
      // database object. Every object access above remains census-checked.
      return actionCode === constants.SQLITE_SELECT || actionCode === constants.SQLITE_FUNCTION
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    });
    try {
      return run();
    } finally {
      db.setAuthorizer(null);
    }
  }

  return (pluginId: string): SearchOwnedIndex => {
    const index: SearchOwnedIndex = {
    query(statement: SearchIndexStatement) {
      return execute(pluginId, 'query', statement, () => db.prepare(statement.sql).all(...(statement.params ?? [])));
    },
    async write({ expectedFence, statements }: { readonly expectedFence: number; readonly statements: readonly SearchIndexStatement[] }) {
      if (!Number.isSafeInteger(expectedFence) || expectedFence < 0) throw new TypeError('owned-index expectedFence must be a non-negative safe integer');
      if (!Array.isArray(statements) || statements.length === 0 || statements.length > maxStatements) {
        throw new Error(`owned-index write requires 1 to ${maxStatements} statements`);
      }
      return writeCoordinator.run(async () => {
        // This check is deliberately inside the coordinator turn and before the
        // transaction: a moved source fence executes no plugin statements.
        if (fenceOf(pluginId) !== expectedFence) return { changes: 0 };
        return txn(db, () => {
          let changes = 0;
          for (const statement of statements) {
            changes += execute(pluginId, 'write', statement, () => db.prepare(statement.sql).run(...(statement.params ?? [])).changes);
            // The transaction is rolled back if a plugin attempts an unbounded
            // rebuild through a broad DML statement.
            if (changes > maxRows) {
              throw new Error(`owned-index write exceeds the ${maxRows}-row batch limit`);
            }
          }
          return { changes };
        }) as Promise<{ readonly changes: number }>;
      });
    },
    };
    return Object.freeze(index);
  };
}
