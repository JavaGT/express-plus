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

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { failure, type WorkbenchFailure } from './outcome.ts';
import { sendFailure, type SendJson } from './http-failure.ts';
import { sendJson, type HttpResponseLike } from './http-response.ts';

// --- Content negotiation (Accept-Encoding contract) -------------------------
//
// RFC 7230 `token` grammar: 1*tchar where tchar is any visible ASCII character
// except separators ()<>@,;:\"/[]?={} \t. Accept-Encoding codings must match it.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// RFC 9110 §12.4.2 weight grammar: "0" [ "." *3DIGIT ] / "1" [ "." *3"0" ] —
// up to three fractional digits when present, no sign, exponent, or garbage.
const QVALUE_RE = /^(?:0(?:\.\d{1,3})?|1(?:\.000)?)$/;

function parseQValue(raw: string): number | undefined {
  const value = raw.trim();
  if (!QVALUE_RE.test(value)) return undefined;
  return value === '1' || value === '1.000' ? 1 : Number.parseFloat(value);
}

// parseAcceptEncoding turns an Accept-Encoding header into a coding→q map per
// RFC 9110 §12.5.3: absent header → {} (everything acceptable; serveStatic then
// picks identity for tooling predictability); entries split on ',', token
// validated against the RFC 7230 token grammar and lowercased; `;q=` requires
// the complete q-value grammar (0[.ddd] or 1[.000], ddd=000..999) with missing q
// defaulting to 1 and MALFORMED q defaulting to 1; duplicate tokens last-win;
// entries whose coding fails the token grammar are dropped entirely. The
// wildcard '*' is kept as an ordinary map key.
export function parseAcceptEncoding(headerValue: string | undefined): Record<string, number> {
  if (headerValue === undefined || headerValue === null) return {};
  const prefs: Record<string, number> = {};
  for (const rawItem of headerValue.split(',')) {
    const item = rawItem.trim();
    if (!item) continue;
    const semi = item.indexOf(';');
    const token = (semi === -1 ? item : item.slice(0, semi)).trim().toLowerCase();
    if (!TOKEN_RE.test(token)) continue;
    let q = 1;
    if (semi !== -1) {
      for (const param of item.slice(semi + 1).split(';')) {
        const eq = param.indexOf('=');
        if (eq === -1) continue;
        if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
        // A malformed q-value leaves the RFC 9110 default of 1 in place.
        const parsed = parseQValue(param.slice(eq + 1));
        if (parsed !== undefined) q = parsed;
        break;
      }
    }
    prefs[token] = q; // duplicates: later entry wins
  }
  return prefs;
}

// Quality of a coding under the parsed preferences: explicit entry wins, else
// the wildcard, else unmentioned identity is acceptable but least-preferred
// (RFC 9110 §12.5.3 weights it 0.001), else not acceptable.
function qualityOf(coding: string, prefs: Record<string, number>): number {
  if (Object.hasOwn(prefs, coding)) return prefs[coding];
  if (Object.hasOwn(prefs, '*')) return prefs['*'];
  return coding === 'identity' ? 0.001 : 0;
}

