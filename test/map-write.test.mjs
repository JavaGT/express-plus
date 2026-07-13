// E2-E: map field write API on a loaded row.
// A map field (e.g. collaborators) exposes add/remove/has on the hydrated row
// instance, writing to a side-table named <Entity>_<field>.

import { ref, text, map, scope, grant, read } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, createServer, durableMutationVariant, executeFrameworkDDL } from '../src/internal.mjs';
import { ValidationError } from '../src/field-strategy.mjs';

// ---- Setup ----------------------------------------------------------------

const TodoList = entity('TodoList', {
    title: text(),
  owner: ref('User', { role: 'owner' }),
  collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),

  grant: () => [
    scope(({ is }) => is.owner()).can(() => grant(read)),
  ],
});

async function setup() {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [TodoList] });
  const todoList = app.entity(TodoList);
  executeFrameworkDDL(db);
  // Manual DDL: role column is nullable (matches old test, allows .set without role)
  db.exec(`CREATE TABLE IF NOT EXISTS TodoList (
    id TEXT PRIMARY KEY,
    title TEXT,
    owner TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS TodoList_collaborators (
    TodoList_id TEXT,
    member_id TEXT,
    role TEXT
  )`);
  const server = await createServer({
    db,
    handlers: todoList.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [todoList.projection],
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    authorize: async () => true,
  });
  return { db, server, todoList };
}

// hydrate threading the dispatch ref (3rd arg)
function listWith(server, id, todoList) {
  return todoList.hydrate({ id }, null, server.dispatch);
}

// ---- Test 1: write API (add / has) on a loaded row -----------------------

test('loaded row map field add and has', async (t) => {
  const { db, server, todoList } = await setup();
  t.after(() => db.close());
  const created = todoList.create({ title: 'Buy groceries', owner: 'u1' });
  const list = listWith(server, created.id, todoList);

  assert.ok(list.collaborators, 'map field should exist on hydrated row');
  assert.equal(typeof list.collaborators.set, 'function', 'set should be a function');
  assert.equal(typeof list.collaborators.remove, 'function', 'remove should be a function');
  assert.equal(typeof list.collaborators.has, 'function', 'has should be a function');

  // set with role
  await list.collaborators.set('u2', { role: 'editor' });
  assert.equal(list.collaborators.has('u2'), true, 'u2 should be a member');
  assert.equal(list.collaborators.has('u3'), false, 'u3 should not be a member');
});

// ---- Test 2: set without role, remove, has false after remove -------------

test('set without role stores null; remove then has returns false', async (t) => {
  const { db, server, todoList } = await setup();
  t.after(() => db.close());
  const created = todoList.create({ title: 'Chores', owner: 'u1' });
  const list = listWith(server, created.id, todoList);

  // set with no role
  await list.collaborators.set('u4');
  assert.equal(list.collaborators.has('u4'), true);

  // remove
  await list.collaborators.remove('u4');
  assert.equal(list.collaborators.has('u4'), false);
});

// ---- Test 3: the side-table actually got the row --------------------------

test('side-table row written correctly', async (t) => {
  const { db, server, todoList } = await setup();
  t.after(() => db.close());
  const created = todoList.create({ title: 'Side table check', owner: 'u1' });
  const list = listWith(server, created.id, todoList);
  await list.collaborators.set('u5', { role: 'viewer' });

  const row = db.prepare(
    `SELECT * FROM TodoList_collaborators WHERE TodoList_id = :id AND member_id = :member`,
  ).get({ id: created.id, member: 'u5' });

  assert.ok(row, 'side-table should have the inserted row');
  assert.equal(row.TodoList_id, created.id);
  assert.equal(row.member_id, 'u5');
  assert.equal(row.role, 'viewer');
});

// ---- Test 4: map field in create payload → ValidationError ----------------

test('map field in create payload throws ValidationError', () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [TodoList] });
  const todoList = app.entity(TodoList);
  assert.throws(
    () => {
      todoList.create({ title: 'x', owner: 'u1', collaborators: { u2: 'editor' } });
    },
    (err) => {
      assert.ok(err instanceof ValidationError, 'should throw ValidationError');
      assert.match(err.message, /collaborators|map/i);
      assert.match(err.message, /handle|row|add|write|payload/i);
      return true;
    },
    'map field should be rejected from create payload',
  );
  db.close();
});
