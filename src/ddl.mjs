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
//   map        → {Entity}_{field} ({Entity}_id, member_id [, role])
//   log        → {Entity}_{field} ({Entity}_id, ...entry sub-fields)
//   presence   → {Entity}_{field} ({Entity}_id, ...presence sub-fields)

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
  return 'TEXT'; // fallback (presence, state, etc. are not stored in the main table)
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
    if (descriptor.kind === 'value' || descriptor.kind === 'crdt' || descriptor.kind === 'hash') {
      cols.push(`${name} ${sqlType(descriptor)}`);
    } else if (descriptor.kind === 'struct') {
      // struct fields (link) flatten to multiple columns
      for (const cellName of Object.keys(descriptor.cells ?? {})) {
        cols.push(`${structCellColumn(name, cellName)} TEXT`);
      }
    }
    // map / log / presence / state / store → NOT stored in main table
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

// Generate side-table DDL for log fields (entries with sub-fields).
function logTableDDL(entity, name, descriptor) {
  const tableName = `${entity.name}_${name}`;
  const ownerCol = `${entity.name}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`];
  if (Array.isArray(descriptor.fields)) {
    for (const entryField of descriptor.fields) {
      // log entry sub-fields — assume TEXT for simplicity
      cols.push(`${entryField} TEXT`);
    }
  }
  return `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate side-table DDL for presence fields (connected client tracking).
function presenceTableDDL(entity, name) {
  const tableName = `${entity.name}_${name}`;
  const ownerCol = `${entity.name}_id`;
  const cols = [`${ownerCol} TEXT NOT NULL`, 'client_id TEXT NOT NULL', `PRIMARY KEY (${ownerCol}, client_id)`];
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
    } else if (descriptor.kind === 'presence') {
      statements.push(presenceTableDDL(entity, name));
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
  ];
}

export function executeFrameworkDDL(db) {
  for (const sql of generateFrameworkDDL()) {
    db.exec(sql);
  }
}
