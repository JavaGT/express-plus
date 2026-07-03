// Performance-measurement harness for the workbench framework.
//
// Exercises the real hot paths (create / read / list / update) over the actual
// node:http transport with both default-on auth layers engaged (the route gate
// and the owner-scoped row grant's SQL scope + .can capability). Zero
// dependencies — only node: builtins (Node 26).
//
// Usage:  node bench/hot-path.mjs
//
// Emits EXACTLY ONE line of JSON on stdout:
//   {"create_ops_s":N,"read_ops_s":N,"list_ops_s":N,"update_ops_s":N,"composite_ops_s":N}
// where composite_ops_s is the geometric mean of the four throughputs. All
// progress goes to stderr. On any unexpected HTTP status the harness prints
// {"error":"..."} on stdout and exits 1 — it never silently measures a broken app.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import workbench, { entity } from '../src/internal.mjs';
import {
  text, number, boolean, ref, scope, grant, read, write, subscribe, principal,
} from '../src/index.mjs';

// ---------------------------------------------------------------------------
// Workload sizing. Two passes per phase; we report the better (max) of the two
// to shed scheduler/JIT noise. Counts kept modest so total runtime stays well
// under ~30s while still amortizing per-request overhead.
// ---------------------------------------------------------------------------
const WARMUP = 200;
const CREATE_N = 800;
const READ_N = 800;
const LIST_N = 200;
const UPDATE_N = 800;
const LIST_SEED = 100; // rows a list request returns (owner-visible, pre-seeded)
const PASSES = 2;

// ---------------------------------------------------------------------------
// Entities. Both are owner-scoped so every request runs the real authorization
// path (SQL scope compiled from is.owner() + the .can capability). ~4 data
// fields plus the owner ref.
//   Note — target of create / read / update (grows during the run).
//   Feed — target of list ONLY; pre-seeded to a fixed size so a list request
//          returns a stable ~LIST_SEED rows regardless of Note growth.
// ---------------------------------------------------------------------------
function ownedNote() {
  return entity('Note', {
    title: text(),
    body: text(),
    count: number(),
    done: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

function ownedFeed() {
  return entity('Feed', {
    title: text(),
    body: text(),
    count: number(),
    done: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read),
      ),
    ],
  });
}

const me = principal({ type: 'user', id: 'bench-user' });

const log = (msg) => process.stderr.write(`${msg}\n`);

