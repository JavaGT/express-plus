// P6e-2 Slice A — computeDelta tests.
//
// Tests the pure delta-computation core: no I/O, no DB, no live.mjs change.

import { text, ref, hash, link, map, list, log, state, raster, polyline, everyone, grant, scope, read } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entity, computeDelta, createDeltaProjector, created, updated, removed, native } from '../src/internal.mjs';

// --- test entity with one field of each diff-eligible kind plus excluded kinds ---

function makeDoc() {
  return entity('Doc', {
    fields: {
      title: text(),
      status: state({ values: ['draft', 'published', 'archived'] }),
      body: text.crdt(),
      share: link(),
      password: hash(),
      tags: map(ref('Tag')),
      items: list(text()),
    },
    grant: () => [scope(everyone()).can(() => grant(read))],
  });
}

test('computeDelta returns {} when prev == next for all fields', () => {
  const Doc = makeDoc();
  const prev = { title: 'hello', status: 'draft', body: 'abc', share: { token: 't1', tier: 'free' } };
  const next = { title: 'hello', status: 'draft', body: 'abc', share: { token: 't1', tier: 'free' } };
  const result = computeDelta(Doc, prev, next);
  assert.deepEqual(result, {});
});

test('value field: changed title produces { title: { set: next } }', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, { title: 'a' }, { title: 'b' });
  assert.deepEqual(result, { title: { set: 'b' } });
});

test('state field: changed status produces { status: { from, to } }', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, { status: 'draft' }, { status: 'published' });
  assert.deepEqual(result, { status: { from: 'draft', to: 'published' } });
});

test('crdt field: changed body produces an insert delta (NOT a {set})', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, { body: 'hello' }, { body: 'hello world' });
  assert.ok(result.body, 'body should have a delta');
  assert.ok(result.body.insert, 'delta should have an insert op');
  assert.equal(result.body.insert.at, 5);
  assert.equal(result.body.insert.text, ' world');
  assert.equal(result.body.set, undefined, 'crdt delta must NOT be a { set }');
});

test('raster/polyline crdt stubs produce replace deltas and dev diagnostics', () => {
  const Drawing = entity('Drawing', {
    fields: {
      pixels: raster.crdt(),
      stroke: polyline.crdt(),
    },
    grant: () => [scope(everyone()).can(() => grant(read))],
  });
  const diagnostics = [];
  const result = computeDelta(
    Drawing,
    { pixels: 'old-pixels', stroke: [{ x: 0, y: 0 }] },
    { pixels: 'new-pixels', stroke: [{ x: 1, y: 1 }] },
    undefined,
    { diagnostics: (ctx) => diagnostics.push(ctx) },
  );
  assert.deepEqual(result, {
    pixels: { set: 'new-pixels' },
    stroke: { set: [{ x: 1, y: 1 }] },
  });
  assert.deepEqual(diagnostics, [
    { entity: 'Drawing', field: 'pixels', type: 'raster' },
    { entity: 'Drawing', field: 'stroke', type: 'polyline' },
  ]);
});

test('struct field: changed sub-cell produces { cells: { <subCell>: { set: value } } }', () => {
  const Doc = makeDoc();
  const prev = { share: { token: 'old-token', tier: 'free' } };
  const next = { share: { token: 'new-token', tier: 'free' } };
  const result = computeDelta(Doc, prev, next);
  assert.deepEqual(result, {
    share: { cells: { token: { set: 'new-token' } } },
  });
});

test('COLD prev (prevRow = {}): value field set-from-empty', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, {}, { title: 'x' });
  assert.deepEqual(result, { title: { set: 'x' } });
});

test('COLD prev (prevRow = undefined): value field set-from-empty', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, undefined, { title: 'x' });
  assert.deepEqual(result, { title: { set: 'x' } });
});

test('hash field is EXCLUDED: changed hash produces NO entry', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, { password: 'old' }, { password: 'new' });
  // `password` is hash-kind → excluded → not in result
  assert.equal(result.password, undefined);
  // A diff-eligible field that IS unchanged still absent
  assert.deepEqual(result, {});
});

test('store/ordered/map fields EXCLUDED: not in result', () => {
  const Doc = makeDoc();
  const result = computeDelta(
    Doc,
    { tags: { alice: 'viewer' }, items: [{ key: '1', value: 'a' }] },
    { tags: { alice: 'editor' }, items: [{ key: '1', value: 'b' }] },
  );
  assert.equal(result.tags, undefined, 'map (store kind) excluded');
  assert.equal(result.items, undefined, 'list (ordered kind) excluded');
});

test('changedFieldNames honored: only fields in the list are checked', () => {
  const Doc = makeDoc();
  const result = computeDelta(
    Doc,
    { title: 'a', status: 'draft' },
    { title: 'b', status: 'published' },
    ['title'], // only check title — status change should be absent
  );
  assert.deepEqual(result, { title: { set: 'b' } });
});

test('unknown field name in changedFieldNames does not throw (skipped defensively)', () => {
  const Doc = makeDoc();
  // Should not throw even though 'nonexistent' is not in entityRecord.fields
  const result = computeDelta(Doc, { title: 'a' }, { title: 'b' }, ['nonexistent', 'title']);
  assert.deepEqual(result, { title: { set: 'b' } });
});

