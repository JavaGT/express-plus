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
