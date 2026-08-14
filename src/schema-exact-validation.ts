// schema-exact-validation.ts — S2/A3 exact schema validator: post-migration
// drift detection against the live SQLite schema (epic scope#23, S2
// considerations #6/#7/#9).
//
// Where the A1/A2 phases verify that declarations are well-formed and that
// every database object has exactly one declared owner, THIS phase compares
// every declared object against the live schema via PRAGMAs: columns (name,
// declared type/affinity, nullability, defaults including the parenthesised
// expression form), primary-key order, foreign keys (referenced table,
// columns, referenced columns, ON UPDATE / ON DELETE actions), indexes
// (unique, partial, collation, columns, expression terms), declared triggers,
// and virtual tables plus their shadow tables. Each drift is reported with a
// DISTINCT code and names the owning schema/plugin and the object — never row
// or table contents.
//
// The module is read-only over the database handle and is intended to run as a
// post-migration lifecycle phase (A5 wires it), so it always validates the
// settled schema rather than a half-migrated one.
//
// Ownership attribution comes from the S2/A2 global census (schema-census.ts).
// An object observed in the live schema that no participant owns is undeclared
// drift; an object owned by a participant OTHER than the one whose declaration
// is being validated is a conflicting-ownership drift (consideration #8/#9).

import { censusKey, type CensusEntry } from './schema-census.ts';
import type { SqliteSchemaDescription } from './sqlite-schema.ts';

export interface ExactSchemaError {
  readonly code: string;
  readonly message: string;
  readonly ownerKind: 'schema' | 'plugin';
  readonly owner: string;
  readonly objectKind: 'table' | 'column' | 'index' | 'trigger' | 'virtual-table' | 'shadow-table';
  readonly name: string;
}

export interface ExactSchemaStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface ExactSchemaDb {
  prepare(sql: string): ExactSchemaStatement;
}

type Push = (
  code: string,
  ownerKind: ExactSchemaError['ownerKind'],
  owner: string,
  objectKind: ExactSchemaError['objectKind'],
  name: string,
  detail: string,
) => void;

function folded(name: string): string {
  return name.toLowerCase();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// SQLite storage-affinity rules (the declared-type grammar of CREATE TABLE).
// `text`/`varchar`/`CLOB` all store as TEXT affinity, `int`/`INTEGER` as
// INTEGER, and so on — the exact validator compares affinities, not spellings.
function affinityOf(type: string | undefined): string {
  const t = (type ?? '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t.includes('BLOB') || t === '') return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

// SQLite strips balanced outer parentheses from DEFAULT expressions when it
// stores dflt_value (DEFAULT (strftime(...)) is stored as strftime(...)).
// Strip them on both sides so the parenthesised declaration matches.
function stripOuterParens(text: string): string {
  let value = text;
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0;
    let closesAtEnd = false;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          closesAtEnd = i === value.length - 1;
          break;
        }
      }
    }
    if (!closesAtEnd) break;
    value = value.slice(1, -1);
  }
  return value;
}