test('null delta dropped: unchanged value field absent from result even if in changedFieldNames', () => {
  const Doc = makeDoc();
  // title unchanged, status changed — but only title in changedFieldNames
  const result = computeDelta(
    Doc,
    { title: 'a', status: 'draft' },
    { title: 'a', status: 'published' },
    ['title'],
  );
  // title unchanged → value.diff returns null → dropped
  assert.deepEqual(result, {});
});

test('struct field with all sub-cells changed', () => {
  const Doc = makeDoc();
  const prev = { share: { token: 'old-token', tier: 'starter' } };
  const next = { share: { token: 'new-token', tier: 'premium' } };
  const result = computeDelta(Doc, prev, next);
  assert.deepEqual(result, {
    share: { cells: { token: { set: 'new-token' }, tier: { set: 'premium' } } },
  });
});

test('struct field COLD prev: all sub-cells set from empty', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, {}, { share: { token: 't1', tier: 'free' } });
  assert.deepEqual(result, {
    share: { cells: { token: { set: 't1' }, tier: { set: 'free' } } },
  });
});

test('crdt field COLD prev: insert-from-empty delta', () => {
  const Doc = makeDoc();
  const result = computeDelta(Doc, {}, { body: 'hello' });
  assert.ok(result.body, 'body should have a delta');
  assert.ok(result.body.insert, 'cold crdt delta should have an insert op');
  assert.equal(result.body.insert.at, 0);
  assert.equal(result.body.insert.text, 'hello');
});

test('multiple field changes produce a multi-key result', () => {
  const Doc = makeDoc();
  const result = computeDelta(
    Doc,
    { title: 'a', status: 'draft', body: 'hi' },
    { title: 'b', status: 'published', body: 'hi world' },
  );
  assert.ok(result.title);
  assert.ok(result.status);
  assert.ok(result.body);
  assert.equal(result.title.set, 'b');
  assert.deepEqual(result.status, { from: 'draft', to: 'published' });
  assert.ok(result.body.insert, 'crdt body should have an insert op');
});

test('createDeltaProjector: created seeds shadow and returns undefined', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  const event = { handle: created('Doc'), data: { id: 'd1', title: 'a' } };
  assert.equal(projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, event), undefined);
});

test('createDeltaProjector: updated after created diffs against seeded row', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: created('Doc'), data: { id: 'd1', title: 'a' } });
  const delta = projector.project(Doc, 'd1', { id: 'd1', title: 'b' }, { handle: updated('Doc'), data: { id: 'd1', title: 'b' } });
  assert.deepEqual(delta, { title: { set: 'b' } });
});

test('createDeltaProjector: cold updated diffs from empty and seeds', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  const first = projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: updated('Doc'), data: { id: 'd1', title: 'a' } });
  assert.deepEqual(first, { title: { set: 'a' } });
  const second = projector.project(Doc, 'd1', { id: 'd1', title: 'b' }, { handle: updated('Doc'), data: { id: 'd1', title: 'b' } });
  assert.deepEqual(second, { title: { set: 'b' } });
});

test('createDeltaProjector: removed evicts shadow', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: created('Doc'), data: { id: 'd1', title: 'a' } });
  assert.equal(projector.project(Doc, 'd1', undefined, { handle: removed('Doc'), data: { id: 'd1' } }), undefined);
  const delta = projector.project(Doc, 'd1', { id: 'd1', title: 'b' }, { handle: updated('Doc'), data: { id: 'd1', title: 'b' } });
  assert.deepEqual(delta, { title: { set: 'b' } });
});

test('createDeltaProjector: native event returns field delta without shadow mutation', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: created('Doc'), data: { id: 'd1', title: 'a' } });
  const nativeDelta = projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: native('Doc', 'tags', 'added'), data: { owner: 'd1', member: 'u1' } });
  assert.deepEqual(nativeDelta, { tags: { owner: 'd1', member: 'u1' } });
  const updateDelta = projector.project(Doc, 'd1', { id: 'd1', title: 'b' }, { handle: updated('Doc'), data: { id: 'd1', title: 'b' } });
  assert.deepEqual(updateDelta, { title: { set: 'b' } });
});

test('createDeltaProjector: clear evicts all shadows', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: created('Doc'), data: { id: 'd1', title: 'a' } });
  projector.clear();
  const delta = projector.project(Doc, 'd1', { id: 'd1', title: 'b' }, { handle: updated('Doc'), data: { id: 'd1', title: 'b' } });
  assert.deepEqual(delta, { title: { set: 'b' } });
});

test('createDeltaProjector: unchanged updated returns {}', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector();
  projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: created('Doc'), data: { id: 'd1', title: 'a' } });
  const delta = projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: updated('Doc'), data: { id: 'd1', title: 'a' } });
  assert.deepEqual(delta, {});
});

test('createDeltaProjector: maxScopes evicts oldest shadow', () => {
  const Doc = makeDoc();
  const projector = createDeltaProjector({ maxScopes: 1 });
  projector.project(Doc, 'd1', { id: 'd1', title: 'a' }, { handle: created('Doc'), data: { id: 'd1', title: 'a' } });
  projector.project(Doc, 'd2', { id: 'd2', title: 'x' }, { handle: created('Doc'), data: { id: 'd2', title: 'x' } });
  const delta = projector.project(Doc, 'd1', { id: 'd1', title: 'b' }, { handle: updated('Doc'), data: { id: 'd1', title: 'b' } });
  assert.deepEqual(delta, { title: { set: 'b' } });
});
