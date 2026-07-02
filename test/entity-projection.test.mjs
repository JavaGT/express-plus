// Entity-as-projection (Fork A, eng-review spec #3) — RED-GREEN.
// The materialized entity row is a PROJECTION of the committed event log.
// Handlers EMIT EVENTS ONLY. A projection consumer (in-txn) folds committed
// events into entity rows. A re-bootstrap (row read) and a resync (log fold via
// reducer) MUST agree — because the row IS the reducer fold materialized.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import {
  entity, text, ref, link, grant, read, write, scope, everyone,
  generateFrameworkDDL,
} from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

test('entity-projection: create — handler emits event — entity.projection writes row', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Note.create': ({ payload, principal }) => {
        const data = { ...payload };
        data.id = randomUUID();
        data.owner = principal.id;
        return [{ type: 'Note.created', scope: 'Note:new', data }];
      },
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'c1',
    type: 'Note.create',
    payload: { body: 'hello world' },
    principal: { id: 'u1' },
  });

  assert.equal(result.granted, true);
  assert.equal(result.deduped, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'Note.created');

  // The projection consumer wrote the row — verify it's in the table
  const row = db.prepare('SELECT * FROM Note WHERE body = ?').get('hello world');
  assert.ok(row, 'entity row written by projection consumer');
  assert.equal(row.body, 'hello world');
  assert.equal(row.owner, 'u1');
});

test('entity-projection: create — round-trip: row == reducer fold', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Note.create': ({ payload, principal }) => {
        const data = { ...payload };
        data.id = randomUUID();
        data.owner = principal.id;
        return [{ type: 'Note.created', scope: 'Note:new', data }];
      },
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'c1',
    type: 'Note.create',
    payload: { body: 'round-trip payload' },
    principal: { id: 'u1' },
  });

  const row = db.prepare('SELECT * FROM Note WHERE body = ?').get('round-trip payload');
  assert.ok(row);
  assert.equal(row.body, 'round-trip payload');
  assert.equal(row.owner, 'u1');

  // Fold the log event through the declared reducer — must match
  const logEvent = result.events[0];
  const reducerState = Note.verbs.created.reduce({}, logEvent);
  assert.equal(reducerState.body, 'round-trip payload');
  assert.equal(reducerState.owner, 'u1');
  assert.equal(reducerState.body, row.body, 'reducer fold matches materialized row');
  assert.equal(reducerState.owner, row.owner, 'reducer fold matches materialized row');
});

test('entity-projection: update — projection updates row', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  const row = Note.create({ body: 'original' });

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Note.update': ({ payload }) => [
        { type: 'Note.updated', scope: `Note:${row.id}`, data: { id: row.id, ...payload } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'u1',
    type: 'Note.update',
    payload: { body: 'updated body' },
    principal: { id: 'u1' },
  });

  assert.equal(result.granted, true);
  const updated = Note.findById(row.id);
  assert.equal(updated.body, 'updated body');

  // Reducer fold matches
  const reducerState = Note.verbs.updated.reduce(
    { body: 'original' },
    result.events[0],
  );
  assert.equal(reducerState.body, 'updated body');
});

// A struct (link) field's cells persist on CREATE via flattenStruct; they must
// ALSO persist on UPDATE. The `.updated` projection reducer previously skipped
// struct fields, so a struct-cell change committed to the log but never
// materialized to the row — the row read (bootstrap) and the log fold (resync)
// disagreed. This asserts the update path flattens struct cells like create.
test('entity-projection: update — struct (link) cells persist to the row', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Doc = entity('Doc', {
    fields: {
      title: text(),
      linkShare: link({ tiers: ['view', 'comment', 'edit'], tier: 'view' }),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Doc.generateDDL()) db.exec(sql);

  const row = Doc.create({ title: 'memo', linkShare: { token: 'tok-1', tier: 'view' } });
  assert.equal(row.linkShare.tier, 'view');

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Doc.update': ({ payload }) => [
        { type: 'Doc.updated', scope: `Doc:${row.id}`, data: { id: row.id, ...payload } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'su1',
    type: 'Doc.update',
    payload: { linkShare: { tier: 'edit' } },
    principal: { id: 'u1' },
  });

  assert.equal(result.granted, true);

  // The row (bootstrap read) must reflect the struct-cell change.
  const updated = Doc.findById(row.id);
  assert.equal(updated.linkShare.tier, 'edit', 'struct cell persisted to row on update');
  // Partial struct update leaves the untouched cell intact.
  assert.equal(updated.linkShare.token, 'tok-1', 'untouched struct cell preserved');
});

test('entity-projection: remove — projection deletes row', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
    fields: {
      body: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  const row = Note.create({ body: 'delete me' });

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Note.remove': ({ payload }) => [
        { type: 'Note.removed', scope: `Note:${payload.id}`, data: { id: payload.id } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note.projection],
    }),
  });

  const result = await server.dispatch({
    actionId: 'd1',
    type: 'Note.remove',
    payload: { id: row.id },
    principal: { id: 'u1' },
  });

  assert.equal(result.granted, true);
  const deleted = Note.findById(row.id);
  assert.equal(deleted, null, 'row deleted by projection consumer');

  // Reducer fold: _removed flag set
  const reducerState = Note.verbs.removed.reduce({ body: 'delete me' }, result.events[0]);
  assert.equal(reducerState._removed, true);
});

test('entity-projection: projection failure rolls back the whole txn', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
    fields: { body: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Note.create': () => [
        { type: 'Note.created', scope: 'Note:new', data: { id: randomUUID(), body: 'fail' } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Note.created'],
        apply: () => { throw new Error('projection failure'); },
      }],
    }),
  });

  await assert.rejects(
    () => server.dispatch({ actionId: 'x', type: 'Note.create', payload: {}, principal: { id: 'u1' } }),
    /projection failure/,
  );

  // Nothing persisted
  const logRows = db.prepare('SELECT * FROM _Log').all();
  assert.equal(logRows.length, 0, 'Log rollback on projection failure');
  const entityRows = db.prepare('SELECT * FROM Note').all();
  assert.equal(entityRows.length, 0, 'entity row rollback on projection failure');
});