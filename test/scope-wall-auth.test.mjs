import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, grant, read, ref, scope, subscribe, text, write } from '../src/internal.mjs';

function privateNote() {
  return entity('PrivateNote', {
    body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function boot(t, configure = () => {}, options = {}) {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, ...options });
  app.mount('/notes', privateNote());
  configure(app);
  await app.ddl();
  app.listen(0, {
    principalOf: (req) => ({ type: 'user', id: req.headers['x-test-user'] ?? 'attacker' }),
  });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  return { app, origin: `http://127.0.0.1:${app.httpServer.address().port}` };
}

async function seedPrivateEvent(origin) {
  const response = await fetch(`${origin}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
    body: JSON.stringify({ body: 'secret history' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('entity-shaped scope replay applies the same row wall as snapshot', async (t) => {
  const { origin } = await boot(t);
  const note = await seedPrivateEvent(origin);

  const response = await fetch(`${origin}/events-since?scope=PrivateNote:${note.id}&cursor=0`, {
    headers: { 'x-test-user': 'attacker' },
  });
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(body).includes('secret history'), false);
  assert.equal(body.events, undefined);
});

test('known entity scope denial cannot fall through to the opaque-scope snapshot callback', async (t) => {
  let fallbackCalled = false;
  const { origin } = await boot(t, (app) => {
    app.scopeSnapshot = async () => {
      fallbackCalled = true;
      return { body: 'secret fallback' };
    };
  });
  const note = await seedPrivateEvent(origin);

  const response = await fetch(`${origin}/snapshot?scope=PrivateNote:${note.id}`, {
    headers: { 'x-test-user': 'attacker' },
  });

  assert.equal(response.status, 404);
  assert.equal(fallbackCalled, false);
});

test('opaque scopes fail closed unless one explicit authorizer admits the principal', async (t) => {
  const denied = await boot(t, (app) => {
    app.scopeSnapshot = async () => ({ title: 'Project One' });
  });
  const missingAuth = await fetch(`${denied.origin}/snapshot?scope=project:p1`, {
    headers: { 'x-test-user': 'owner' },
  });
  const missingReplayAuth = await fetch(`${denied.origin}/events-since?scope=project:p1&cursor=0`, {
    headers: { 'x-test-user': 'owner' },
  });
  assert.equal(missingAuth.status, 404);
  assert.equal(missingReplayAuth.status, 404);

  const admitted = await boot(t, (app) => {
    app.resolveScope = async (requestedScope) =>
      requestedScope === 'project:p1' ? { entity: 'PrivateNote', id: 'scope-anchor' } : null;
    app.scopeSnapshot = async () => ({ title: 'Project One' });
  });
  admitted.app.entities.get('PrivateNote').insert({
    id: 'scope-anchor',
    body: 'authorization anchor',
    owner: 'owner',
  });
  const snapshot = await fetch(`${admitted.origin}/snapshot?scope=project:p1`, {
    headers: { 'x-test-user': 'owner' },
  });
  const replay = await fetch(`${admitted.origin}/events-since?scope=project:p1&cursor=0`, {
    headers: { 'x-test-user': 'owner' },
  });
  assert.equal(snapshot.status, 200);
  assert.equal(replay.status, 200);

  const foreign = await fetch(`${admitted.origin}/events-since?scope=project:p1&cursor=0`, {
    headers: { 'x-test-user': 'attacker' },
  });
  assert.equal(foreign.status, 404);
});

test('constructor scope hooks receive the authorized anchor and preserve falsy snapshots', async (t) => {
  let receivedAnchor = null;
  const { app, origin } = await boot(t, () => {}, {
    resolveScope: async (requestedScope) =>
      requestedScope === 'project:p1' ? { entity: 'PrivateNote', id: 'scope-anchor' } : null,
    scopeSnapshot: async (_scope, _principal, anchor) => {
      receivedAnchor = anchor;
      return false;
    },
  });
  app.entities.get('PrivateNote').insert({
    id: 'scope-anchor',
    body: 'authorization anchor',
    owner: 'owner',
  });

  const response = await fetch(`${origin}/snapshot?scope=project:p1`, {
    headers: { 'x-test-user': 'owner' },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.snapshot, false);
  assert.deepEqual({ ...receivedAnchor, row: { ...receivedAnchor.row } }, {
    entity: 'PrivateNote',
    id: 'scope-anchor',
    row: { id: 'scope-anchor', body: 'authorization anchor', owner: 'owner' },
  });
});
