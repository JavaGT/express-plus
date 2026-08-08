// @ts-nocheck
// views.mjs — a minimal, zero-deps view engine (SPEC §3).
//
// `resolveTemplate(viewsDir, name, data)` reads an HTML file from the views
// directory and replaces placeholders with values from `data`. No template
// language, no evaluation, no includes — just key-value interpolation.
//
// Two placeholder forms, differing ONLY in whether the value is HTML-escaped:
//   * `{{key}}`   — the SAFE DEFAULT. The value is HTML-escaped before it is
//                   inserted, so a value containing `<script>` renders as inert
//                   text. This is fail-closed: an app that interpolates
//                   user-controlled data cannot accidentally emit an XSS sink.
//   * `{{{key}}}` — the EXPLICIT opt-out. The value is inserted raw (unescaped),
//                   for the rare case an app has already-trusted HTML to embed.
//                   The extra brace is the app SAYING "I trust this is HTML".
//
// An unresolved placeholder stays as-is (it is NOT an error — a partial render
// with a visible `{{unknown}}` is the least-surprising default and never leaks
// secrets). The triple-brace form is matched first so `{{{x}}}` is never
// mis-read as a double-brace placeholder wrapped in stray braces.
//
// `matchExtension(filename)` returns a content-type for static file serving.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { failure } from './outcome.ts';
import { sendFailure } from './http-failure.ts';
import { sendJson } from './http-response.ts';

// HTML-context escaping (OWASP): the five characters that can break out of text
// or an attribute value. `&` is replaced first so an already-escaped entity is
// not double-escaped by a later rule.
const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export function resolveTemplate(viewsDir, name, data = {}) {
  const filePath = resolve(viewsDir, `${name}`);
  const source = readFileSync(filePath, 'utf-8');
  // Triple-brace (raw) is matched before double-brace (escaped) so the greedier
  // form wins. `[^{}]` for the key forbids nested braces, keeping the two forms
  // unambiguous.
  return source
    .replace(/\{\{\{([^{}]+?)\}\}\}/g, (_, key) => {
      const k = key.trim();
      return Object.hasOwn(data, k) ? String(data[k]) : `{{{${k}}}}`;
    })
    .replace(/\{\{([^{}]+?)\}\}/g, (_, key) => {
      const k = key.trim();
      return Object.hasOwn(data, k) ? escapeHtml(data[k]) : `{{${k}}}`;
    });
}

// Simple content-type map for common static file extensions.
const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Browsers refuse ES modules whose Content-Type is not a JavaScript MIME
  // (Firefox: blocked as application/octet-stream). Cover both .js and .mjs.
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
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

// `stripPrefix` recovers the path tail under a URL prefix. The `?query` is
// dropped (the caller already has it as `url.searchParams`); a missing prefix is
// a pass-through so the factory is usable bare.
export function stripPrefix(url, prefix) {
  if (!prefix) return url;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// `serveStatic(dir, options)` is a catch-all request handler factory for the
// `app.use(prefix, fn)` seam: GET a file under `dir` at the prefix-stripped tail,
// fall through to `next()` on a missing/unsafe file so a downstream handler (a
// SPA fallback) may serve it, and 404 only when there is no `next`. Path
// traversal is rejected via `isSafePath` (fail closed). `options.prefix` is the
// URL prefix already trimmed of trailing slashes; the tail is taken from
// `req.params.path` when the intercept has already stripped it, else from the
// raw URL.
export function serveStatic(dir, options = {}) {
  return (req, res, next) => {
    const rel = req.params?.path ?? stripPrefix(req.url, options.prefix);
    const relPath = String(rel).replace(/^\/+/, '');
    if (!relPath || !isSafePath(dir, relPath)) return next ? next() : sendStaticFailure(res, failure('not-found', 'not found'));
    const fullPath = resolve(dir, relPath);
    if (!existsSync(fullPath)) return next ? next() : sendStaticFailure(res, failure('not-found', 'not found'));
    try {
      const content = readFileSync(fullPath);
      const mime = matchExtension(relPath);
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': mime,
          'content-length': Buffer.byteLength(content),
        });
      }
      res.end(content);
    } catch {
      return sendStaticFailure(res, failure('internal', 'Internal error.'));
    }
  };
}

// Static files share the same failure encoder as every other HTTP edge.
function sendStaticFailure(res, workbenchFailure) {
  return sendFailure(sendJson, res, workbenchFailure);
}
