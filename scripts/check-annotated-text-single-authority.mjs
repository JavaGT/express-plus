// W1/W3 single-authority gate for the composite annotated-text seam
// (scope#992 Finding 7). W1 enforces the v10 descriptor parser and the
// operated-envelope constructor. W3 rules activate once their owner files exist.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const publicRoot = join(root, 'public');
const buildRoot = join(root, 'build');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path, out);
    else if (name.name.endsWith('.ts') || name.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

function rel(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function fail(authority, owners) {
  const list = Array.isArray(owners) ? owners : [owners];
  throw new Error(`annotated-text single authority violation: ${authority} has ${list.length} owners (${list.join(', ')})`);
}

function retired(symbol) {
  throw new Error(`retired annotated history symbol remains: ${symbol}`);
}

const sources = [...walk(srcRoot), ...walk(publicRoot)];
const straySourceModules = sources.filter((path) => rel(path).startsWith('src/') && path.endsWith('.mjs'));
if (straySourceModules.length > 0) fail('authored TypeScript source', straySourceModules.map(rel));

const declarations = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
  .map((entry) => join(root, entry.name));
const emitted = walk(buildRoot);
const checkedFiles = [...sources, ...emitted, ...declarations];
const byRel = new Map(checkedFiles.map((path) => [rel(path), readFileSync(path, 'utf8')]));

function tokens(source) {
  const out = [];
  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*|\d+|[{}():,=;]/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[0];
    if (value.startsWith('//') || value.startsWith('/*') || value.startsWith('`')) continue;
    out.push((value.startsWith("'") || value.startsWith('"')) ? value.slice(1, -1) : value);
  }
  return out;
}

function declaredFunctions(_path, source, names) {
  const found = [];
  const words = tokens(source);
  for (let index = 0; index < words.length - 1; index += 1) {
    if (['function', 'const', 'let', 'var'].includes(words[index]) && names.has(words[index + 1])) found.push(words[index + 1]);
  }
  return found;
}

// This deliberately narrow syntax rule owns direct operated-envelope object
// literals. Computed/incremental assembly is prohibited by constructor-name
// ownership below; imports must resolve to the sole constructor module.
function hasDirectOperatedEnvelope(source) {
  const words = tokens(source);
  const stack = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === '{') {
      const prefix = words.slice(Math.max(0, index - 4), index);
      stack.push({ version: false, facts: false, type: prefix.includes('interface') || (prefix.includes('type') && words[index - 1] === '=') });
      continue;
    }
    if (word === '}') {
      const object = stack.pop();
      if (!object?.type && object?.version && object.facts) return true;
      continue;
    }
    const object = stack.at(-1);
    if (!object || words[index + 1] !== ':') continue;
    if (word === 'facts') object.facts = true;
    if (word === 'version' && ['13', '14', '15'].includes(words[index + 2]) && words[index + 3] !== ';') object.version = true;
  }
  return false;
}

const V10_EXPORT = /export\s+(?:function|const|async function)\s+(parseRegionEditDescriptor|isRegionEditDescriptor)\b/;
const v10Owners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('src/') && V10_EXPORT.test(source)) v10Owners.push(path);
}
if (v10Owners.length !== 1 || v10Owners[0] !== 'src/annotated-text-region-descriptor.ts') {
  fail('v10 descriptor grammar', v10Owners.length ? v10Owners : ['<missing>']);
}

const emittedV10Owners = [];
const declarationV10Owners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('build/') && V10_EXPORT.test(source)) emittedV10Owners.push(path);
  if (path.endsWith('.d.ts') && /export\s+function\s+(?:parseRegionEditDescriptor|isRegionEditDescriptor)\b/.test(source)) declarationV10Owners.push(path);
}
if (emittedV10Owners.length !== 1 || emittedV10Owners[0] !== 'build/annotated-text-region-descriptor.mjs') {
  fail('emitted v10 descriptor grammar', emittedV10Owners.length ? emittedV10Owners : ['<missing>']);
}
if (declarationV10Owners.length !== 1 || declarationV10Owners[0] !== 'index.d.ts') {
  fail('declared v10 descriptor grammar', declarationV10Owners.length ? declarationV10Owners : ['<missing>']);
}

const ENVELOPE_CONSTRUCTOR = /export\s+function\s+(constructV13OperatedEvent|constructV14OperatedEvent|constructV15RegionEvent)\b/;
const envelopeOwners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('src/') && ENVELOPE_CONSTRUCTOR.test(source)) envelopeOwners.push(path);
}
if (envelopeOwners.length !== 1 || envelopeOwners[0] !== 'src/annotated-text-operated-event.ts') {
  fail('operated envelope construction', envelopeOwners.length ? envelopeOwners : ['<missing>']);
}

const constructorNames = new Set(['constructV13OperatedEvent', 'constructV14OperatedEvent', 'constructV15RegionEvent']);
const emittedEnvelopeOwners = [];
for (const [path, source] of byRel) {
  if (!path.startsWith('build/')) continue;
  if (declaredFunctions(path, source, constructorNames).length > 0) emittedEnvelopeOwners.push(path);
}
if (emittedEnvelopeOwners.length !== 1 || emittedEnvelopeOwners[0] !== 'build/annotated-text-operated-event.mjs') {
  fail('emitted operated envelope construction', emittedEnvelopeOwners.length ? emittedEnvelopeOwners : ['<missing>']);
}

const inlineOwners = [];
for (const [path, source] of byRel) {
  if (!path.startsWith('src/') || path === 'src/annotated-text-operated-event.ts') continue;
  if (hasDirectOperatedEnvelope(source)) inlineOwners.push(path);
}
if (inlineOwners.length > 0) fail('operated envelope construction', ['src/annotated-text-operated-event.ts', ...inlineOwners]);

for (const [path, source] of byRel) {
  if (!path.startsWith('src/') || path === 'src/annotated-text-operated-event.ts') continue;
  for (const match of source.matchAll(/import\s*{([^}]*)}\s*from\s*['"]([^'"]+)['"]/g)) {
    const imported = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0]);
    if (imported.some((name) => constructorNames.has(name)) && !match[2].endsWith('annotated-text-operated-event.ts')) {
      fail('operated envelope constructor import', [path]);
    }
  }
}

const w3Active = byRel.has('src/legacy-annotated-history-read-privacy.ts');
if (w3Active) {
  const banned = ['annotatedMove', 'annotatedMoveActionTypes', 'hasAnnotatedMoveCapability', 'ANNOTATED_TEXT_COMPENSATION'];
  for (const symbol of banned) {
    for (const [path, source] of byRel) {
      if (!path.startsWith('src/') && !path.startsWith('public/')) continue;
      if (new RegExp(`\\b${symbol}\\b`).test(source)) retired(symbol);
    }
  }
}

console.log('annotated-text single authority: ok');
