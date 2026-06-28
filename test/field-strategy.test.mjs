// Phase 1 — the field-type persistence strategy + validate-as-pipeline-stage.
//
// SPEC §5.1 (named-whole plugin contracts), §7 stage 1 (validate), §7.2 (the
// field-type plugin owns the persistence strategy). Each KIND (value/store/crdt/
// ordered) is a named whole owning its own {validate, apply, diff} machinery,
// resolved by kind from one framework-owned table — the descriptor carries only
// its kind (deletion test: kind ABSORBS the strategy, no per-field config object).
//
// The mutation pipeline's stage 1 (validate) runs each field's structural +
// declared validate over a payload and throws a typed ValidationError naming the
// field path + reason BEFORE any apply — a bad payload never proceeds (fail
// closed). Grounded against note.mjs (text.crdt body, ref owner) and the blog
// spine's value fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, text, ref, boolean, date, grant, scope, read, write, subscribe } from '../src/index.mjs';
import { resolveStrategy, validateMutation, ValidationError, serializeField } from '../src/field-strategy.mjs';

// --- the strategy table is keyed by kind, framework-owned ---

test('resolveStrategy(kind) returns the named-whole strategy for each kind', () => {
  for (const kind of ['value', 'store', 'crdt', 'ordered']) {
    const strategy = resolveStrategy(kind);
    assert.equal(typeof strategy.validate, 'function', `${kind}.validate`);
    assert.equal(typeof strategy.apply, 'function', `${kind}.apply`);
    assert.equal(typeof strategy.diff, 'function', `${kind}.diff`);
  }
});

test('resolveStrategy throws on an unknown kind (fail closed, not a silent default)', () => {
  assert.throws(() => resolveStrategy('nonsense'), /unknown field kind/i);
});

// --- the value strategy: whole-value apply + diff (the blog-spine path) ---

test('value strategy apply replaces the whole value', () => {
  const { apply } = resolveStrategy('value');
  assert.equal(apply('old', 'new'), 'new');
});

test('value strategy diff is a whole-value set, null when unchanged', () => {
  const { diff } = resolveStrategy('value');
  assert.deepEqual(diff('a', 'b'), { set: 'b' });
  assert.equal(diff('a', 'a'), null, 'an unchanged value produces no diff');
});

// --- crdt/store/ordered: known names, validate works, merge is Phase 2 ---

test('crdt strategy validates structurally but its merge is a loud Phase-2 throw', () => {
  const crdt = resolveStrategy('crdt');
  assert.doesNotThrow(() => crdt.validate('hello', text.crdt()));
  assert.throws(() => crdt.apply('a', 'b'), /crdt.*phase 2/i);
  assert.throws(() => crdt.diff('a', 'b'), /crdt.*phase 2/i);
});

// --- validate-as-pipeline-stage over an entity's declared fields ---

function makeArticle() {
  return entity('Article', {
    fields: {
      title: text({ validate: (s) => s.length <= 10 || 'title too long' }),
      published: boolean({ default: false }),
      owner: ref('User', { role: 'owner', readonly: true }),
      blog: ref('Blog', { required: true }),
    },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

test('validateMutation passes a well-formed payload through untouched', () => {
  const Article = makeArticle();
  const payload = { title: 'hello', published: true };
  assert.deepEqual(validateMutation(Article, payload), payload);
});

test('validateMutation throws ValidationError naming the field path + reason on a declared-validate reject', () => {
  const Article = makeArticle();
  assert.throws(
    () => validateMutation(Article, { title: 'this title is way too long' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Article\.title/);
      assert.match(err.message, /title too long/);
      return true;
    },
  );
});

test('validateMutation throws on a structural type mismatch (boolean given a string)', () => {
  const Article = makeArticle();
  assert.throws(
    () => validateMutation(Article, { published: 'yes' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Article\.published/);
      return true;
    },
  );
});

test('validateMutation ignores fields absent from the payload (partial update)', () => {
  const Article = makeArticle();
  // a partial update touching only `published` must not trip `title`'s validate.
  assert.deepEqual(validateMutation(Article, { published: true }), { published: true });
});

test('validateMutation rejects a payload key that is not a declared field (fail closed)', () => {
  const Article = makeArticle();
  assert.throws(
    () => validateMutation(Article, { nonsense: 1 }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /nonsense/);
      assert.match(err.message, /not a declared field/i);
      return true;
    },
  );
});

// --- field-option enforcement at the validate seam (the untrusted-payload rules) ---

test('validateMutation rejects a client write to a readonly field (owner is set server-side)', () => {
  // `readonly` is an untrusted-payload rule: a client may not set or change the
  // field directly. The framework fills it server-side (e.g. owner from the
  // session) in the write path. A payload that names a readonly field is rejected
  // at the validate seam — the seam that already sees the untrusted payload.
  const Article = makeArticle();
  assert.throws(
    () => validateMutation(Article, { owner: 'mallory' }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Article\.owner/);
      assert.match(err.message, /readonly/i);
      return true;
    },
  );
});

test('validateMutation rejects clearing a required field to null/undefined (payload-visible requiredness)', () => {
  // A required field is a final-record invariant. The validate seam enforces the
  // part it can see: a payload may not explicitly CLEAR a required field (set it
  // to null/undefined). Final requiredness on create — was the field supplied by
  // payload OR route OR principal OR default — is the write path's job (Phase 2),
  // where all the sources are merged.
  const Article = makeArticle();
  assert.throws(
    () => validateMutation(Article, { blog: null }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Article\.blog/);
      assert.match(err.message, /required/i);
      return true;
    },
  );
});

test('validateMutation still allows a partial update that does not touch readonly/required fields', () => {
  // Enforcement must not break partial updates: a payload touching only `title`
  // is fine even though owner is readonly and blog is required — absent ≠ cleared.
  const Article = makeArticle();
  assert.deepEqual(validateMutation(Article, { title: 'hello' }), { title: 'hello' });
});

// --- serializeField: the value-kind's value→stored-cell mapping ---
// SPEC §7.2: the field-type plugin owns the persistence strategy. node:sqlite
// refuses to bind a JS boolean and has no boolean type, so a `boolean` field
// becomes the integer 1/0. The SAME serialize that the write path will use also
// bakes a scope literal (fields.published.is(true)) into a bindable param — one
// place owns "how a value-kind field becomes a stored cell" (singular system).

test('serializeField maps a boolean to the integer 1/0 (sqlite has no boolean type)', () => {
  assert.equal(serializeField(boolean(), true), 1);
  assert.equal(serializeField(boolean(), false), 0);
});

test('serializeField passes text and ref values through unchanged', () => {
  assert.equal(serializeField(text(), 'hello'), 'hello');
  assert.equal(serializeField(ref('User'), 'user-1'), 'user-1');
});

test('serializeField maps a Date to a bindable stored form (epoch millis)', () => {
  const d = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(serializeField(date(), d), d.getTime());
  // a value already in stored form (number/string) passes through.
  assert.equal(serializeField(date(), 1735689600000), 1735689600000);
});

test('serializeField leaves null/undefined untouched (a null cell is null)', () => {
  assert.equal(serializeField(boolean(), null), null);
  assert.equal(serializeField(text(), undefined), undefined);
});
