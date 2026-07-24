// Phase 1 — the field-type persistence strategy + validate-as-pipeline-stage.
//
// SPEC §5.1 (named-whole plugin contracts), §7 stage 1 (validate), §7.2 (the
// field-type plugin owns the persistence strategy). Each KIND (value/store/crdt/
// ordered/struct) is a named whole owning its own {validate, apply} machinery,
// resolved by kind from one framework-owned table — the descriptor carries only
// its kind (deletion test: kind ABSORBS the strategy, no per-field config object).
// NOTE: only value/state/crdt/store/struct carry a `diff` (snapshot delta);
// `ordered` has NO `strategy.diff` — its delta contract is the native per-op
// identity-keyed events (DECISIONLOG #74 — VESTIGIAL, deleted orderedListDiff).
//
// The mutation pipeline's stage 1 (validate) runs each field's structural +
// declared validate over a payload and throws a typed ValidationError naming the
// field path + reason BEFORE any apply — a bad payload never proceeds (fail
// closed). Grounded against note.mjs (text.crdt body, ref owner) and the blog
// spine's value fields.

import { text, ref, boolean, date, json, grant, scope, read, write, subscribe, everyone } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity } from '../src/internal.mjs';
import { resolveStrategy, validateMutation, ValidationError, serializeField, deserializeField } from '../src/field-strategy.mjs';

// --- the strategy table is keyed by kind, framework-owned ---

test('resolveStrategy(kind) returns the named-whole strategy for each kind', () => {
  // value/store/crdt are snapshot-diff-bearing kinds: {validate, apply, diff}.
  for (const kind of ['value', 'store', 'crdt']) {
    const strategy = resolveStrategy(kind);
    assert.equal(typeof strategy.validate, 'function', `${kind}.validate`);
    assert.equal(typeof strategy.apply, 'function', `${kind}.apply`);
    assert.equal(typeof strategy.diff, 'function', `${kind}.diff`);
  }
  // ordered has NO strategy.diff — its delta contract is the native per-op
  // identity-keyed events (.inserted/.moved/.reordered/.removed), NOT a
  // whole-list snapshot diff (DECISIONLOG #74 — VESTIGIAL: deleted
  // orderedListDiff). The absent `.diff` is the structural declaration of
  // "ordered is per-op, not snapshot"; computeDelta's DIFF_ELIGIBLE set
  // (field-delta.mjs) enforces it never reaches this (absent) `.diff`.
  const ordered = resolveStrategy('ordered');
  assert.equal(typeof ordered.validate, 'function', 'ordered.validate');
  assert.equal(typeof ordered.apply, 'function', 'ordered.apply');
  assert.equal(ordered.diff, undefined, 'ordered has no strategy.diff (per-op events, not snapshot)');
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

// --- crdt/store/ordered: known names and operation boundaries ---

test('text crdt rejects whole values and whole-value diffs', () => {
  const crdt = resolveStrategy('crdt');
  assert.equal(crdt.validate('hello', text.crdt()), 'text.crdt accepts native operations only');
  assert.equal(crdt.apply('a', 'b'), 'b');
  assert.throws(() => crdt.diff('hello', 'hello!'), /field\.apply/);
});

// --- validate-as-pipeline-stage over an entity's declared fields ---

function makeArticle() {
  return entity('Article', {
        title: text({ validate: (s) => s.length <= 10 || 'title too long' }),
    published: boolean({ default: false }),
    owner: ref('User', { role: 'owner', readonly: true }),
    blog: ref('Blog', { required: true }),

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

test('validateMutation accepts JSON values and rejects non-JSON payloads', () => {
  const Document = entity('Document', {
        meta: json(),

    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  assert.deepEqual(validateMutation(Document, {
    meta: { tags: ['research'], score: 1, nested: { ok: true }, empty: null },
  }), {
    meta: { tags: ['research'], score: 1, nested: { ok: true }, empty: null },
  });

  assert.throws(
    () => validateMutation(Document, { meta: { bad: undefined } }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /Document\.meta/);
      assert.match(err.message, /JSON value/);
      return true;
    },
  );

  assert.throws(
    () => validateMutation(Document, { meta: Number.POSITIVE_INFINITY }),
    /JSON value/,
  );

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => validateMutation(Document, { meta: circular }),
    /JSON value/,
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

test('validateMutation accepts null only for an explicitly nullable field', () => {
  const NullableNote = entity('NullableNote', {
    note: text({ optional: true, nullable: true }),
    label: text({ optional: true }),
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  assert.deepEqual(validateMutation(NullableNote, { note: null }), { note: null });
  assert.throws(() => validateMutation(NullableNote, { label: null }), /expected a text value/);
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

test('json fields serialize to TEXT and deserialize back to JSON values', () => {
  const descriptor = json({ tags: 'string[]' });
  const value = { tags: ['research', 'scope'], score: 42, ok: true, nested: null };
  const stored = serializeField(descriptor, value);

  assert.equal(stored, JSON.stringify(value));
  assert.deepEqual(deserializeField(descriptor, stored), value);
  assert.equal(deserializeField(descriptor, null), null);
});
