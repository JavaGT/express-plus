import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { defineSqliteSchema } from '../src/sqlite-schema.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { projectionSource, principalSnapshot } from '../src/principal-snapshot-declaration.mjs';
import { principalSnapshotScope } from '../src/principal-snapshot-scope.mjs';
import { createPrincipalSnapshotDelivery } from '../src/principal-snapshot-delivery.mjs';
import { createPrincipalSnapshotTransaction } from '../src/principal-snapshot-transaction.mjs';
import { createWriteQueue } from '../src/write-queue.mjs';
import { validatePrincipalSnapshotDeclarations } from '../src/principal-snapshot-delivery.mjs';

function setup() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const schema = defineSqliteSchema({
    name: 'principal-delivery',
    tables: [{
      name: 'HubItem',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'recipientId', type: 'text', notNull: true },
        { name: 'title', type: 'text', notNull: true },
        { name: 'rank', type: 'integer', notNull: true },
        { name: 'hidden', type: 'text', notNull: true },
      ],
    }],
  });
  schema.prepare(db);
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('b', 'u1', 'second', 2, 'secret');
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('a', 'u1', 'first', 1, 'secret');
  db.prepare('INSERT INTO HubItem (id, recipientId, title, rank, hidden) VALUES (?, ?, ?, ?, ?)').run('c', 'u2', 'other', 1, 'secret');
  const source = projectionSource(schema, 'HubItem');
  const declaration = principalSnapshot('user-hub', {
    principalType: 'user',
    output: principalSnapshot.object({
      items: principalSnapshot.many(source, {
        via: source.field.recipientId,
        key: source.field.id,
        select: principalSnapshot.select(source.field.title),
        orderBy: [principalSnapshot.orderBy(source.field.rank)],
      }),
    }),
  });
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [declaration] });
  const app = { db, writeQueue: createWriteQueue(), _principalSnapshotTxActive: false };
  const runtime = createPrincipalSnapshotTransaction(app);
  app.principalSnapshots = { transaction: runtime.transaction };
  runtime._registerDeclaration(declaration);
  runtime._setWakeHook((decl, principal) => delivery.wake(decl, principal));
  return { db, schema, declaration, delivery, app };
}

test('principal bootstrap projects only recipient-visible declared columns with durable cursor', async () => {
  const { declaration, delivery } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const result = await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope });
  assert.deepEqual(result, { kind: 'snapshot', snapshot: { items: [{ title: 'first', id: 'a' }, { title: 'second', id: 'b' }] }, cursor: 0 });
  assert.ok(Object.isFrozen(result.snapshot));
  assert.equal('hidden' in result.snapshot.items[0], false);
});

test('principal delivery fails closed for malformed, unknown, and mismatched recipients', async () => {
  const { declaration, delivery } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u2' }, scope }), { kind: 'revoked' });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'link', id: 'u1' }, scope }), { kind: 'revoked' });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'PrincipalSnapshot:unknown/user/u1' }), { kind: 'revoked' });
  assert.deepEqual(await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'PrincipalSnapshot:user-hub/user/%3a' }), { kind: 'revoked' });
});

test('principal catchup is snapshot-only and exact invalidation wakes only its recipient', async () => {
  const { declaration, delivery, app } = setup();
  const one = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const two = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u2' } });
  const delivered = [];
  const other = [];
  const a = await delivery.subscribe({ principal: { type: 'user', id: 'u1' }, scope: one, after: 0, signal: new AbortController().signal, deliver: async (batch) => delivered.push(...batch) });
  const b = await delivery.subscribe({ principal: { type: 'user', id: 'u2' }, scope: two, after: 0, signal: new AbortController().signal, deliver: async (batch) => other.push(...batch) });
  await a.activate();
  await b.activate();
  await app.principalSnapshots.transaction((tx) => tx.invalidate(declaration, { type: 'user', id: 'u1' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [{ type: 'resync', seq: 1, reason: 'recipient-snapshot-required' }]);
  assert.deepEqual(other, []);
  assert.deepEqual(await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope: one, after: 1 }), { kind: 'catchup', envelopes: [], cursor: 1 });
  const stale = await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope: one, after: 0 });
  assert.equal(stale.kind, 'snapshot');
  assert.equal(stale.cursor, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
});

test('principal delivery validation rejects a foreign source schema and undeclared source table', () => {
  const { schema } = setup();
  const source = projectionSource(schema, 'HubItem');
  const declaration = principalSnapshot('valid-source', {
    principalType: 'user',
    output: principalSnapshot.object({ rows: principalSnapshot.many(source, { via: source.field.recipientId, key: source.field.id, select: principalSnapshot.select(source.field.title) }) }),
  });
  assert.doesNotThrow(() => validatePrincipalSnapshotDeclarations([declaration], schema));
  assert.throws(() => validatePrincipalSnapshotDeclarations([declaration], defineSqliteSchema({ name: 'foreign', tables: [] })), /application schema/);
  const other = defineSqliteSchema({ name: 'other', tables: [{ name: 'Other', columns: [{ name: 'id', type: 'text', primaryKey: true }] }] });
  const foreignSource = projectionSource(other, 'Other');
  const foreignDeclaration = principalSnapshot('foreign-source', {
    principalType: 'user',
    output: principalSnapshot.object({ rows: principalSnapshot.many(foreignSource, { via: foreignSource.field.id, key: foreignSource.field.id, select: principalSnapshot.select(foreignSource.field.id) }) }),
  });
  assert.throws(() => validatePrincipalSnapshotDeclarations([foreignDeclaration], schema), /application schema/);
});
