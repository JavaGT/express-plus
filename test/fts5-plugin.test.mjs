import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createFts5Plugin } from '../build/fts5-plugin.mjs';
import { createSearchPluginRegistry } from '../build/search-plugin.mjs';
import { createSearchOwnedIndexCapability } from '../build/index-capability.mjs';
import { createSearchStalenessBridge } from '../build/search-staleness.mjs';
import { createSearchReconcileEngine } from '../build/search-reconcile.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT, privateNote TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createFts5Plugin({
    id: 'note-fts', version: '1.0.0', tokenizer: 'porter',
    source: { entity: 'Note', fields: ['title', 'body'] },
  });
  registry.register(plugin);
  registry.bindSource(db);
  for (const entry of registry.census().entries) db.exec(entry.sql);
  const census = new Map();
  for (const object of plugin.ownedObjects) {
    census.set(`${object.kind}:${object.name}`.toLowerCase(), {
      kind: 'plugin', owner: plugin.id, objectKind: object.kind, name: object.name,
    });
  }
  const queue = createWriteQueue();
  registry.bindIndex(createSearchOwnedIndexCapability({
    db, census, writeCoordinator: queue, fenceOf: (id) => registry.stateOf(id).fence,
  }));
  const prepared = await registry.prepare(plugin.id);
  assert.equal(prepared.ok, true, prepared.lastError?.message);
  const insert = (id, title, body, privateNote = 'not searchable') => db.prepare('INSERT INTO Note (id, title, body, privateNote) VALUES (?, ?, ?, ?)').run(id, title, body, privateNote);
  return { db, registry, plugin, queue, insert };
}

async function close(kit) {
  await kit.queue.close();
  kit.db.close();
}

async function rebuild(kit) {
  const result = await kit.registry.rebuild('note-fts');
  assert.equal(result.ok, true, result.lastError?.message);
}

test('FTS5 plugin declares two census-owned FTS generations and no source-maintenance triggers', async (t) => {
  const kit = await setup();
  t.after(() => close(kit));
  const census = kit.registry.census();
  const tables = census.objects.filter((object) => object.kind === 'virtual-table');
  assert.equal(tables.length, 2);
  assert.ok(tables.every((table) => /tokenize='porter'/.test(table.ddl[0])));
  assert.equal(census.objects.filter((object) => object.kind === 'trigger').length, 0);
  assert.equal(kit.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'Note'").get().count, 0);
  const before = kit.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'SearchFts_note_fts%'").get().count;
  for (const entry of census.entries) kit.db.exec(entry.sql);
  assert.equal(kit.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'SearchFts_note_fts%'").get().count, before, 'reboot creation is idempotent');
});

test('FTS5 plugin validates MATCH with SQLite and never returns raw source rows', async (t) => {
  const kit = await setup();
  t.after(() => close(kit));
  kit.insert('a', 'hello', 'world', 'secret source field');
  await rebuild(kit);
  const malformed = await kit.registry.search('note-fts', { query: 'hello AND' });
  assert.equal(malformed.ok, false);
  assert.match(malformed.lastError.message, /FTS5 query/);
  const outcome = await kit.registry.search('note-fts', { query: 'hello' });
  assert.equal(outcome.ok, true);
  assert.deepEqual(Object.keys(outcome.result.hits[0]).sort(), ['excerpt', 'id', 'rank']);
});

test('FTS5 plugin uses bm25 ordering, bounded snippets, and deterministic id tie breaking', async (t) => {
  const kit = await setup();
  t.after(() => close(kit));
  kit.insert('b', 'needle', 'x'.repeat(80));
  kit.insert('a', 'needle', 'y'.repeat(80));
  kit.insert('c', 'needle needle needle', 'z'.repeat(80));
  await rebuild(kit);
  const outcome = await kit.registry.search('note-fts', { query: 'needle', limit: 3 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.hits[0].id, 'c');
  assert.deepEqual(outcome.result.hits.slice(1).map((hit) => hit.id), ['a', 'b']);
  assert.equal(outcome.result.hits[0].rank, 1);
  assert.ok(outcome.result.hits.every((hit) => hit.rank >= 0 && hit.rank <= 1));
  assert.ok(outcome.result.hits.every((hit) => hit.excerpt.length <= 160));
});

test('FTS5 plugin participates in fenced A3 shadow rebuild, reconcile, parity, and actual-index health', async (t) => {
  const kit = await setup();
  const bridge = createSearchStalenessBridge({ registry: kit.registry });
  bridge.engage(kit.db);
  const engine = createSearchReconcileEngine({ registry: kit.registry, staleness: bridge, db: kit.db, writeQueue: kit.queue });
  t.after(() => close(kit));
  kit.insert('a', 'fresh', 'index');
  const rebuilt = await engine.rebuildShadow('note-fts');
  assert.equal(rebuilt.ok, true, rebuilt.lastError);
  assert.equal(engine.parity('note-fts').matches, true);
  assert.equal(kit.registry.healthOf('note-fts').plugin.integrity.ok, true);
  kit.db.prepare('UPDATE Note SET body = ? WHERE id = ?').run('changed', 'a');
  const reconciled = await kit.registry.reconcile('note-fts', [{ entity: 'Note', rowId: 'a', kind: 'updated' }]);
  assert.equal(reconciled.ok, true);
  assert.equal((await kit.registry.search('note-fts', { query: 'changed' })).result.hits[0].id, 'a');
});
