// views.mjs — a minimal, zero-deps view engine (SPEC §3).
//
// `resolveTemplate(viewsDir, name, data)` reads an HTML file from the views
// directory and replaces `{{key}}` placeholders with values from `data`. No
// template language, no evaluation, no includes — just key-value interpolation.
// An unresolved placeholder stays as-is (it is NOT an error — a partial render
// with visible `{{unknown}}` is the least-surprising default and never leaks
// secrets).
//
// `matchExtension(filename)` returns a content-type for static file serving.

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function resolveTemplate(viewsDir, name, data = {}) {
  const filePath = resolve(viewsDir, `${name}`);
  const source = readFileSync(filePath, 'utf-8');
  return source.replace(/\{\{(.+?)\}\}/g, (_, key) => {
    const k = key.trim();
    return Object.hasOwn(data, k) ? String(data[k]) : `{{${k}}}`;
  });
}

// Simple content-type map for common static file extensions.
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

export function matchExtension(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// Guard: a requested static path must not escape the root directory.
export function isSafePath(root, requested) {
  const resolved = resolve(root, requested);
  return resolved.startsWith(resolve(root) + sep) || resolved === resolve(root);
}
