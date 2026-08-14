import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createSearchPluginRegistry } from '../build/search-plugin.mjs';
import { createVectorPlugin, VectorPluginValidationError } from '../build/vector-plugin.mjs';
import { createSearchStalenessBridge } from '../build/search-staleness.mjs';
import { createSearchReconcileEngine } from '../build/search-reconcile.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

function setup({ dimensions = 2, owns = () => true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, embedding TEXT, embedding_model TEXT, owner TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createVectorPlugin({
    id: 'note-vectors',
    version: '1.0.0',
    source: {
      entity: 'Note',
      vector: 'embedding',
      model: 'embedding_model',
      owns,
    },
    modelSpace: { model: 'embed-v1', dimensions },
  });
  registry.register(plugin);
  registry.bindSource(db);
  const insert = (id, embedding, model = 'embed-v1', owner = 'alice') => {
    db.prepare('INSERT INTO Note (id, embedding, embedding_model, owner) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(embedding), model, owner);
  };
  return { db, registry, plugin, insert };
}

async function rebuild(kit) {
  const outcome = await kit.registry.rebuild('note-vectors');
  assert.equal(outcome.ok, true, outcome.lastError?.message);
}

test('vector plugin rejects a source vector with wrong dimensions', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('n1', [1]);
  const outcome = await kit.registry.rebuild('note-vectors');
  assert.equal(outcome.ok, false);
  assert.ok(outcome.lastError);
  assert.match(outcome.lastError.message, /requires 2/);
  assert.equal(kit.registry.stateOf('note-vectors').state, 'failed');
});

test('vector plugin rejects NaN and infinity at ingest with a typed error', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  // SQLite JSON text permits neither special value, so validate through the
  // public plugin lifecycle with a reader that returns the raw bad values.
  kit.registry.bindSource({
    prepare() {
      return { all: () => [{ id: 'n1', embedding: [1, NaN], embedding_model: 'embed-v1' }], get: () => undefined };
    },
  });
  const nan = await kit.registry.rebuild('note-vectors');
  assert.equal(nan.ok, false);
  assert.match(nan.lastError.message, /non-finite/);

  kit.registry.bindSource({
    prepare() {
      return { all: () => [{ id: 'n1', embedding: [1, Infinity], embedding_model: 'embed-v1' }], get: () => undefined };
    },
  });
  const infinity = await kit.registry.rebuild('note-vectors');
  assert.equal(infinity.ok, false);
  assert.match(infinity.lastError.message, /non-finite/);
});

test('vector plugin rejects model-space mismatch and unauthorized source ownership', async (t) => {
  const mismatch = setup();
  t.after(() => mismatch.db.close());
  mismatch.insert('n1', [1, 0], 'other-model');
  const modelOutcome = await mismatch.registry.rebuild('note-vectors');
  assert.equal(modelOutcome.ok, false);
  assert.match(modelOutcome.lastError.message, /requires 'embed-v1'/);

  const owned = setup({ owns: (row) => row.owner === 'alice' });
  t.after(() => owned.db.close());
  owned.insert('n2', [1, 0], 'embed-v1', 'mallory');
  const ownerOutcome = await owned.registry.rebuild('note-vectors');
  assert.equal(ownerOutcome.ok, false);
  assert.match(ownerOutcome.lastError.message, /not owned/);
});

test('ownership rejection purges stale rows and aborts a partial rebuild', async (t) => {
  const kit = setup({ owns: (row) => row.owner === 'alice' });
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  kit.insert('n2', [0, 1]);
  await rebuild(kit);

  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('mallory', 'n2');
  const rebuilt = await kit.registry.rebuild('note-vectors');
  assert.equal(rebuilt.ok, false);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 0, 'a failed direct rebuild leaves no partial index active');

  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('alice', 'n2');
  await rebuild(kit);
  kit.db.prepare('UPDATE Note SET owner = ? WHERE id = ?').run('mallory', 'n2');
  const reconciled = await kit.registry.reconcile('note-vectors', [{ entity: 'Note', rowId: 'n2', kind: 'updated' }]);
  assert.equal(reconciled.ok, false);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 1, 'a row that loses ownership is removed from the active index');
});

