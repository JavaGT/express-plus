// The authorization adapter (S5/A2) WIRED into the real HTTP CRUD dispatch
// path. The adapter must be THE admission path for REST read/mutate — not an
// unused type. These tests prove:
//   - an injected adapter is consulted on every read/mutate verb
//   - the injected adapter's decision is honored (deny → 403)
//   - the route gate also consults the injected adapter (spec item 3)
//   - the framework default adapter is unchanged for existing callers

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { text, ref, scope, grant, deny, read, write, subscribe, principal, operations } from '../build/index.mjs';
import workbench, { entity } from '../build/internal.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';

// An owner-scoped Note: the owner may read+write+subscribe; anyone else is
// denied outright.
function ownedNote() {
  return entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : deny('no'),
      ),
    ],
  });
}

// A spy adapter records every admit input and delegates to the framework
// default, so the production decision surface stays the reference.
function spyAdapter() {
  const inner = createAuthorizationAdapter();
  const calls = [];
  return {
    calls,
    admit: async (input) => {
      calls.push(input);
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
}

// A wrapper adapter that overrides admission for one category while delegating
// everything else to the framework default.
function makeAdapter({ onEntity, onPrincipal } = {}) {
  const inner = createAuthorizationAdapter();
  return {
    admit: async (input) => {
      if (input.category === 'entity' && onEntity) return onEntity(input);
      if (input.category === 'principal' && onPrincipal) return onPrincipal(input);
      return inner.admit(input);
    },
    registerResource: (input) => inner.registerResource(input),
  };
}

function deniedDecision(input, reasonCode, operation) {
  return {
    admitted: false,
    operation: operation ?? operations.read,
    resourceCategory: input.category,
    resourceId: null,
    reasonCode,
    capabilities: [],
    trace: null,
  };
}

function seed(ddl, rows = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  for (const { sql, params } of rows) db.prepare(sql).run(...params);
  return db;
}

async function serve(t, db, Entity, who, authorization) {
  const app = workbench({ db });
  app.mount('/notes', Entity);
  app.listen(0, { principalOf: () => who, authorization });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return { origin: `http://127.0.0.1:${port}` };
}

const alice = principal({ type: 'user', id: 'alice' });
const ddl = 'CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT, owner TEXT)';

const seededDb = () => seed(ddl, [
  { sql: 'INSERT INTO Note (id, body, owner) VALUES (?, ?, ?)', params: ['1', 'a', 'alice'] },
]);

test('HTTP read consults the injected adapter (injection honored)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 200);
  const entityCalls = spy.calls.filter((c) => c.category === 'entity');
  assert.ok(entityCalls.some((c) => c.verb === 'read'), 'read consulted the injected adapter');
});

test('HTTP list consults the injected adapter (row post-filter)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);
  const res = await fetch(`${a.origin}/notes`);
  assert.equal(res.status, 200);
  const entityCalls = spy.calls.filter((c) => c.category === 'entity');
  assert.ok(entityCalls.some((c) => c.verb === 'list'), 'list consulted the injected adapter');
});

test('HTTP update and remove consult the injected adapter', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);

  const updated = await fetch(`${a.origin}/notes/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'a2' }),
  });
  assert.equal(updated.status, 200);
  assert.ok(spy.calls.some((c) => c.category === 'entity' && c.verb === 'update'), 'update consulted the injected adapter');

  const removed = await fetch(`${a.origin}/notes/1`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.ok(spy.calls.some((c) => c.category === 'entity' && c.verb === 'remove'), 'remove consulted the injected adapter');
});

test('the injected adapter decision is honored, not the framework default (deny → 403)', async (t) => {
  const db = seededDb();
  // An injected adapter that denies every entity admission. The framework
  // default would ADMIT alice reading her own note; the injected policy wins.
  const denying = makeAdapter({
    onEntity: (input) => deniedDecision(input, 'no-capability'),
  });
  const a = await serve(t, db, ownedNote(), alice, denying);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 403, 'injected denial is honored over the framework default');
});

test('the route gate consults the injected adapter (principal category)', async (t) => {
  const db = seededDb();
  const spy = spyAdapter();
  const a = await serve(t, db, ownedNote(), alice, spy);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 200);
  assert.ok(spy.calls.some((c) => c.category === 'principal'), 'the route gate ran through the injected adapter');
});

test('an injected adapter that denies the route gate yields 401', async (t) => {
  const db = seededDb();
  const denyingGate = makeAdapter({
    onPrincipal: (input) => deniedDecision(input, 'anonymous'),
  });
  const a = await serve(t, db, ownedNote(), alice, denyingGate);
  const res = await fetch(`${a.origin}/notes/1`);
  assert.equal(res.status, 401, 'an injected principal denial is honored');
});

test('the default adapter keeps existing callers working (no authorization injected)', async (t) => {
  const db = seededDb();
  const a = await serve(t, db, ownedNote(), alice, undefined);
  const read = await fetch(`${a.origin}/notes/1`);
  assert.equal(read.status, 200);
  const list = await fetch(`${a.origin}/notes`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).length, 1);
  // a stranger's read of alice's note is OUT OF SCOPE → 404 (invisible), while
  // a visible-but-denied write is 403 — the pre-adapter behavior, unchanged.
  const b = await serve(t, seededDb(), ownedNote(), principal({ type: 'user', id: 'bob' }), undefined);
  const strangerRead = await fetch(`${b.origin}/notes/1`);
  assert.equal(strangerRead.status, 404);
});
