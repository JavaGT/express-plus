import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { deny, entity, grant, principal, read, ref, scope, text, write } from '../build/index.mjs';

const user = principal({ type: 'user', id: 'cascade-user' });
const grants = () => grant(read, write);

function fixture({ denyChildRemoval = false } = {}) {
  const Parent = entity('CascadeParent', { name: text(), grant: grants });
  const Child = entity('CascadeChild', {
    parentId: ref(Parent, { onRemove: 'cascade' }),
    name: text(),
    grant: denyChildRemoval
      ? () => [scope(({ fields }) => fields.name.is('A')).can(() => deny('child removal denied'))]
      : grants,
  });
  const Join = entity('CascadeJoin', {
    childId: ref(Child, { onRemove: 'cascade' }),
    name: text(),
    grant: grants,
  });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Parent, Child, Join] });
  return { Parent, Child, Join, db, app };
}

async function start(f) {
  await f.app.start();
  f.db.prepare('INSERT INTO CascadeParent (id, name) VALUES (?, ?)').run('parent', 'Parent');
  f.db.prepare('INSERT INTO CascadeChild (id, parentId, name) VALUES (?, ?, ?)').run('child-b', 'parent', 'B');
  f.db.prepare('INSERT INTO CascadeChild (id, parentId, name) VALUES (?, ?, ?)').run('child-a', 'parent', 'A');
  f.db.prepare('INSERT INTO CascadeJoin (id, childId, name) VALUES (?, ?, ?)').run('join-b', 'child-b', 'B');
  f.db.prepare('INSERT INTO CascadeJoin (id, childId, name) VALUES (?, ?, ?)').run('join-a', 'child-a', 'A');
}

test('opted-in removal emits descendant lifecycle events child-first and removes every row atomically', async (t) => {
  const f = fixture();
  t.after(async () => { await f.app.shutdown(); f.db.close(); });
  await start(f);

  const result = await f.app.dispatch({ actionId: 'cascade-remove', type: 'CascadeParent.remove', payload: { id: 'parent' }, principal: user });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.events.map((event) => event.type), [
    'CascadeJoin.removed', 'CascadeChild.removed', 'CascadeJoin.removed', 'CascadeChild.removed', 'CascadeParent.removed',
  ]);
  for (const table of ['CascadeParent', 'CascadeChild', 'CascadeJoin']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM _DeletedRowAnchor WHERE entity IN ('CascadeParent', 'CascadeChild', 'CascadeJoin')").get().count, 5);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = 'cascade-remove'").get().count, 1);
});

test('cascade admission failure rolls back rows, log, deleted anchors, and receipt', async (t) => {
  const f = fixture({ denyChildRemoval: true });
  t.after(async () => { await f.app.shutdown(); f.db.close(); });
  await start(f);
  const result = await f.app.dispatch({ actionId: 'cascade-denied', type: 'CascadeParent.remove', payload: { id: 'parent' }, principal: user });
  assert.equal(result.ok, false);
  for (const table of ['CascadeParent', 'CascadeChild', 'CascadeJoin']) {
    assert.ok(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count > 0);
  }
  for (const table of ['_Log', '_DeletedRowAnchor', '_ActionReceipt']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
});

test('cascade declarations reject invalid targets, multiple owning refs, and cycles', async () => {
  const Lone = entity('CascadeLone', { name: text(), grant: grants });
  const Missing = entity('CascadeMissing', { parentId: ref('NoCascadeTarget', { onRemove: 'cascade' }), grant: grants });
  await assert.rejects(workbench({ db: new DatabaseSync(':memory:'), entities: [Lone, Missing] }).start(), /unknown cascade target/);

  const Parent = entity('CascadeMultiParent', { grant: grants });
  const Child = entity('CascadeMultiChild', { one: ref(Parent, { onRemove: 'cascade' }), two: ref(Parent, { onRemove: 'cascade' }), grant: grants });
  await assert.rejects(workbench({ db: new DatabaseSync(':memory:'), entities: [Parent, Child] }).start(), /only one onRemove ref/);

  const Left = entity('CascadeLeft', { rightId: ref('CascadeRight', { onRemove: 'cascade' }), grant: grants });
  const Right = entity('CascadeRight', { leftId: ref(Left, { onRemove: 'cascade' }), grant: grants });
  await assert.rejects(workbench({ db: new DatabaseSync(':memory:'), entities: [Left, Right] }).start(), /cascade cycle/);

  const Invalid = entity('CascadeInvalid', { name: text({ onRemove: 'cascade' }), grant: grants });
  await assert.rejects(workbench({ db: new DatabaseSync(':memory:'), entities: [Invalid] }).start(), /onRemove requires ref/);
});
