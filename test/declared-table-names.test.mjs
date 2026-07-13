import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, text, ref, map } from '../src/index.mjs';
import { declaredTableNames } from '../src/server.mjs';

test('declaredTableNames — simple entity yields its main table', () => {
  const Widget = entity('Widget', { name: text() });
  const result = declaredTableNames([Widget]);
  assert.deepStrictEqual(result, ['Widget']);
  assert.ok(Object.isFrozen(result));
});

test('declaredTableNames — entity with map(ref) yields main + side table, sorted/frozen', () => {
  const Project = entity('Project', {
    name: text(),
    members: map(ref('User'), { role: 'member' }),
  });
  const result = declaredTableNames([Project]);
  assert.deepStrictEqual(result, ['Project', 'Project_members']);
  assert.ok(Object.isFrozen(result));
});

test('declaredTableNames — multiple entities are unioned', () => {
  const A = entity('A', { label: text() });
  const B = entity('B', { label: text() });
  const result = declaredTableNames([A, B]);
  assert.deepStrictEqual(result, ['A', 'B']);
});

test('declaredTableNames — case-insensitive table collisions throw clearly', () => {
  const Foo = entity('Foo', { x: text() });
  const foo = entity('foo', { x: text() });
  assert.throws(
    () => declaredTableNames([Foo, foo]),
    /duplicate.*(?:Foo|foo)/i,
  );
});
