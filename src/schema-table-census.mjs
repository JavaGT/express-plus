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

const RE_CREATE_TABLE = /^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(.+)/im;

function unquoteIdentifier(name) {
  if (name.startsWith('"') && name.endsWith('"')) return name.slice(1, -1);
  if (name.startsWith('`') && name.endsWith('`')) return name.slice(1, -1);
  if (name.startsWith('[') && name.endsWith(']')) return name.slice(1, -1);
  return name;
}

function firstToken(s) {
  const m = s.match(/^\s*(\S+)/);
  return m ? m[1] : '';
}

export function collectTableNamesFromDdl(entries) {
  const seen = new Map();
  const names = [];

  for (const { source, sql } of entries) {
    const match = sql.match(RE_CREATE_TABLE);
    if (!match) continue;

    const raw = firstToken(match[1]);
    const name = unquoteIdentifier(raw);

    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(
        `duplicate framework table declaration: ${name} (from ${seen.get(lower)} and ${source})`,
      );
    }
    seen.set(lower, source);
    names.push(name);
  }

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

export const frameworkTableNames = collectFrameworkTableNames();
