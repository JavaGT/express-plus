// Hostile recovery tests — Wave 3.7.
// Tests are normal (passing) when the system already satisfies a contract,
// test.todo when a known production gap exists (the assertion body genuinely
// runs and fails, not a skipped placeholder).

import { text, ref, scope, grant, read, write, subscribe } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity } from '../src/internal.mjs';
import { LiveList } from '../public/workbench-client.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectEntity() {
  return entity('Project', {
    name: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

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

async function harness(t, principalId = 'u1') {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/notes', ownedNote());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: principalId }) });
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });
  return { db, base };
}

const json = (r) => r.json();

// ---------------------------------------------------------------------------
// Fake channel + fetch — same pattern as live-list.test.mjs
// ---------------------------------------------------------------------------

function makeFakeChannel() {
  const subs = new Map();
  const checkpoints = new Map();
  let subscribeAck = { currentSeq: 1 };

  const channel = {
    _setAck(ack) { subscribeAck = ack; },
    subscribe(entity, id, optionsOrOnEvent, maybeOnEvent) {
      const onEvent = typeof optionsOrOnEvent === 'function' ? optionsOrOnEvent : maybeOnEvent;
      const key = `${entity}\0${String(id)}`;
      if (subs.has(key)) throw new Error(`already subscribed to ${entity}:${id}`);
      subs.set(key, onEvent);
      if (typeof optionsOrOnEvent?.onCheckpoint === 'function') {
        checkpoints.set(key, optionsOrOnEvent.onCheckpoint);
      }
      return Promise.resolve(subscribeAck);
    },
    unsubscribe(entity, id) {
      const key = `${entity}\0${String(id)}`;
      subs.delete(key);
      checkpoints.delete(key);
      return Promise.resolve();
    },
    close() {},
    emit(envelope) {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      const onEvent = subs.get(key);
      if (onEvent) onEvent(envelope);
    },
    checkpoint(entity, id, currentSeq) {
      checkpoints.get(`${entity}\0${String(id)}`)?.({ currentSeq });
    },
  };
  return channel;
}

function makeFakeFetch(routes) {
  return async (url) => {
    const urlStr = typeof url === 'string' ? url : String(url);
    for (const route of routes) {
      if (urlStr.includes(route.match)) {
        const body = typeof route.responseFn === 'function'
          ? route.responseFn(urlStr)
          : route.response;
        return { ok: true, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
}

function snapshotUrl(e, id) { return `/api/${e}/${id}/snapshot`; }
function eventsSinceUrl(e, id, cursor) { return `/api/${e}/${id}/events?cursor=${cursor}`; }

// ===========================================================================
// Contract 4 — normal test FIRST to avoid event-loop interaction with todos
// ===========================================================================

test('Contract 4 — custom-scope snapshot returns the projection with a cursor', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    resolveScope: (scope) => {
      const m = scope.match(/^project:(.+)$/);
      if (m) return { entity: 'Project', id: m[1] };
      return null;
    },
    scopeSnapshot: async (_scope, _principal, anchor) => {
      return { ...anchor.row, aggregated: true };
    },
  });
  app.mount('/projects', projectEntity());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const base = `http://127.0.0.1:${app.httpServer.address().port}`;

  app.entities.get('Project').insert({ id: 'p1', name: 'alpha', owner: 'u1' });

  const snap = await json(await fetch(`${base}/snapshot?scope=project:p1`));
  assert.equal(snap.snapshot.id, 'p1');
  assert.equal(snap.snapshot.name, 'alpha');
  assert.equal(snap.snapshot.owner, 'u1');
  assert.equal(snap.snapshot.aggregated, true);
  assert.ok(snap.cursors != null, 'response includes cursors');
  assert.equal(typeof snap.cursors['project:p1'], 'number');
  assert.equal(snap.cursors['project:p1'], 0,
    'cursor for the custom scope is 0 (no committed events on this scope)');
});

// ===========================================================================
// Contract 4 (detail) — todo, runs last
// ===========================================================================

test.todo('Contract 4 (detail) — custom-scope snapshot atomicity: cursor read before async scopeSnapshot', async (t) => {
  let releaseSnapshot;
  let parkOnce = true;
  let projectedName = 'before';

  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    resolveScope: (scope) => {
      const m = scope.match(/^project:(.+)$/);
      if (m) return { entity: 'Project', id: m[1] };
      return null;
    },
    scopeSnapshot: async (_scope, _principal, anchor) => {
      if (parkOnce) {
        parkOnce = false;
        await new Promise((r) => { releaseSnapshot = r; });
      }
      return { ...anchor.row, name: projectedName, aggregated: true };
    },
  });
  app.mount('/projects', projectEntity());
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  t.after(() => { app.httpServer.close(); db.close(); });

  const base = `http://127.0.0.1:${app.httpServer.address().port}`;

  app.entities.get('Project').insert({ id: 'p1', name: 'alpha', owner: 'u1' });

  const snapP = fetch(`${base}/snapshot?scope=project:p1`).then((r) => r.json());
  for (let i = 0; i < 1000 && !releaseSnapshot; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(releaseSnapshot, 'scopeSnapshot parked');

  projectedName = 'after';
  db.prepare(
    'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = ?',
  ).run('project:p1', 5, 5);

  releaseSnapshot();
  const snap = await snapP;

  const pair = [snap.snapshot.name, snap.cursors['project:p1']];
  assert.ok(
    (pair[0] === 'before' && pair[1] === 0)
      || (pair[0] === 'after' && pair[1] === 5),
    `snapshot and cursor must share one epoch; received ${JSON.stringify(pair)}`,
  );
});

