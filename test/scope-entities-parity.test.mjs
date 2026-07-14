// Wave 6 — workbench-only golden-parity proof for projects/scope-entities.mjs.
//
// scope-entities.mjs is a workbench-native mirror of Scope's REAL, already
// migrated entity declarations at
// /Users/server/Development/scope/src/lib/wb-scope/entities.ts (a separate
// repo, imported there from the published 'workbench' package). That file —
// not scope.db, not schema.prisma — is the golden source for this proof:
// entities.ts is deployed, workbench-native TypeScript today, so mirroring it
// field-for-field is the meaningful parity target. (schema.prisma predates
// the migration and is a deliberately different, wider shape in several
// places — e.g. its ExternalRef has no projectId column at all, and its
// Artefact/MediaFile carry review/original-hash fields entities.ts dropped
// on purpose — so a raw Prisma-column diff would misreport dozens of
// intentional redesign decisions as "gaps.")
//
// This module never imports, executes, or writes to anything under
// /Users/server/Development/scope — it only reads entities.ts as TEXT
// (read-only) and extracts a narrow field-name -> constructor-name map via a
// balanced-brace regex scan. Same philosophy already documented on
// src/sqlite-storage-description.mjs: this is deliberately descriptive
// evidence, not a general TypeScript parser or a general compatibility
// policy — it is good enough to catch exactly the kind of drift a
// hand-maintained mirror file accumulates (a missing field, a field using
// the wrong workbench field-kind constructor), nothing more.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as scopeEntities from '../projects/scope-entities.mjs';

const REAL_ENTITIES_TS = '/Users/server/Development/scope/src/lib/wb-scope/entities.ts';

// Helper keys in an `entity('Name', { ... })` body that are never field
// constructors (they take entity/verb values or arrow functions, not a
// workbench field descriptor).
const NON_FIELD_KEYS = new Set(['grant', 'routes']);

function parseEntityFieldCtors(source) {
  const importLine = source.match(/^import \{([^}]+)\} from 'workbench';/m);
  if (!importLine) {
    throw new Error("entities.ts: expected a top-level `import { ... } from 'workbench';` line");
  }
  const importedNames = importLine[1].split(',').map((s) => s.trim()).filter(Boolean);
  // Only the field-constructor names among the import — not entity/inherit/
  // membership/grant verbs, which are called with different shapes and are
  // excluded explicitly rather than guessed.
  const NON_CTOR_IMPORTS = new Set(['entity', 'inherit', 'membership', 'read', 'write', 'subscribe']);
  const ctorNames = importedNames.filter((name) => !NON_CTOR_IMPORTS.has(name));
  if (ctorNames.length === 0) {
    throw new Error('entities.ts: found no field-constructor names in the workbench import line');
  }
  // `(?:<[^>]*>)?` allows for a TypeScript generic type argument between the
  // constructor name and its call parens (entities.ts has `json<string[]>(...)`)
  // — entities.ts is TypeScript, this extractor reads it as text, so its
  // syntax (not just workbench's runtime call shape) has to be accounted for.
  const fieldCtorPattern = new RegExp(`^\\s*(\\w+):\\s*(${ctorNames.join('|')})(?:<[^>]*>)?\\(`);

  const entities = {};
  const blockRe = /export const (\w+) = entity\('([^']+)',\s*\{/g;
  let m;
  while ((m = blockRe.exec(source))) {
    const [, exportName, literalName] = m;
    if (exportName !== literalName) {
      throw new Error(`entities.ts: export ${exportName} declares a mismatched entity name '${literalName}'`);
    }
    const bodyStart = blockRe.lastIndex - 1; // index of the opening '{'
    let depth = 1;
    let i = bodyStart + 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) {
      throw new Error(`entities.ts: unbalanced braces scanning the '${exportName}' entity body`);
    }
    const body = source.slice(bodyStart + 1, i - 1);
    const fields = {};
    for (const line of body.split('\n')) {
      const fm = line.match(fieldCtorPattern);
      if (!fm) continue;
      const [, fieldName, ctor] = fm;
      if (NON_FIELD_KEYS.has(fieldName)) continue;
      fields[fieldName] = ctor;
    }
    entities[exportName] = fields;
    blockRe.lastIndex = i;
  }
  return entities;
}

test('parseEntityFieldCtors extracts field name -> constructor from an inline fixture', () => {
  const fixture = `import { entity, text, date, json, inherit, read, write, subscribe } from 'workbench';

export const Widget = entity('Widget', {
  projectId: text({ immutable: true }),
  tags: json(null, { optional: true, default: [] }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  grant: inherit(Widget, { via: 'projectId' }),
  routes: (r) => r.resource(),
});
`;
  const parsed = parseEntityFieldCtors(fixture);
  assert.deepEqual(parsed, {
    Widget: { projectId: 'text', tags: 'json', createdAt: 'date' },
  });
});

test('parseEntityFieldCtors throws on a mismatched export/name pair', () => {
  const fixture = `import { entity, text } from 'workbench';

export const Foo = entity('Bar', {
  name: text(),
});
`;
  assert.throws(() => parseEntityFieldCtors(fixture), /mismatched entity name/);
});

test('scope-entities.mjs mirrors Scope\'s real entities.ts field-for-field', { skip: !fileReadable(REAL_ENTITIES_TS) }, () => {
  const source = readFileSync(REAL_ENTITIES_TS, 'utf8');
  const golden = parseEntityFieldCtors(source);

  const goldenNames = Object.keys(golden).sort();
  const mirrorNames = Object.keys(scopeEntities)
    .filter((name) => name !== 'initScope' && scopeEntities[name]?.fields)
    .sort();
  assert.deepEqual(
    mirrorNames,
    goldenNames,
    'scope-entities.mjs must declare exactly the same set of entities as the real entities.ts',
  );

  const mismatches = [];
  for (const entityName of goldenNames) {
    const goldenFields = golden[entityName];
    const mirrorEntity = scopeEntities[entityName];
    for (const [fieldName, ctor] of Object.entries(goldenFields)) {
      const mirrorField = mirrorEntity.fields[fieldName];
      if (!mirrorField) {
        mismatches.push(`${entityName}.${fieldName}: missing in scope-entities.mjs (entities.ts declares it as ${ctor}())`);
        continue;
      }
      if (mirrorField.type !== ctor) {
        mismatches.push(`${entityName}.${fieldName}: scope-entities.mjs uses ${mirrorField.type}(), entities.ts uses ${ctor}()`);
      }
    }
    const mirrorFieldNames = Object.keys(mirrorEntity.fields);
    for (const fieldName of mirrorFieldNames) {
      if (!(fieldName in goldenFields)) {
        mismatches.push(`${entityName}.${fieldName}: present in scope-entities.mjs but not declared in entities.ts`);
      }
    }
  }

  assert.deepEqual(mismatches, [], `scope-entities.mjs drifted from entities.ts:\n${mismatches.join('\n')}`);
});

function fileReadable(path) {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
