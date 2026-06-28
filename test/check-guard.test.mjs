import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  check,
  resolveDecision,
  assertGuarded,
  UnawaitedCheckError,
} from '../src/index.mjs';

// Phase 0 — the async `is.*` guard (SPEC §6.1, §13; ADR #16).
//
// A check is a per-entity named fact: a plain, awaitable function like
// `is.owner()`. The foot-gun (SPEC §13 "Load-bearing guards"): an UNAWAITED
// `is.author() || is.blogOwner()` over two pending promises returns the first
// (always-truthy) promise and silently grants everyone.
//
// ADR #16: JavaScript cannot make a value throw on boolean coercion
// (`ToBoolean(object)` is always true, no hook), so the guard is two layers:
// (1) a RUNTIME BACKSTOP on the value a grant body resolves to, and
// (2) LOAD-TIME STATIC ANALYSIS of the grant body's source.

test('an awaited check resolves to its boolean result', async () => {
  const isOwner = check(async () => true);
  assert.equal(await isOwner(), true);

  const isEditor = check(async () => false);
  assert.equal(await isEditor(), false);
});

test('a check coerces a truthy/falsy result to a strict boolean', async () => {
  const isOwner = check(async () => 'yes');
  assert.equal(await isOwner(), true);

  const isEditor = check(() => 0);
  assert.equal(await isEditor(), false);
});

// Layer (1): runtime backstop.

test('a grant body that returns an un-awaited check throws UnawaitedCheckError', async () => {
  const isOwner = check(async () => false);
  // The body forgot `await`: it returns the check's promise as the decision.
  const body = () => isOwner();
  await assert.rejects(() => resolveDecision(body), UnawaitedCheckError);
});

test('a grant body using un-awaited `||` throws (the classic foot-gun)', async () => {
  const isAuthor = check(async () => false);
  const isBlogOwner = check(async () => false);
  // `is.author() || is.blogOwner()` yields the first pending promise — the
  // decision is a thenable, so the backstop fails closed.
  const body = () => isAuthor() || isBlogOwner();
  await assert.rejects(() => resolveDecision(body), UnawaitedCheckError);
});

test('a correctly-awaited grant body resolves to a boolean decision', async () => {
  const isAuthor = check(async () => false);
  const isBlogOwner = check(async () => true);
  const body = async () => (await isAuthor()) || (await isBlogOwner());
  assert.equal(await resolveDecision(body), true);
});

// Layer (2): load-time static analysis.

test('static analysis rejects a grant body calling is.* without await', () => {
  const body = ({ is }) => is.author() || is.blogOwner();
  assert.throws(() => assertGuarded(body), UnawaitedCheckError);
});

test('static analysis accepts a grant body that awaits every check', () => {
  const body = async ({ is }) => (await is.author()) || (await is.blogOwner());
  assert.doesNotThrow(() => assertGuarded(body));
});

test('static analysis ignores is.* inside comments and strings', () => {
  const body = async ({ is }) => {
    // a stray is.owner() in a comment must not trip the scan
    const note = 'see is.author() in the docs';
    return (await is.owner()) ? note : false;
  };
  assert.doesNotThrow(() => assertGuarded(body));
});

test('UnawaitedCheckError carries the offending check name', () => {
  const body = ({ is }) => is.owner();
  try {
    assertGuarded(body);
    assert.fail('expected assertGuarded to throw');
  } catch (err) {
    assert.ok(err instanceof UnawaitedCheckError);
    assert.equal(err.check, 'owner');
    assert.match(err.message, /owner/);
  }
});