// ===========================================================================
// Contract 1 — owner can resync after entity deletion
// ===========================================================================

test.todo('Contract 1 — owner events-since after deletion succeeds', async (t) => {
  const { db, base } = await harness(t, 'u1');

  const created = await json(await fetch(`${base}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'hello' }),
  }));
  const id = created.id;

  const delRes = await fetch(`${base}/notes/${id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 204);

  assert.equal(db.prepare('SELECT * FROM Note WHERE id = ?').get(id), undefined);
  const log = db.prepare('SELECT * FROM _Log WHERE scope = ?').all(`Note:${id}`);
  assert.equal(log.length, 2, 'two events remain in _Log');

  // Gap: currently 404 because authorizeRow calls readScopeRow on the
  // deleted row and returns {status: 404}.
  const r = await fetch(`${base}/events-since/Note/${id}?cursor=0`);
  assert.equal(r.status, 200,
    'owner should get 200 for events-since after deletion (currently returns 404)');

  const body = await json(r);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].type, 'Note.created');
  assert.equal(body.events[1].type, 'Note.removed');

});

// ===========================================================================
// Contract 2 — LiveList resync internal hole
// ===========================================================================

test.todo('Contract 2 — LiveList resync with internal hole rejects the batch', async (t) => {
  const channel = makeFakeChannel();
  channel._setAck({ currentSeq: 3 });

  const fetch = makeFakeFetch([
    { match: '/snapshot', response: { snapshot: { val: 'a' }, seq: 3 } },
    {
      match: '/events',
      response: {
        events: [
          { type: 'ticket.updated', scope: 'ticket', seq: 4, data: { val: 'b' }, actionId: 'a4', committedAt: '1' },
          { type: 'ticket.updated', scope: 'ticket', seq: 5, data: { val: 'c' }, actionId: 'a5', committedAt: '2' },
          { type: 'ticket.updated', scope: 'ticket', seq: 7, data: { val: 'e' }, actionId: 'a7', committedAt: '3' },
        ],
      },
    },
  ]);

  const list = new LiveList({
    entity: 'ticket', id: '1', channel, fetchImpl: fetch,
    snapshotUrl, eventsSinceUrl,
  });
  t.after(() => list.close());
  await list.subscribe();
  assert.equal(list.cursor, 3, 'initial cursor from snapshot');
  assert.equal(list.state.val, 'a', 'initial state from snapshot');

  channel.checkpoint('ticket', '1', 7);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(list.cursor, 3,
    'cursor unchanged — resync batch with internal hole rejected');
  assert.equal(list.state.val, 'a',
    'state unchanged');
});

// ===========================================================================
// Contract 3 — unknown/missing/malformed historical events
// ===========================================================================

test.todo('Contract 3 — unknown/missing/malformed historical events do not advance state or cursor', async (t) => {
  const channel = makeFakeChannel();
  channel._setAck({ currentSeq: 1 });

  const fetch = makeFakeFetch([
    { match: '/snapshot', response: { snapshot: { val: 'initial' }, seq: 1 } },
    {
      match: '/events',
      response: {
        events: [
          { type: 'ticket.updated', scope: 'ticket', seq: 2, data: { val: 'applied' }, actionId: 'a2', committedAt: '1' },
          { type: 'ticket.weird', scope: 'ticket', seq: 3, data: { val: 'unknown' }, actionId: 'a3', committedAt: '2' },
          { type: null, scope: 'ticket', seq: 4, data: null, actionId: 'a4', committedAt: '3' },
          { scope: 'ticket', seq: 5, actionId: 'a5', committedAt: '4' },
        ],
      },
    },
  ]);

  const list = new LiveList({
    entity: 'ticket', id: '1', channel, fetchImpl: fetch,
    snapshotUrl, eventsSinceUrl,
  });
  t.after(() => list.close());
  await list.subscribe();
  assert.equal(list.cursor, 1, 'initial cursor from snapshot');
  assert.equal(list.state.val, 'initial');

  channel.checkpoint('ticket', '1', 5);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(list.cursor, 1,
    'cursor unchanged — the entire invalid historical batch is rejected');
  assert.equal(list.state.val, 'initial');
});