// Collapse whitespace, uppercase all characters outside single-quoted string
// literals, and strip double-quoted identifier quoting — so SQLite's stored
// form and the declaration's form compare equal regardless of case, spacing,
// or quoting. String-literal contents (e.g. strftime format strings) are
// preserved verbatim.
function normaliseSql(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  let out = '';
  let inString = false;
  let inIdentifier = false;
  for (let i = 0; i < collapsed.length; i += 1) {
    const ch = collapsed[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (collapsed[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (inIdentifier) {
      if (ch === '"') {
        inIdentifier = false;
        continue;
      }
      out += ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inIdentifier = true;
      continue;
    }
    out += ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch;
  }
  return out;
}

function normaliseDefault(value: string | number | Uint8Array | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  return normaliseSql(stripOuterParens(text.trim()));
}

// The default a declaration compiles into CREATE TABLE, in stored form.
function declaredDefault(column: { default?: number | string; defaultExpression?: string }): string | null {
  if (column.defaultExpression !== undefined) return column.defaultExpression;
  if (column.default === undefined) return null;
  return typeof column.default === 'number' ? String(column.default) : `'${column.default.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Live-schema readers (PRAGMAs only — never table contents)
// ---------------------------------------------------------------------------

interface LiveIndexTerm {
  name: string | null;
  descending: number;
  collation: string;
}

interface LiveIndex {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  sqlTerms: string[];
  terms: LiveIndexTerm[];
}

interface LiveForeignKey {
  table: string;
  columns: string[];
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

function indexSqlTerms(db: ExactSchemaDb, indexName: string, xinfoTerms: Array<{ name: string | null }>): string[] {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND lower(name) = lower(?)").get(indexName);
  const sql = row === undefined ? '' : String(row.sql ?? '');
  if (sql === '') {
    // Auto-indexes (origin 'u'/'pk' from UNIQUE/PK constraints) have no stored
    // SQL — derive their terms from PRAGMA index_xinfo column names instead.
    return xinfoTerms.map((term) => (term.name === null ? '' : normaliseSql(quoteIdent(term.name))));
  }
  const open = sql.indexOf('(');
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];
  const inner = sql.slice(open + 1, close);
  const terms: string[] = [];
  let termDepth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      if (ch === "'") {
        if (inner[i + 1] === "'") i += 1;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') termDepth += 1;
    else if (ch === ')') termDepth -= 1;
    else if (ch === ',' && termDepth === 0) {
      terms.push(normaliseSql(inner.slice(start, i)));
      start = i + 1;
    }
  }
  terms.push(normaliseSql(inner.slice(start)));
  return terms;
}

function readLiveIndexes(db: ExactSchemaDb, tableName: string): LiveIndex[] {
  return db.prepare(`PRAGMA index_list(${quoteIdent(tableName)})`).all().map((row) => {
    const name = String(row.name);
    const terms = db.prepare(`PRAGMA index_xinfo(${quoteIdent(name)})`).all()
      .filter((term) => (term.key as number) === 1)
      .sort((a, b) => (a.seqno as number) - (b.seqno as number))
      .map((term) => ({
        name: term.name === null ? null : String(term.name),
        descending: term.desc as number,
        collation: String(term.coll),
      }));
    return {
      name,
      unique: row.unique === 1,
      origin: String(row.origin),
      partial: row.partial === 1,
      sqlTerms: indexSqlTerms(db, name, terms),
      terms,
    };
  });
}

function readLiveForeignKeys(db: ExactSchemaDb, tableName: string): LiveForeignKey[] {
  const groups = new Map<number, LiveForeignKey>();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`).all()) {
    const id = row.id as number;
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        table: String(row.table),
        columns: [],
        referencedColumns: [],
        onUpdate: String(row.on_update).toUpperCase(),
        onDelete: String(row.on_delete).toUpperCase(),
      };
      groups.set(id, group);
    }
    group.columns[row.seq as number] = String(row.from);
    group.referencedColumns[row.seq as number] = String(row.to);
  }
  return [...groups.values()];
}

function foreignKeyKey(foreignKey: { table: string; columns: readonly string[]; referencedColumns: readonly string[] }): string {
  return JSON.stringify([
    folded(foreignKey.table),
    foreignKey.columns.map(folded),
    foreignKey.referencedColumns.map(folded),
  ]);
}

// ---------------------------------------------------------------------------
// Ordinary tables
// ---------------------------------------------------------------------------

function declaredIndexTerms(index: { columns?: readonly string[]; expression?: readonly string[] }): string[] {
  return [
    ...(index.columns ?? []).map((column) => normaliseSql(quoteIdent(column))),
    ...(index.expression ?? []).map((term) => normaliseSql(term)),
  ];
}

