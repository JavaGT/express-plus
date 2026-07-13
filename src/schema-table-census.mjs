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

const AUTH_ENTITIES = [User, Session, Inbox, Credential, Invitation, ApiKey, TwoFactor];

const RE_TABLE_NAME = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s*\(/m;

function extractTableName(sql) {
  const match = sql.match(RE_TABLE_NAME);
  if (!match) {
    throw new Error(
      `malformed framework CREATE TABLE — cannot extract table name: ` +
      `${JSON.stringify(sql.length > 80 ? sql.slice(0, 80) + '…' : sql)}`,
    );
  }
  return match[1];
}

function collectFrameworkTableNames() {
  const names = new Set();

  function claim(sql, source) {
    const name = extractTableName(sql);
    if (names.has(name)) {
      throw new Error(`duplicate framework table declaration: ${name} (${source})`);
    }
    names.add(name);
  }

  for (const sql of generateFrameworkDDL()) {
    if (sql.startsWith('CREATE TABLE')) {
      claim(sql, 'framework DDL');
    }
  }

  if (MIGRATION_DDL.startsWith('CREATE TABLE')) {
    claim(MIGRATION_DDL, 'migration DDL');
  }

  for (const entity of AUTH_ENTITIES) {
    for (const sql of generateDDL(entity)) {
      if (sql.startsWith('CREATE TABLE')) {
        claim(sql, `auth entity ${entity.name}`);
      }
    }
  }

  return Object.freeze(
    [...names].sort((a, b) => {
      const ga = a.startsWith('_') ? 0 : 1;
      const gb = b.startsWith('_') ? 0 : 1;
      if (ga !== gb) return ga - gb;
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }),
  );
}

export const frameworkTableNames = collectFrameworkTableNames();
