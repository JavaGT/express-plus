// Emit runtime .mjs siblings from typed src/**/*.ts sources.
// Node refuses type-stripping under node_modules, so the published package
// must ship plain .mjs while .ts remains the editable source of truth.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

function toRuntime(source) {
  const stripped = stripTypeScriptTypes(source, {
    filename: 'module.ts',
  });
  return stripped.replaceAll(/from\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'from $1$2.mjs$1')
    .replaceAll(/import\s+(['"])(\.\.?\/[^'"]+)\.ts\1/g, 'import $1$2.mjs$1')
    .replaceAll(/import\s*\(\s*(['"])(\.\.?\/[^'"]+)\.ts\1\s*\)/g, 'import($1$2.mjs$1)');
}

const sources = walk(srcRoot);
let written = 0;
for (const tsPath of sources) {
  const mjsPath = tsPath.replace(/\.ts$/, '.mjs');
  const emitted = toRuntime(readFileSync(tsPath, 'utf8'));
  writeFileSync(mjsPath, emitted);
  written += 1;
  if (process.env.WORKBENCH_EMIT_VERBOSE === '1') {
    console.log(`emit ${relative(root, mjsPath)}`);
  }
}

if (process.argv.includes('--print')) {
  console.log(`emitted ${written} module(s)`);
}
