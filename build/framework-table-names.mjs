// Lightweight package-table census for security-sensitive code that cannot
// import the auth compile graph without introducing an initialization cycle.
// This module is ALSO the reserved-framework-namespace registry: it derives the
// framework-owned object names (tables, indexes, triggers, virtual tables) so
// schema/entity/plugin declarations can be refused pre-touch when they claim a
// name the framework reserves (S2/A2, consideration #5).
import { generateFrameworkDDL } from './ddl.mjs';
import { MIGRATION_DDL } from './migrations.mjs';

const AUTH_TABLE_NAMES = ['User', 'Session', 'Inbox', 'Credential', 'Invitation', 'ApiKey', 'TwoFactor'];
const CREATE_TABLE_NAME = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/iy;

// The physical object kinds a CREATE statement can declare. 'virtual-table' is
// a virtual table (a table in sqlite_master, but declared via CREATE VIRTUAL
// TABLE); it shares SQLite's relation namespace with tables and indexes.


// A derived set of owned object names, grouped by kind.







// CREATE [UNIQUE|VIRTUAL|TEMP] INDEX|TABLE|TRIGGER [IF NOT EXISTS] <name>.
const CREATE_OBJECT_NAME = /CREATE\s+(?:(UNIQUE|VIRTUAL|TEMP)\s+)?(INDEX|TABLE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:]]|[^\]])+]|[A-Za-z_][A-Za-z0-9_]*)/iy;

function unquoteIdentifier(name        )         {
  if (name.startsWith('"')) return name.slice(1, -1).replaceAll('""', '"');
  if (name.startsWith('`')) return name.slice(1, -1).replaceAll('``', '`');
  if (name.startsWith('[')) return name.slice(1, -1).replaceAll(']]', ']');
  return name;
}

function objectKindLabel(kind                      )         {
  if (kind === 'virtualTables') return 'virtual table';
  return kind.slice(0, -1);
}

// Collect object names from DDL entries for the requested kinds, skipping SQL
// comments and quoted regions (the same scanner contract as
// collectTableNamesFromDdl, generalized to indexes/triggers/virtual tables).
// Within one call, a name repeated for the same kind is a hard error (a
// participant cannot declare one object twice).
export function collectObjectNamesFromDdl(
  entries                     ,
  kinds                                                                                       = {},
)                 {
  const want = {
    tables: kinds.tables ?? false,
    indexes: kinds.indexes ?? false,
    triggers: kinds.triggers ?? false,
    virtualTables: kinds.virtualTables ?? false,
  };
  const out                 = { tables: [], indexes: [], triggers: [], virtualTables: [] };
  const seen = new Map                ();
  const push = (kind                      , name        , source        )       => {
    const key = `${kind}\u0000${name.toLowerCase()}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(`duplicate ${objectKindLabel(kind)} declaration: ${name} (from ${prior} and ${source})`);
    }
    seen.set(key, source);
    out[kind].push(name);
  };
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
      CREATE_OBJECT_NAME.lastIndex = index;
      const match = CREATE_OBJECT_NAME.exec(uncommented);
      if (!match || (index > 0 && /[A-Za-z0-9_]/.test(uncommented[index - 1]))) {
        index += 1;
        continue;
      }
      const modifier = match[1];
      const keyword = match[2];
      const name = unquoteIdentifier(match[3]);
      if (keyword === 'TABLE') {
        if (modifier === 'VIRTUAL') {
          if (want.virtualTables) push('virtualTables', name, source);
        } else if (want.tables) {
          push('tables', name, source);
        }
      } else if (keyword === 'INDEX') {
        if (want.indexes) push('indexes', name, source);
      } else if (want.triggers) {
        push('triggers', name, source);
      }
      index = CREATE_OBJECT_NAME.lastIndex;
    }
  }
  return out;
}

export function stripSqlComments(sql        )         {
  let result = '';
  let quote                = null;
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






export function collectTableNamesFromDdl(entries            )           {
  const seen = new Map                ();
  const names           = [];
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
      ...generateFrameworkDDL().map((sql        ) => ({ source: 'framework DDL', sql })),
      { source: 'migration DDL', sql: MIGRATION_DDL },
    ]),
    ...AUTH_TABLE_NAMES,
  ]),
])                     ;

// The reserved-framework-namespace registry (S2/A2, consideration #5): every
// object name the package may physically create — framework DDL tables and
// indexes, the migration table, and the auth entity main tables. Folded
// lower-case, like all SQLite identifier comparisons. The FULL registry
// (including the auth entities' generated indexes/triggers, which require the
// auth compile graph) is derived in schema-table-census.ts.
export const frameworkReservedNamesWithoutAuthCompile                      = Object.freeze(
  (() => {
    const all = collectObjectNamesFromDdl(
      [
        ...generateFrameworkDDL().map((sql        ) => ({ source: 'framework DDL', sql })),
        { source: 'migration DDL', sql: MIGRATION_DDL },
      ],
      { tables: true, indexes: true, triggers: true, virtualTables: true },
    );
    return new Set([
      ...all.tables,
      ...all.indexes,
      ...all.triggers,
      ...all.virtualTables,
      ...AUTH_TABLE_NAMES,
    ].map((name) => name.toLowerCase()));
  })(),
);
