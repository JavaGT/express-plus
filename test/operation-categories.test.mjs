// S5/A1 — the stable operation-category vocabulary (src/operation.ts).
//
// The invariant under test: categories are frozen identity tokens (the same
// discipline as grant capabilities), the verb→category table is the one
// normalization source for route verbs, every category round-trips through
// operationCategory(), and an unknown name fails closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  read, subscribe, create, update, deleteOp, execute, search, blobRead, administrative,
  operationCategory, OPERATION_CATEGORIES,
} from '../build/operation.mjs';
// The stable-vocabulary aliases (`delete` is a reserved word, `blob-read` is
// hyphenated): same tokens as deleteOp / blobRead, proven in the alias test.
import { delete as deleteAlias, 'blob-read' as blobReadAlias } from '../build/operation.mjs';

test('operation categories are frozen identity tokens', () => {
  for (const category of OPERATION_CATEGORIES) {
    assert.ok(Object.isFrozen(category), `category ${category.operation} is frozen`);
    assert.equal(typeof category.operation, 'string');
  }
  // Identity: all nine categories are distinct tokens (never two equal objects).
  assert.equal(OPERATION_CATEGORIES.length, 9);
  assert.equal(new Set(OPERATION_CATEGORIES).size, 9);
});

test('every operation category round-trips through operationCategory()', () => {
  for (const category of OPERATION_CATEGORIES) {
    assert.equal(operationCategory(category.operation), category);
  }
});

test('verb→category table maps every route verb without changing engine behavior', () => {
  assert.equal(operationCategory('list'), read);
  assert.equal(operationCategory('read'), read);
  assert.equal(operationCategory('create'), create);
  assert.equal(operationCategory('update'), update);
  assert.equal(operationCategory('remove'), deleteOp);
  assert.equal(operationCategory('subscribe'), subscribe);
  assert.equal(operationCategory('admin'), administrative);
});

test('the non-verb categories are the stable downstream set', () => {
  assert.equal(execute.operation, 'execute');
  assert.equal(search.operation, 'search');
  assert.equal(blobRead.operation, 'blob-read');
  assert.equal(administrative.operation, 'administrative');
  assert.equal(deleteOp.operation, 'delete');
});

test('unknown verb fails closed', () => {
  assert.throws(() => operationCategory('list-all'), /unknown operation/);
  assert.throws(() => operationCategory('nope'), /unknown operation/);
  assert.throws(() => operationCategory(''), /unknown operation/);
});

test('an inherited Object.prototype key fails closed (no prototype masquerade)', () => {
  // VERB_CATEGORY is a null-prototype object with an own-property check, so a
  // name the vocabulary never declared can never resolve through the prototype
  // chain into a truthy "category".
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
    assert.throws(() => operationCategory(key), /unknown operation/, `${key} must fail closed`);
  }
});

test('the stable-vocabulary aliases are the same tokens (delete / blob-read)', () => {
  // `delete` and `blob-read` are the exact spellings the operation strings
  // name; deleteOp / blobRead are the canonical identifiers in code. Both
  // spellings resolve to the SAME frozen token.
  assert.equal(deleteOp.operation, 'delete');
  assert.equal(blobRead.operation, 'blob-read');
  assert.equal(deleteAlias, deleteOp);
  assert.equal(blobReadAlias, blobRead);
  assert.equal(operationCategory('delete'), deleteOp);
  assert.equal(operationCategory('blob-read'), blobRead);
});
