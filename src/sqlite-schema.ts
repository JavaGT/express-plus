import { begin, commit, rollback, type DbHandle } from './driver.ts';
import { runMigrations } from './migrations.ts';

const ALLOWED_TYPES = new Set(['text', 'integer', 'real', 'blob']);
const ALLOWED_FK_ACTIONS = new Set(['cascade', 'set null', 'set default', 'restrict', 'no action']);
const ALLOWED_DEFAULT_EXPRESSIONS = new Set([
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
]);

function requireName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function folded(name: string): string {
  return name.toLowerCase();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteDefault(value: number | string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`default must be a finite number or string`);
}

function normaliseAction(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ALLOWED_FK_ACTIONS.has(value.toLowerCase())) {
    throw new Error(`invalid ${label} action "${value}"`);
  }
  return value.toUpperCase();
}

function compileTable(table: SqliteTableSpec): string {
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

function compileIndex(tableName: string, index: SqliteIndexSpec): string {
  const unique = index.unique ? ' UNIQUE' : '';
  return `CREATE${unique} INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(tableName)} (${index.columns.map(quoteIdent).join(', ')})`;
}

interface SqliteSchemaInput {
  name?: unknown;
  tables?: unknown;
  externalTables?: unknown;
  migrations?: unknown;
}

interface LooseExternalTable { name?: unknown; columns?: unknown; }
interface LooseTable { name?: unknown; columns?: unknown; primaryKey?: unknown; indexes?: unknown; foreignKeys?: unknown; }
interface LooseColumn { name?: unknown; type?: unknown; primaryKey?: unknown; notNull?: unknown; default?: unknown; defaultExpression?: unknown; }
interface LooseIndex { name?: unknown; columns?: unknown; unique?: unknown; }
interface LooseForeignKey { columns?: unknown; references?: unknown; onDelete?: unknown; onUpdate?: unknown; }
interface LooseMigration { version?: unknown; up?: unknown; }

function validateSpec(input: unknown): void {
  if (input === null || typeof input !== 'object') throw new Error('schema declaration must be an object');
  const spec = input as SqliteSchemaInput;
  requireName(spec.name, 'schema name');
  if (!Array.isArray(spec.tables)) throw new Error('schema tables must be an array');
  const tables = spec.tables as unknown[];
  if (spec.externalTables !== undefined && !Array.isArray(spec.externalTables)) {
    throw new Error('schema externalTables must be an array');
  }
  const externalTables = (spec.externalTables ?? []) as unknown[];
  if (spec.migrations !== undefined && !Array.isArray(spec.migrations)) {
    throw new Error('schema migrations must be an array');
  }
  const migrations = (spec.migrations ?? []) as unknown[];

  const tablesByName = new Map<string, { table: SqliteTableSpec; columnsByName: Map<string, unknown> }>();
  const referencedTablesByName = new Map<string, { table: SqliteTableSpec; columnsByName: Map<string, unknown> }>();
  const globalIndexes = new Set<string>();

  for (const externalTable of externalTables) {
    if (externalTable === null || typeof externalTable !== 'object') {
      throw new Error('external table declaration must be an object');
    }
    const declaration = externalTable as LooseExternalTable;
    requireName(declaration.name, 'external table name');
    const externalKey = folded(declaration.name as string);
    if (referencedTablesByName.has(externalKey)) throw new Error(`duplicate external table "${declaration.name}"`);
    if (!Array.isArray(declaration.columns) || (declaration.columns as unknown[]).length === 0) {
      throw new Error(`external table "${declaration.name}" must declare at least one column`);
    }
    const columnsByName = new Map<string, unknown>();
    for (const columnName of declaration.columns as unknown[]) {
      requireName(columnName, `column name in external table "${declaration.name}"`);
      const columnKey = folded(columnName as string);
      if (columnsByName.has(columnKey)) throw new Error(`duplicate column "${columnName}" in external table "${declaration.name}"`);
      columnsByName.set(columnKey, { name: columnName });
    }
    referencedTablesByName.set(externalKey, { table: externalTable as SqliteTableSpec, columnsByName });
  }

  for (const table of tables) {
    if (table === null || typeof table !== 'object') throw new Error('table declaration must be an object');
    const declaration = table as LooseTable;
    requireName(declaration.name, 'table name');
    const tableKey = folded(declaration.name as string);
    if (tablesByName.has(tableKey) || referencedTablesByName.has(tableKey)) throw new Error(`duplicate table "${declaration.name}"`);
    if (!Array.isArray(declaration.columns) || (declaration.columns as unknown[]).length === 0) {
      throw new Error(`table "${declaration.name}" must declare at least one column`);
    }

    const columnsByName = new Map<string, unknown>();
    let columnPrimaryKeys = 0;
    for (const column of declaration.columns as unknown[]) {
      if (column === null || typeof column !== 'object') throw new Error(`invalid column in table "${declaration.name}"`);
      const col = column as LooseColumn;
      requireName(col.name, `column name in table "${declaration.name}"`);
      const columnKey = folded(col.name as string);
      if (columnsByName.has(columnKey)) throw new Error(`duplicate column "${col.name}" in table "${declaration.name}"`);
      if (typeof col.type !== 'string' || !ALLOWED_TYPES.has(col.type.toLowerCase())) {
        throw new Error(`invalid column type "${col.type}" for column "${col.name}"`);
      }
      if (col.default !== undefined && col.defaultExpression !== undefined) {
        throw new Error(`column "${col.name}" cannot declare both default and defaultExpression`);
      }
      if (col.default !== undefined) quoteDefault(col.default as number | string);
      if (col.defaultExpression !== undefined && !ALLOWED_DEFAULT_EXPRESSIONS.has(col.defaultExpression as string)) {
        throw new Error(`invalid default expression "${col.defaultExpression}" for column "${col.name}"`);
      }
      if (col.primaryKey === true) columnPrimaryKeys += 1;
      columnsByName.set(columnKey, col);
    }

    if (columnPrimaryKeys > 1 || (columnPrimaryKeys > 0 && declaration.primaryKey !== undefined)) {
      throw new Error(`table "${declaration.name}" has conflicting primary key declarations`);
    }
    if (declaration.primaryKey !== undefined) {
      validateColumnList(declaration.primaryKey, columnsByName, `primary key on table "${declaration.name}"`);
    }

    for (const index of (declaration.indexes ?? []) as unknown[]) {
      const idx = index as LooseIndex;
      requireName(idx.name, `index name on table "${declaration.name}"`);
      const indexKey = folded(idx.name as string);
      if (globalIndexes.has(indexKey)) throw new Error(`duplicate index "${idx.name}"`);
      globalIndexes.add(indexKey);
      validateColumnList(idx.columns, columnsByName, `index "${idx.name}"`);
    }

    tablesByName.set(tableKey, { table: table as SqliteTableSpec, columnsByName });
    referencedTablesByName.set(tableKey, { table: table as SqliteTableSpec, columnsByName });
  }

  for (const { table, columnsByName } of tablesByName.values()) {
    for (const foreignKey of (table.foreignKeys ?? []) as unknown[]) {
      if (foreignKey === null || typeof foreignKey !== 'object' || (foreignKey as LooseForeignKey).references === null || typeof (foreignKey as LooseForeignKey).references !== 'object') {
        throw new Error(`invalid foreign key on table "${table.name}"`);
      }
      const fk = foreignKey as LooseForeignKey;
      validateColumnList(fk.columns, columnsByName, `foreign key on table "${table.name}"`);
      requireName((fk.references as { table?: unknown }).table, `referenced table for foreign key on "${table.name}"`);
      const referenced = referencedTablesByName.get(folded((fk.references as { table: string }).table));
      if (referenced === undefined) {
        throw new Error(`foreign key on table "${table.name}" references missing table "${(fk.references as { table: string }).table}"`);
      }
      validateColumnList((fk.references as { columns?: unknown }).columns, referenced.columnsByName, `foreign key reference to table "${referenced.table.name}"`);
      if ((fk.columns as unknown[]).length !== ((fk.references as { columns: unknown[] }).columns).length) {
        throw new Error(`foreign key on table "${table.name}" has mismatched column counts`);
      }
      normaliseAction(fk.onDelete, 'ON DELETE');
      normaliseAction(fk.onUpdate, 'ON UPDATE');
    }
  }

  const migrationVersions = new Set<number>();
  for (const migration of migrations) {
    const m = migration as LooseMigration;
    if (migration === null || typeof migration !== 'object' || !Number.isSafeInteger(m.version) || (m.version as number) <= 0) {
      throw new Error('migration version must be a positive safe integer');
    }
    if (migrationVersions.has(m.version as number)) throw new Error(`duplicate migration version ${m.version}`);
    if (typeof m.up !== 'function') throw new Error(`migration ${m.version} must declare an up function`);
    migrationVersions.add(m.version as number);
  }
}

function validateColumnList(columns: unknown, knownColumns: ReadonlyMap<string, unknown>, label: string): void {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error(`${label} must contain at least one column`);
  const seen = new Set<string>();
  for (const name of columns) {
    requireName(name, `column in ${label}`);
    const key = folded(name as string);
    if (seen.has(key)) throw new Error(`${label} contains duplicate column "${name}"`);
    if (!knownColumns.has(key)) throw new Error(`${label} references missing column "${name}"`);
    seen.add(key);
  }
}

export interface SqliteColumnSpec {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: number | string;
  defaultExpression?: string;
}

export interface SqliteForeignKeySpec {
  columns: readonly string[];
  references: { table: string; columns: readonly string[] };
  onDelete?: string;
  onUpdate?: string;
}

export interface SqliteIndexSpec {
  name: string;
  unique?: boolean;
  columns: readonly string[];
}

export interface SqliteTableSpec {
  name: string;
  columns: readonly SqliteColumnSpec[];
  primaryKey?: readonly string[];
  foreignKeys?: readonly SqliteForeignKeySpec[];
  indexes?: readonly SqliteIndexSpec[];
}

export interface SqliteMigrationSpec {
  version: number;
  up: (db: DbHandle) => void;
}

export interface SqliteSchemaSpec {
  name: string;
  tables: readonly SqliteTableSpec[];
  externalTables?: readonly { name: string; columns: readonly string[] }[];
  migrations?: readonly SqliteMigrationSpec[];
}

export interface SqliteSchemaDescription {
  name: string;
  tableNames: readonly string[];
  tables: readonly SqliteTableSpec[];
  migrations: readonly SqliteMigrationSpec[];
  ddl: readonly string[];
  prepare(db: DbHandle, options?: { skipMigrations?: boolean; skipIndexes?: boolean; now?: () => string }): void;
}

export function defineSqliteSchema(spec: SqliteSchemaInput): SqliteSchemaDescription {
  validateSpec(spec);
  const validated = spec as SqliteSchemaSpec;
  const tables = Object.freeze(validated.tables.map((table) => Object.freeze({
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
  const tableDdl = validated.tables.map(compileTable);
  const indexDdl = validated.tables.flatMap((table) => (table.indexes ?? []).map((index) => compileIndex(table.name, index)));
  const ddl = [...tableDdl, ...indexDdl];
  const tableNames = validated.tables.map((table) => table.name);
  const migrations = [...(validated.migrations ?? [])];

  const schema: SqliteSchemaDescription = {
    name: validated.name,
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
  };
  return Object.freeze(schema);
}
