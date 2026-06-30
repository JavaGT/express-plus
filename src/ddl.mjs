// ddl.mjs — generate CREATE TABLE statements for compiled entities.
//
// The framework generates NO DDL by default (the app owns its schema). This
// module provides `generateDDL(entity)` which returns an ordered array of SQL
// strings: the main entity table first, then each side-table (map membership,
// log entries, presence). The returned SQL is standalone — it may be executed
// against a node:sqlite DatabaseSync handle, or printed and committed to a
// migration file.
//
// Column type mappings (SQLite):
//   text / ref / crdt / hash / date    → TEXT
//   boolean                             → INTEGER (node:sqlite refuses JS booleans)
//   number                              → REAL
//   struct (link)                       → one column per struct cell
//   id                                  → TEXT PRIMARY KEY (caller-owned UUID)
//
// Side-table naming (from scope-sql.mjs):
//   map          → {Entity}_{field} ({Entity}_id, member_id [, role])
//   log          → {Entity}_{field} ({Entity}_id, ...entry sub-fields)
//   ephemeral   → {Entity}_{field} ({Entity}_id, client_id)
import { structCellColumn } from './field-strategy.mjs';

// Map a field's kind+type to its SQLite column type.
function sqlType(descriptor) {
  const { kind, type } = descriptor;
  if (kind === 'value' || kind === 'store' || kind === 'crdt' || kind === 'hash') {
    switch (type) {
      case 'boolean': return 'INTEGER';
      case 'number': return 'REAL';
      default: return 'TEXT';
    }
  }
  if (kind === 'struct') return 'TEXT'; // each struct cell is a TEXT column
  return 'TEXT'; // fallback (state, ephemeral, etc.)
}

