import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createServer, durableMutationVariant } from '../src/pipeline.mjs';
import { buildEffectsRegistry } from '../src/effect-compiler.mjs';
import { entity } from '../src/entity.mjs';
import { text } from '../src/field.mjs';
import { scope } from '../src/scope.mjs';
import { everyone } from '../src/scope-sql.mjs';
import { grant, read, write } from '../src/grant.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

function setupDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT)');
  return db;
}

const noteProjection = {
  eventTypes: ['Note.created', 'Note.updated'],
  apply(ev, db) {
    if (ev.type === 'Note.created') {
      db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run(ev.data.id, ev.data.body ?? null);
    } else if (ev.type === 'Note.updated') {
      db.prepare('UPDATE Note SET body = ? WHERE id = ?').run(ev.data.body ?? null, ev.data.id);
    }
  },
};

const handlers = {
  'Note.create': ({ payload }) => [{ type: 'Note.created', scope: `Note:${payload.id}`, data: payload }],
};

test('durable variant: pre-projection denial leaves zero footprint', async () => {
  const db = setupDb();
  const server = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [noteProjection],
      admission: { beforeProjection: () => false, afterProjection: () => true },
    }),
  });

  const result = await server.dispatch({ actionId: 'pre-deny', type: 'Note.create', payload: { id: 'n1', body: 'x' } });

  assert.equal(result.granted, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c, 0, 'no log row before pre-projection denial');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Note').get().c, 0, 'no projection row before pre-projection denial');
  db.close();
});

test('durable variant: post-projection denial rolls back log and projection', async () => {
  const db = setupDb();
  const server = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [noteProjection],
      admission: { beforeProjection: () => true, afterProjection: () => false },
    }),
  });

  const result = await server.dispatch({ actionId: 'post-deny', type: 'Note.create', payload: { id: 'n2', body: 'x' } });

  assert.equal(result.granted, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c, 0, 'rolled back log row after post-projection denial');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM Note').get().c, 0, 'rolled back projected row after post-projection denial');
  db.close();
});

test('durable variant: effects recurse through the same variant interface', async () => {
  const db = setupDb();

  const Source = entity('SourceVariant', {
    fields: { body: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
    effects: {
      'SourceVariant.created': { mutate: { name: 'TargetVariant' }, with: { body: 'from-effect' } },
    },
  });
  const Target = entity('TargetVariant', {
    fields: { body: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
    admitsEffects: ['SourceVariant'],
  });
  db.exec('CREATE TABLE SourceVariant (id TEXT PRIMARY KEY, body TEXT)');
  db.exec('CREATE TABLE TargetVariant (id TEXT PRIMARY KEY, body TEXT)');

  const projectionConsumers = [
    {
      eventTypes: ['SourceVariant.created'],
      apply(ev, d) { d.prepare('INSERT INTO SourceVariant (id, body) VALUES (?, ?)').run(ev.data.id, ev.data.body ?? null); },
    },
    {
      eventTypes: ['TargetVariant.created'],
      apply(ev, d) { d.prepare('INSERT INTO TargetVariant (id, body) VALUES (?, ?)').run(ev.data.id, ev.data.body ?? null); },
    },
  ];
  const admissionCalls = [];
  const server = createServer({
    handlers: {
      'SourceVariant.create': ({ payload }) => [{ type: 'SourceVariant.created', scope: `SourceVariant:${payload.id}`, data: payload }],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers,
      effectsRegistry: buildEffectsRegistry([Source, Target]),
      admission: {
        beforeProjection: () => true,
        afterProjection: ({ entityName, principal }) => {
          admissionCalls.push({ entityName, principalType: principal?.type, effect: principal?.attributes?.effect });
          return true;
        },
      },
    }),
  });

  const result = await server.dispatch({
    actionId: 'effect-recurses',
    type: 'SourceVariant.create',
    payload: { id: 's1', body: 'origin' },
    principal: { type: 'user', id: 'u1' },
  });

  assert.equal(result.granted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM TargetVariant').get().c, 1, 'effect target projected by recursive variant');
  assert.ok(admissionCalls.some((call) => call.entityName === 'TargetVariant' && call.principalType === 'system' && call.effect === 'SourceVariant'));
  db.close();
});
