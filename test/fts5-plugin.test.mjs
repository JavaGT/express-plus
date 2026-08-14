import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createFts5Plugin, Fts5QueryValidationError } from '../build/fts5-plugin.mjs';
import { createSearchPluginRegistry } from '../build/search-plugin.mjs';
import { createSearchStalenessBridge } from '../build/search-staleness.mjs';
import { createSearchReconcileEngine } from '../build/search-reconcile.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
  const registry = createSearchPluginRegistry();
  const plugin = createFts5Plugin({
    id: 'note-fts', version: '1.0.0', tokenizer: 'porter',
    source: { entity: 'Note', fields: ['title', 'body'] },
  });
  registry.register(plugin);
  registry.bindSource(db);
  const insert = (id, title, body) => db.prepare('INSERT INTO Note (id, title, body) VALUES (?, ?, ?)').run(id, title, body);
  return { db, registry, plugin, insert };
}

async function rebuild(kit) {
  const result = await kit.registry.rebuild('note-fts');
  assert.equal(result.ok, true, result.lastError?.message);
}

test('FTS5 plugin declares tokenizer-configured virtual tables and only its mirror triggers', (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  const census = kit.registry.census();
  const table = census.objects.find((object) => object.name === 'Note_title_fts');
  assert.equal(table.kind, 'virtual-table');
  assert.match(table.ddl[0], /tokenize='porter'/);
  const triggers = census.objects.filter((object) => object.kind === 'trigger');
  assert.deepEqual(triggers.map((trigger) => trigger.name), [
    'Note_title_fts_insert', 'Note_title_fts_update', 'Note_title_fts_delete',
    'Note_body_fts_insert', 'Note_body_fts_update', 'Note_body_fts_delete',
  ]);
  for (const entry of census.entries) kit.db.exec(entry.sql);
  const before = kit.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get().count;
  for (const entry of census.entries) kit.db.exec(entry.sql);
  assert.equal(kit.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get().count, before);
});

test('FTS5 plugin refuses malformed MATCH queries before they execute', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('a', 'hello', 'world');
  await rebuild(kit);
  const outcome = await kit.registry.search('note-fts', { query: 'hello AND' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.lastError.message, /FTS5 query/);
  assert.throws(() => kit.plugin.search({}, { query: '"unterminated' }), Fts5QueryValidationError);
});

test('FTS5 plugin returns bounded deterministic excerpts and normalized rank ties', async (t) => {
  const kit = setup();
  t.after(() => kit.db.close());
  kit.insert('b', 'needle', 'x'.repeat(80));
  kit.insert('a', 'needle', 'y'.repeat(80));
  kit.insert('c', 'needle needle', 'z'.repeat(80));
  await rebuild(kit);
  const outcome = await kit.registry.search('note-fts', { query: 'needle', limit: 3 });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result.hits.map((hit) => hit.id), ['c', 'a', 'b']);
  assert.equal(outcome.result.hits[0].rank, 1);
  assert.equal(outcome.result.hits[1].rank, 0.5);
  assert.ok(outcome.result.hits.every((hit) => hit.excerpt.length <= 126));
});

test('FTS5 plugin participates in A3 shadow rebuild, reconcile, parity, and integrity health', async (t) => {
  const kit = setup();
  const bridge = createSearchStalenessBridge({ registry: kit.registry });
  bridge.engage(kit.db);
  const queue = createWriteQueue();
  const engine = createSearchReconcileEngine({ registry: kit.registry, staleness: bridge, db: kit.db, writeQueue: queue });
  t.after(async () => { await queue.close(); kit.db.close(); });
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
