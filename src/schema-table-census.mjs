// Derives the canonical set of persistent framework table names from the actual
// DDL generators — one authoritative source, no hand-maintained lists.
// Every table the framework owns appears here: framework DDL tables, the
// migration table, and the main tables of the seven always-registered auth
// entities. No DB, no mutable registry, no Scope nouns, no workbench/internal.

import { generateFrameworkDDL, generateDDL } from './ddl.mjs';
import {
  User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor,
} from './auth/entities.mjs';
import { MIGRATION_DDL } from './migrations.mjs';
import {
  collectTableNamesFromDdl as collectNames,
  stripSqlComments,
} from './framework-table-names.mjs';

const AUTH_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];
const TABLE_REF_KEYWORD = /(?:\bFROM|\bJOIN|\bINTO|\bUPDATE|\bTABLE|\bUSING)\s+/iy;
const TABLE_IDENTIFIER = /("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/y;

function unquoteIdentifier(name) {
  if (name.startsWith('"')) return name.slice(1, -1).replaceAll('""', '"');
  if (name.startsWith('`')) return name.slice(1, -1).replaceAll('``', '`');
  if (name.startsWith('[')) return name.slice(1, -1).replaceAll(']]', ']');
  return name;
}

function skipSqlStringOrIdentifier(sql, start) {
  const quote = sql[start];
  if (quote !== "'" && quote !== '"' && quote !== '`' && quote !== '[') return start;
  const closing = quote === '[' ? ']' : quote;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === closing) {
      if (closing !== ']' && sql[index + 1] === closing) {
        index += 2;
        continue;
      }
      if (closing === ']' && sql[index + 1] === ']') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

export function collectTableNamesFromDdl(entries) {
  const names = collectNames(entries);

  return Object.freeze(
    names.sort((a, b) => {
      const ga = a.startsWith('_') ? 0 : 1;
      const gb = b.startsWith('_') ? 0 : 1;
      if (ga !== gb) return ga - gb;
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }),
  );
}

function collectFrameworkTableNames() {
  const entries = [];

  for (const sql of generateFrameworkDDL()) {
    entries.push({ source: 'framework DDL', sql });
  }
  entries.push({ source: 'migration DDL', sql: MIGRATION_DDL });
  for (const entity of AUTH_ENTITIES) {
    for (const sql of generateDDL(entity)) {
      entries.push({ source: `auth entity ${entity.name}`, sql });
    }
  }

  return collectTableNamesFromDdl(entries);
}

export function declaredTableNames(entities) {
  const entries = [];
  for (const entity of entities) {
    for (const sql of generateDDL(entity)) {
      entries.push({ source: `entity ${entity.name}`, sql });
    }
  }
  return collectTableNamesFromDdl(entries);
}

export const frameworkTableNames = collectFrameworkTableNames();

const FRAMEWORK_TABLE_NAME_SET = new Set(
  frameworkTableNames.map((name) => name.toLowerCase()),
);

/**
 * App-lint helper: reject SQL that references a framework-owned table by name.
 * Matches FROM/JOIN/INTO/UPDATE/TABLE/USING table refs (quoted or bare).
 * Does not execute SQL. String literals and comments are ignored.
 */
export function assertNoFrameworkTableSql(sql) {
  if (typeof sql !== 'string') {
    throw new TypeError('assertNoFrameworkTableSql: sql must be a string');
  }
  const uncommented = stripSqlComments(sql);
  for (let index = 0; index < uncommented.length;) {
    const character = uncommented[index];
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      index = skipSqlStringOrIdentifier(uncommented, index);
      continue;
    }
    TABLE_REF_KEYWORD.lastIndex = index;
    const keyword = TABLE_REF_KEYWORD.exec(uncommented);
    if (!keyword || keyword.index !== index) {
      index += 1;
      continue;
    }
    let cursor = TABLE_REF_KEYWORD.lastIndex;
    while (cursor < uncommented.length) {
      while (cursor < uncommented.length && /\s/.test(uncommented[cursor])) cursor += 1;
      if (uncommented[cursor] === '(') {
        index = cursor + 1;
        break;
      }
      TABLE_IDENTIFIER.lastIndex = cursor;
      const ident = TABLE_IDENTIFIER.exec(uncommented);
      if (!ident || ident.index !== cursor) {
        index = cursor + 1;
        break;
      }
      const name = unquoteIdentifier(ident[1]);
      if (FRAMEWORK_TABLE_NAME_SET.has(name.toLowerCase())) {
        throw new Error(`SQL must not reference framework table ${name}`);
      }
      cursor = TABLE_IDENTIFIER.lastIndex;
      while (cursor < uncommented.length && /\s/.test(uncommented[cursor])) cursor += 1;
      if (uncommented[cursor] === ',') {
        cursor += 1;
        continue;
      }
      index = cursor;
      break;
    }
  }
}
