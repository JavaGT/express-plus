import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scopeOf,
  parseScopeKey,
  tryParseScopeKey,
  isScopeHandle,
} from '../src/scope-handle.mjs';

test('scopeOf builds a frozen Scope handle with stable key', () => {
  const h = scopeOf('Note', 'abc-123');
  assert.deepEqual(
    { brand: h.brand, entity: h.entity, id: h.id, key: h.key },
    { brand: 'scope-handle', entity: 'Note', id: 'abc-123', key: 'Note:abc-123' },
  );
  assert.equal(String(h), 'Note:abc-123');
  assert.ok(Object.isFrozen(h));
  assert.equal(isScopeHandle(h), true);
});

test('scopeOf stringifies non-string ids', () => {
  assert.equal(scopeOf('Note', 42).key, 'Note:42');
  assert.equal(scopeOf('Note', 42).id, '42');
});

test('scopeOf preserves colons inside the id (first colon is the separator)', () => {
  const h = scopeOf('Note', 'a:b:c');
  assert.equal(h.key, 'Note:a:b:c');
  assert.equal(h.entity, 'Note');
  assert.equal(h.id, 'a:b:c');
  assert.deepEqual(parseScopeKey(h.key), h);
});

test('parseScopeKey round-trips scope keys into handles', () => {
  const h = parseScopeKey('Project:p1');
  assert.equal(h.entity, 'Project');
  assert.equal(h.id, 'p1');
  assert.equal(h.key, 'Project:p1');
});

test('malformed scope keys fail closed; tryParse returns null', () => {
  assert.throws(() => parseScopeKey(''), /invalid scope key/);
  assert.throws(() => parseScopeKey('NoColon'), /invalid scope key/);
  assert.throws(() => parseScopeKey(':id'), /invalid scope key/);
  assert.throws(() => parseScopeKey('Entity:'), /invalid scope key/);
  assert.throws(() => parseScopeKey(null), /scope key must be a string/);
  assert.equal(tryParseScopeKey('NoColon'), null);
  assert.equal(tryParseScopeKey('Entity:id')?.key, 'Entity:id');
});

test('scopeOf rejects empty or dotted entity names', () => {
  assert.throws(() => scopeOf('', 'x'), /scope entity/);
  assert.throws(() => scopeOf('A.B', 'x'), /scope entity/);
  assert.throws(() => scopeOf('A:B', 'x'), /scope entity/);
  assert.throws(() => scopeOf('Note', ''), /scope id/);
  assert.throws(() => scopeOf('Note', null), /scope id/);
});
