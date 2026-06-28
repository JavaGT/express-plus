// `admin` capability token (SPEC §6). The exemplar doc.mjs confers an
// OWNER capability set [read, write, subscribe, admin]; `admin` must be a
// distinct, typed, frozen capability token exported from the package, on par
// with read/write/subscribe (authorization is typed tokens, never strings).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admin, read, write, subscribe, grant } from '../src/index.mjs';

test('admin is a distinct frozen capability token', () => {
  assert.ok(admin, 'admin is exported');
  assert.equal(typeof admin, 'object');
  assert.ok(Object.isFrozen(admin), 'admin token is frozen');
  // distinct identity from the other capabilities (compared by identity, not string)
  assert.notEqual(admin, read);
  assert.notEqual(admin, write);
  assert.notEqual(admin, subscribe);
});

test('admin participates in a grant capability set by identity', () => {
  const decision = grant(read, write, subscribe, admin);
  assert.equal(decision.granted, true);
  assert.ok(decision.capabilities.includes(admin), 'grant carries the admin token by identity');
});