// Generate the main table DDL for one entity.
function mainTableDDL(entity) {
  const cols = ['id TEXT PRIMARY KEY'];
  const { fields } = entity;
  if (!fields) return cols;

  for (const [name, descriptor] of Object.entries(fields)) {
    // Derived fields have no stored column (computed on read).
    if (descriptor.derived) continue;
    // Fields that are stored in the main table (value, crdt, hash, struct)
    if (descriptor.kind === 'value' || descriptor.kind === 'crdt' || descriptor.kind === 'hash' || descriptor.kind === 'state') {
      cols.push(`${name} ${sqlType(descriptor)}`);
    } else if (descriptor.kind === 'struct') {
      // struct fields (link) flatten to multiple columns
      for (const cellName of Object.keys(descriptor.cells ?? {})) {
        cols.push(`${structCellColumn(name, cellName)} TEXT`);
      }
    }
    // map / log / ephemeral / store → NOT stored in main table
  }
  return `CREATE TABLE IF NOT EXISTS ${entity.name} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate side-table DDL for map membership fields.
function mapTableDDL(entity, name, descriptor) {
  const tableName = `${entity.name}_${name}`;
  const ownerCol = `${entity.name}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'member_id TEXT NOT NULL'];
  // Role column: if roles are declared, add a TEXT role column
  if (Array.isArray(descriptor.roles) && descriptor.roles.length > 0) {
    cols.push('role TEXT NOT NULL');
  }
  cols.push(`PRIMARY KEY (${ownerCol}, member_id)`);
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate side-table DDL for log fields (append-only entries with sub-fields).
// Each entry has a stable `id` (identity) + one stored cell per declared entry
// sub-field. Like map/ordered, the main table has no column for a log — it lives
// entirely in the <Entity>_<field> side-table, ordered by rowid (append order).
function logTableDDL(entity, name, descriptor) {
  const tableName = `${entity.name}_${name}`;
  const ownerCol = `${entity.name}_id`;
  const entryCols = Object.keys(descriptor.entry ?? {});
  const cols = [`${ownerCol} TEXT NOT NULL`, 'id TEXT NOT NULL'];
  for (const subField of entryCols) {
    cols.push(`${subField} TEXT`);
  }
  cols.push(`PRIMARY KEY (${ownerCol}, id)`);
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate side-table DDL for ephemeral fields (per-connection cell tracking).
// `presence` is a retired wrapper over `ephemeral` (one non-persisting kind).
function ephemeralTableDDL(entity, name) {
  const tableName = `${entity.name}_${name}`;
  const ownerCol = `${entity.name}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'client_id TEXT NOT NULL', 'cells TEXT', `PRIMARY KEY (${ownerCol}, client_id)`];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate side-table DDL for ordered (list) fields. Each element has a stable
// `id` (identity) + a fractional `key` (sort position) + an `item` JSON cell.
// Order is derived by ORDER BY key (not an array shift), so a between-insert or
// a move re-keys only the affected row — siblings keep their keys (no renumber).
function orderedTableDDL(entity, name) {
  const tableName = `${entity.name}_${name}`;
  const ownerCol = `${entity.name}_id`;
  const cols = [
    `${ownerCol} TEXT NOT NULL`,
    'id TEXT NOT NULL',
    'key REAL NOT NULL',
    'item TEXT',
    `PRIMARY KEY (${ownerCol}, id)`,
  ];
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate a complete, ordered sequence of CREATE TABLE statements for one
// compiled entity: the main table, then each side-table.
export function generateDDL(entity) {
  const statements = [];
  const { fields } = entity;
  if (!fields) return statements;

  statements.push(mainTableDDL(entity));

  for (const [name, descriptor] of Object.entries(fields)) {
    if (descriptor.kind === 'store') {
      if (descriptor.type === 'map') {
        statements.push(mapTableDDL(entity, name, descriptor));
      } else if (descriptor.type === 'log') {
        statements.push(logTableDDL(entity, name, descriptor));
      }
    } else if (descriptor.kind === 'ephemeral') {
      statements.push(ephemeralTableDDL(entity, name));
    } else if (descriptor.kind === 'ordered') {
      statements.push(orderedTableDDL(entity, name));
    }
  }

  return statements;
}

// Execute the generated DDL statements against a DatabaseSync handle.
export function executeDDL(entity, db) {
  for (const sql of generateDDL(entity)) {
    db.exec(sql);
  }
}

export function generateFrameworkDDL() {
  return [
    `CREATE TABLE IF NOT EXISTS BlobStore (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  md5 TEXT,
  sha256 TEXT,
  size INTEGER,
  mime TEXT,
  createdAt TEXT NOT NULL
);`,
    'CREATE INDEX IF NOT EXISTS idx_blob_status ON BlobStore(status);',
    `CREATE TABLE IF NOT EXISTS _Log (
  scope TEXT NOT NULL,
  seq INTEGER NOT NULL,
  eventType TEXT NOT NULL,
  eventData TEXT NOT NULL,
  actionId TEXT NOT NULL,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (scope, seq)
);`,
    'CREATE INDEX IF NOT EXISTS idx__Log_actionId ON _Log (actionId);',
    `CREATE TABLE IF NOT EXISTS _Cursor (
  scope TEXT NOT NULL PRIMARY KEY,
  lastSeq INTEGER NOT NULL
);`,
    // Job-queue substrate (spec #5). A job is a unit of work with its own
    // lifecycle (queued/claimed/running/completed/failed), NOT a derived read
    // model — separate seam from the projection registry. Timestamps are ms-epoch
    // INTEGERS so lease/grace comparisons are plain numeric (no ISO-string
    // juggling). _Worker stores only the token HASH (never the raw bearer).
    `CREATE TABLE IF NOT EXISTS _Job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  enqueuedAt INTEGER NOT NULL,
  workerId TEXT,
  claimedAt INTEGER,
  leaseUntil INTEGER
);`,
    'CREATE INDEX IF NOT EXISTS idx__job_claim ON _Job (status, enqueuedAt);',
    `CREATE TABLE IF NOT EXISTS _Worker (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL,
  lastHeartbeat INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  registeredAt INTEGER NOT NULL
);`,
  ];
}

export function executeFrameworkDDL(db) {
  for (const sql of generateFrameworkDDL()) {
    db.exec(sql);
  }
}
