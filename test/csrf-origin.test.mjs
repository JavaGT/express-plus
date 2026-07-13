// Priority 4 — CSRF origin guard (eng-review §8 Tier-2 ops bundle, #13).
// A state-mutating request (POST/PUT/PATCH/DELETE) that carries a FOREIGN
// Origin or Referer is rejected (403) before it can mutate state. A mutation
// with NO Origin/Referer is allowed — Node fetch and curl omit these by default,
// and a browser always sends a foreign Origin on a cross-site POST (the real
// CSRF vector). Same-origin Origin/Referer passes. This is the standard
// stateless CSRF defense; it stops cross-site forgeries without breaking
// non-browser API clients (AGENTS.md → Authorization: decisions are computed,
// not magic words; allowlist over denylist).

import { text, ref, scope, grant, read, write, subscribe } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../src/internal.mjs';

function ownedNote() {
  return entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });
  return { base, port };
}

const MUTATING = ['POST', 'PATCH', 'DELETE'];

test('CSRF: a mutation with no Origin/Referer is allowed (non-browser client)', async (t) => {
  const { base } = await setup(t);
  for (const method of MUTATING) {
    // create first so update/remove have a target
    const created = await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'seed' }),
    });
    assert.equal(created.status, 201, `${method} seed create should succeed`);
    const { id } = await created.json();
    const r = await fetch(`${base}/notes/${id}`, {
      method: method === 'POST' ? 'PATCH' : method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(method === 'DELETE' ? {} : { body: 'x' }),
    });
    // POST to /notes/:id is not a route (405 or 404) — only PATCH/DELETE mutate
    if (method !== 'POST') {
      assert.ok(r.status < 400, `${method} with no Origin allowed, got ${r.status}`);
    }
  }
});

test('CSRF: a same-origin Origin header passes', async (t) => {
  const { base, port } = await setup(t);
  const r = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ body: 'same' }),
  });
  assert.equal(r.status, 201);
});

test('CSRF: a foreign Origin header is rejected (403)', async (t) => {
  const { base } = await setup(t);
  const r = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ body: 'forged' }),
  });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.failure.message, 'forbidden');
});

test('CSRF: a foreign Referer (no Origin) is rejected (403)', async (t) => {
  const { base } = await setup(t);
  const r = await fetch(`${base}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'http://evil.example/form' },
    body: JSON.stringify({ body: 'forged' }),
  });
  assert.equal(r.status, 403);
});