function validateColumns(db: ExactSchemaDb, owner: string, table: SqliteSchemaDescription['tables'][number], push: Push): void {
  const live = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table.name)})`).all();
  const declared = new Map(table.columns.map((column) => [folded(column.name), column]));
  for (const column of live) {
    const name = String(column.name);
    const expected = declared.get(folded(name));
    if (expected === undefined) {
      push('extra-column', 'schema', owner, 'column', name, `of table "${table.name}" is extra (not declared)`);
      continue;
    }
    if ((column.hidden as number) !== 0) {
      push('extra-column', 'schema', owner, 'column', name, `of table "${table.name}" is hidden or generated (not declared)`);
      continue;
    }
    const liveType = column.type === null ? '' : String(column.type);
    if (affinityOf(liveType) !== affinityOf(expected.type)) {
      push('changed-type', 'schema', owner, 'column', name, `of table "${table.name}" has type "${liveType}" but is declared "${expected.type ?? '(none)'}"`);
    }
    if ((column.notnull === 1) !== Boolean(expected.notNull)) {
      push('changed-nullability', 'schema', owner, 'column', name, `of table "${table.name}" has nullability differing from its declaration`);
    }
    if (normaliseDefault(column.dflt_value as string | number | Uint8Array | null | undefined) !== normaliseDefault(declaredDefault(expected))) {
      push('changed-default', 'schema', owner, 'column', name, `of table "${table.name}" has a default differing from its declaration`);
    }
  }
  for (const column of table.columns) {
    if (!live.some((row) => folded(String(row.name)) === folded(column.name))) {
      push('missing-column', 'schema', owner, 'column', column.name, `of table "${table.name}" is declared but absent from the live schema`);
    }
  }
}

function validatePrimaryKey(db: ExactSchemaDb, owner: string, table: SqliteSchemaDescription['tables'][number], push: Push): void {
  const live = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table.name)})`).all()
    .filter((column) => (column.pk as number) > 0)
    .sort((a, b) => (a.pk as number) - (b.pk as number))
    .map((column) => String(column.name));
  const declared = (table.primaryKey ?? table.columns.filter((column) => column.primaryKey).map((column) => column.name)).map((name) => String(name));
  if (JSON.stringify(live.map(folded)) !== JSON.stringify(declared.map(folded))) {
    push('pk-mismatch', 'schema', owner, 'table', table.name,
      `has primary key [${live.join(', ')}] but is declared [${declared.join(', ')}]`);
  }
}

function validateForeignKeys(db: ExactSchemaDb, owner: string, table: SqliteSchemaDescription['tables'][number], push: Push): void {
  const live = readLiveForeignKeys(db, table.name);
  const matched = new Set<number>();
  for (const foreignKey of table.foreignKeys ?? []) {
    const declaredShape = {
      table: foreignKey.references.table,
      columns: [...foreignKey.columns],
      referencedColumns: [...foreignKey.references.columns],
    };
    const liveIndex = live.findIndex((candidate) => foreignKeyKey(candidate) === foreignKeyKey(declaredShape));
    if (liveIndex < 0) {
      push('fk-mismatch', 'schema', owner, 'table', table.name,
        `declares a foreign key on (${foreignKey.columns.join(', ')}) referencing "${foreignKey.references.table}" (${foreignKey.references.columns.join(', ')}) that is not present in the live schema`);
      continue;
    }
    matched.add(liveIndex);
    const onUpdate = (foreignKey.onUpdate ?? 'no action').toUpperCase();
    const onDelete = (foreignKey.onDelete ?? 'no action').toUpperCase();
    const liveFk = live[liveIndex];
    if (liveFk.onUpdate !== onUpdate || liveFk.onDelete !== onDelete) {
      push('wrong-fk-action', 'schema', owner, 'table', table.name,
        `foreign key on (${foreignKey.columns.join(', ')}) referencing "${foreignKey.references.table}" has live actions ON UPDATE ${liveFk.onUpdate} / ON DELETE ${liveFk.onDelete}, declared ON UPDATE ${onUpdate} / ON DELETE ${onDelete}`);
    }
  }
  live.forEach((foreignKey, index) => {
    if (!matched.has(index)) {
      push('extra-fk', 'schema', owner, 'table', table.name,
        `has a foreign key on (${foreignKey.columns.join(', ')}) referencing "${foreignKey.table}" (${foreignKey.referencedColumns.join(', ')}) that is not declared`);
    }
  });
}

