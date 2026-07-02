import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  EventKind,
  created,
  updated,
  removed,
  fieldSet,
  native,
  parseEventType,
  lifecycleVerb,
  event,
  action,
  createServer,
  generateFrameworkDDL,
} from '../src/index.mjs';

test('event handle constructors derive stable persisted event types', () => {
  const createdHandle = created('Project');
  assert.deepEqual(createdHandle, {
    brand: 'event-handle',
    entity: 'Project',
    kind: EventKind.created,
    type: 'Project.created',
  });
  assert.equal(String(createdHandle), 'Project.created');
  assert.deepEqual(updated('Project'), {
    brand: 'event-handle',
    entity: 'Project',
    kind: EventKind.updated,
    type: 'Project.updated',
  });
  assert.deepEqual(removed('Project'), {
    brand: 'event-handle',
    entity: 'Project',
    kind: EventKind.removed,
    type: 'Project.removed',
  });
  assert.deepEqual(fieldSet('Project', 'updated'), {
    brand: 'event-handle',
    entity: 'Project',
    kind: EventKind.fieldSet,
    field: 'updated',
    type: 'Project.updated.set',
  });
  assert.deepEqual(native('Project', 'updated', 'removed'), {
    brand: 'event-handle',
    entity: 'Project',
    kind: EventKind.native,
    field: 'updated',
    nativeName: 'removed',
    type: 'Project.updated.removed',
  });
});

test('parseEventType round-trips existing entity event strings into handles', () => {
  for (const type of [
    'Project.created',
    'Project.updated',
    'Project.removed',
    'Project.updated.set',
    'Project.updated.removed',
  ]) {
    const handle = parseEventType(type);
    assert.equal(handle.type, type);
    assert.ok(Object.isFrozen(handle));
  }
  assert.equal(parseEventType('Project.updated.set').kind, EventKind.fieldSet);
  assert.equal(parseEventType('Project.updated.removed').kind, EventKind.native);
});

test('malformed entity event types fail closed', () => {
  assert.throws(() => parseEventType('Project.published'), /invalid event type/);
  assert.throws(() => parseEventType('Project'), /invalid event type/);
  assert.throws(() => parseEventType('Project.field.name.extra'), /invalid event type/);
});

test('pipeline event(handle, reduce) preserves handle and string type', () => {
  const handle = updated('Project');
  const declaration = event(handle, (state) => state);
  assert.equal(declaration.brand, 'event');
  assert.equal(declaration.handle, handle);
  assert.equal(declaration.type, 'Project.updated');
});

test('pipeline event(string, reduce) remains generic compatibility only', () => {
  const declaration = event('post.published', (state) => state);
  assert.equal(declaration.brand, 'event');
  assert.equal(declaration.handle, undefined);
  assert.equal(declaration.type, 'post.published');
  assert.equal(lifecycleVerb(declaration.handle), undefined);
});

test('durable row replay preserves generic post.published without parsing', async () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const Publish = action('post.publish');
  let calls = 0;
  const server = createServer({
    handlers: {
      'post.publish': ({ payload }) => {
        calls += 1;
        return [{ type: 'post.published', scope: `Post:${payload.id}`, data: { id: payload.id } }];
      },
    },
    authorize: () => true,
    db,
  });

  await server.dispatch({ actionId: 'a1', type: Publish.type, payload: { id: 'p1' }, principal: { id: 'u1' } });
  const replayed = await server.dispatch({ actionId: 'a1', type: Publish.type, payload: { id: 'p1' }, principal: { id: 'u1' } });

  assert.equal(calls, 1);
  assert.equal(replayed.events[0].type, 'post.published');
  assert.equal(replayed.events[0].handle, undefined);
});

test('durable entity event strings replay with non-enumerable handles', async () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const Create = action('Project.create');
  const server = createServer({
    handlers: {
      'Project.create': () => [{ type: 'Project.created', scope: 'Project:p1', data: { id: 'p1' } }],
    },
    authorize: () => true,
    db,
  });

  await server.dispatch({ actionId: 'a1', type: Create.type, payload: {}, principal: { id: 'u1' } });
  const replayed = await server.dispatch({ actionId: 'a1', type: Create.type, payload: {}, principal: { id: 'u1' } });

  assert.equal(replayed.events[0].type, 'Project.created');
  assert.equal(replayed.events[0].handle.kind, EventKind.created);
  assert.equal(Object.prototype.propertyIsEnumerable.call(replayed.events[0], 'handle'), false);
});
