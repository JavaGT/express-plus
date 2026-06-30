// Auto-generated CRUD action+event types per entity (Fork B, eng-review spec #7).
// entity('Note',{...}) auto-generates Note.create/.update/.remove action types
// and Note.created/.updated/.removed event types with generic reducers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entity, text, ref, grant, read, write, scope, everyone,
} from '../src/index.mjs';

test('entity auto-generates verbs.create/.update/.remove action types', () => {
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

  assert.ok(Note.verbs, 'entity has a verbs namespace');
  assert.equal(Note.verbs.create.type, 'Note.create');
  assert.equal(Note.verbs.create.brand, 'action');
  assert.equal(Note.verbs.update.type, 'Note.update');
  assert.equal(Note.verbs.update.brand, 'action');
  assert.equal(Note.verbs.remove.type, 'Note.remove');
  assert.equal(Note.verbs.remove.brand, 'action');
});

test('entity auto-generates verbs.created/.updated/.removed event types with reducers', () => {
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

  assert.equal(Note.verbs.created.type, 'Note.created');
  assert.equal(Note.verbs.created.brand, 'event');
  assert.equal(Note.verbs.updated.type, 'Note.updated');
  assert.equal(Note.verbs.updated.brand, 'event');
  assert.equal(Note.verbs.removed.type, 'Note.removed');
  assert.equal(Note.verbs.removed.brand, 'event');

  // Verify reducers exist and work
  assert.equal(typeof Note.verbs.created.reduce, 'function');
  assert.equal(typeof Note.verbs.updated.reduce, 'function');
  assert.equal(typeof Note.verbs.removed.reduce, 'function');

  // The created reducer folds event data into state
  const state = Note.verbs.created.reduce({}, { scope: 'Note:1', data: { body: 'hello', owner: 'u1' } });
  assert.equal(state.body, 'hello');
  assert.equal(state.owner, 'u1');

  // The updated reducer merges the delta
  const updated = Note.verbs.updated.reduce(
    { body: 'hello', owner: 'u1' },
    { scope: 'Note:1', data: { body: 'world' } },
  );
  assert.equal(updated.body, 'world');
  assert.equal(updated.owner, 'u1');

  // The removed reducer marks the row as removed
  const removed = Note.verbs.removed.reduce(
    { body: 'hello' },
    { scope: 'Note:1', data: {} },
  );
  assert.equal(removed.body, 'hello');
  assert.equal(removed._removed, true);
});

test('the verbs namespace contains no redundant keys', () => {
  const Note = entity('Note', {
    fields: { body: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });

  const keys = Object.keys(Note.verbs).sort();
  assert.deepEqual(keys, ['create', 'created', 'remove', 'removed', 'update', 'updated']);
});

test('auto-gen types are distinct per entity', () => {
  const Note = entity('Note', {
    fields: { body: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });
  const Post = entity('Post', {
    fields: { title: text() },
    grant: () => [scope(() => everyone()).can(() => grant(read))],
  });

  assert.notEqual(Note.verbs.create.type, Post.verbs.create.type);
  assert.equal(Note.verbs.create.type, 'Note.create');
  assert.equal(Post.verbs.create.type, 'Post.create');
});