// S6/A3 — compiled blob-reference census. The census replaces the runtime
// `blobColumns` derivation: it is compiled once at prepare time from entity
// declarations (`blob: true` fields) and action-level `declaredBlobField`
// declarations, carries the full reference contract (owning resource, field,
// lifecycle stage, erasure category, ownership model), and never reasons about
// content hashes (S6 consideration #7 — hash equality NEVER merges ownership).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { text, blob } from '../build/index.mjs';
import { entity } from '../build/internal.mjs';
import { compileBlobCensus, EMPTY_BLOB_CENSUS } from '../build/blob-census.mjs';
import { declaredBlobField } from '../build/server.mjs';

function note() {
  return entity('Note', { body: text(), photo: blob() });
}

test('entity blob:true fields compile into fully-shaped, deterministic references', () => {
  const census = compileBlobCensus({ entities: new Map([['Note', note()]]) });

  assert.deepEqual(census.references, [{
    table: 'Note',
    column: 'photo',
    owningResource: 'Note',
    field: 'photo',
    lifecycle: 'finalize',
    erasureCategory: 'deletable',
    ownership: 'exclusive',
  }]);
  assert.deepEqual(census.entityReferences, census.references, 'an entity blob field is an entity-derived reference');
  assert.deepEqual(census.byResource.get('Note'), census.references);
  assert.deepEqual(census.byTableColumn.get('Note\u0000photo'), census.references);
});

test('non-blob fields are excluded; an unengaged seam carries the empty census', () => {
  const census = compileBlobCensus({
    entities: new Map([
      ['Note', entity('Note', { body: text(), title: text() })],
      ['Plain', { name: 'Plain', fields: { body: text() } }],
    ]),
  });
  assert.deepEqual(census.references, []);
  assert.deepEqual(census.entityReferences, []);
  assert.deepEqual(EMPTY_BLOB_CENSUS.references, []);
});

test('action-level declaredBlobField resolves into the census under its owning resource', () => {
  const census = compileBlobCensus({
    entities: new Map(),
    declaredBlobFields: [
      declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'retained' }),
    ],
  });
  assert.deepEqual(census.references, [{
    table: 'File',
    column: 'blob',
    owningResource: 'File',
    field: 'blob',
    lifecycle: 'finalize',
    erasureCategory: 'retained',
    ownership: 'exclusive',
  }]);
  // The declared-only reference is owned by the pending-blob pipeline — it is
  // NOT an entity-derived reference, so the framework finalize consumer leaves
  // it alone.
  assert.deepEqual(census.entityReferences, []);
});

test('explicit shared ownership and lifecycle stage are carried through', () => {
  const census = compileBlobCensus({
    entities: new Map(),
    declaredBlobFields: [
      declaredBlobField({
        actionName: 'Media.attach', field: 'blob', resourceField: 'id',
        owningResource: 'Media', erasureCategory: 'deletable', ownership: 'shared', lifecycle: 'adopt',
      }),
    ],
  });
  assert.deepEqual(census.references, [{
    table: 'Media',
    column: 'blob',
    owningResource: 'Media',
    field: 'blob',
    lifecycle: 'adopt',
    erasureCategory: 'deletable',
    ownership: 'shared',
  }]);
});

test('an entity blob field and an action declaration for the same column merge into ONE reference', () => {
  const census = compileBlobCensus({
    entities: new Map([['File', entity('File', { id: text(), blob: blob() })]]),
    declaredBlobFields: [
      declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'retained' }),
    ],
  });
  assert.equal(census.references.length, 1);
  assert.deepEqual(census.references[0], {
    table: 'File',
    column: 'blob',
    owningResource: 'File',
    field: 'blob',
    lifecycle: 'finalize',
    // The action-level declaration is the explicit statement — its erasure
    // category wins over the entity's implicit `deletable` default.
    erasureCategory: 'retained',
    ownership: 'exclusive',
  });
  assert.deepEqual(census.entityReferences, census.references, 'a merged column is still entity-derived');
});

test('a declared blob field without owningResource or erasureCategory fails declaration validation', () => {
  assert.throws(
    () => declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id' }),
    /requires actionName, field, resourceField, owningResource, and erasureCategory/,
  );
  assert.throws(
    () => declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File' }),
    /requires actionName, field, resourceField, owningResource, and erasureCategory/,
  );
  // Defense in depth at the census compile boundary too.
  assert.throws(
    () => compileBlobCensus({ entities: new Map(), declaredBlobFields: [{ actionName: 'x', field: 'b', resourceField: 'id' }] }),
    /requires owningResource and erasureCategory/,
  );
});

test('action-level reference identifiers fail during census compilation', () => {
  for (const declaration of [
    { actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File; DROP TABLE BlobStore', erasureCategory: 'deletable' },
    { actionName: 'File.upload', field: 'blob id', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' },
  ]) {
    assert.throws(
      () => compileBlobCensus({ entities: new Map(), declaredBlobFields: [declaration] }),
      /owningResource and field must be SQL identifiers/,
    );
  }
});

test('declared references on distinct owning resources stay distinct, even for the same column name', () => {
  const census = compileBlobCensus({
    entities: new Map(),
    declaredBlobFields: [
      declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' }),
      declaredBlobField({ actionName: 'Media.upload', field: 'blob', resourceField: 'id', owningResource: 'Media', erasureCategory: 'deletable' }),
    ],
  });
  assert.deepEqual(census.references.map((r) => `${r.table}.${r.column}`), ['File.blob', 'Media.blob']);
});

test('matching field setups across entities yield distinct references — hashes never merge ownership', () => {
  const census = compileBlobCensus({
    entities: new Map([
      ['Note', entity('Note', { photo: blob() })],
      ['Post', entity('Post', { photo: blob() })],
    ]),
  });
  // Two entities with an identical `photo` blob field produce two distinct
  // references. The census carries no hash/bytes information at all, so two
  // rows holding the same bytes can never be deduplicated or merged here.
  assert.equal(census.references.length, 2);
  assert.deepEqual(census.references.map((r) => r.table), ['Note', 'Post']);
  assert.deepEqual(census.references[0].ownership, 'exclusive');
  assert.deepEqual(census.references[1].ownership, 'exclusive');
});

test('compilation is deterministic and DB-free — identical inputs yield identical output', () => {
  const input = {
    entities: new Map([['Note', note()], ['File', entity('File', { blob: blob() })]]),
    declaredBlobFields: [
      declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' }),
    ],
  };
  const first = compileBlobCensus(input);
  const second = compileBlobCensus(input);
  assert.deepEqual(second.references, first.references);
  assert.deepEqual([...second.byResource.keys()], [...first.byResource.keys()]);
  assert.deepEqual([...second.byTableColumn.keys()], [...first.byTableColumn.keys()]);
  assert.deepEqual(second.entityReferences, first.entityReferences);
  // A throwing DbHandle stub would blow up any DB touch; the census compiles
  // purely from declarations.
  compileBlobCensus({
    entities: new Map([['Note', note()]]),
    declaredBlobFields: [declaredBlobField({ actionName: 'File.upload', field: 'blob', resourceField: 'id', owningResource: 'File', erasureCategory: 'deletable' })],
  });
});
