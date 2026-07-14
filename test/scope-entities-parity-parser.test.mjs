// A small, deliberately narrow, regex-based extractor of workbench entity
// declarations from Scope's real, already-migrated TypeScript source at
// /Users/server/Development/scope/src/lib/wb-scope/entities.ts.
//
// This is NOT a general TypeScript parser — same philosophy already
// documented on src/sqlite-storage-description.mjs: "Raw table/index SQL is
// deliberately descriptive evidence, not a second SQL parser or a general
// compatibility policy." parseEntitiesTs is good enough to catch the kind of
// drift a hand-maintained mirror file (projects/scope-entities.mjs)
// accumulates against its real source — a missing field, a field declared
// with the wrong workbench field-kind constructor, a dropped modifier — and
// nothing more. It does not evaluate expressions, does not resolve imports
// across files, and will mis-parse arbitrary TypeScript that doesn't follow
// this file's existing single-field-per-line, `key: ctor(...)` shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REAL_ENTITIES_TS = '/Users/server/Development/scope/src/lib/wb-scope/entities.ts';
const NON_FIELD_KEYS = new Set(['grant', 'routes']);
const NON_CTOR_IMPORTS = new Set(['entity', 'inherit', 'membership', 'read', 'write', 'subscribe']);

export function parseEntitiesTs(source) {
  const importLine = source.match(/^import \{([^}]+)\} from 'workbench';/m);
  if (!importLine) {
    throw new Error("entities.ts: expected a top-level `import { ... } from 'workbench';` line");
  }
  const importedNames = importLine[1].split(',').map((s) => s.trim()).filter(Boolean);
  const ctorNames = importedNames.filter((name) => !NON_CTOR_IMPORTS.has(name));
  if (ctorNames.length === 0) {
    throw new Error('entities.ts: found no field-constructor names in the workbench import line');
  }
  // `(?:<[^>]*>)?` allows a TypeScript generic type argument between the
  // constructor name and its call parens (e.g. `json<string[]>(...)`).
  const fieldStart = new RegExp(`^(\\w+):\\s*(${ctorNames.join('|')})(?:<[^>]*>)?\\(`);

  const result = {};
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

    // Split the body into one chunk per top-level (depth-0-within-body) field
    // declaration by scanning for `<identifier>:` at zero nesting depth, then
    // grab everything up to the next such boundary (or the body's end) as
    // that field's own argument text — this keeps sibling fields' option
    // objects (`{ optional: true, validate: (v) => v.length ... }`) from
    // bleeding into each other.
    const boundaries = [];
    const keyRe = /(\w+):/g;
    let km;
    while ((km = keyRe.exec(body))) {
      // Only treat this as a field boundary if we're at nesting depth 0 at
      // the position just before the key (i.e. it's a direct property of the
      // entity body, not something inside a nested object/arrow function).
      let depth = 0;
      for (let j = 0; j < km.index; j++) {
        if (body[j] === '{' || body[j] === '(' || body[j] === '[') depth++;
        else if (body[j] === '}' || body[j] === ')' || body[j] === ']') depth--;
      }
      if (depth === 0) boundaries.push({ index: km.index, name: km[1] });
    }

    for (let b = 0; b < boundaries.length; b++) {
      const { index, name } = boundaries[b];
      if (NON_FIELD_KEYS.has(name)) continue;
      const chunkEnd = b + 1 < boundaries.length ? boundaries[b + 1].index : body.length;
      const chunk = body.slice(index, chunkEnd);
      const fm = chunk.match(fieldStart);
      if (!fm) continue; // not a `key: ctor(...)` field (e.g. grant/routes already skipped, or an unrecognized shape)
      const descriptor = { ctor: fm[2] };
      if (/\boptional:\s*true\b/.test(chunk)) descriptor.optional = true;
      if (/\bnullable:\s*true\b/.test(chunk)) descriptor.nullable = true;
      if (/\bimmutable:\s*true\b/.test(chunk)) descriptor.immutable = true;
      if (/\breadonly:\s*true\b/.test(chunk)) descriptor.readonly = true;
      if (/\btouch:\s*true\b/.test(chunk)) descriptor.touch = true;
      if (/\bdefault:/.test(chunk)) descriptor.hasDefault = true;
      if (/\bvalidate:/.test(chunk)) descriptor.hasValidate = true;
      fields[name] = descriptor;
    }

    result[exportName] = { fields };
    blockRe.lastIndex = i;
  }
  return result;
}

test('parseEntitiesTs extracts field descriptors from an inline fixture', () => {
  const fixture = `import { entity, text, date, json, inherit, read, write, subscribe } from 'workbench';

export const Widget = entity('Widget', {
  projectId: text({ immutable: true }),
  label: text(),
  url: text({ optional: true }),
  colour: text({ optional: true, nullable: true, validate: (value) => value.length <= 64 }),
  createdAt: date({ readonly: true, default: () => new Date() }),
  updatedAt: date({ touch: true, default: () => new Date() }),
  tags: json(null, { optional: true, default: [] }),
  grant: inherit(Widget, { via: 'projectId' }),
  routes: (r) => r.resource(),
});
`;
  const parsed = parseEntitiesTs(fixture);
  assert.deepEqual(parsed, {
    Widget: {
      fields: {
        projectId: { ctor: 'text', immutable: true },
        label: { ctor: 'text' },
        url: { ctor: 'text', optional: true },
        colour: { ctor: 'text', optional: true, nullable: true, hasValidate: true },
        createdAt: { ctor: 'date', readonly: true, hasDefault: true },
        updatedAt: { ctor: 'date', touch: true, hasDefault: true },
        tags: { ctor: 'json', optional: true, hasDefault: true },
      },
    },
  });
});

test('parseEntitiesTs throws on a mismatched export/name pair', () => {
  const fixture = `import { entity, text } from 'workbench';

export const Foo = entity('Bar', {
  name: text(),
});
`;
  assert.throws(() => parseEntitiesTs(fixture), /mismatched entity name/);
});

test('parseEntitiesTs against the real entities.ts confirms the known Wave 6 facts', { skip: !fileReadable(REAL_ENTITIES_TS) }, () => {
  const source = readFileSync(REAL_ENTITIES_TS, 'utf8');
  const parsed = parseEntitiesTs(source);

  assert.equal(parsed.Source.fields.projectId.immutable, true);
  assert.equal(parsed.Source.fields.updatedAt.ctor, 'date');
  assert.equal(parsed.Source.fields.updatedAt.touch, true);
  assert.equal(parsed.Theme.fields.codeIds.ctor, 'json');
  assert.equal(parsed.Theme.fields.codeIds.optional, true);
  assert.equal(parsed.Codebook.fields.updatedAt.ctor, 'date');
  assert.equal(parsed.Collection.fields.updatedAt.ctor, 'date');
  assert.equal(parsed.Comment.fields.resolved.ctor, 'boolean');
  assert.equal(parsed.Comment.fields.createdAt.ctor, 'text');

  for (const name of ['Project', 'Note', 'Comment', 'File']) {
    assert.ok(parsed[name], `expected entities.ts to declare ${name}`);
  }
  assert.equal(Object.keys(parsed.Note.fields).length, 6, 'Note: projectId, title, content, sortOrder, createdAt, updatedAt');
  assert.equal(Object.keys(parsed.Comment.fields).length, 10, 'Comment: projectId, body, segmentId, parentId, userId, resolved, resolvedAt, resolvedBy, createdAt, updatedAt');
  assert.equal(Object.keys(parsed.File.fields).length, 9, 'File: projectId, name, type, mime, size, md5, sha256, createdAt, updatedAt');
});

function fileReadable(path) {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