function fail(message) {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

// A JSON fetch that hard-fails on an unexpected status so a broken app can never
// be silently measured.
async function req(origin, path, { method = 'GET', body, expect } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${origin}${path}`, init);
  } catch (err) {
    fail(`request ${method} ${path} threw: ${err?.message ?? err}`);
  }
  if (expect !== undefined && res.status !== expect) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    fail(`${method} ${path} expected ${expect} got ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Phase drivers. Each returns nothing; measurement is done by the caller timing
// a full pass. Sequential awaited requests (no concurrency) so the number is a
// clean per-request round-trip throughput.
// ---------------------------------------------------------------------------
async function createPass(origin, n, sink) {
  for (let i = 0; i < n; i++) {
    const res = await req(origin, '/notes', {
      method: 'POST',
      body: { title: `t${i}`, body: `b${i}`, count: i, done: i % 2 === 0 },
      expect: 201,
    });
    const row = await res.json();
    if (!row || row.id == null) fail('create returned no id');
    if (sink) sink.push(row.id);
  }
}

async function readPass(origin, n, ids) {
  for (let i = 0; i < n; i++) {
    const id = ids[i % ids.length];
    const res = await req(origin, `/notes/${id}`, { expect: 200 });
    await res.json();
  }
}

async function listPass(origin, n) {
  for (let i = 0; i < n; i++) {
    const res = await req(origin, '/feed', { expect: 200 });
    const rows = await res.json();
    if (!Array.isArray(rows)) fail('list did not return an array');
  }
}

async function updatePass(origin, n, ids) {
  for (let i = 0; i < n; i++) {
    const id = ids[i % ids.length];
    const res = await req(origin, `/notes/${id}`, {
      method: 'PATCH',
      body: { count: i, done: i % 2 === 1, title: `u${i}` },
      expect: 200,
    });
    await res.json();
  }
}

// Time a pass and return ops/sec.
async function timed(n, run) {
  const start = process.hrtime.bigint();
  await run();
  const ns = Number(process.hrtime.bigint() - start);
  return (n * 1e9) / ns;
}

// Run a measurement pass PASSES times and keep the best throughput.
async function best(label, n, makeRun) {
  let top = 0;
  for (let p = 0; p < PASSES; p++) {
    const ops = await timed(n, makeRun(p));
    top = Math.max(top, ops);
    log(`  ${label} pass ${p + 1}/${PASSES}: ${ops.toFixed(0)} ops/s`);
  }
  return top;
}

function geomean(values) {
  const logSum = values.reduce((s, v) => s + Math.log(v), 0);
  return Math.exp(logSum / values.length);
}

async function main() {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  app.mount('/feed', ownedFeed());
  app.listen(0, { principalOf: () => me });
  await app.ready; // resolves routes, builds schema (tables) + kernel

  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;

  // Pre-seed the Feed table so every list request returns a fixed row count.
  // Owner column carries the principal id (what is.owner() compiles against),
  // matching how create stamps ownership — so these rows are owner-visible.
  const insert = db.prepare(
    'INSERT INTO Feed (id, title, body, count, done, owner) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < LIST_SEED; i++) {
    insert.run(randomUUID(), `feed${i}`, `body${i}`, i, i % 2, 'bench-user');
  }

  // Sanity: a list must actually return the seeded rows (catches a scope/owner
  // mismatch before we start reporting throughput as if the app were healthy).
  const check = await req(origin, '/feed', { expect: 200 });
  const seeded = await check.json();
  if (!Array.isArray(seeded) || seeded.length !== LIST_SEED) {
    fail(`list sanity check: expected ${LIST_SEED} rows, got ${Array.isArray(seeded) ? seeded.length : typeof seeded}`);
  }

  // Warmup — mixed traffic, timings discarded.
  log('warmup...');
  const warmIds = [];
  for (let i = 0; i < WARMUP; i++) {
    const res = await req(origin, '/notes', {
      method: 'POST',
      body: { title: `w${i}`, body: `w${i}`, count: i, done: false },
      expect: 201,
    });
    warmIds.push((await res.json()).id);
    await req(origin, `/notes/${warmIds[warmIds.length - 1]}`, { expect: 200 });
    await req(origin, '/feed', { expect: 200 });
  }

  // create — measured; collect ids for read/update.
  log('create...');
  const ids = [];
  const create_ops_s = await best('create', CREATE_N, () => () => createPass(origin, CREATE_N, ids));
  if (ids.length === 0) fail('no ids collected from create phase');

  // read — spread single-row reads over the created ids.
  log('read...');
  const read_ops_s = await best('read', READ_N, () => () => readPass(origin, READ_N, ids));

  // list — the collection endpoint (fixed ~LIST_SEED rows via the Feed table).
  log('list...');
  const list_ops_s = await best('list', LIST_N, () => () => listPass(origin, LIST_N));

  // update — PATCH over the created ids (the framework's update verb).
  log('update...');
  const update_ops_s = await best('update', UPDATE_N, () => () => updatePass(origin, UPDATE_N, ids));

  const composite_ops_s = geomean([create_ops_s, read_ops_s, list_ops_s, update_ops_s]);

  // Clean teardown.
  await app.shutdown();
  db.close();

  const out = {
    create_ops_s: Math.round(create_ops_s),
    read_ops_s: Math.round(read_ops_s),
    list_ops_s: Math.round(list_ops_s),
    update_ops_s: Math.round(update_ops_s),
    composite_ops_s: Math.round(composite_ops_s),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

main().catch((err) => fail(err?.stack ?? String(err)));