// Merge a header name into an existing Vary value case-insensitively without
// replacing or duplicating it — the request spine may already have set
// `Vary: Origin` before this handler runs.
export function mergeVary(existing: string | undefined | null, name: string): string {
  const names = new Set(
    String(existing ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  names.add(name.toLowerCase());
  return [...names].join(', ');
}

// HTML-context escaping (OWASP): the five characters that can break out of text
// or an attribute value. `&` is replaced first so an already-escaped entity is
// not double-escaped by a later rule.
const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export function resolveTemplate(viewsDir: string, name: string, data: Record<string, unknown> = {}): string {
  const filePath = resolve(viewsDir, `${name}`);
  const source = readFileSync(filePath, 'utf-8');
  // Triple-brace (raw) is matched before double-brace (escaped) so the greedier
  // form wins. `[^{}]` for the key forbids nested braces, keeping the two forms
  // unambiguous.
  return source
    .replace(/\{\{\{([^{}]+?)\}\}\}/g, (_match, key: string) => {
      const k = key.trim();
      return Object.hasOwn(data, k) ? String(data[k]) : `{{{${k}}}}`;
    })
    .replace(/\{\{([^{}]+?)\}\}/g, (_match, key: string) => {
      const k = key.trim();
      return Object.hasOwn(data, k) ? escapeHtml(data[k]) : `{{${k}}}`;
    });
}

// Simple content-type map for common static file extensions.
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
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

export function matchExtension(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// Guard: a requested static path must not escape the root directory.
export function isSafePath(root: string, requested: string): boolean {
  const resolved = resolve(root, requested);
  return resolved.startsWith(resolve(root) + sep) || resolved === resolve(root);
}

// `stripPrefix` recovers the path tail under a URL prefix. The `?query` is
// dropped (the caller already has it as `url.searchParams`); a missing prefix is
// a pass-through so the factory is usable bare.
export function stripPrefix(url: string, prefix?: string): string {
  if (!prefix) return url;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export interface StaticRequest {
  url?: string;
  params?: { path?: string };
  // Provided by the serve intercept context; optional so bare test doubles work.
  headers?: Record<string, string | undefined>;
}

export interface ServeStaticOptions {
  prefix?: string;
  // Managed-path guard (S1/A2): when provided, a resolved file that the
  // predicate marks as managed (e.g. under the adapter-owned database
  // directory) is refused before it is read. Refused paths behave exactly like
  // unsafe paths: fall through to `next()` when one is provided, else 404.
  isManagedPath?: (resolvedPath: string) => boolean;
  // Cache-Control policies keyed by request path: exact path ('/index.html'),
  // path prefix ('/assets/'), or extension ('.svg'). Most-specific match wins
  // (exact > prefix > extension); an unmatched path gets NO cache header,
  // preserving the historical no-header behavior for existing consumers.
  cacheControl?: Record<string, string>;
  // Serve precompressed `.br`/`.gz` siblings (same path + extension) when the
  // client's Accept-Encoding admits them, per the negotiation contract below.
  // Every 200 (and any 406) carries `Vary` merged case-insensitively with any
  // prior value (e.g. the spine's `Origin`), never replacing it.
  precompressed?: boolean;
}

// `serveStatic(dir, options)` is a catch-all request handler factory for the
// `app.use(prefix, fn)` seam: GET a file under `dir` at the prefix-stripped tail,
// fall through to `next()` on a missing/unsafe file so a downstream handler (a
// SPA fallback) may serve it, and 404 only when there is no `next`. Path
// traversal is rejected via `isSafePath` (fail closed), and managed paths via
// `options.isManagedPath` (fail closed). `options.prefix` is the URL prefix
// already trimmed of trailing slashes; the tail is taken from
// `req.params.path` when the intercept has already stripped it, else from the
// raw URL.
export function serveStatic(dir: string, options: ServeStaticOptions = {}) {
  return (req: StaticRequest, res: HttpResponseLike, next?: (err?: unknown) => unknown) => {
    const rel = req.params?.path ?? stripPrefix(req.url ?? '', options.prefix);
    const relPath = String(rel).replace(/^\/+/, '');
    if (!relPath || !isSafePath(dir, relPath)) return next ? next() : sendStaticFailure(res, failure('not-found', 'not found'));
    const fullPath = resolve(dir, relPath);
    if (options.isManagedPath) {
      // Real-path containment: a symlink inside an allowed static root that
      // points into the owned directory must not bypass the managed-path guard.
      // The path is resolved to its real location when the file exists (a
      // missing file 404s below regardless of its path).
      let guarded = fullPath;
      if (existsSync(fullPath)) {
        try { guarded = realpathSync(fullPath); } catch { guarded = fullPath; }
      }
      if (options.isManagedPath(guarded)) return next ? next() : sendStaticFailure(res, failure('not-found', 'not found'));
    }
    if (!existsSync(fullPath)) return next ? next() : sendStaticFailure(res, failure('not-found', 'not found'));
    try {
      const content = readFileSync(fullPath);
      const mime = matchExtension(relPath);
      // Negotiation only engages when the mount opts in; identity is the
      // fallback representation and always a candidate.
      let body: Buffer = content;
      let encoding: 'br' | 'gzip' | undefined;
      if (options.precompressed) {
        const prefs = parseAcceptEncoding(req.headers?.['accept-encoding']);
        // Candidate priority: br > gzip > identity (tie-break order). Identity
        // is always available; siblings are used only when they exist on disk.
        type Representation = { encoding: 'br' | 'gzip' | 'identity'; path: string };
        const candidates: Representation[] = [];
        if (existsSync(fullPath + '.br')) candidates.push({ encoding: 'br', path: fullPath + '.br' });
        if (existsSync(fullPath + '.gz')) candidates.push({ encoding: 'gzip', path: fullPath + '.gz' });
        candidates.push({ encoding: 'identity', path: fullPath });
        const eligible = candidates.filter((c) => qualityOf(c.encoding, prefs) > 0);
        if (eligible.length === 0) {
          // No acceptable representation. The failure encoder maps
          // 'not-acceptable' to 406; Vary is still set first so caches key the
          // 406 on Accept-Encoding too.
          setRawHeader(res, 'vary', mergeVary(rawHeaderOf(res, 'vary'), 'accept-encoding'));
          return sendStaticFailure(res, failure('not-acceptable', 'No acceptable representation.'));
        }
        // maxBy q with stable priority tie-break (candidates are in priority order)
        let best = eligible[0];
        for (const c of eligible) {
          if (qualityOf(c.encoding, prefs) > qualityOf(best.encoding, prefs)) best = c;
        }
        if (best.encoding !== 'identity') {
          body = readFileSync(best.path);
          encoding = best.encoding;
        }
      }
      const cacheControl = matchCacheControl(relPath, options.cacheControl);
      if (!res.headersSent) {
        const headers: Record<string, unknown> = {
          'content-type': mime,
          'content-length': Buffer.byteLength(body),
        };
        if (cacheControl) headers['cache-control'] = cacheControl;
        if (options.precompressed) {
          // Merge with any prior Vary (e.g. Origin from CORS handling) — never
          // replace it — on every 200, encoded or identity alike.
          headers['vary'] = mergeVary(rawHeaderOf(res, 'vary'), 'accept-encoding');
          if (encoding) headers['content-encoding'] = encoding;
        }
        res.writeHead(200, headers);
      }
      res.end(body);
    } catch {
      return sendStaticFailure(res, failure('internal', 'Internal error.'));
    }
  };
}

// Read a response header through the raw Node response — the handler facade has
// setHeader but no getHeader, and `res.raw` is its documented escape hatch.
// The raw shape is optional so test doubles without a `raw` degrade to "no
// prior value" instead of failing (identity/Vary behavior stays correct).
type RawHeaderAccess = {
  raw?: {
    getHeader?: (name: string) => unknown;
    setHeader?: (name: string, value: string) => unknown;
  };
};

function rawHeaderOf(res: object, name: string): string {
  return String((res as RawHeaderAccess).raw?.getHeader?.(name) ?? '');
}

function setRawHeader(res: object, name: string, value: string): void {
  (res as RawHeaderAccess).raw?.setHeader?.(name, value);
}

// Most-specific cache policy for a request path: exact path beats path prefix
// beats extension; everything else gets no header (historical behavior).
// Prefix keys are normalized to leading-slash form so both '/assets/' and
// 'assets/' match a relPath like 'assets/app.js' (the intercept strips the
// mount prefix, leaving no leading slash).
export function matchCacheControl(
  relPath: string,
  policies: Record<string, string> | undefined,
): string | undefined {
  if (!policies) return undefined;
  const exactCandidates = [relPath, `/${relPath}`];
  for (const candidate of exactCandidates) {
    if (Object.hasOwn(policies, candidate)) return policies[candidate];
  }
  let bestPrefix: string | undefined;
  const normalized = `/${relPath}`;
  for (const rawKey of Object.keys(policies)) {
    if (!rawKey.startsWith('/')) continue;
    const key = rawKey.endsWith('/') ? rawKey : `${rawKey}/`;
    if (normalized === key || normalized.startsWith(key)) {
      if (bestPrefix === undefined || key.length > bestPrefix.length) bestPrefix = key;
    }
  }
  if (bestPrefix !== undefined) return policies[bestPrefix];
  const dot = relPath.lastIndexOf('.');
  if (dot !== -1 && relPath.indexOf('/', dot) === -1) {
    const ext = relPath.slice(dot).toLowerCase();
    if (Object.hasOwn(policies, ext)) return policies[ext];
  }
  return undefined;
}

// Static files share the same failure encoder as every other HTTP edge.
function sendStaticFailure(res: HttpResponseLike, workbenchFailure: WorkbenchFailure): unknown {
  return sendFailure(sendJson as unknown as SendJson, res, workbenchFailure);
}
