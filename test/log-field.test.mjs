// RED-first contract for the `log` field constructor (Slice A2 'continue all'
// sub-piece 4). doc.mjs declares:
//
//   chat: log({ sender: ref('User'), body: text() })   // append-only; emits :appended:<id>
//
// `log` is an append-only, internally-keyed owned collection of STRUCTURED
// entries — each entry has named sub-fields (here `sender` a User FK + `body`
// text). Like `map`, it is the `store` KIND's owned-collection (an owned
// relation is a field on the entity, not a join table — AGENTS), distinguished
// as `type: 'log'`. Its per-entry shape is the declared `entry` descriptor map.
//
// SCOPE = import-surface only (mirrors map/Inbox import-now-wiring-later): this
// delivers the `log` symbol + a descriptor the entity compiler accepts at load.
// The append mutation, the `:appended:<id>` event handle, and any per-entry
// query are the `store` kind's Phase-2 behavior (its strategy apply/diff already
// fail closed loud Phase-2). A `store`-kind field is correctly NOT whole-value
// comparable in scope (the existing fieldHandle non-value gate throws).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, log, ref, text, scope, everyone, grant, read } from '../src/index.mjs';

test('log() returns a frozen store-kind descriptor of type log', () => {
  const descriptor = log({ sender: ref('User'), body: text() });
  assert.equal(descriptor.kind, 'store');
  assert.equal(descriptor.type, 'log');
  assert.ok(Object.isFrozen(descriptor));
});

test('log() carries its per-entry sub-field descriptors', () => {
  const descriptor = log({ sender: ref('User'), body: text() });
  assert.ok(descriptor.entry, 'descriptor exposes the entry shape');
  assert.equal(descriptor.entry.sender.type, 'ref');
  assert.equal(descriptor.entry.sender.target, 'User');
  assert.equal(descriptor.entry.body.type, 'text');
});

test('log() entry shape is frozen (a declared shape is immutable)', () => {
  const descriptor = log({ sender: ref('User'), body: text() });
  assert.ok(Object.isFrozen(descriptor.entry));
});

test('.can(fn) returns a new frozen descriptor carrying the access function', () => {
  const fn = () => grant(read);
  const descriptor = log({ sender: ref('User'), body: text() }).can(fn);
  assert.equal(descriptor.access, fn);
  assert.ok(Object.isFrozen(descriptor));
  assert.equal(descriptor.kind, 'store');
  assert.equal(descriptor.type, 'log');
});

test('a log field compiles into an entity at import without throwing', () => {
  const Doc = entity('DocWithLog', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      chat: log({ sender: ref('User'), body: text() }),
    },
  });
  assert.equal(Doc.name, 'DocWithLog');
});

test('a log field is not whole-value comparable in scope (fail closed)', () => {
  const Doc = entity('DocWithLog2', {
    grant: scope(() => everyone()).can(() => grant(read)),
    fields: {
      chat: log({ sender: ref('User'), body: text() }),
    },
  });
  assert.throws(() => Doc.chat.is('x'), /store field and cannot be compared/);
});