function validateIndexes(db: ExactSchemaDb, owner: string, table: SqliteSchemaDescription['tables'][number], push: Push): void {
  const live = readLiveIndexes(db, table.name).filter((index) => index.origin !== 'pk');
  const matched = new Set<string>();
  for (const index of table.indexes ?? []) {
    const liveIndex = live.find((candidate) => folded(candidate.name) === folded(index.name));
    if (liveIndex === undefined) {
      push('missing-index', 'schema', owner, 'table', table.name, `is missing declared index "${index.name}"`);
      continue;
    }
    matched.add(liveIndex.name);
    const expectedTerms = declaredIndexTerms(index);
    const termsMatch = expectedTerms.length === liveIndex.sqlTerms.length
      && expectedTerms.every((term, position) => term === liveIndex.sqlTerms[position]);
    if (liveIndex.origin !== 'c' || liveIndex.unique !== Boolean(index.unique)
      || liveIndex.partial !== (index.where !== undefined) || !termsMatch) {
      push('index-mismatch', 'schema', owner, 'table', table.name, `index "${index.name}" does not match its declaration`);
    }
  }
  for (const constraint of table.unique ?? []) {
    const expectedTerms = constraint.columns.map((name) => normaliseSql(quoteIdent(name)));
    const liveIndex = live.findIndex((candidate) => candidate.origin === 'u'
      && expectedTerms.length === candidate.sqlTerms.length
      && expectedTerms.every((term, position) => term === candidate.sqlTerms[position]));
    if (liveIndex < 0) {
      push('missing-index', 'schema', owner, 'table', table.name,
        `is missing the auto-index for declared UNIQUE (${constraint.columns.join(', ')})`);
      continue;
    }
    matched.add(live[liveIndex].name);
  }
  for (const index of live) {
    if (!matched.has(index.name)) {
      push('extra-index', 'schema', owner, 'table', table.name, `has extra index "${index.name}"`);
    }
  }
}

// Trigger policy (S2 consideration #9): an observed trigger on the table is
// declared drift only if it is owned by NO participant; a trigger owned by a
// participant other than the validating schema (or a plugin) is a
// conflicting-ownership drift. A trigger declared by this table's declaration
// and owned by this schema (or a plugin) is permitted.
function validateTriggers(db: ExactSchemaDb, census: ReadonlyMap<string, CensusEntry>, owner: string, table: SqliteSchemaDescription['tables'][number], push: Push): void {
  const declared = new Set((table.triggers ?? []).map((trigger) => folded(trigger.name)));
  for (const trigger of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND lower(tbl_name) = lower(?)").all(table.name)) {
    const name = String(trigger.name);
    const censusEntry = census.get(censusKey('trigger', name));
    const ownedByDeclarant = censusEntry !== undefined
      && (censusEntry.kind === 'plugin' || (censusEntry.kind === 'schema' && folded(censusEntry.owner) === folded(owner)));
    if (!declared.has(folded(name))) {
      if (censusEntry !== undefined && !ownedByDeclarant) {
        push('conflicting-ownership', 'schema', owner, 'trigger', name,
          `of table "${table.name}" is owned by ${censusEntry.kind} "${censusEntry.owner}", not schema "${owner}" or a plugin`);
      } else {
        push('extra-trigger', 'schema', owner, 'trigger', name, `of table "${table.name}" is undeclared`);
      }
      continue;
    }
    if (censusEntry !== undefined && !ownedByDeclarant) {
      push('conflicting-ownership', 'schema', owner, 'trigger', name,
        `of table "${table.name}" is declared by this schema but owned by ${censusEntry.kind} "${censusEntry.owner}"`);
    }
  }
}

