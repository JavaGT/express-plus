import { begin, commit, rollback } from './driver.mjs';
import { runMigrations } from './migrations.mjs';

const ALLOWED_TYPES = new Set(['text', 'integer', 'real', 'blob']);
const ALLOWED_FK_ACTIONS = new Set(['cascade', 'set null', 'set default', 'restrict', 'no action']);
const ALLOWED_DEFAULT_EXPRESSIONS = new Set([
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
]);

function requireName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function folded(name) {
  return name.toLowerCase();
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteDefault(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`default must be a finite number or string`);
}

function normaliseAction(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ALLOWED_FK_ACTIONS.has(value.toLowerCase())) {
    throw new Error(`invalid ${label} action "${value}"`);
  }
  return value.toUpperCase();
}

function compileTable(table) {
  const lines = table.columns.map((column) => {
    let sql = `  ${quoteIdent(column.name)} ${column.type.toUpperCase()}`;
    if (column.primaryKey) sql += ' PRIMARY KEY';
    if (column.notNull) sql += ' NOT NULL';
    if (column.default !== undefined) sql += ` DEFAULT ${quoteDefault(column.default)}`;
    if (column.defaultExpression !== undefined) sql += ` DEFAULT ${column.defaultExpression}`;
    return sql;
  });

  if (table.primaryKey !== undefined) {
    lines.push(`  PRIMARY KEY (${table.primaryKey.map(quoteIdent).join(', ')})`);
  }

  for (const foreignKey of table.foreignKeys ?? []) {
    let sql = `  FOREIGN KEY (${foreignKey.columns.map(quoteIdent).join(', ')})`;
    sql += ` REFERENCES ${quoteIdent(foreignKey.references.table)}`;
    sql += ` (${foreignKey.references.columns.map(quoteIdent).join(', ')})`;
    const onDelete = normaliseAction(foreignKey.onDelete, 'ON DELETE');
    const onUpdate = normaliseAction(foreignKey.onUpdate, 'ON UPDATE');
    if (onDelete !== undefined) sql += ` ON DELETE ${onDelete}`;
    if (onUpdate !== undefined) sql += ` ON UPDATE ${onUpdate}`;
    lines.push(sql);
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${lines.join(',\n')}\n);`;
}

function compileIndex(tableName, index) {
  const unique = index.unique ? ' UNIQUE' : '';
  return `CREATE${unique} INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(tableName)} (${index.columns.map(quoteIdent).join(', ')})`;
}

function validateSpec(spec) {
  if (spec === null || typeof spec !== 'object') throw new Error('schema declaration must be an object');
  requireName(spec.name, 'schema name');
  if (!Array.isArray(spec.tables)) throw new Error('schema tables must be an array');
  if (spec.externalTables !== undefined && !Array.isArray(spec.externalTables)) {
    throw new Error('schema externalTables must be an array');
  }
  if (spec.migrations !== undefined && !Array.isArray(spec.migrations)) {
    throw new Error('schema migrations must be an array');
  }

  const tablesByName = new Map();
  const referencedTablesByName = new Map();
  const globalIndexes = new Set();

  for (const externalTable of spec.externalTables ?? []) {
    if (externalTable === null || typeof externalTable !== 'object') {
      throw new Error('external table declaration must be an object');
    }
    requireName(externalTable.name, 'external table name');
    const externalKey = folded(externalTable.name);
    if (referencedTablesByName.has(externalKey)) throw new Error(`duplicate external table "${externalTable.name}"`);
    if (!Array.isArray(externalTable.columns) || externalTable.columns.length === 0) {
      throw new Error(`external table "${externalTable.name}" must declare at least one column`);
    }
    const columnsByName = new Map();
    for (const columnName of externalTable.columns) {
      requireName(columnName, `column name in external table "${externalTable.name}"`);
      const columnKey = folded(columnName);
      if (columnsByName.has(columnKey)) throw new Error(`duplicate column "${columnName}" in external table "${externalTable.name}"`);
      columnsByName.set(columnKey, { name: columnName });
    }
    referencedTablesByName.set(externalKey, { table: externalTable, columnsByName });
  }

  for (const table of spec.tables) {
    if (table === null || typeof table !== 'object') throw new Error('table declaration must be an object');
    requireName(table.name, 'table name');
    const tableKey = folded(table.name);
    if (tablesByName.has(tableKey) || referencedTablesByName.has(tableKey)) throw new Error(`duplicate table "${table.name}"`);
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      throw new Error(`table "${table.name}" must declare at least one column`);
    }

    const columnsByName = new Map();
    let columnPrimaryKeys = 0;
    for (const column of table.columns) {
      if (column === null || typeof column !== 'object') throw new Error(`invalid column in table "${table.name}"`);
      requireName(column.name, `column name in table "${table.name}"`);
      const columnKey = folded(column.name);
      if (columnsByName.has(columnKey)) throw new Error(`duplicate column "${column.name}" in table "${table.name}"`);
      if (typeof column.type !== 'string' || !ALLOWED_TYPES.has(column.type.toLowerCase())) {
        throw new Error(`invalid column type "${column.type}" for column "${column.name}"`);
      }
      if (column.default !== undefined && column.defaultExpression !== undefined) {
        throw new Error(`column "${column.name}" cannot declare both default and defaultExpression`);
      }
      if (column.default !== undefined) quoteDefault(column.default);
      if (column.defaultExpression !== undefined && !ALLOWED_DEFAULT_EXPRESSIONS.has(column.defaultExpression)) {
        throw new Error(`invalid default expression "${column.defaultExpression}" for column "${column.name}"`);
      }
      if (column.primaryKey) columnPrimaryKeys += 1;
      columnsByName.set(columnKey, column);
    }

    if (columnPrimaryKeys > 1 || (columnPrimaryKeys > 0 && table.primaryKey !== undefined)) {
      throw new Error(`table "${table.name}" has conflicting primary key declarations`);
    }
    if (table.primaryKey !== undefined) {
      validateColumnList(table.primaryKey, columnsByName, `primary key on table "${table.name}"`);
    }

    for (const index of table.indexes ?? []) {
      requireName(index?.name, `index name on table "${table.name}"`);
      const indexKey = folded(index.name);
      if (globalIndexes.has(indexKey)) throw new Error(`duplicate index "${index.name}"`);
      globalIndexes.add(indexKey);
      validateColumnList(index.columns, columnsByName, `index "${index.name}"`);
    }

    tablesByName.set(tableKey, { table, columnsByName });
    referencedTablesByName.set(tableKey, { table, columnsByName });
  }

  for (const { table, columnsByName } of tablesByName.values()) {
    for (const foreignKey of table.foreignKeys ?? []) {
      if (foreignKey === null || typeof foreignKey !== 'object' || foreignKey.references === null || typeof foreignKey.references !== 'object') {
        throw new Error(`invalid foreign key on table "${table.name}"`);
      }
      validateColumnList(foreignKey.columns, columnsByName, `foreign key on table "${table.name}"`);
      requireName(foreignKey.references.table, `referenced table for foreign key on "${table.name}"`);
      const referenced = referencedTablesByName.get(folded(foreignKey.references.table));
      if (referenced === undefined) {
        throw new Error(`foreign key on table "${table.name}" references missing table "${foreignKey.references.table}"`);
      }
      validateColumnList(foreignKey.references.columns, referenced.columnsByName, `foreign key reference to table "${referenced.table.name}"`);
      if (foreignKey.columns.length !== foreignKey.references.columns.length) {
        throw new Error(`foreign key on table "${table.name}" has mismatched column counts`);
      }
      normaliseAction(foreignKey.onDelete, 'ON DELETE');
      normaliseAction(foreignKey.onUpdate, 'ON UPDATE');
    }
  }

  const migrationVersions = new Set();
  for (const migration of spec.migrations ?? []) {
    if (migration === null || typeof migration !== 'object' || !Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error('migration version must be a positive safe integer');
    }
    if (migrationVersions.has(migration.version)) throw new Error(`duplicate migration version ${migration.version}`);
    if (typeof migration.up !== 'function') throw new Error(`migration ${migration.version} must declare an up function`);
    migrationVersions.add(migration.version);
  }
}

function validateColumnList(columns, knownColumns, label) {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error(`${label} must contain at least one column`);
  const seen = new Set();
  for (const name of columns) {
    requireName(name, `column in ${label}`);
    const key = folded(name);
    if (seen.has(key)) throw new Error(`${label} contains duplicate column "${name}"`);
    if (!knownColumns.has(key)) throw new Error(`${label} references missing column "${name}"`);
    seen.add(key);
  }
}

export function defineSqliteSchema(spec) {
  validateSpec(spec);
  const tables = Object.freeze(spec.tables.map((table) => Object.freeze({
    ...table,
    columns: Object.freeze(table.columns.map((column) => Object.freeze({ ...column }))),
    foreignKeys: Object.freeze((table.foreignKeys ?? []).map((foreignKey) => Object.freeze({
      ...foreignKey,
      columns: Object.freeze([...foreignKey.columns]),
      references: Object.freeze({ ...foreignKey.references, columns: Object.freeze([...foreignKey.references.columns]) }),
    }))),
    indexes: Object.freeze((table.indexes ?? []).map((index) => Object.freeze({ ...index, columns: Object.freeze([...index.columns]) }))),
    ...(table.primaryKey === undefined ? {} : { primaryKey: Object.freeze([...table.primaryKey]) }),
  })));
  const tableDdl = spec.tables.map(compileTable);
  const indexDdl = spec.tables.flatMap((table) => (table.indexes ?? []).map((index) => compileIndex(table.name, index)));
  const ddl = [...tableDdl, ...indexDdl];
  const tableNames = spec.tables.map((table) => table.name);
  const migrations = [...(spec.migrations ?? [])];

  return Object.freeze({
    name: spec.name,
    tableNames: Object.freeze(tableNames),
    tables,
    migrations: Object.freeze(migrations),
    ddl: Object.freeze(ddl),
    prepare(db, options) {
      if (tableDdl.length > 0) {
        begin(db);
        try {
          for (const sql of tableDdl) db.exec(sql);
          commit(db);
        } catch (error) {
          try { rollback(db); } catch { /* transaction is already unusable */ }
          throw error;
        }
      }
      if (!options?.skipMigrations) runMigrations(db, migrations, options);
      if (!options?.skipIndexes && indexDdl.length > 0) {
        begin(db);
        try {
          for (const sql of indexDdl) db.exec(sql);
          commit(db);
        } catch (error) {
          try { rollback(db); } catch { /* transaction is already unusable */ }
          throw error;
        }
      }
    },
  });
}
