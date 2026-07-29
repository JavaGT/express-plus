// Lightweight package-table census for security-sensitive code that cannot
// import the auth compile graph without introducing an initialization cycle.
import { generateFrameworkDDL } from './ddl.mjs';
import { MIGRATION_DDL } from './migrations.mjs';

const AUTH_TABLE_NAMES = ['User', 'Session', 'Inbox', 'Credential', 'Invitation', 'ApiKey', 'TwoFactor'];
const CREATE_TABLE_NAME = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/iy;

function unquoteIdentifier(name) {
  if (name.startsWith('"')) return name.slice(1, -1).replaceAll('""', '"');
  if (name.startsWith('`')) return name.slice(1, -1).replaceAll('``', '`');
  if (name.startsWith('[')) return name.slice(1, -1).replaceAll(']]', ']');
  return name;
}

export function stripSqlComments(sql) {
  let result = '';
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote === '[') {
      if (character === ']' && sql[index + 1] === ']') {
        result += ']]'; index += 1;
      } else {
        result += character;
        if (character === ']') quote = null;
      }
    } else if (quote) {
      if (character === quote && sql[index + 1] === quote) {
        result += quote + quote; index += 1;
      } else {
        result += character;
        if (character === quote) quote = null;
      }
    } else if (character === '-' && sql[index + 1] === '-') {
      while (index + 1 < sql.length && sql[index + 1] !== '\n') index += 1;
    } else if (character === '/' && sql[index + 1] === '*') {
      result += ' ';
      index += 1;
      while (index + 1 < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        if (sql[index] === '\n') result += '\n';
        index += 1;
      }
      if (index + 1 < sql.length) index += 1;
    } else {
      result += character;
      if (character === "'" || character === '"' || character === '`' || character === '[') quote = character;
    }
  }
  return result;
}

export function collectTableNamesFromDdl(entries) {
  const seen = new Map();
  const names = [];
  for (const { source, sql } of entries) {
    const uncommented = stripSqlComments(sql);
    for (let index = 0; index < uncommented.length;) {
      const quote = uncommented[index];
      if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
        const closing = quote === '[' ? ']' : quote;
        index += 1;
        while (index < uncommented.length) {
          if (uncommented[index] === closing) {
            if (uncommented[index + 1] === closing) index += 2;
            else { index += 1; break; }
          } else index += 1;
        }
        continue;
      }
      CREATE_TABLE_NAME.lastIndex = index;
      const match = CREATE_TABLE_NAME.exec(uncommented);
      if (!match || (index > 0 && /[A-Za-z0-9_]/.test(uncommented[index - 1]))) {
        index += 1;
        continue;
      }
      const name = unquoteIdentifier(match[1]);
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        throw new Error(`duplicate framework table declaration: ${name} (from ${seen.get(lower)} and ${source})`);
      }
      seen.set(lower, source);
      names.push(name);
      index = CREATE_TABLE_NAME.lastIndex;
    }
  }
  return names;
}

export const frameworkTableNamesWithoutAuthCompile = Object.freeze([
  ...new Set([
    ...collectTableNamesFromDdl([
      ...generateFrameworkDDL().map((sql) => ({ source: 'framework DDL', sql })),
      { source: 'migration DDL', sql: MIGRATION_DDL },
    ]),
    ...AUTH_TABLE_NAMES,
  ]),
]);
