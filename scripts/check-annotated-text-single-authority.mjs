// W1/W3 single-authority gate for the composite annotated-text seam
// (scope#992 Finding 7). W1 enforces the v10 descriptor parser and the
// operated-envelope constructor. W3 rules activate once their owner files exist.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(root, 'src');
const publicRoot = join(root, 'public');

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
  throw new Error(`annotated-text single authority violation: ${authority} has ${list.length} owners`);
}

function retired(symbol) {
  throw new Error(`retired annotated history symbol remains: ${symbol}`);
}

const sources = [...walk(srcRoot), ...walk(publicRoot)];
const byRel = new Map(sources.map((path) => [rel(path), readFileSync(path, 'utf8')]));

const V10_EXPORT = /export\s+(?:function|const|async function)\s+(parseRegionEditDescriptor|isRegionEditDescriptor)\b/;
const v10Owners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('src/') && V10_EXPORT.test(source)) v10Owners.push(path);
}
if (v10Owners.length !== 1 || v10Owners[0] !== 'src/annotated-text-region-descriptor.ts') {
  fail('v10 descriptor grammar', v10Owners.length ? v10Owners : ['<missing>']);
}

const ENVELOPE_CONSTRUCTOR = /export\s+function\s+(constructV13OperatedEvent|constructV14OperatedEvent|constructV15RegionEvent)\b/;
const envelopeOwners = [];
for (const [path, source] of byRel) {
  if (path.startsWith('src/') && ENVELOPE_CONSTRUCTOR.test(source)) envelopeOwners.push(path);
}
if (envelopeOwners.length !== 1 || envelopeOwners[0] !== 'src/annotated-text-operated-event.ts') {
  fail('operated envelope construction', envelopeOwners.length ? envelopeOwners : ['<missing>']);
}

const INLINE_ENVELOPE = /version:\s*1[345]\s*,[\s\S]{0,240}\bfacts\s*:/;
const inlineOwners = [];
for (const [path, source] of byRel) {
  if (path === 'src/annotated-text-operated-event.ts') continue;
  if (path.startsWith('src/') && INLINE_ENVELOPE.test(source)) inlineOwners.push(path);
}
if (inlineOwners.length > 0) fail('operated envelope construction', ['src/annotated-text-operated-event.ts', ...inlineOwners]);

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
