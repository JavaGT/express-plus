// Structural check: app-facing docs exist and cover public package surface.
// Does not re-implement the library — asserts committed documentation artifacts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

test('quickstart and functionality docs exist and are linked from README', () => {
  assert.ok(existsSync(join(root, 'docs/quickstart.md')));
  assert.ok(existsSync(join(root, 'docs/functionality.md')));
  assert.ok(existsSync(join(root, 'examples/minimal-note.mjs')));
  const readme = read('README.md');
  assert.match(readme, /docs\/quickstart\.md/);
  assert.match(readme, /docs\/functionality\.md/);
  assert.match(readme, /examples\/minimal-note\.mjs/);
});

test('functionality.md documents major public export groups from build/index.mjs', () => {
  const index = read('build/index.mjs');
  const func = read('docs/functionality.md');
  const mustAppear = [
    'entity', 'text', 'grant', 'scope', 'router', 'schedule', 'tick',
    'membership', 'emailSeam', 'User', 'Session', 'LiveChannel', 'createLiveStore',
    'workbench/client', 'workbench/server',
  ];
  for (const name of mustAppear) {
    assert.ok(func.includes(name), `functionality.md should mention ${name}`);
  }
  // Public entry still exports entity
  assert.match(index, /export \{ entity/);
  assert.match(index, /export \{ text,/);
});

test('quickstart names a runnable path and verification steps', () => {
  const qs = read('docs/quickstart.md');
  assert.match(qs, /examples\/minimal-note\.mjs/);
  assert.match(qs, /projects\/chat\/server\.mjs/);
  assert.match(qs, /curl|localhost|127\.0\.0\.1/);
  assert.match(qs, /Node\.js|Node /);
});

test('minimal-note example imports workbench and mounts an entity', () => {
  const src = read('examples/minimal-note.mjs');
  assert.match(src, /from 'workbench'/);
  assert.match(src, /entity\(/);
  assert.match(src, /\.mount\(/);
  assert.match(src, /\.listen\(/);
});
