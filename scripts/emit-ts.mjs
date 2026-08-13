// Emit runtime .mjs modules from typed src/**/*.ts sources into build/.
// Node refuses type-stripping under node_modules, so the published package
// must ship plain .mjs while .ts remains the editable source of truth.
// build/ is kept an exact image of the .ts tree WITHOUT a full wipe first:
// stale files (no matching .ts) are deleted and only changed files are
// rewritten, so a concurrent process importing from build/ (e.g. the node
// test suite) never sees a missing module during the emit.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const buildRoot = join(root, 'build');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (
      name.endsWith('.ts')
      && !name.endsWith('.d.ts')
      && !name.endsWith('.d.mts')
    ) out.push(path);
  }
  return out;
}

function toRuntime(source) {
  const stripped = stripTypeScriptTypes(source, {
    filename: 'module.ts',
  });
  return stripped.replaceAll(/from\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'from $1$2.mjs$1')
    .replaceAll(/import\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'import $1$2.mjs$1')
    .replaceAll(/import\s*\(\s*(['"])(\.\.?\/[^'"]+)\.ts\1\s*\)/g, 'import($1$2.mjs$1)');
}

const sources = walk(srcRoot);
const expected = new Map(sources.map((tsPath) => [
  relative(srcRoot, tsPath).replace(/\.ts$/, '.mjs'),
  toRuntime(readFileSync(tsPath, 'utf8')),
]));

// Delete anything in build/ that has no matching .ts source (exact image),
// pruning directories emptied by the sweep.
function sweepStale(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sweepStale(path);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
    } else if (!expected.has(relative(buildRoot, path))) {
      rmSync(path);
    }
  }
}
if (existsSync(buildRoot)) {
  sweepStale(buildRoot);
} else {
  mkdirSync(buildRoot, { recursive: true });
}

let written = 0;
for (const [rel, emitted] of expected) {
  const mjsPath = join(buildRoot, rel);
  if (existsSync(mjsPath) && readFileSync(mjsPath, 'utf8') === emitted) continue;
  mkdirSync(dirname(mjsPath), { recursive: true });
  writeFileSync(mjsPath, emitted);
  written += 1;
  if (process.env.WORKBENCH_EMIT_VERBOSE === '1') {
    console.log(`emit ${relative(root, mjsPath)}`);
  }
}

if (process.argv.includes('--print')) {
  console.log(`emitted ${written} module(s)`);
}
