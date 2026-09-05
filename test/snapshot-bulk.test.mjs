// Issue #184 — authorized multi-snapshot bootstrap (GET /snapshots?scope=...).
//
// The bulk endpoint returns the SAME per-scope snapshots LiveList already
// understands (each `results` entry is exactly a GET /snapshot/:entity/:id
// body) plus the per-scope cursors the client sets BEFORE starting its
// per-scope streams (SPEC §7.1). Authz-equivalence: response rows == the union
// of the per-scope compiled-scope rows for the same principal — withheld fields
// stay withheld, denied scopes contribute no rows, and no trailer metadata
// bypasses a grant. Version skew (#189) fails closed: unknown params/scopes
// reject the WHOLE request, never a partially-foldable response.

import { text, ref, scope, grant, read, write, subscribe, everyone } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

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

// Everyone may read; only the row owner may read the `secret` field (withheld
// as an omitted field for every other principal).
function sharedNote() {
  return entity('SharedNote', {
    body: text(),
    owner: text(),
    secret: text().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    checks: { owner: ({ entity: row, principal }) => row.owner === principal.id },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      (await is.owner()) ? grant(read, write, subscribe) : grant(read, subscribe)
    ))],
  });
}

async function harness(t, principalId = 'u1', mounts = { Note: ownedNote(), SharedNote: sharedNote() }, principalOf) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  for (const [name, declaration] of Object.entries(mounts)) app.mount(`/${name.toLowerCase()}`, declaration);
  await app.ddl();
  app.listen(0, { principalOf: principalOf ?? (() => ({ id: principalId })) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });
  return { app, db, base };
}

const json = (r) => r.json();

test('bulk snapshots return the same per-scope bodies as the single route, plus per-scope cursors', async (t) => {
  const { app, base } = await harness(t, 'u1', { Note: ownedNote() });
  const created = await json(await fetch(`${base}/note`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v0' }),
  }));
  await fetch(`${base}/note/${created.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v1' }),
  });
  app.entities.get('Note').insert({ id: 'n-seeded', body: 'seeded', owner: 'u1' });

  const scopes = [`Note:${created.id}`, 'Note:n-seeded'];
  const bulk = await json(await fetch(`${base}/snapshots?${scopes.map((s) => `scope=${s}`).join('&')}`));

  // Each entry is exactly the single-entity snapshot body.
  for (const scope of scopes) {
    const single = await json(await fetch(`${base}/snapshot/${scope.replace(':', '/')}`));
    assert.deepEqual(bulk.results[scope], single, `bulk entry for ${scope} equals the single route body`);
  }
  // Per-scope cursors agree with the entries they were captured with.
  assert.deepEqual(bulk.cursors, Object.fromEntries(scopes.map((s) => [s, bulk.results[s].seq])));
  assert.equal(bulk.cursors[`Note:${created.id}`], 2, 'the patched scope carries its committed seq');
  // No grant-bypass trailer: nothing beyond results + cursors.
  assert.deepEqual(Object.keys(bulk).sort(), ['cursors', 'results']);

  // The cursor is stream-start-ready: events after it replay with no gap.
  await fetch(`${base}/note/${created.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'v2' }),
  });
  const tail = await json(await fetch(`${base}/events-since/Note/${created.id}?cursor=${bulk.cursors[`Note:${created.id}`]}`));
  assert.deepEqual(tail.events.map((e) => e.seq), [3], 'the bulk cursor replays exactly the post-bootstrap events');
});

