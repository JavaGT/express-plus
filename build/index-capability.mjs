// index-capability.ts — census-authorized search-plugin owned-index access.
//
// Plugins receive statements, never a database handle. SQLite's authorizer is
// installed only while Workbench prepares and executes one of those statements,
// making the settled ownership census the execution authority.

import { constants } from 'node:sqlite';
import { txn,               } from './driver.mjs';






















const DENIED_ACTIONS = new Set        ([
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

// These are the only SQL functions an owned-index statement may invoke. FTS5
// needs its auxiliary functions (and MATCH appears as one in the authorizer);
// the scalar set supports ordinary result shaping without admitting connection
// state, extension loading, or application-defined functions.
const ALLOWED_FUNCTIONS = new Set([
  'abs', 'coalesce', 'concat', 'concat_ws', 'format', 'if', 'ifnull', 'iif',
  'instr', 'length', 'lower', 'ltrim', 'max', 'min', 'nullif', 'replace',
  'round', 'rtrim', 'substr', 'substring', 'trim', 'typeof', 'unicode', 'upper',
  'bm25', 'fts5', 'fts5_source_id', 'highlight', 'match', 'snippet',
]);

function ownedBy(census                                  , pluginId        , name               )          {
  if (name === null) return false;
  for (const kind of ['table', 'virtual-table', 'index', 'trigger']         ) {
    const entry = census.get(`${kind}:${name.toLowerCase()}`);
    if (entry?.owner === pluginId && (entry.kind === 'plugin' || entry.kind === 'sqlite-artifact')) return true;
  }
  return false;
}

function isOwnedVirtualTable(census                                  , pluginId        , name               )          {
  if (name === null) return false;
  const entry = census.get(`virtual-table:${name.toLowerCase()}`);
  return entry?.kind === 'plugin' && entry.owner === pluginId;
}

function assertStatement(statement                      )       {
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
export function createSearchOwnedIndexCapability(options                                   )                                         {
  const { db, census, writeCoordinator, fenceOf } = options;
  const maxStatements = options.maxStatements ?? 128;
  const maxRows = options.maxRows ?? 10_000;
  if (typeof db.setAuthorizer !== 'function') {
    throw new Error('owned-index capability requires a SQLite statement authorizer');
  }
  // FTS5 is loaded before the post-census capability binds. Do not leave its
  // connection able to load arbitrary extensions while plugins hold SQL access.
  db.enableLoadExtension?.(false);
  if (!Number.isSafeInteger(maxStatements) || maxStatements < 1) {
    throw new TypeError('owned-index capability maxStatements must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new TypeError('owned-index capability maxRows must be a positive safe integer');
  }

  function execute   (pluginId        , mode                   , statement                      , run         )    {
    assertStatement(statement);
    // FTS5 asks SQLite for the connection data version while it applies a
    // virtual-table operation. Permit that one engine-internal pragma only after
    // its census-owned virtual table has been selected for the operation.
    let virtualTableOperation = false;
    db.setAuthorizer((actionCode, arg1, arg2, dbName) => {
      if (dbName !== null && dbName !== 'main') return constants.SQLITE_DENY;
      if (actionCode === constants.SQLITE_PRAGMA) {
        return virtualTableOperation && arg1 === 'data_version' && arg2 === null
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY;
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
      // SELECT does not name a database object. A function does, however, name
      // executable connection code, so it is explicitly allowlisted.
      return actionCode === constants.SQLITE_SELECT || (actionCode === constants.SQLITE_FUNCTION && arg2 !== null && ALLOWED_FUNCTIONS.has(arg2.toLowerCase()))
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    });
    try {
      return run();
    } finally {
      db.setAuthorizer(null);
    }
  }

  return (pluginId        )                   => {
    const index                   = {
    query(statement                      ) {
      return execute(pluginId, 'query', statement, () => db.prepare(statement.sql).all(...(statement.params ?? [])));
    },
    async write({ expectedFence, statements }                                                                                          ) {
      if (!Number.isSafeInteger(expectedFence) || expectedFence < 0) throw new TypeError('owned-index expectedFence must be a non-negative safe integer');
      if (!Array.isArray(statements) || statements.length === 0 || statements.length > maxStatements) {
        throw new Error(`owned-index write requires 1 to ${maxStatements} statements`);
      }
      return writeCoordinator.run(async () => {
        // This check is deliberately inside the coordinator turn and before the
        // transaction: a moved source fence executes no plugin statements.
        if (fenceOf(pluginId) !== expectedFence) return { changes: 0 };
        return txn(db, () => {
          const totalChanges = () => Number(db.prepare('SELECT total_changes() AS changes').get()?.changes ?? 0);
          const before = totalChanges();
          for (const statement of statements) {
            execute(pluginId, 'write', statement, () => db.prepare(statement.sql).run(...(statement.params ?? [])));
            // total_changes() includes rows changed by trigger programs and
            // virtual-table internals. Check before the transaction can commit.
            if (totalChanges() - before > maxRows) {
              throw new Error(`owned-index write exceeds the ${maxRows}-row batch limit`);
            }
          }
          return { changes: totalChanges() - before };
        })                                         ;
      });
    },
    };
    return Object.freeze(index);
  };
}
