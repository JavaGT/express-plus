// Phase 1 — the field-type plugin contract.
//
// A field constructor (text, ref, boolean, date, ...) returns a FIELD
// DESCRIPTOR: an immutable record carrying the field's kind (one of the four
// named-whole contracts value/store/crdt/ordered per ADR #9), its persistence
// strategy, and its declared options (validate, default, role, readonly,
// required). The fluent `.can(fn)` chains onto a descriptor and returns a NEW
// descriptor with the access function attached — it never mutates the original.
//
// These tests pin the contract the mutation pipeline and entity compiler build
// on. Source of truth: SPEC §5.1 (field types), §5.4 (field access), §13
// Phase 1. Grounded against note.mjs and comment.mjs.

import { ref, boolean, date, json, read, write, subscribe, grant } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { text } from '../src/internal.mjs';

test('text() returns a value-kind field descriptor', () => {
  const f = text();
  assert.equal(f.kind, 'value');
});

test('text.crdt() returns a crdt-kind field descriptor', () => {
  const f = text.crdt();
  assert.equal(f.kind, 'crdt');
});

test('the four named-whole kinds are distinct, not a flag enum', () => {
  // value/store/crdt/ordered are distinguished by genuinely distinct machinery
  // (ADR #9). The kind names the contract; the type names the instance. text and
  // ref are two value-kind instances (both store a single value), distinguished
  // by type, not kind. text vs text.crdt are different kinds (value vs crdt).
  assert.notEqual(text().kind, text.crdt().kind);
  assert.equal(text().kind, 'value');
  assert.equal(text.crdt().kind, 'crdt');
  assert.notEqual(text().type, ref('User').type);
});

test('ref(Target) records its target for the typed FK', () => {
  const f = ref('Doc', { required: true });
  assert.equal(f.kind, 'value');
  assert.equal(f.target, 'Doc');
  assert.equal(f.required, true);
});

test('ref(Target, {role}) records the role so the compiler can derive is.<role>()', () => {
  const f = ref('User', { role: 'owner', readonly: true });
  assert.equal(f.role, 'owner');
  assert.equal(f.readonly, true);
});

test('boolean({default}) and date({default}) record their default', () => {
  const b = boolean({ default: false });
  assert.equal(b.kind, 'value');
  assert.equal(b.default, false);

  const now = () => new Date(0);
  const d = date({ default: now });
  assert.equal(d.default, now);
});

test('json(shape, options) returns a value-kind json descriptor', () => {
  const shape = { embedding: 'number[]', meta: 'object' };
  const fallback = () => ({ embedding: [], meta: {} });
  const f = json(shape, { default: fallback });

  assert.equal(f.kind, 'value');
  assert.equal(f.type, 'json');
  assert.equal(f.shape, shape);
  assert.equal(f.default, fallback);
  assert.ok(Object.isFrozen(f));
});

test('text({validate}) records its validate function', () => {
  const v = (s) => s.length <= 10 || 'too long';
  const f = text({ validate: v });
  assert.equal(f.validate, v);
});

test('a field with no .can has no access function (strong-inherits row grant)', () => {
  // ADR #4: a field without .can is readable exactly when the row is readable.
  // The descriptor carries no access function; the compiler reads that as
  // "inherit the row grant".
  const f = text();
  assert.equal(f.access, undefined);
});

test('.can(fn) returns a NEW descriptor with the access fn attached, leaving the original untouched', () => {
  const base = text();
  const fn = async ({ is }) => (await is.author()) ? grant(read, write, subscribe) : grant(read, subscribe);
  const gated = base.can(fn);

  assert.equal(gated.access, fn);
  assert.equal(base.access, undefined, '.can must not mutate the original descriptor');
  assert.notEqual(gated, base, '.can must return a new descriptor');
  assert.equal(gated.kind, base.kind, 'the new descriptor keeps the kind');
});

test('field descriptors are frozen (immutable)', () => {
  const f = text();
  assert.ok(Object.isFrozen(f));
});
