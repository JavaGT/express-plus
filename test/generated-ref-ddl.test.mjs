import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, grant, principal, read, ref, text, write } from '../src/index.mjs';
import { defineSqliteSchema } from '../src/server.mjs';

const user = principal({ type: 'user', id: 'ref-user' });
const grants = () => grant(read, write);

test('generated refs enforce deterministic indexes and fresh-database integrity', async (t) => {
  const Parent = entity('RefParent', { name: text(), grant: grants });
  const Child = entity('RefChild', {
    parentId: ref(Parent, { physical: true }),
    optionalParentId: ref(Parent, { optional: true, physical: true }),
    selfId: ref('RefChild', { nullable: true, physical: true }),
    grant: grants,
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Child, Parent] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const ddl = Child.generateDDL().join('\n');
  assert.match(ddl, /FOREIGN KEY \("parentId"\) REFERENCES "RefParent" \("id"\) ON DELETE RESTRICT ON UPDATE NO ACTION/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS "idx_RefChild_parentId" ON "RefChild" \("parentId"\);/);
  assert.match(ddl, /parentId TEXT NOT NULL/);
  assert.match(ddl, /optionalParentId TEXT/);
  assert.match(ddl, /selfId TEXT/);
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_index_list('RefChild') WHERE origin = 'c' ORDER BY name").all().map(({ name }) => name),
    ['idx_RefChild_optionalParentId', 'idx_RefChild_parentId', 'idx_RefChild_selfId'],
  );
  db.prepare('INSERT INTO RefParent (id, name) VALUES (?, ?)').run('parent', 'Parent');
  db.prepare('INSERT INTO RefChild (id, parentId, optionalParentId, selfId) VALUES (?, ?, ?, ?)').run('child', 'parent', null, null);
  assert.throws(
    () => db.prepare('INSERT INTO RefChild (id, parentId) VALUES (?, ?)').run('orphan', 'missing'),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(() => db.prepare('DELETE FROM RefParent WHERE id = ?').run('parent'), /FOREIGN KEY constraint failed/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('eventful removal refs are deferred NO ACTION and cannot be deleted outside Workbench', async (t) => {
  const Parent = entity('RefCascadeParent', { name: text(), grant: grants });
  const Child = entity('RefCascadeChild', { parentId: ref(Parent, { onRemove: 'cascade', physical: true }), grant: grants });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Parent, Child] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  const fk = db.prepare("SELECT on_delete, on_update FROM pragma_foreign_key_list('RefCascadeChild')").get();
  assert.equal(fk.on_delete, 'NO ACTION');
  assert.equal(fk.on_update, 'NO ACTION');
  db.prepare('INSERT INTO RefCascadeParent (id, name) VALUES (?, ?)').run('parent', 'Parent');
  db.prepare('INSERT INTO RefCascadeChild (id, parentId) VALUES (?, ?)').run('child', 'parent');
  assert.throws(() => db.prepare('DELETE FROM RefCascadeParent WHERE id = ?').run('parent'), /FOREIGN KEY constraint failed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
  const result = await app.dispatch({ actionId: 'eventful-remove', type: 'RefCascadeParent.remove', payload: { id: 'parent' }, principal: user });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.events.map((event) => event.type), ['RefCascadeChild.removed', 'RefCascadeParent.removed']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _DeletedRowAnchor').get().count, 2);
});

test('generated refs support schema-owned entity targets, preserve unresolved logical refs, and reject colliding indexes', async (t) => {
  const Parent = entity('SchemaRefParent', { grant: grants });
  const Child = entity('SchemaRefChild', { parentId: ref(Parent, { physical: true }), grant: grants });
  const schema = defineSqliteSchema({
    name: 'schema-parent',
    tables: [{ name: 'SchemaRefParent', columns: [{ name: 'id', type: 'text', primaryKey: true }] }],
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, schema, entities: [Child, Parent] });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  db.prepare('INSERT INTO SchemaRefParent (id) VALUES (?)').run('parent');
  db.prepare('INSERT INTO SchemaRefChild (id, parentId) VALUES (?, ?)').run('child', 'parent');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const Missing = entity('MissingRefChild', { parentId: ref('ExternalParent'), grant: grants });
  assert.doesNotMatch(Missing.generateDDL().join('\n'), /FOREIGN KEY|idx_MissingRefChild_parentId/);

  const One = entity('Index_A', { b: ref(Parent, { physical: true }), grant: grants });
  const Two = entity('Index', { A_b: ref(Parent, { physical: true }), grant: grants });
  await assert.rejects(workbench({ db: new DatabaseSync(':memory:'), entities: [Parent, One, Two] }).start(), /duplicate generated index/i);
});
