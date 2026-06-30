// Source-based admission helpers — unit tests for principalFrom and effectSource.
//
// These helpers support the scheduler/tick analogue by providing authoring
// utilities for minting and checking bounded system principals tagged with a
// source identifier. Tests cover construction, validation, and the intended
// admitsEffects integration pattern.
//
// Import pattern mirrors effects-auth.test.mjs (explicit relative imports).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { principal, principalFrom, effectSource } from '../src/index.mjs';

// ---- principalFrom construction ----

test('principalFrom(source) returns a frozen system principal with attributes.source', () => {
  const p = principalFrom('Blog.publish');
  assert.equal(p.type, 'system');
  assert.equal(p.id, null);
  assert.equal(p.attributes.source, 'Blog.publish');
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.attributes));
});

test('principalFrom rejects empty string', () => {
  assert.throws(
    () => principalFrom(''),
    Error,
    'principalFrom(source): source must be a non-empty string',
  );
});

test('principalFrom rejects non-string: number', () => {
  assert.throws(
    () => principalFrom(123),
    Error,
    'principalFrom(source): source must be a non-empty string',
  );
});

test('principalFrom rejects non-string: null', () => {
  assert.throws(
    () => principalFrom(null),
    Error,
    'principalFrom(source): source must be a non-empty string',
  );
});

test('principalFrom rejects non-string: undefined', () => {
  assert.throws(
    () => principalFrom(undefined),
    Error,
    'principalFrom(source): source must be a non-empty string',
  );
});

test('principalFrom rejects non-string: object', () => {
  assert.throws(
    () => principalFrom({}),
    Error,
    'principalFrom(source): source must be a non-empty string',
  );
});

// ---- effectSource construction ----

test('effectSource(source) returns a function', () => {
  const fn = effectSource('Blog.publish');
  assert.equal(typeof fn, 'function');
});

test('effectSource rejects empty string at construction', () => {
  assert.throws(
    () => effectSource(''),
    Error,
    'effectSource(source): source must be a non-empty string',
  );
});

test('effectSource rejects null at construction', () => {
  assert.throws(
    () => effectSource(null),
    Error,
    'effectSource(source): source must be a non-empty string',
  );
});

// ---- effectSource runtime admission ----

test('effectSource admits principalFrom with matching source', () => {
  const check = effectSource('Blog.publish');
  const p = principalFrom('Blog.publish');
  assert.equal(check({ principal: p }), true);
});

test('effectSource rejects principalFrom with mismatched source', () => {
  const check = effectSource('Blog.publish');
  const p = principalFrom('Blog.other');
  assert.equal(check({ principal: p }), false);
});

test('effectSource rejects a user principal (non-system)', () => {
  const check = effectSource('Blog.publish');
  const userPrincipal = principal({ type: 'user', id: 'u1' });
  assert.equal(check({ principal: userPrincipal }), false);
});

test('effectSource rejects nullish principal', () => {
  const check = effectSource('Blog.publish');
  assert.equal(check({ principal: null }), false);
});

test('effectSource rejects system principal with no source attribute', () => {
  const check = effectSource('Blog.publish');
  const p = principal({ type: 'system' });
  assert.equal(check({ principal: p }), false);
});

// ---- integration-style test ----

test('integration: fake target admits matching source, rejects mismatch', () => {
  const target = {
    admitsEffects: ({ principal }) => effectSource('Blog.publish')({ principal }),
  };

  const matching = principalFrom('Blog.publish');
  const mismatch = principalFrom('Blog.other');

  assert.equal(target.admitsEffects({ principal: matching }), true, 'admits matching source');
  assert.equal(target.admitsEffects({ principal: mismatch }), false, 'rejects mismatched source');
});
