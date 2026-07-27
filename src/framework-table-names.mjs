// Lightweight package-table census for security-sensitive code that cannot
// import the auth compile graph without introducing an initialization cycle.
import { generateFrameworkDDL } from './ddl.mjs';
import { MIGRATION_DDL } from './migrations.mjs';

const AUTH_TABLE_NAMES = ['User', 'Session', 'Inbox', 'Credential', 'Invitation', 'ApiKey', 'TwoFactor'];
const CREATE_TABLE_NAME = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/gi;

function unquoteIdentifier(name) {
  if (name.startsWith('"')) return name.slice(1, -1).replaceAll('""', '"');
  if (name.startsWith('`')) return name.slice(1, -1).replaceAll('``', '`');
  if (name.startsWith('[')) return name.slice(1, -1).replaceAll(']]', ']');
  return name;
}

export function collectTableNamesFromDdl(entries) {
  const seen = new Map();
  const names = [];
  for (const { source, sql } of entries) {
    const uncommented = sql.replace(/^\s*--.*$/gm, '');
    for (const match of uncommented.matchAll(CREATE_TABLE_NAME)) {
      const name = unquoteIdentifier(match[1]);
      const lower = name.toLowerCase();
      if (seen.has(lower)) {
        throw new Error(`duplicate framework table declaration: ${name} (from ${seen.get(lower)} and ${source})`);
      }
      seen.set(lower, source);
      names.push(name);
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
