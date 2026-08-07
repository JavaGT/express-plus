import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function expectedRuntime(source) {
  return stripTypeScriptTypes(source, { filename: 'module.ts' })
    .replaceAll(/from\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'from $1$2.mjs$1')
    .replaceAll(/import\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'import $1$2.mjs$1')
    .replaceAll(/import\s*\(\s*(['"])(\.\.?\/[^'"]+)\.ts\1\s*\)/g, 'import($1$2.mjs$1)');
}

test('emitted .mjs siblings match typed sources', () => {
  const sources = walk(srcRoot);
  assert.ok(sources.length > 0, 'expected at least one src/**/*.ts module');
  for (const tsPath of sources) {
    const mjsPath = tsPath.replace(/\.ts$/, '.mjs');
    const actual = readFileSync(mjsPath, 'utf8');
    const expected = expectedRuntime(readFileSync(tsPath, 'utf8'));
    assert.equal(actual, expected, `${mjsPath} is stale; run pnpm emit:ts`);
  }
});

test('emit:ts script rewrites without error', () => {
  execFileSync(process.execPath, ['scripts/emit-ts.mjs'], {
    cwd: root,
    stdio: 'pipe',
  });
});
