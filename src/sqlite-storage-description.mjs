import { DatabaseSync } from 'node:sqlite';

import { generateDDL } from './ddl.mjs';
import { collectTableNamesFromDdl } from './schema-table-census.mjs';

function quoteIdent(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error('SQLite identifier must be a non-empty string without NUL bytes');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function describeIndexes(db, tableName) {
  const rows = db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all();
  return rows
    .map((row) => ({
      name: row.name,
      unique: row.unique === 1,
      origin: row.origin,
      partial: row.partial === 1,
      columns: db
        .prepare(`PRAGMA index_info(${quoteIdent(row.name)})`)
        .all()
        .sort((a, b) => a.seqno - b.seqno)
        .map((column) => column.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function describeForeignKeys(db, tableName) {
  const groups = new Map();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all()) {
    let group = groups.get(row.id);
    if (group === undefined) {
      group = {
        table: row.table,
        columns: [],
        referencedColumns: [],
        onUpdate: row.on_update,
        onDelete: row.on_delete,
        match: row.match,
      };
      groups.set(row.id, group);
    }
    group.columns[row.seq] = row.from;
    group.referencedColumns[row.seq] = row.to;
  }
  return [...groups.values()];
}

function describeTable(db, tableName) {
  const schema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (schema === undefined) throw new Error(`SQLite table '${tableName}' does not exist`);
  const sql = schema.sql ?? '';
  const columns = db
    .prepare(`PRAGMA table_xinfo(${quoteIdent(tableName)})`)
    .all()
    .sort((a, b) => a.cid - b.cid)
    .map((column) => ({
      name: column.name,
      type: String(column.type).toUpperCase(),
      notNull: column.notnull === 1,
      defaultValue: column.dflt_value ?? null,
      primaryKeyPosition: column.pk,
      hidden: column.hidden,
    }));
  return {
    name: tableName,
    virtual: /^CREATE\s+VIRTUAL\s+TABLE/i.test(sql),
    withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(sql),
    columns,
    primaryKey: columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((column) => column.name),
    foreignKeys: describeForeignKeys(db, tableName),
    indexes: describeIndexes(db, tableName),
  };
}

export function describeSqliteStorage(db, tableNames) {
  if (!Array.isArray(tableNames)) throw new Error('tableNames must be an array');
  const names = [...tableNames];
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error('tableNames must not contain duplicates');
  }
  return deepFreeze({
    tableNames: names,
    tables: names.map((name) => describeTable(db, name)),
  });
}

export function describeEntityStorage(entity) {
  const ddl = generateDDL(entity);
  const tableNames = collectTableNamesFromDdl(
    ddl.map((sql) => ({ source: `entity ${entity.name}`, sql })),
  );
  const db = new DatabaseSync(':memory:');
  try {
    for (const sql of ddl) db.exec(sql);
    return describeSqliteStorage(db, tableNames);
  } finally {
    db.close();
  }
}
