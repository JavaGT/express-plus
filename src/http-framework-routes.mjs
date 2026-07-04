// Framework-owned HTTP routes — snapshot, events-since, blob upload, job queue.
//
// These are NOT mounted routes: they are framework defaults intercepted before
// route matching in the request handler, like /health. Auth runs through the
// SAME engine as REST (mayVerb / mayRow / readScope), not a second path.
//
// Exports: handleResyncRoute, handleBlobUploadRoute, handleJobRoute.

import { sendJson } from './http-response.mjs';
import { readScopedRow, authorizeRow } from './http-row-read.mjs';
import { readSeq, readSince, minSeqForScope } from './committed-log.mjs';
import { BodyError, readRawBody, readRequestBody } from './http-body.mjs';

// routes — resolved at request time from `/snapshot/:entity/:id` and
// `/events-since/:entity/:id`. The entity table IS the snapshot (scope's proven
// shape); the committed `_Log` is the RESYNC source. Authorization runs the SAME
// mayVerb('read') engine as REST `read` (the viewer bar), after the same
// readScope row filter — one auth engine, no second path (SPEC §7, §7.1).
//
// Returns true when the request was handled (the caller short-circuits); false
// when the path is not a framework resync route (fall through to matchRoute).
export async function handleResyncRoute(app, req, res, principal) {
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

async function snapshotRoute(app, entity, id, scopeKey, principal, res) {
  // Read the row + the scope cursor in ONE synchronous block — no await between
  // them — then authorize. A concurrent dispatch commit cannot split the pair
  // (eng-review Tier-1 #2): the cursor is captured alongside the row, before the
  // async mayVerb yields. The pair we authorize is the pair we return.
  const row = readScopedRow(app, entity, id, principal);
  const lastSeq = readSeq(app.db, scopeKey);
  const auth = await authorizeRow(app, entity, 'read', id, principal, row);
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
  const auth = await authorizeRow(app, entity, 'read', scopeKey.slice(scopeKey.indexOf(':') + 1), principal);
  if (auth.status) {
    sendJson(res, auth.status, { error: auth.status === 404 ? 'not found' : 'forbidden' });
    return true;
  }
  const minSeq = minSeqForScope(app.db, scopeKey);
  // The client wants events > cursor; the first wanted is cursor+1. If that is
  // older than the oldest RETAINED event, the gap can never be filled → HARD-FAIL.
  // Never a silent truncate (SPEC §3.6 — the single non-negotiable property).
  if (minSeq !== null && cursor + 1 < minSeq) {
    sendJson(res, 200, { resync: 'stale', reason: 'cursor-behind-retention' });
    return true;
  }
  const rows = readSince(app.db, scopeKey, cursor);
  const events = rows.map((r) => ({
    type: r.eventType,
    scope: r.scope,
    seq: r.seq,
    data: r.data ?? null,
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

export async function handleBlobUploadRoute(app, req, res, principal) {
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
export async function handleJobRoute(app, req, res) {
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
