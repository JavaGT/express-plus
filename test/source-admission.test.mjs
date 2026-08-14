// Source-based admission helpers — unit tests for effectSource.
//
// principalFrom was REMOVED (S5/A5 kill decision, workbench#75): the scheduler
// clock dispatch now mints `machinePrincipal({ id, operations })` instead of an
// id-less system principal. effectSource remains the effects admission helper.
// See test/principal-from.test.mjs for the kill-decision assertions and
// test/machine-principal.test.mjs for the attributable replacement.
//
// Import pattern mirrors effects-auth.test.mjs (explicit relative imports).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { principal, effectSource } from '../build/internal.mjs';

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

test('effectSource admits an effect principal with matching source entity', () => {
  const check = effectSource('Blog.publish');
  const p = principal({ type: 'system', attributes: { effect: 'Blog.publish' } });
  assert.equal(check({ principal: p }), true);
});

test('effectSource rejects an effect principal with a mismatched source entity', () => {
  const check = effectSource('Blog.publish');
  const p = principal({ type: 'system', attributes: { effect: 'Blog.other' } });
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

test('effectSource rejects system principal with no effect attribute', () => {
  const check = effectSource('Blog.publish');
  const p = principal({ type: 'system' });
  assert.equal(check({ principal: p }), false);
});

// ---- integration-style test ----

test('integration: fake target admits matching source, rejects mismatch', () => {
  const target = {
    admitsEffects: ({ principal }) => effectSource('Blog.publish')({ principal }),
  };

  const matching = principal({ type: 'system', attributes: { effect: 'Blog.publish' } });
  const mismatch = principal({ type: 'system', attributes: { effect: 'Blog.other' } });

  assert.equal(target.admitsEffects({ principal: matching }), true, 'admits matching source');
  assert.equal(target.admitsEffects({ principal: mismatch }), false, 'rejects mismatched source');
});