function validateTable(db: ExactSchemaDb, census: ReadonlyMap<string, CensusEntry>, owner: string, table: SqliteSchemaDescription['tables'][number], push: Push): void {
  const censusEntry = census.get(censusKey('table', table.name));
  if (censusEntry !== undefined && !(censusEntry.kind === 'schema' && folded(censusEntry.owner) === folded(owner))) {
    push('conflicting-ownership', 'schema', owner, 'table', table.name,
      `is owned by ${censusEntry.kind} "${censusEntry.owner}", not schema "${owner}"`);
    return;
  }
  const live = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)").get(table.name);
  if (live === undefined) {
    push('missing-table', 'schema', owner, 'table', table.name, 'is declared but absent from the live schema');
    return;
  }
  if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live.sql ?? ''))) {
    push('table-kind', 'schema', owner, 'table', table.name, 'is a virtual table but is declared as an ordinary table');
    return;
  }
  validateColumns(db, owner, table, push);
  validatePrimaryKey(db, owner, table, push);
  validateForeignKeys(db, owner, table, push);
  validateIndexes(db, owner, table, push);
  validateTriggers(db, census, owner, table, push);
}

// ---------------------------------------------------------------------------
// Virtual tables + shadow tables
// ---------------------------------------------------------------------------

function validateVirtualTable(db: ExactSchemaDb, census: ReadonlyMap<string, CensusEntry>, schemaName: string, virtualTable: SqliteSchemaDescription['virtualTables'][number], push: Push): void {
  const pluginId = virtualTable.ownerPluginId;
  const censusEntry = census.get(censusKey('virtual-table', virtualTable.name));
  if (censusEntry !== undefined && !(censusEntry.kind === 'plugin' && folded(censusEntry.owner) === folded(pluginId))) {
    push('conflicting-ownership', 'schema', schemaName, 'virtual-table', virtualTable.name,
      `is owned by ${censusEntry.kind} "${censusEntry.owner}", not plugin "${pluginId}"`);
    return;
  }
  const live = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)").get(virtualTable.name);
  if (live === undefined) {
    push('missing-table', 'plugin', pluginId, 'virtual-table', virtualTable.name, 'is declared but absent from the live schema');
    return;
  }
  if (!/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(live.sql ?? ''))) {
    push('table-kind', 'plugin', pluginId, 'virtual-table', virtualTable.name, 'exists as an ordinary table but is declared as a virtual table');
    return;
  }
  for (const shadow of virtualTable.shadowTables) {
    const shadowLive = db.prepare("SELECT type FROM sqlite_schema WHERE type = 'table' AND lower(name) = lower(?)").get(shadow);
    if (shadowLive === undefined) {
      push('missing-table', 'plugin', pluginId, 'shadow-table', shadow,
        `of virtual table "${virtualTable.name}" is declared but absent from the live schema`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Validate every object declared by the given schema declarations against the
// live SQLite schema. Returns all drift diagnostics (each with a distinct
// code); never throws and never reads table contents. The census supplies
// ownership attribution so undeclared and conflicting-ownership objects are
// told apart.
export function validateExactSchema(
  db: ExactSchemaDb,
  census: ReadonlyMap<string, CensusEntry>,
  schemas: readonly SqliteSchemaDescription[],
): readonly ExactSchemaError[] {
  const errors: ExactSchemaError[] = [];
  const push: Push = (code, ownerKind, owner, objectKind, name, detail) => {
    errors.push({
      code,
      message: `${ownerKind} "${owner}" ${objectKind} "${name}" ${detail}`,
      ownerKind,
      owner,
      objectKind,
      name,
    });
  };
  for (const schema of schemas) {
    for (const table of schema.tables) validateTable(db, census, schema.name, table, push);
    for (const virtualTable of schema.virtualTables) validateVirtualTable(db, census, schema.name, virtualTable, push);
  }
  return errors;
}