test('vector plugin refuses sources without ownership and contains ownership predicate errors', async (t) => {
  assert.throws(() => createVectorPlugin({
    id: 'unowned-vectors',
    version: '1.0.0',
    source: { entity: 'Note', vector: 'embedding', model: 'embedding_model' },
    modelSpace: { model: 'embed-v1', dimensions: 2 },
  }), /requires an ownership predicate/);

  const kit = setup({ owns: () => { throw new Error('ownership backend unavailable'); } });
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  const outcome = await kit.registry.rebuild('note-vectors');
  assert.equal(outcome.ok, false);
  assert.match(outcome.lastError.message, /ownership could not be verified/);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 0);
  assert.throws(
    () => kit.plugin.validateSourceRow({ id: 'n1', embedding: [1, 0], embedding_model: 'embed-v1' }),
    (error) => error instanceof VectorPluginValidationError && error.code === 'unauthorized-source-ownership',
  );
});

test('model or dimension changes create a new generation and refuse cross-space queries', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  await rebuild(kit);
  const before = kit.plugin.generationIdentity;
  kit.plugin.setModelSpace({ model: 'embed-v2', dimensions: 3 });
  assert.notEqual(kit.plugin.generationIdentity, before);
  const changed = kit.registry.stateOf('note-vectors');
  assert.equal(changed.state, 'building');
  assert.ok(changed.generation > 1);
  assert.deepEqual(changed.counts, {});
  const outcome = await kit.registry.search('note-vectors', { query: { model: 'embed-v1', vector: [1, 0] } });
  assert.equal(outcome.ok, false);
  assert.match(outcome.lastError.message, /requires 'embed-v2'/);
});

test('nearest-neighbour search has bounded deterministic ties and removes deleted sources', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('b', [1, 0]);
  kit.insert('a', [1, 0]);
  kit.insert('c', [0, 1]);
  await rebuild(kit);
  const found = await kit.registry.search('note-vectors', {
    query: { model: 'embed-v1', vector: [1, 0] },
    limit: 2,
  });
  assert.equal(found.ok, true);
  assert.deepEqual(found.result.hits.map((hit) => hit.id), ['a', 'b']);

  kit.db.prepare('DELETE FROM Note WHERE id = ?').run('a');
  const deleted = await kit.registry.reconcile('note-vectors', [{ entity: 'Note', rowId: 'a', kind: 'removed' }]);
  assert.equal(deleted.ok, true);
  const after = await kit.registry.search('note-vectors', { query: { model: 'embed-v1', vector: [1, 0] } });
  assert.deepEqual(after.result.hits.map((hit) => hit.id), ['b', 'c']);
});

test('vector search honors an already-cancelled request', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('n1', [1, 0]);
  await rebuild(kit);
  const controller = new AbortController();
  controller.abort();
  const result = await kit.registry.search('note-vectors', {
    query: { model: 'embed-v1', vector: [1, 0] },
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.result, null);
});

test('vector search yields so an abort stops a large scoring pass', async (t) => {
  const kit = setup({ dimensions: 64 });
  t.after(() => kit.db.close());
  for (let index = 0; index < 4_000; index += 1) kit.insert(`n${index}`, Array(64).fill(1));
  await rebuild(kit);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  const result = await kit.registry.search('note-vectors', {
    query: { model: 'embed-v1', vector: Array(64).fill(1) },
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.result, null);
});

test('vector plugin supports A3 shadow rebuild, validation, and parity census', async (t) => {
  const kit = setup();
  const bridge = createSearchStalenessBridge({ registry: kit.registry });
  bridge.engage(kit.db);
  const queue = createWriteQueue();
  const engine = createSearchReconcileEngine({ registry: kit.registry, staleness: bridge, db: kit.db, writeQueue: queue });
  t.after(async () => {
    await queue.close();
    kit.db.close();
  });
  kit.insert('n1', [1, 0]);
  const rebuilt = await engine.rebuildShadow('note-vectors');
  assert.equal(rebuilt.ok, true, rebuilt.lastError ?? 'rebuild failed');
  assert.equal(rebuilt.activated, true);
  assert.equal(engine.parity('note-vectors').matches, true);
  assert.equal(kit.plugin.indexCensus({}).Note.count, 1);
});

test('validation errors retain a typed code', () => {
  const kit = setup();
  assert.throws(
    () => kit.plugin.validateSourceRow({ id: 'n1', embedding: [1], embedding_model: 'embed-v1' }),
    (error) => error instanceof VectorPluginValidationError && error.code === 'dimension-mismatch',
  );
  kit.db.close();
});
