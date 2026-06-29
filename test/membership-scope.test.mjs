// E2-A: the compile (scope→SQL) side of map membership as a compilable check.
//
// A `map` field (the `store` kind, `type: 'map'`) is an owned membership
// collection living in a side-table `<Entity>_<field>`. Whole-value comparison
// of the map in scope is still forbidden (`.is/.in/.isNull` throw — a map is not
// a scalar). But MEMBERSHIP is a compilable fact: `Entity.<field>.has(principal.id)`
// lowers to a correlated EXISTS over the membership side-table, keyed to the
// principalId param the query layer rebinds per request.
//
// This is the bridge that lets a declared check
//   collaborator: ({ TodoList, principal }) => TodoList.collaborators.has(principal.id)
// be used inside `scope(...)` — harvested ONCE to SQL, never run per row. The
// declared check is reached through an entity-NAME-keyed self handle injected by
// the harvester (the same name the developer wrote), so `.has()` knows which
// entity owns the membership table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entity, ref, text, map, scope, grant, read, anyOf } from '../src/index.mjs';

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

test('a map field membership check compiles to a correlated EXISTS over the side-table', () => {
  const TodoList = entity('TodoList', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner' }),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    checks: {
      // entity-name-keyed self handle: `TodoList` is the entity itself; `.has`
      // tests membership of `principal.id` in the collaborators side-table.
      collaborator: ({ TodoList, principal }) => TodoList.collaborators.has(principal.id),
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.collaborator())).can(() => grant(read)),
    ],
  });

  const s = norm(TodoList.readScope.sql);
  // owner half: the FK column equals the principalId param (existing path).
  assert.match(s, /owner = :p\d+_principalId/);
  // collaborator half: a correlated EXISTS over the membership side-table.
  assert.match(s, /EXISTS \(/i);
  assert.match(s, /FROM TodoList_collaborators/i);
  // the side-table row must belong to THIS entity row (owner-fk col = t0.id) ...
  assert.match(s, /TodoList_id = t0\.id/i);
  // ... and its member must be the requesting principal (the rebindable param).
  assert.match(s, /member_id = :p\d+_principalId/i);
});

test('the membership scope keeps the principalId placeholder for bindReadScope', () => {
  const TodoList = entity('TodoList', {
    fields: {
      owner: ref('User', { role: 'owner' }),
      collaborators: map(ref('User'), { role: ['viewer'], default: {} }),
    },
    checks: {
      collaborator: ({ TodoList, principal }) => TodoList.collaborators.has(principal.id),
    },
    grant: () => [
      scope(({ is }) => is.collaborator()).can(() => grant(read)),
    ],
  });

  // exactly the principalId placeholder(s) remain null in the compiled template
  // (bindReadScope fills every `_principalId` key with the concrete principal id).
  const keys = Object.keys(TodoList.readScope.params);
  assert.ok(keys.length >= 1);
  for (const k of keys) {
    assert.ok(k.endsWith('_principalId'), `expected only principalId params, saw '${k}'`);
  }
});

test('a map field is still NOT whole-value comparable in scope (.is throws, .has does not)', () => {
  const Doc = entity('Doc', {
    fields: {
      owner: ref('User', { role: 'owner' }),
      collaborators: map(ref('User'), { role: ['viewer'] }),
    },
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });
  // whole-value ops remain fail-closed ...
  assert.throws(() => Doc.collaborators.is('x'), /store field and cannot be compared/);
  assert.throws(() => Doc.collaborators.in(['x']), /store field and cannot be compared/);
  assert.throws(() => Doc.collaborators.isNull(), /store field and cannot be compared/);
  // ... but membership is a compilable op and must NOT throw at handle level.
  assert.doesNotThrow(() => Doc.collaborators.has('some-user-id'));
});
