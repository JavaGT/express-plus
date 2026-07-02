// Priority 6 — ordered `list` field (eng-review test plan 737-739, consult #20).
//
// `list(of)` is the `ordered` named whole's first instance: a fractional-index
// keyspace where each element has a STABLE `id` and a fractional `key` (the sort
// position). insertAt mints a key BETWEEN the neighbor keys — siblings keep
// their keys (no renumber, the hallmark of fractional indexing vs an array
// shift). move re-keys ONLY the moved element. reorder is sugar that re-keys
// each element to a fresh evenly-spaced sequence.
//
// These are HANDLE behavior tests against the side-table (the storage path).
// Ordered's delta contract is the native per-op identity-keyed EVENTS
// (`.inserted`/`.moved`/`.reordered`/`.removed`) — NOT a `strategy.diff`
// snapshot diff (DECISIONLOG #74 — VESTIGIAL, deleted orderedListDiff; a
// fractional-index keyspace is intrinsically per-op, not whole-state-snapshot).
// A2 ships the storage + handle; the events' live normalization landed in P6e-1b.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { setActiveDb } from '../src/db.mjs';
import {
  entity,
  text,
  list,
  generateDDL,
  createServer, durableMutationVariant,
  executeFrameworkDDL,
} from '../src/index.mjs';

const Items = entity('Items', {
  fields: { parts: list(text()) },
  grant: () => [],
});

async function setup() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Items)) db.exec(sql);
  db.prepare("INSERT INTO Items (id) VALUES ('r1')").run();
  const server = await createServer({
    db,
    handlers: Items.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Items.projection],
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    authorize: async () => true,
  });
  return { db, server };
}

function rowWith(server, id) {
  return Items.hydrate({ id }, null, server.dispatch);
}

function keyOf(db, id) {
  const row = db
    .prepare("SELECT key FROM Items_parts WHERE Items_id = 'r1' AND id = ?")
    .get(String(id));
  return row?.key;
}

test('insertAt mints a fractional key between neighbors — sibling keys unchanged', async (t) => {
  const { db, server } = await setup();
  t.after(() => db.close());
  const row = rowWith(server, 'r1');
  const aId = await row.parts.insertAt(0, 'a');
  const cId = await row.parts.insertAt(1, 'c');
  const aKey = keyOf(db, aId);
  const cKey = keyOf(db, cId);
  // insert b between a and c at index 1
  const bId = await row.parts.insertAt(1, 'b');
  assert.deepEqual(await row.parts.toArray(), ['a', 'b', 'c']);
  // siblings keep their keys (no renumber)
  assert.equal(keyOf(db, aId), aKey, 'a key unchanged by the between-insert');
  assert.equal(keyOf(db, cId), cKey, 'c key unchanged by the between-insert');
  // b's key is strictly between a's and c's (the fractional position)
  const bKey = keyOf(db, bId);
  assert.ok(aKey < bKey && bKey < cKey, 'b keyed strictly between its neighbors');
});

test('move(id, i) re-keys only the moved element; unaffected siblings keep their keys', async (t) => {
  const { db, server } = await setup();
  t.after(() => db.close());
  const row = rowWith(server, 'r1');
  const aId = await row.parts.insertAt(0, 'a');
  const bId = await row.parts.insertAt(1, 'b');
  const cId = await row.parts.insertAt(2, 'c');
  const aKey = keyOf(db, aId);
  const bKey = keyOf(db, bId);
  const cKey = keyOf(db, cId);
  // move b to the end (after c)
  await row.parts.move(bId, 2);
  assert.deepEqual(await row.parts.toArray(), ['a', 'c', 'b']);
  // the moved element was re-keyed; the two siblings were NOT touched
  assert.notEqual(keyOf(db, bId), bKey, 'b was re-keyed by the move');
  assert.equal(keyOf(db, aId), aKey, 'a (unaffected) kept its key');
  assert.equal(keyOf(db, cId), cKey, 'c (unaffected) kept its key');
  assert.ok(keyOf(db, bId) > cKey, 'b now sorts after c');
});

test('reorder([ids]) reorders to the given sequence — sugar over per-element re-key', async (t) => {
  const { db, server } = await setup();
  t.after(() => db.close());
  const row = rowWith(server, 'r1');
  const aId = await row.parts.insertAt(0, 'a');
  const bId = await row.parts.insertAt(1, 'b');
  const cId = await row.parts.insertAt(2, 'c');
  await row.parts.reorder([cId, aId, bId]);
  assert.deepEqual(await row.parts.toArray(), ['c', 'a', 'b']);
  // the id set is unchanged — reorder re-keys, it does not add/remove
  const ids = db
    .prepare("SELECT id FROM Items_parts WHERE Items_id = 'r1'")
    .all()
    .map((r) => r.id)
    .sort();
  assert.deepEqual(ids, [aId, bId, cId].map(String).sort());
});

test('remove(id) deletes one element without disturbing the others', async (t) => {
  const { db, server } = await setup();
  t.after(() => db.close());
  const row = rowWith(server, 'r1');
  const aId = await row.parts.insertAt(0, 'a');
  const bId = await row.parts.insertAt(1, 'b');
  const cId = await row.parts.insertAt(2, 'c');
  const aKey = keyOf(db, aId);
  const cKey = keyOf(db, cId);
  await row.parts.remove(bId);
  assert.deepEqual(await row.parts.toArray(), ['a', 'c']);
  assert.equal(keyOf(db, bId), undefined, 'b is gone');
  assert.equal(keyOf(db, aId), aKey, 'a key intact');
  assert.equal(keyOf(db, cId), cKey, 'c key intact');
});
