// The HTTP transport — Phase 2, slice 1 (SPEC §3, §4).
//
// Phase 1 resolved a declared app into an inspectable routing table (a list of
// { method, path, verb, entity, gate }). This module turns that table into a
// running node:http server. It is a DISTINCT seam from the resolution layer
// (app.mjs): the table is built at mount time and is the single source of routes;
// this module only serves it. There is no second routing path.
//
// The request flow, fail-closed at each step:
//   1. derive the principal (default: anonymous, until session hydration lands)
//   2. match { method, url } to a route in the table — no match → 404
//   3. run the route's gate(principal) — the first default-on auth layer — and
//      deny with 401 when it returns false
//   4. dispatch the admitted request (slice 1: a stub echoing the matched verb;
//      DB-backed CRUD is the next slice)
//
// The row grant (the SQL scope + .can) still runs downstream in dispatch on every
// admitted verb — this layer decides route admission, never row visibility. No
// second auth path.

import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { anonymous } from './principal.mjs';
import { bindReadScope } from './scope-sql.mjs';
import { ValidationError } from './field-strategy.mjs';
import { mayVerb, mayRow } from './row-grant.mjs';
import { config } from './config.mjs';
import { applySecurityHeaders, renderError, isSameOriginRequest } from './middleware.mjs';
import { sessionPrincipalOf, sessionTokenOf } from './session.mjs';
import { startTickEngine } from './tick-engine.mjs';
import { startReaper } from './reaper.mjs';
import { createLiveServer } from './live.mjs';
import { readSeq } from './cursor.mjs';
import { getLog } from './log.mjs';
import { buildKernel } from './kernel.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { resolveTemplate } from './views.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { isSafePath, matchExtension } from './views.mjs';

// Match a concrete request path against a route's path template. Phase-1 routes
// carry literal segments and `:param` segments (e.g. `/notes/:id`). Returns the
// bound params on a match, or null on no match. A segment count mismatch is a
// non-match (a longer or shorter path is a different route).
function matchPath(template, actual) {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (t.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i += 1) {
    if (t[i].startsWith(':')) {
      params[t[i].slice(1)] = decodeURIComponent(a[i]);
    } else if (t[i] !== a[i]) {
      return null;
    }
  }
  return params;
}

// Specificity of a path template: the count of LITERAL (non-param) segments.
// More literals = more specific. A literal route (`/docs/feed`) beats a
// parametric one (`/docs/:id`) for the same request regardless of declaration
// order — so a CRUD `/:id` declared by `r.resource()` does not shadow a
// hand-written `/feed` route the entity mounts after it. Ties (same literal
// count, e.g. `/a/:x` vs `/:a/b`) fall back to declaration order (first wins).
function specificity(template) {
  return template.split('/').filter((s) => s && !s.startsWith(':')).length;
}

// Find the route whose method AND path template match the request, preferring
// the MOST SPECIFIC match. Path is matched first so a known path with the wrong
// method can be told apart (405) from an unknown path (404).
function matchRoute(routes, method, pathname) {
  let pathMatched = false;
  let best = null;
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params === null) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const score = specificity(route.path);
    if (!best || score > best.score) best = { route, params, score };
  }
  return best ? { route: best.route, params: best.params } : { route: null, params: null, pathMatched };
}

// Send a JSON response with a status code. One place owns the response shape so
// every exit (404, 401, 200) is consistent.
function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function committedEventHeaders(result, actionId, scope = null) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const relevantEvents = scope ? events.filter((event) => event.scope === scope) : events;
  const seq = relevantEvents.reduce(
    (max, event) => Number.isFinite(event.seq) ? Math.max(max, event.seq) : max,
    -Infinity,
  );
  return {
    'x-workbench-action-id': actionId,
    ...(Number.isFinite(seq) ? { 'x-workbench-seq': String(seq) } : {}),
  };
}

// Read and parse a request body. Caps the body to guard against unbounded uploads.
// An empty body parses to {}. Entity CRUD still requires JSON; imperative routes
// can also accept browser forms.
const BODY_LIMIT = 1_000_000; // ~1mb, SPEC §3 body-parse cap.