test('response rows are the union of the per-scope compiled-scope rows — denied scopes contribute nothing', async (t) => {
  const { app, db, base } = await harness(t);
  const created = await json(await fetch(`${base}/sharednote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'mine', owner: 'u1', secret: 's1' }),
  }));
  // Out of u1's row scope (owned by u2) and in u1's scope but with a withheld field.
  app.entities.get('Note').insert({ id: 'n-foreign', body: 'foreign', owner: 'u2' });
  app.entities.get('SharedNote').insert({ id: 's-shared', body: 'shared', owner: 'u2', secret: 'hidden' });

  const requested = [
    `SharedNote:${created.id}`, 'Note:n-foreign', 'SharedNote:s-shared', 'Note:n-missing',
  ];
  const bulk = await json(await fetch(`${base}/snapshots?${requested.map((s) => `scope=${s}`).join('&')}`));

  // The compiled row scope for u1 decides exactly which requested rows appear.
  const authorized = new Set();
  for (const entityName of ['Note', 'SharedNote']) {
    const filter = app.entities.get(entityName).scopeFilter({ id: 'u1' });
    for (const row of db.prepare(`SELECT id FROM ${entityName} AS t0 WHERE ${filter.sql}`).all(filter.params)) {
      authorized.add(`${entityName}:${row.id}`);
    }
  }
  assert.deepEqual(Object.keys(bulk.results).sort(), [...authorized].filter((s) => requested.includes(s)).sort());
  assert.ok(!('Note:n-foreign' in bulk.results), 'a row outside the compiled scope contributes no rows');
  assert.ok(!('Note:n-missing' in bulk.cursors), 'a nonexistent row contributes no cursor');
  assert.deepEqual(bulk.cursors, Object.fromEntries(
    Object.keys(bulk.results).map((s) => [s, bulk.results[s].seq]),
  ), 'cursors cover exactly the authorized scopes');

  // Withheld field: readable only for the owner — omitted for u1 on s-shared,
  // present on u1's own row (same wire shape both routes).
  assert.equal('secret' in bulk.results['SharedNote:s-shared'].snapshot, false, 'the unreadable field is withheld');
  assert.equal(bulk.results[`SharedNote:${created.id}`].snapshot.secret, 's1', 'the owner reads their own field');

  // A principal outside every requested row scope gets an empty, still-200 body.
  const other = await harness(t, 'u2');
  const denied = await json(await fetch(`${other.base}/snapshots?scope=Note:n-foreign`));
  assert.deepEqual(denied, { results: {}, cursors: {} }, 'denied scopes spell absence, not an error trailer');
});

test('withheld fields match the single-route projection exactly (deep parity with per-scope snapshots)', async (t) => {
  const { app, base } = await harness(t);
  // Owned by u2 (trusted insert): u1 reads the row, but its `secret` is withheld.
  app.entities.get('SharedNote').insert({ id: 's2', body: 'theirs', owner: 'u2', secret: 'hidden-from-u1' });
  const scope = 'SharedNote:s2';
  const bulk = await json(await fetch(`${base}/snapshots?scope=${scope}`));
  const single = await json(await fetch(`${base}/snapshot/SharedNote/s2`));
  assert.deepEqual(bulk.results[scope], single);
  assert.equal('secret' in single.snapshot, false, 'the single route withholds identically');
});

test('§7.1: the cursor is captured atomically with the snapshot — no split pair across the auth await', async (t) => {
  let releaseRead;
  let parkOnce = true;
  const yieldingNote = entity('Note', {
    body: text(), owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) => {
        if (parkOnce) {
          parkOnce = false;
          await new Promise((r) => { releaseRead = r; });
        }
        return (await is.owner()) ? grant(read, write, subscribe) : grant(read);
      }),
    ],
  });
  const { app, base } = await harness(t, 'u1', { Note: yieldingNote });
  app.entities.get('Note').insert({ id: 'n1', body: 'v0', owner: 'u1' });

  const bulkP = fetch(`${base}/snapshots?scope=Note:n1`).then((r) => r.json());
  for (let i = 0; i < 1000 && !releaseRead; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(releaseRead, 'the bulk capture parked inside the auth .can');

  // Commit DURING the auth await: v0 → v1 advances the cursor 0 → 1.
  await app.writeQueue.run(() => app.kernel.dispatch({
    actionId: 'bulk-split-pair-test-update',
    type: 'Note.update',
    payload: { id: 'n1', body: 'v1' },
    principal: { id: 'u1' },
  }));
  releaseRead();
  const bulk = await bulkP;

  assert.equal(bulk.results['Note:n1'].snapshot.body, 'v0', 'row is the pre-commit snapshot');
  assert.equal(bulk.results['Note:n1'].seq, 0, 'cursor matches the row — no split pair');
  assert.equal(bulk.cursors['Note:n1'], 0);
});

test('version skew fails closed — unknown params, malformed scopes, unknown entities, over-budget sets', async (t) => {
  const { base } = await harness(t);
  const cases = [
    `${base}/snapshots`,
    `${base}/snapshots?scope=not-a-scope`,
    `${base}/snapshots?scope=Bogus:n1`,
    `${base}/snapshots?scope=Note:n1&mode=all`,
    `${base}/snapshots?scope=${encodeURIComponent('Note:')}`,
  ];
  for (const url of cases) {
    const r = await fetch(url);
    const body = await json(r);
    assert.equal(r.status, 400, `fail closed: ${url}`);
    assert.equal(body.results, undefined, 'no partial response a client could fold');
  }
  const tooMany = Array.from({ length: 257 }, (_, i) => `scope=Note:n${i}`).join('&');
  const capped = await fetch(`${base}/snapshots?${tooMany}`);
  assert.equal(capped.status, 400, 'over-budget scope set is rejected');
});

test('duplicate scopes collapse to one entry', async (t) => {
  const { app, base } = await harness(t);
  app.entities.get('Note').insert({ id: 'n1', body: 'x', owner: 'u1' });
  const bulk = await json(await fetch(`${base}/snapshots?scope=Note:n1&scope=Note:n1`));
  assert.deepEqual(Object.keys(bulk.results), ['Note:n1']);
  assert.deepEqual(bulk.cursors, { 'Note:n1': 0 });
});

test('anonymous principals are rejected at the route gate', async (t) => {
  const { base } = await harness(t, 'u1', undefined, () => ({ type: 'anonymous', id: null }));
  const r = await fetch(`${base}/snapshots?scope=Note:n1`);
  assert.equal(r.status, 401);
});

test('bulk bootstrap stays inside budget at workspace scale (256-scope cap, per-scope re-auth)', async (t) => {
  const { app, base } = await harness(t);
  const count = 200;
  for (let i = 0; i < count; i++) {
    app.entities.get('Note').insert({ id: `n${i}`, body: `body-${i}`, owner: 'u1' });
  }
  const query = Array.from({ length: count }, (_, i) => `scope=Note:n${i}`).join('&');
  const started = performance.now();
  const r = await fetch(`${base}/snapshots?${query}`);
  const bulk = await json(r);
  const elapsedMs = performance.now() - started;
  const bytes = Number((await fetch(`${base}/snapshots?${query}`)).headers.get('content-length'));
  assert.equal(Object.keys(bulk.results).length, count, 'every authorized scope is present');
  assert.deepEqual(bulk.cursors, Object.fromEntries(Array.from({ length: count }, (_, i) => [`Note:n${i}`, 0])));
  // Loose ceiling only — catches a catastrophic per-scope regression (the
  // recorded figures live in the issue report, not in a flaky assertion).
  assert.ok(elapsedMs < 5000, `bulk bootstrap of ${count} scopes took ${elapsedMs.toFixed(0)}ms`);
  console.log(`[snapshot-bulk] ${count} scopes: ${elapsedMs.toFixed(0)}ms, ${bytes} bytes`);
});
