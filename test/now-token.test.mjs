// ADR #24 — the `now` token resolves at COMMIT, never by the handler calling
// `new Date()`. A handler emits the framework NOW token where it wants a
// timestamp; the durable variant substitutes the commit-time ISO for every
// occurrence (deep walk of event data) before the row hits _Log. The token
// itself never reaches the log — handlers stay pure of the clock (consult #24).

import { principal } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, durableMutationVariant, NOW, executeFrameworkDDL } from '../src/internal.mjs';
import { setActiveDb } from '../src/db.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function setupDb() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db, { replace: true });
  executeFrameworkDDL(db);
  return db;
}

test('now-token: a handler-emitted NOW resolves to the commit-time ISO in event data', async () => {
  const db = setupDb();
  const server = createServer({
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    handlers: {
      'Stamped.create': ({ payload }) => [{
        type: 'Stamped.created',
        scope: `Stamped:${payload.id}`,
        data: { id: payload.id, createdAt: NOW, updatedAt: NOW },
      }],
    },
  });

  const { granted, events } = await server.dispatch({
    actionId: 'a1',
    type: 'Stamped.create',
    payload: { id: 1 },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(granted, true);
  const ev = events[0];
  assert.match(ev.data.createdAt, ISO, 'createdAt resolved to an ISO timestamp at commit');
  assert.equal(typeof ev.data.createdAt, 'string', 'the NOW symbol was replaced, not stored verbatim');
  assert.equal(ev.data.updatedAt, ev.data.createdAt, 'two NOW tokens in one event resolve to the same commit time');

  // The token never persists to _Log — the stored row carries the ISO string.
  const row = db.prepare('SELECT eventData FROM _Log WHERE actionId = ?').get('a1');
  const stored = JSON.parse(row.eventData);
  assert.match(stored.createdAt, ISO);
  assert.equal(stored.updatedAt, stored.createdAt);
  db.close();
});

test('now-token: a NOW nested in an array + object resolves at every level', async () => {
  const db = setupDb();
  const server = createServer({
    db,
    authorize: () => true,
    pipeline: durableMutationVariant({
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    handlers: {
      'Audit.create': ({ payload }) => [{
        type: 'Audit.created',
        scope: `Audit:${payload.id}`,
        data: { events: [{ at: NOW }, { nested: { stamped: NOW } }], root: NOW },
      }],
    },
  });

  const { events } = await server.dispatch({
    actionId: 'a2',
    type: 'Audit.create',
    payload: { id: 1 },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  const ev = events[0];
  assert.match(ev.data.root, ISO);
  assert.match(ev.data.events[0].at, ISO);
  assert.match(ev.data.events[1].nested.stamped, ISO);
  assert.equal(ev.data.events[0].at, ev.data.root, 'all tokens in the batch share the commit time');
  db.close();
});