function readCappedBody(req, limit = BODY_LIMIT, tooLargeMessage = 'request body exceeds the 1mb limit') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        // Stop consuming and reject so the handler can write a 413. Do NOT
        // destroy the socket — an abrupt close would race the response and the
        // client would see a dropped connection instead of the 413. Pausing and
        // resuming (drain-to-end) lets the response flush cleanly.
        aborted = true;
        req.pause();
        reject(new BodyError(tooLargeMessage, 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function contentType(req) {
  return (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function contentTypeParam(req, name) {
  const parts = String(req.headers['content-type'] ?? '').split(';').slice(1);
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (key?.trim().toLowerCase() !== name) continue;
    const value = valueParts.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return value;
  }
  return null;
}

function assignFormValue(body, name, value) {
  if (Object.prototype.hasOwnProperty.call(body, name)) {
    Object.defineProperty(body, name, {
      value: Array.isArray(body[name]) ? [...body[name], value] : [body[name], value],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(body, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

function parseUrlencodedBody(buffer) {
  const body = {};
  const params = new URLSearchParams(buffer.toString('utf8'));
  for (const [name, value] of params) assignFormValue(body, name, value);
  return body;
}

function parseMultipartHeaders(rawHeaders) {
  const headers = {};
  for (const line of rawHeaders.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value) {
  const params = {};
  for (const part of value.split(';').slice(1)) {
    const [key, ...valueParts] = part.split('=');
    const name = key?.trim().toLowerCase();
    if (!name) continue;
    let paramValue = valueParts.join('=').trim();
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) paramValue = paramValue.slice(1, -1);
    params[name] = paramValue;
  }
  return params;
}

function parseMultipartBody(buffer, boundary) {
  if (!boundary) throw new BodyError('multipart body is missing a boundary', 400);
  const body = {};
  const delimiter = `--${boundary}`;
  const raw = buffer.toString('binary');
  for (const section of raw.split(delimiter).slice(1)) {
    if (section.startsWith('--')) break;
    const trimmed = section.startsWith('\r\n') ? section.slice(2) : section;
    const splitAt = trimmed.indexOf('\r\n\r\n');
    if (splitAt === -1) continue;
    const headers = parseMultipartHeaders(trimmed.slice(0, splitAt));
    let content = Buffer.from(trimmed.slice(splitAt + 4), 'binary');
    if (content.subarray(-2).toString('binary') === '\r\n') content = content.subarray(0, -2);
    const disposition = parseContentDisposition(headers['content-disposition'] ?? '');
    if (!disposition.name) continue;
    if (Object.prototype.hasOwnProperty.call(disposition, 'filename')) {
      assignFormValue(body, disposition.name, {
        name: disposition.name,
        filename: disposition.filename,
        type: headers['content-type'] ?? 'application/octet-stream',
        size: content.length,
        content,
      });
    } else {
      assignFormValue(body, disposition.name, content.toString('utf8'));
    }
  }
  return body;
}

async function readRequestBody(req, { jsonOnly = false } = {}) {
  const buffer = await readCappedBody(req);
  if (buffer.length === 0) return {};
  const type = contentType(req);
  if (type === '' || type === 'application/json') {
    const raw = buffer.toString('utf8').trim();
    if (raw === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new BodyError('request body is not valid JSON', 400);
    }
  }
  if (!jsonOnly && type === 'application/x-www-form-urlencoded') return parseUrlencodedBody(buffer);
  if (!jsonOnly && type === 'multipart/form-data') return parseMultipartBody(buffer, contentTypeParam(req, 'boundary'));
  throw new BodyError(jsonOnly ? 'request body must be JSON' : 'unsupported request body content type', 415);
}

// A request body the framework refuses to parse — distinct from a
// ValidationError (a well-formed payload that fails a field rule). It carries the
// HTTP status the refusal maps to: an oversized body is 413 Payload Too Large, a
// malformed body is 400 Bad Request.
class BodyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Read a raw (binary) request body into a Buffer, capped at `limit` bytes. Used
// by the /blobs upload route: a blob upload is opaque bytes, not JSON. The same
// cap-and-refuse contract as readRequestBody (a baked-in default) — an oversized
// upload rejects with a 413 and drains to a clean response, never an abrupt
// socket close that would race the response.
function readRawBody(req, limit) {
  return readCappedBody(req, limit, 'upload exceeds the size limit');
}

// DB-backed dispatch for one admitted verb. The route gate already admitted the
// request; here the SECOND default-on auth layer runs: the row grant's SQL scope
// (which rows are visible) and its .can capability (what may be done). Both must
// pass. A missing db is fail-closed (500): an entity CRUD route cannot serve
// without persistence.
async function dispatch(req, res, route, principal, db, params, body, app = null) {
  if (!db) {
    sendJson(res, 500, { error: 'no database configured for entity dispatch' });
    return;
  }
  const actionId = randomUUID();
  const { entity, verb } = route;
  const table = entity.name;
  const bound = bindReadScope(entity.readScope, principal);
  const where = bound ? bound.sql : '1=1';
  const scopeParams = bound ? bound.params : {};

  // Staleness indicators for projected.async fields. Each projected field has a
  // monotonic counter in _ProjectedCursor tracking how many times the compute has
  // run successfully. The read/list response includes a header per field so the
  // client can detect staleness by comparing with its last-known cursor value.
  function addProjectedCursors(res, db, entity) {
    if (!entity.projectedAsyncFields || entity.projectedAsyncFields.length === 0) return;
    for (const [fieldName] of entity.projectedAsyncFields) {
      const row = db.prepare(
        'SELECT lastSeq FROM _ProjectedCursor WHERE entity = :e AND field = :f',
      ).get({ e: entity.name, f: fieldName });
      if (row) res.setHeader(`x-workbench-projected-${fieldName}`, String(row.lastSeq));
    }
  }

  if (verb === 'list') {
    const rows = db.prepare(`SELECT * FROM ${table} AS t0 WHERE ${where}`).all(scopeParams)
      .map((row) => entity.deserializeRow(row));
    // Post-filter through the SAME mayRow('list') engine `read` uses — the SQL
    // scope decides VISIBILITY, the .can body decides the read CAPABILITY. A
    // grant can admit a row via scope yet deny read in .can; without this list
    // would leak it (one auth path: list + read agree). mayRow owns inherit and
    // scope-only handling so list does not re-derive the skip.
    const listed = [];
    for (const row of rows) {
      if (await mayRow(entity, 'list', row, principal)) listed.push(row);
    }
    addProjectedCursors(res, db, entity);
    sendJson(res, 200, listed);
    return;
  }

  if (verb === 'read') {
    const row = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: params.id });
    // not visible under scope OR absent → 404 (do not distinguish, fail closed).
    if (!row) return void sendJson(res, 404, { error: 'not found' });
    entity.deserializeRow(row);
    if (!(await mayRow(entity, 'read', row, principal))) {
      return void sendJson(res, 403, { error: 'forbidden' });
    }
    addProjectedCursors(res, db, entity);
    sendJson(res, 200, row);
    return;
  }

  if (verb === 'create') {
    const kernel = app?.kernel;
    if (!kernel) return void sendJson(res, 500, { error: 'no mutation kernel configured' });
    let result;
    try {
      result = await app.writeQueue.run(() => kernel.dispatch({ actionId, type: `${table}.create`, payload: body, principal }));
    } catch (err) {
      if (err?.status === 503) return void sendJson(res, 503, { error: 'service busy' });
      if (err instanceof ValidationError) return void sendJson(res, 400, { error: err.message });
      throw err;
    }
    if (!result.granted) return void sendJson(res, 403, { error: 'forbidden' });
    const id = result.events[0].data.id;
    const created = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE t0.id = :id`)
      .get({ id });
    entity.deserializeRow(created);
    sendJson(res, 201, created, committedEventHeaders(result, actionId, `${table}:${id}`));
    return;
  }

  if (verb === 'update') {
    const kernel = app?.kernel;
    if (!kernel) return void sendJson(res, 500, { error: 'no mutation kernel configured' });
    const row = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: params.id });
    if (!row) return void sendJson(res, 404, { error: 'not found' });
    entity.deserializeRow(row);
    if (!(await mayRow(entity, 'update', row, principal))) {
      return void sendJson(res, 403, { error: 'forbidden' });
    }
    let result;
    try {
      result = await app.writeQueue.run(() => kernel.dispatch({
        actionId,
        type: `${table}.update`,
        payload: { ...body, id: params.id },
        principal,
      }));
    } catch (err) {
      if (err?.status === 503) return void sendJson(res, 503, { error: 'service busy' });
      if (err instanceof ValidationError) return void sendJson(res, 400, { error: err.message });
      throw err;
    }
    if (!result.granted) return void sendJson(res, 403, { error: 'forbidden' });
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(params.id);
    entity.deserializeRow(updated);
    sendJson(res, 200, updated, committedEventHeaders(result, actionId, `${table}:${params.id}`));
    return;
  }

  if (verb === 'remove') {
    const kernel = app?.kernel;
    if (!kernel) return void sendJson(res, 500, { error: 'no mutation kernel configured' });
    const row = db
      .prepare(`SELECT * FROM ${table} AS t0 WHERE ${where} AND t0.id = :id`)
      .get({ ...scopeParams, id: params.id });
    if (!row) return void sendJson(res, 404, { error: 'not found' });
    entity.deserializeRow(row);
    if (!(await mayRow(entity, 'remove', row, principal))) {
      return void sendJson(res, 403, { error: 'forbidden' });
    }
    let result;
    try {
      result = await app.writeQueue.run(() => kernel.dispatch({
        actionId,
        type: `${table}.remove`,
        payload: { id: params.id },
        principal,
      }));
    } catch (err) {
      if (err?.status === 503) return void sendJson(res, 503, { error: 'service busy' });
      throw err;
    }
    if (!result.granted) return void sendJson(res, 403, { error: 'forbidden' });
    res.writeHead(204, committedEventHeaders(result, actionId, `${table}:${params.id}`));
    res.end();
    return;
  }

  // an unknown verb is fail-closed (the routing table only mints the five).
  sendJson(res, 500, { error: `unknown verb '${verb}'` });
}

// Framework-owned snapshot + resync endpoints (spec #1, D6/D7). NOT mounted
// routes — resolved at request time from `/snapshot/:entity/:id` and
// `/events-since/:entity/:id`. The entity table IS the snapshot (scope's proven
// shape); the committed `_Log` is the RESYNC source. Authorization runs the SAME
// mayVerb('read') engine as REST `read` (the viewer bar), after the same
// readScope row filter — one auth engine, no second path (SPEC §7, §7.1).
//
// Returns true when the request was handled (the caller short-circuits); false
// when the path is not a framework resync route (fall through to matchRoute).
async function handleResyncRoute(app, req, res, principal) {
  const url = new URL(req.url, 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  if (seg.length !== 3 || (seg[0] !== 'snapshot' && seg[0] !== 'events-since')) return false;
  if (!app || !app.entities || !app.db) return false;
  const [, entityName, id] = seg;
  const entity = app.entities.get(entityName);
  if (!entity) { sendJson(res, 404, { error: 'not found' }); return true; }
  // route gate (requireUser) — fail closed for anonymous, same as a mounted route.
  if (!principal || principal.id == null) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  const scopeKey = `${entityName}:${id}`;
  if (seg[0] === 'snapshot') return snapshotRoute(app, entity, id, scopeKey, principal, res);
  const cursor = Number(url.searchParams.get('cursor') ?? 0);
  return eventsSinceRoute(app, entity, scopeKey, principal, res, cursor);
}

// Load the materialized row through the readScope (fail closed: out-of-scope OR
// absent → 404) and admit via mayVerb('read'). Shared by snapshot + events-since
// — both prove the viewer can read THIS scope's current row before serving it.
// Read the materialized row through the readScope (fail closed: out-of-scope OR
// absent → null). Synchronous — no await — so /snapshot can read the scope cursor
// in the SAME statement block and return a (row, seq) pair that actually
// coexisted: a concurrent dispatch commit must not advance the cursor in the gap
// between reading the row and reading the cursor (eng-review Tier-1 #2). node:sqlite
// is single-writer + sync, and there is no yield between these two reads.
function readScopedRow(app, entity, id, principal) {
  const bound = bindReadScope(entity.readScope, principal);
  const where = bound ? bound.sql : '1=1';
  const scopeParams = bound ? bound.params : {};
  const row = app.db
    .prepare(`SELECT * FROM ${entity.name} AS t0 WHERE ${where} AND t0.id = :id`)
    .get({ ...scopeParams, id });
  return entity.deserializeRow(row);
}

// Load the materialized row through the readScope (fail closed: out-of-scope OR
// absent → 404) and admit via mayVerb('read'). Shared by snapshot + events-since
// — both prove the viewer can read THIS scope's current row before serving it.
// `preRow` is supplied only by /snapshot, which must read the row + cursor together
// (see readScopedRow); every other caller reads the row here.
async function authorizeRead(app, entity, id, principal, preRow = null) {
  const row = preRow ?? readScopedRow(app, entity, id, principal);
  if (!row) return { status: 404 };
  // mayRow owns inherit, scope-only, and own-.can handling; snapshot and
  // events-since do not re-derive authorization shape.
  if (!(await mayRow(entity, 'read', row, principal))) return { status: 403 };
  return { row };
}

async function snapshotRoute(app, entity, id, scopeKey, principal, res) {
  // Read the row + the scope cursor in ONE synchronous block — no await between
  // them — then authorize. A concurrent dispatch commit cannot split the pair
  // (eng-review Tier-1 #2): the cursor is captured alongside the row, before the
  // async mayVerb yields. The pair we authorize is the pair we return.
  const row = readScopedRow(app, entity, id, principal);
  const lastSeq = readSeq(app.db, scopeKey);
  const auth = await authorizeRead(app, entity, id, principal, row);
  if (auth.status) {
    sendJson(res, auth.status, { error: auth.status === 404 ? 'not found' : 'forbidden' });
    return true;
  }
  sendJson(res, 200, { snapshot: auth.row, seq: lastSeq });
  return true;
}

async function eventsSinceRoute(app, entity, scopeKey, principal, res, cursor) {
  // events-since authorizes against the CURRENT row (fail closed: a deleted or
  // out-of-scope row yields 404). The log is replayed for an admitted viewer.
  const auth = await authorizeRead(app, entity, scopeKey.slice(scopeKey.indexOf(':') + 1), principal);
  if (auth.status) {
    sendJson(res, auth.status, { error: auth.status === 404 ? 'not found' : 'forbidden' });
    return true;
  }
  const oldest = app.db
    .prepare('SELECT MIN(seq) AS min FROM _Log WHERE scope = ?')
    .get(scopeKey);
  const minSeq = oldest ? oldest.min : null;
  // The client wants events > cursor; the first wanted is cursor+1. If that is
  // older than the oldest RETAINED event, the gap can never be filled → HARD-FAIL.
  // Never a silent truncate (SPEC §3.6 — the single non-negotiable property).
  if (minSeq !== null && cursor + 1 < minSeq) {
    sendJson(res, 200, { resync: 'stale', reason: 'cursor-behind-retention' });
    return true;
  }
  const rows = app.db
    .prepare('SELECT * FROM _Log WHERE scope = ? AND seq > ? ORDER BY seq')
    .all(scopeKey, cursor);
  const events = rows.map((r) => ({
    type: r.eventType,
    scope: r.scope,
    seq: r.seq,
    data: r.eventData ? JSON.parse(r.eventData) : null,
    actionId: r.actionId,
    committedAt: r.committedAt,
  }));
  sendJson(res, 200, { events });
  return true;
}

// Framework-owned blob upload endpoint (spec #2, eng-review Walk 1b). NOT a
// mounted route: `POST /blobs` streams the request body to the BlobStore as a
// PENDING blob (`.pending` file + row), returning { id, md5, sha256, size, mime }.
// The blob is ADOPTED later by the dispatch that references it (an entity field
// marked `blob: true` carrying the blob id) — adopted IN that dispatch's
// transaction, finalized post-commit. A rolled-back dispatch leaves it pending
// for the reaper. Route-gate fail-closed: anonymous → 401 (same admission as a
// mounted route — no second auth path). Returns true when handled; false to fall
// through to matchRoute.
const BLOB_LIMIT = 50_000_000; // ~50mb upload cap (SPEC §3 size-guard default).
// Blob reaper cadence + stale threshold (eng-review spec #10, consult #17). A
// pending upload whose adopt dispatch never came (client crash / abandonment) is
// orphaned; once it is older than the TTL the reaper sweeps the .pending file +
// row. Defaults baked into the framework — no app config (AGENTS.md: sensible
// defaults are framework-owned). Interval chosen so a sweep lands well inside the
// TTL window (6×/hour) so orphans don't linger far past the threshold.
const BLOB_REAP_INTERVAL_MS = 10 * 60_000; // sweep every 10 minutes.
const BLOB_REAP_TTL_MS = 60 * 60_000;       // a pending blob is stale after 1 hour.

async function handleBlobUploadRoute(app, req, res, principal) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/blobs' || req.method !== 'POST') return false;
  if (!app || !app.blobs) return false;
  // route gate (requireUser) — fail closed for anonymous, same as a mounted route.
  if (!principal || principal.id == null) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  let bytes;
  try {
    bytes = await readRawBody(req, BLOB_LIMIT);
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, { error: err.message });
      return true;
    }
    throw err;
  }
  const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
  const meta = app.blobs.upload({ bytes, mime });
  sendJson(res, 201, meta);
  return true;
}

// Framework-owned job-queue endpoints (spec #5, Walk 2). NOT mounted routes: the
// worker / job API is a framework default, intercepted before route matching (like
// /blobs, /health, /snapshot). Auth is its OWN path — a per-worker bearer token,
// constant-time compared + revocable (cso: never the shared secret, which is used
// only at /workers/register). These routes are anonymous w.r.t. the route gate — a
// worker is not a logged-in principal; the bearer IS the credential. Workers are
// non-browser clients (no Origin/Referer) so they pass the foreign-only CSRF guard.
// Returns true when handled; false to fall through to matchRoute.
async function handleJobRoute(app, req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'POST' || !app?.jobs) return false;
  const jobs = app.jobs;

  // Bearer extraction: `Authorization: Bearer <workerId>.<token>`.
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim() || null;

  if (url.pathname === '/workers/register') {
    let body;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { sendJson(res, err.status, { error: err.message }); return true; }
      throw err;
    }
    const w = jobs.registerWorker(body.secret);
    if (!w) { sendJson(res, 401, { error: 'invalid shared secret' }); return true; }
    sendJson(res, 200, w);
    return true;
  }

  if (url.pathname === '/jobs/claim') {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
    const job = jobs.claim(workerId);
    if (!job) { res.writeHead(204); res.end(); return true; } // no queued work
    sendJson(res, 200, job);
    return true;
  }

  const hb = url.pathname.match(/^\/jobs\/([^/]+)\/heartbeat$/);
  if (hb) {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
    const ok = jobs.heartbeat(hb[1], workerId);
    if (!ok) { sendJson(res, 403, { error: 'not the owning worker or job not running' }); return true; }
    sendJson(res, 200, { ok: true });
    return true;
  }

  const rs = url.pathname.match(/^\/jobs\/([^/]+)\/result$/);
  if (rs) {
    const workerId = jobs.authenticate(bearer);
    if (!workerId) { sendJson(res, 401, { error: 'unauthorized' }); return true; }
    let body;
    try { body = await readRequestBody(req, { jsonOnly: true }); } catch (err) {
      if (err instanceof BodyError) { sendJson(res, err.status, { error: err.message }); return true; }
      throw err;
    }
    let result;
    try { result = jobs.submitResult(rs[1], workerId, body); }
    catch (err) { sendJson(res, 400, { error: err.message }); return true; }
    if (!result.accepted) { sendJson(res, 403, { error: 'not the owning worker or job not in progress' }); return true; }
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

// The imperative terminal: run a hand-written handler chain over an Express-like
// (req, res, next). This is the OTHER arm of the single dispatch fork — it never
// touches the db or the row grant (an imperative route has no entity), so the
// route gate is its only framework-applied auth, and the principal it sees was
// already admitted by that gate (no second auth path).
//
// The chain is `[...optional middleware, finalHandler]`. Each handler is awaited
// with (req, res, next). Calling next() with no argument advances to the next
// handler; calling next(err) — including the deliberate next({ status, message })
// shape — defers to the single error renderer and stops the chain. A handler that
// writes the response (res.json / res.sendStatus / res.send) and does not call
// next() ends the chain by completing the request.
async function runChain(handlers, nodeReq, nodeRes, { principal, params, body, query, autoLoad, app }, { env }) {
  // an Express-like request facade over the node request. The raw node request
  // remains reachable for handlers that need headers; the framework surfaces the
  // already-parsed body, the matched path params, the parsed query, and the
  // already-admitted principal.
  const req = {
    body,
    params,
    query: Object.fromEntries(query),
    principal,
    raw: nodeReq,
    headers: nodeReq.headers,
    method: nodeReq.method,
    url: nodeReq.url,
  };

  // Entity auto-load: a route under an entity's `:<entity>Id` subtree admits the
  // parent row for THIS principal via the SAME authorizeRead path snapshot and
  // events-since use (bindReadScope + mayVerb('read')) — never the unscoped
  // trusted findById, which would bypass read-scope (H1). Out-of-scope = 404 (no
  // existence leak); in-scope-but-denied = 403; in neither case does the handler
  // run. An admitted row is hydrated (principal-aware map handles) for the handler.
  if (autoLoad) {
    const auth = await authorizeRead(app, autoLoad.entity, params[autoLoad.param], principal);
    if (auth.status) {
      renderError(nodeRes, { status: auth.status, message: auth.status === 404 ? 'not found' : 'forbidden' }, { env });
      return;
    }
    // Thread a dispatch ref so a store MUTATION off the hydrated row
    // (`req.doc.collaborators.set(...)`) RE-ENTERS dispatch as a committed
    // pipeline action (consult #19, UNIT 2) — the handle dispatches, the
    // projection applies, one reconciliation path (no direct-SQL fallback). The
    // ref is the writeQueue-wrapped kernel.dispatch (the same wrapping the CRUD
    // sites use, so store mutations serialize through the single-writer mutex).
    // Custom route handlers run OUTSIDE writeQueue, so re-entry acquires a free
    // lock (no deadlock).
    const dispatchRef = app?.kernel
      ? (args) => app.writeQueue.run(() => app.kernel.dispatch(args))
      : null;
    req[autoLoad.key] = autoLoad.entity.hydrate(auth.row, principal, dispatchRef);
  }

  // an Express-like response facade over the node response. `status(n)` records a
  // pending code and chains; `json`/`send` flush with it (defaulting to 200);
  // `sendStatus(n)` ends with no body.
  let pendingStatus = 200;
  const res = {
    status(code) {
      pendingStatus = code;
      return res;
    },
    json(value) {
      sendJson(nodeRes, pendingStatus, value);
      return res;
    },
    send(value) {
      const payload = typeof value === 'string' ? value : String(value);
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(pendingStatus, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
      }
      nodeRes.end(payload);
      return res;
    },
    sendStatus(code) {
      nodeRes.writeHead(code);
      nodeRes.end();
      return res;
    },
    render(name, data = {}) {
      try {
        const html = resolveTemplate(config.viewsDir ?? resolve(process.cwd(), 'views'), name, data);
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(pendingStatus, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(html),
          });
        }
        nodeRes.end(html);
      } catch (err) {
        // Template read failure (e.g. file not found) → 500 or 404.
        const status = err.code === 'ENOENT' ? 404 : 500;
        renderError(nodeRes, { status, message: err.code === 'ENOENT' ? `template not found: ${name}` : err.message }, { env });
      }
      return res;
    },
    // Stream a Web Response / ReadableStream to the client — the SSE/streaming
    // helper. Accepts a fetch-style Response (headers + body stream) or a bare
    // ReadableStream. Writes status + headers once (copying the Web response's
    // headers, defaulting content-type to text/event-stream for a bare stream),
    // then pumps bytes until done. `X-Accel-Buffering: no` is set by default so
    // nginx doesn't buffer the stream (the SSE footgun) — pass `{ buffering: false }`
    // to opt out. One place owns the node-internal plumbing so a handler never
    // casts `res.raw` or hand-rolls a `while (reader.read())` pump.
    async stream(webResponse, { buffering = true } = {}) {
      const isResponse = typeof webResponse?.body?.getReader === 'function'
        || (webResponse && typeof webResponse.body === 'object');
      const body = webResponse?.body ?? webResponse;
      const headers = isResponse && webResponse.headers
        ? Object.fromEntries(webResponse.headers.entries())
        : {};
      if (!('content-type' in headers) && !isResponse) {
        headers['content-type'] = 'text/event-stream; charset=utf-8';
      }
      if (buffering) headers['x-accel-buffering'] = 'no';
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(isResponse && Number.isFinite(webResponse.status) ? webResponse.status : pendingStatus, headers);
      }
      if (!body || typeof body.getReader !== 'function') {
        nodeRes.end();
        return res;
      }
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (nodeRes.destroyed) break;
          nodeRes.write(Buffer.isBuffer(value) ? value : Buffer.from(value));
        }
        if (!nodeRes.writableEnded) nodeRes.end();
      } catch (err) {
        // Headers are already committed mid-stream, so renderError (which writes
        // a JSON body) would append trailing junk into the stream. The response
        // is unrecoverable — tear down the socket instead. Log the pump failure
        // for server-side observability.
        getLog().warn('system', 'res.stream pump failed', { err });
        if (!nodeRes.destroyed) nodeRes.destroy(err);
      } finally {
        try { await reader.cancel(); } catch { /* already closed */ }
      }
      return res;
    },
    raw: nodeRes,
  };

  // walk the chain. `next` is single-shot per step: it either advances (no arg)
  // or renders an error and halts. A thrown error inside a handler propagates to
  // makeRequestHandler's catch, which runs the same renderer.
  for (const handler of handlers) {
    let advance = false;
    let errored = false;
    const next = (err) => {
      if (err) {
        errored = true;
        renderError(nodeRes, err, { env });
      } else {
        advance = true;
      }
    };
    await handler(req, res, next);
    if (errored) return;
    if (!advance) return; // the handler completed the response (no next() call)
  }
}

// The standard stateless CSRF guard (eng-review §8 Tier-2 ops bundle, #13). A
// state-MUTATING request (anything but a safe method) carrying a FOREIGN Origin
// or Referer is rejected; the browser always sends a foreign Origin on a
// cross-site POST (the real forgery vector). A mutation with NO Origin/Referer
// is allowed — Node fetch and curl omit these by default, so a fail-closed
// "missing → reject" would block every non-browser API client. Same-origin
// (the header's host:port equals the request Host) passes. This is a COMPUTED
// decision (AGENTS.md → Authorization: always functions), not a magic-word
// check; it runs before the route gate so a forged mutation never reaches it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Returns true when the mutation is allowed, false when it is foreign (→ 403).
// Safe methods carry no state change; the same-origin verdict (shared with the
// WS upgrade handshake, middleware.mjs) gates every other method.
function csrfGuard(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  return isSameOriginRequest(req);
}

// Build the node:http request handler that serves a routing table. `principalOf`
// derives the request's principal; it defaults to a function returning anonymous
// so an unconfigured server is fail-closed (the default-on route gate denies
// every anonymous request). When an app has a db, `listen` supplies session
// hydration as the principal source (sessionPrincipalOf) — the SAME admission
// path, not a second one. `db` is the app-level node:sqlite handle the
// dispatcher runs against.
export function makeRequestHandler(source, { principalOf = () => anonymous, db, env = config.env, rateLimiter = null, csp, hsts, cors, requestLog = false } = {}) {
  // `source` is either a plain resolved routing table (an array) or an app whose
  // table resolves asynchronously (two-phase boot). When it is an app, every
  // request first awaits `app.ready` so the socket may accept connections before
  // resolution completes without ever dispatching against a partial table.
  const isApp = source && typeof source.resolveRoutes === 'function';
  // Request log (opt-in via `listen(port, {requestLog:true})`). The structured
  // logger also captures every request at info-level on the 'http' channel.
  const shouldLogRequest = requestLog;
  const log = getLog();
  const requestCount = { count: 0 };
  return async function handle(req, res) {
    const startTime = Date.now();
    if (isApp) requestCount.count += 1;
    if (shouldLogRequest) {
      let statusCode = 200;
      const origWriteHead = res.writeHead;
      res.writeHead = function patchedWriteHead(code, ...args) {
        statusCode = code;
        return origWriteHead.apply(this, [code, ...args]);
      };
      res.on('finish', () => {
        const path = new URL(req.url, 'http://localhost').pathname;
        const durationMs = Date.now() - startTime;
        if (shouldLogRequest) {
          process.stderr.write(`${req.method} ${path} ${statusCode} ${durationMs}ms\n`);
        }
        log.info('http', `${req.method} ${path} ${statusCode}`, { method: req.method, path, status: statusCode, durationMs });
      });
    }
    // Security headers are a baked-in default on EVERY response, set before any
    // exit path writes its head (SPEC §3). They are retained through writeHead.
    applySecurityHeaders(res);
    // CSP / HSTS / CORS policy headers (piece 4 — opt-in, default off)
    if (csp) res.setHeader('content-security-policy', csp);
    if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000');
    // CORS: check Origin and set headers if configured (allowlist over denylist)
    const origin = req.headers.origin;
    if (cors && cors.origins && Array.isArray(cors.origins) && origin) {
      if (cors.origins.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-expose-headers', 'x-workbench-seq, x-workbench-action-id');
        res.setHeader('vary', 'Origin');
      }
    }
    try {
      if (isApp) await source.ready;
      const routes = isApp ? source.routes : source;

      // Rate-limit (opt-in via `listen(port, {rateLimit:{...}})`) runs first in
      // the ops stack (eng-review line 213: rateLimit → csrfOrigin). A flood is
      // rejected cheaply here — before CSRF, the route gate, or any write lock —
      // so a denial-of-service attempt never reaches the kernel (the writeQueue
      // is never held by a request that will be refused). Per-IP fixed window; a
      // session window, when configured, additionally caps a logged-in browser
      // (stricter wins). The session key is the opaque `sid` cookie token — read
      // cheaply with no DB lookup, before principal hydration; the IP gate is the
      // non-spoofable base that holds when no cookie is present.
      if (rateLimiter) {
        const r = rateLimiter.check({ ip: req.socket?.remoteAddress, sessionId: sessionTokenOf(req) });
        if (!r.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
          sendJson(res, 429, { error: 'rate limit exceeded', retryAfterMs: r.retryAfterMs });
          return;
        }
      }

      // CSRF origin guard (eng-review #13) — a foreign-origin mutation is
      // rejected before it reaches the route gate or any state change. Bare
      // non-browser requests (no Origin/Referer — Node fetch, curl) pass.
      if (isApp && !csrfGuard(req)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      // Framework-owned /health endpoint (piece 1) — PUBLIC, anonymous, no auth.
      // Intercepts BEFORE matchRoute (like /snapshot, /blobs, /events).
      if (isApp && req.method === 'GET') {
        if (url.pathname === '/health') {
          sendJson(res, 200, { status: 'ok', env });
          return;
        }
        if (url.pathname === '/health/stats') {
          sendJson(res, 200, {
            status: 'ok',
            env,
            uptimeMs: Math.round(process.uptime() * 1000),
            rssBytes: process.memoryUsage().rss,
            requestCount: requestCount.count,
          });
          return;
        }
      }
      // CORS preflight (piece 4 — opt-in): OPTIONS with allowed origin/method → 204
      if (isApp && req.method === 'OPTIONS' && cors && cors.origins && Array.isArray(cors.origins)) {
        const origin = req.headers.origin;
        if (origin && cors.origins.includes(origin)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
          res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
          res.setHeader('access-control-allow-headers', 'content-type');
          res.writeHead(204);
          res.end();
          return;
        }
      }

      // Static file serving — intercepts before route matching. The app declares
      // `app.static('/public', dir)`; every GET request under the prefix is served
      // from the filesystem with a content-type derived from the file extension.
      // Missing files → 404; path-traversal attempts → 404 (fail closed).
      // Framework-owned default endpoints — snapshot + resync (spec #1, D6/D7).
      // Like the /events WS transport, these are framework defaults (not mounted
      // routes): `/snapshot/:entity/:id` and `/events-since/:entity/:id` resolve
      // the entity at request time from the path. Authorized through the SAME
      // mayVerb ('read') as REST `read` — one auth engine, no second path.
      if (isApp && req.method === 'GET') {
        const handled = await handleResyncRoute(source, req, res, principalOf(req));
        if (handled) return;
      }
      // Framework-owned blob upload (spec #2): `POST /blobs` is a framework
      // default, not a mounted route — intercepted before route matching, like
      // the snapshot/resync endpoints and the /events WS transport.
      if (isApp && req.method === 'POST') {
        const handled = await handleBlobUploadRoute(source, req, res, principalOf(req));
        if (handled) return;
      }
      // Framework-owned job-queue endpoints (spec #5): /workers/register,
      // /jobs/claim, /jobs/:id/heartbeat, /jobs/:id/result. Bearer-auth'd (not
      // route-gate auth) — intercepted before matchRoute, like /blobs.
      if (isApp && req.method === 'POST' && source.jobs) {
        const handled = await handleJobRoute(source, req, res);
        if (handled) return;
      }
      if (isApp && source._static && req.method === 'GET') {
        const { prefix, dir } = source._static;
        if (url.pathname.startsWith(prefix)) {
          const filePath = url.pathname.slice(prefix.length) || '/index.html';
          if (!isSafePath(dir, filePath)) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          const fullPath = resolve(dir, filePath);
          if (!existsSync(fullPath)) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          try {
            const content = readFileSync(fullPath);
            const mime = matchExtension(filePath);
            res.writeHead(200, {
              'content-type': mime,
              'content-length': Buffer.byteLength(content),
            });
            res.end(content);
          } catch {
            sendJson(res, 500, { error: 'internal error' });
          }
          return;
        }
      }

      const { route, params, pathMatched } = matchRoute(routes, req.method, url.pathname);

      // no path match → 404; path matched but method did not → 405.
      if (!route) {
        if (pathMatched) {
          sendJson(res, 405, { error: 'method not allowed' });
        } else {
          sendJson(res, 404, { error: 'not found' });
        }
        return;
      }

      // the first default-on auth layer: the route gate decides admission.
      const principal = principalOf(req);
      if (!route.gate(principal)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      // read a body for mutating entity verbs and every imperative route. Entity
      // CRUD stays JSON-only; handlers may accept browser form posts.
      let body = {};
      if (route.handlers || route.verb === 'create' || route.verb === 'update') {
        try {
          body = await readRequestBody(req, { jsonOnly: !route.handlers });
        } catch (err) {
          // a refused body carries its own status (413 oversized, 400 malformed).
          if (err instanceof BodyError) return void sendJson(res, err.status, { error: err.message });
          throw err;
        }
      }

      // admitted. One spine, one legitimate fork at the tail: a route carrying a
      // handler chain runs the chain; an entity route runs DB-backed CRUD (where
      // the second default-on auth layer, the row grant, applies). This is NOT a
      // second auth path — the chain inherits the already-admitted principal and
      // never re-gates.
      if (route.handlers) {
        await runChain(route.handlers, req, res, { principal, params, body, query: url.searchParams, autoLoad: route.autoLoad, app: source }, { env });
      } else {
        await dispatch(req, res, route, principal, db, params, body, isApp ? source : null);
      }
    } catch (err) {
      // the single error renderer (SPEC §3): an unexpected exception becomes an
      // opaque prod-safe 500 (or a dev 500 with a stack). `env` is server-owned,
      // never client-controlled.
      renderError(res, err, { env });
    }
  };
}

// Open a real node:http server for a resolved app and start listening. The
// server is stored on `app.httpServer` and the app is returned (chainable). The
// app's db handle is passed to the dispatcher (read here, owned by the app). The
// routing table was built at mount time; this only serves it.
//
// The second argument is overloaded the Express way: a FUNCTION is a listening
// callback (`app.listen(port, () => ...)`, the exemplar shape); an OBJECT is
// server-owned listen options (`principalOf`, `env`). Both are server-owned —
// neither is client-controlled.
//
// Graceful shutdown (SPEC §3) is framework-owned: SIGTERM/SIGINT close the live
// server, and an unhandledRejection/uncaughtException is trapped. The app mounts
// none of this — `app.shutdown()` is the close the traps call (and tests use).
export function listen(app, port, optionsOrCallback = {}) {
  const isCallback = typeof optionsOrCallback === 'function';
  const options = isCallback ? {} : optionsOrCallback;
  const onListening = isCallback ? optionsOrCallback : options.onListening;
  const log = getLog();

  // The default principal source is session hydration when the app has a db: the
  // principal is built server-side from the request's session cookie (SPEC §572).
  // An explicit `principalOf` option overrides (tests inject a fixed principal).
  // With no db there is nothing to look a session up in, so the source stays the
  // fail-closed `() => anonymous` default in makeRequestHandler.
  const principalOf =
    options.principalOf ?? (app.db ? sessionPrincipalOf(app.db) : undefined);

  // Two-phase boot. The routing table resolves asynchronously (an entity's
  // `routes` thunk may be async — e.g. a parent lazily dynamic-imports a child at
  // wiring time), but the SOCKET opens synchronously so `app.httpServer` is
  // available the instant `listen` returns (the chainable, fluent contract). The
  // handler bridges the two: every request first awaits `app.ready`, so no
  // request is ever served against a partial table even though the socket is
  // already accepting connections. A resolution failure rejects `app.ready`; the
  // handler surfaces it as a 500 and the request is never dispatched — fail closed.
  // CSP / HSTS / CORS / requestLog are opt-in policy headers (piece 4, 5).
  const resolved = makeRequestHandler(
    // Read the table through a thunk: it is empty until resolution completes, and
    // the handler below gates every request on `app.ready` before reading it.
    app,
    { ...options, principalOf, db: app.db, rateLimiter: options.rateLimit ? createRateLimiter(options.rateLimit) : null,
      csp: options.csp, hsts: options.hsts, cors: options.cors, requestLog: options.requestLog },
  );

  const httpServer = createHttpServer(resolved);
  app.httpServer = httpServer;
  installGracefulShutdown(app);
  // The job-queue reaper runs as a framework-owned periodic sweep (spec #5):
  // re-assigns lease-expired jobs + revokes stale-heartbeat workers. Started
  // after installGracefulShutdown so its stop() can be registered with the
  // onShutdown registry (the timer is cleared on graceful exit). Only when the
  // app engaged the job-queue substrate.
  if (app.jobs) {
    app.jobs.startReaper();
    app.onShutdown('job-queue-reaper', () => app.jobs.stop(), { timeoutMs: 1000 });
  }
  // The blob reaper (eng-review spec #10, consult #17). `app.blobs` is built
  // whenever a db is engaged (not opt-in), and POST /blobs is always live, so an
  // abandoned upload leaks a .pending file + row forever with no operator lever
  // — a fail-open default the framework must own (AGENTS.md: Defaults + Fail
  // closed). The sweep runs UNDER the writeQueue mutex: reap() deletes DB rows
  // AND unlinks files (a transaction does not serialize FS unlinks), and a
  // dispatch txn spans an await, so an unsync'd reaper could delete a blob a
  // concurrent dispatch just referenced / is mid-adopting. serialize it as one
  // critical section against dispatch via writeQueue.run. app.blobColumns is set
  // in buildKernel (app.ready); the sweep reads it lazily so it is always current
  // even for apps whose blob fields register after listen() (buildKernel runs in
  // app.ready, which tests await).
  const blobReapIntervalMs = options.blobReapIntervalMs ?? BLOB_REAP_INTERVAL_MS;
  const blobReapTtlMs = options.blobReapTtlMs ?? BLOB_REAP_TTL_MS;
  if (app.blobs) {
    app.sweepBlobs = () => app.writeQueue.run(() =>
      app.blobs.reap({ ttl: blobReapTtlMs, blobColumns: app.blobColumns ?? [] })
    );
    let blobTimer;
    blobTimer = setInterval(() => {
      app.sweepBlobs().catch((err) => log.warn('system', 'blob reap failed', { err }));
    }, blobReapIntervalMs);
    if (typeof blobTimer.unref === 'function') blobTimer.unref();
    app.onShutdown('blob-reaper', () => { if (blobTimer) clearInterval(blobTimer); }, { timeoutMs: 1000 });
  }
  // _Log retention reaper (eng-review #42). The event log grows forever; when a
  // logRetentionDays option is set, the reaper prunes entries older than the
  // configured horizon. Runs at the same cadence as the blob reaper by default,
  // under the writeQueue mutex so concurrent dispatches don't race. The log is
  // eviction-safe: events-since delivers a gap → recover bundle (SPEC §D6); a
  // pruned entry that arrived after the subscriber's cursor is a legitimate gap.
  const logRetentionDays = options.logRetentionDays;
  if (logRetentionDays > 0) {
    app.sweepLog = () => app.writeQueue.run(() => {
      const cutoff = new Date(Date.now() - logRetentionDays * 86_400_000).toISOString();
      app.db.prepare('DELETE FROM _Log WHERE committedAt < :cutoff').run({ cutoff });
      app.db.prepare('DELETE FROM _ProjectedCursor WHERE lastSeq = 0').run();
    });
    let logTimer;
    logTimer = setInterval(() => {
      app.sweepLog().catch((err) => log.warn('system', 'log retention sweep failed', { err }));
    }, options.logRetentionIntervalMs ?? BLOB_REAP_INTERVAL_MS);
    if (typeof logTimer.unref === 'function') logTimer.unref();
    app.onShutdown('log-reaper', () => { if (logTimer) clearInterval(logTimer); }, { timeoutMs: 1000 });
  }
  // Start the tick engine if any entity declares a tick trigger. DEFERRED into
  // `app.ready` below — `app.kernel` (and thus `dispatch`) is not built until
  // `buildKernel(app)` runs; starting earlier would hand the engine an undefined
  // dispatch handle. Scans entities for tick triggers (tick.hz / tick.every);
  // only starts if at least one exists (avoids a no-op timer). ONE reconciliation
  // path — the engine dispatches under a system principal through `kernel.dispatch`,
  // admitted in-txn by the durable variant's `admission.beforeProjection` seam.
  if (typeof onListening === 'function') httpServer.once('listening', onListening);
  httpServer.listen(port);

  // The live WebSocket server for /events subscriptions. It fans out entity-row
  // change events to authorized subscribers using the SAME mayVerb the REST
  // dispatch uses (verb='subscribe') — no second auth path. Created after the
  // HTTP server so the upgrade handler binds to a real socket; stored on the app
  // so dispatch can reach it at request time.
  app.live = createLiveServer(httpServer, {
    path: '/events',
    mayVerb: (entity, verb, row, principal) => mayVerb(entity, verb, row, principal),
    principalOf,                        // the SAME principal resolver HTTP uses — no second auth identity
    db: app.db,
    resolveEntity: (name) => app.entities?.get(name),  // name → record, for subscribe-time authz
  });

  // Resolution runs in the background; `app.ready` completes once the table is
  // built AND the socket is listening, so a caller may await it before closing.
  app.ready = (async () => {
    await app.resolveRoutes();
    app.kernel = buildKernel(app);
    const dispatchThroughWriteQueue = (args) => app.writeQueue.run(() => app.kernel.dispatch(args));
    // app.batch(actions, { principal }) — a server-side composed mutation
    // (SPEC §11, ADR #13). N actions run as ONE transaction = ONE composed
    // commit (one actionId, one `now`), all-or-nothing. This reuses the SAME
    // kernel path (authorize→handler→durable variant) wrapped once in the
    // writeQueue — not a second pipeline. Exposed for server code that needs
    // an atomic multi-entity write outside the per-route HTTP handlers.
    app.batch = (actions, { principal } = {}) =>
      app.writeQueue.run(() => app.kernel.dispatchBatch({ actionId: randomUUID(), actions, principal }));
    // Start the tick engine now that `app.kernel.dispatch` exists. Only starts
    // if some entity declares a tick trigger (tick.hz / tick.every); otherwise
    // startTickEngine returns a no-op and no timer is created.
    const tickEngine = startTickEngine({
      db: app.db,
      entities: app.entities,
      dispatch: dispatchThroughWriteQueue,
    });
    app.onShutdown('tick-engine', () => { tickEngine.stop(); }, { timeoutMs: 1000 });
    // Start the schedule reaper now that app.kernel.dispatch exists. Mirrors
    // the tick engine pattern; uses a fixed 1s poll interval. Only starts if
    // some entity declares a schedule.at / schedule.after deadline trigger.
    const reaper = startReaper({ db: app.db, entities: app.entities, dispatch: dispatchThroughWriteQueue });
    app.onShutdown('reaper', () => { reaper.stop(); }, { timeoutMs: 1000 });
    if (!httpServer.listening) {
      await new Promise((resolve) => httpServer.once('listening', resolve));
    }
    log.info('system', `server listening on port ${app.httpServer.address()?.port ?? port}`);
    return app;
  })();

  return app;
}

// The set of live apps to close on a shutdown signal, and whether the
// process-level traps are installed. These traps belong to the PROCESS, not an
// app — installing them per app would accumulate listeners (a leak, and a
// MaxListeners warning). They are installed ONCE; the signal handler closes
// every registered app.
const liveApps = new Set();
let processTrapsInstalled = false;

function installProcessTraps() {
  if (processTrapsInstalled) return;
  processTrapsInstalled = true;

  const onSignal = () => {
    Promise.all([...liveApps].map((a) => a.shutdown())).then(() => process.exit(0));
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.on('unhandledRejection', (reason) => {
    const log = getLog();
    log.error('system', 'unhandledRejection', { reason });
    process.stderr.write(`unhandledRejection: ${reason}\n`);
  });
  process.on('uncaughtException', (err) => {
    const log = getLog();
    log.error('system', 'uncaughtException', { err });
    process.stderr.write(`uncaughtException: ${err?.stack ?? err}\n`);
  });
}

// The graceful-shutdown seam. `app.shutdown()` closes the live server (resolving
// once it has stopped accepting connections) and unregisters the app. SIGTERM/
// SIGINT close every registered app; an unhandledRejection/uncaughtException is
// trapped so a stray rejection cannot crash the process silently. The framework
// owns these — an app that mounted its own would be a leak.
// 
// onShutdown registry (eng-review #16): apps register named hooks with deadlines.
// Hooks run in registration order on shutdown; each bounded by its timeoutMs.
// A hook exceeding its deadline is force-abandoned (resolve with timeout error, log,
// continue to next).
function installGracefulShutdown(app) {
  if (!app._shutdownHooks) {
    app._shutdownHooks = [];
  }
  if (!app.onShutdown) {
    app.onShutdown = (name, fn, { timeoutMs = 5000 } = {}) => {
      app._shutdownHooks.push({ name, fn, timeoutMs });
    };
  }
  if (!app.shutdown) {
    app.shutdown = () =>
      new Promise((resolve) => {
        // Run registered hooks first, each bounded by its deadline
        const runHooks = async () => {
          for (const hook of app._shutdownHooks) {
            const timer = new Promise((_, reject) => {
              const t = setTimeout(() => {
                clearTimeout(t);
                reject(new Error(`onShutdown hook '${hook.name}' exceeded ${hook.timeoutMs}ms deadline`));
              }, hook.timeoutMs);
            });
            try {
              await Promise.race([hook.fn(), timer]);
            } catch (err) {
              getLog().warn('system', `onShutdown hook '${hook.name}' failed`, { err, hook: hook.name });
              process.stderr.write(`onShutdown hook '${hook.name}' failed: ${err.message}\n`);
              // Continue to next hook (force-abandon on timeout)
            }
          }
        };
        // Close http server and live server, then resolve
        const closeServer = () => new Promise((resolveClose) => {
          if (app.httpServer && app.httpServer.listening) {
            app.httpServer.close(() => {
              liveApps.delete(app);
              resolveClose();
            });
          } else {
            liveApps.delete(app);
            resolveClose();
          }
        });
        // Run hooks then close
        runHooks().then(closeServer).then(resolve);
      });
  }
  liveApps.add(app);
  installProcessTraps();
}
