import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { defineSqliteSchema } from '../build/sqlite-schema.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { projectionSource, projectionSourcePhysical, principalSnapshot } from '../build/principal-snapshot-declaration.mjs';
import { principalSnapshotScope } from '../build/principal-snapshot-scope.mjs';
import { createPrincipalSnapshotDelivery, validatePrincipalSnapshotDeclarations } from '../build/principal-snapshot-delivery.mjs';
import { createPrincipalSnapshotTransaction } from '../build/principal-snapshot-transaction.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

// Covers the Decision 0019 extension: host PHYSICAL table sources (decoupled
// from the application schema) and a denormalizing join for related display
// columns — the surfaces a hub needs when its authoritative tables are
// entity-owned / framework-grant tables the app cannot schema-declare.

function hubDatabase() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  // The schema declares ONLY HubItem; Member and project HostProject are host
  // PHYSICAL tables not present in the schema (entity-owned / grant tables).
  const schema = defineSqliteSchema({
    name: 'physical-join',
    tables: [{
      name: 'HubItem',
      columns: [
        { name: 'id', type: 'text', primaryKey: true },
        { name: 'recipientId', type: 'text', notNull: true },
        { name: 'title', type: 'text', notNull: true },
      ],
    }],
  });
  schema.prepare(db);
  // Host physical tables: a membership grant table and its joined project display table.
  db.exec(`CREATE TABLE Member (member_id TEXT NOT NULL, Project_id TEXT NOT NULL, role TEXT NOT NULL)`);
  db.exec(`CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT NOT NULL, colour TEXT, iconUpdatedAt TEXT)`);
  db.exec(`CREATE TABLE Notification (id TEXT PRIMARY KEY, userId TEXT NOT NULL, title TEXT NOT NULL, readAt TEXT)`);

  const memberSource = projectionSourcePhysical('Member', ['member_id', 'Project_id', 'role']);
  const projectSource = projectionSourcePhysical('Project', ['id', 'name', 'colour', 'iconUpdatedAt']);
  const notificationSource = projectionSourcePhysical('Notification', ['id', 'userId', 'title', 'readAt']);
  const hubSource = projectionSource(schema, 'HubItem');

  const memberships = principalSnapshot('hub-projects', {
    principalType: 'user',
    output: principalSnapshot.object({
      memberships: principalSnapshot.many(memberSource, {
        via: memberSource.field.member_id,
        key: memberSource.field.Project_id,
        select: principalSnapshot.select(memberSource.field.Project_id, memberSource.field.role),
        join: {
          source: projectSource,
          on: { from: memberSource.field.Project_id, to: projectSource.field.id },
          select: principalSnapshot.select(projectSource.field.name, projectSource.field.colour, projectSource.field.iconUpdatedAt),
        },
      }),
      notifications: principalSnapshot.many(notificationSource, {
        via: notificationSource.field.userId,
        key: notificationSource.field.id,
        select: principalSnapshot.select(notificationSource.field.id, notificationSource.field.title, notificationSource.field.readAt),
      }),
      items: principalSnapshot.many(hubSource, {
        via: hubSource.field.recipientId,
        key: hubSource.field.id,
        select: principalSnapshot.select(hubSource.field.title),
      }),
    }),
  });
  return { db, schema, memberships };
}

function setup() {
  const { db, schema, memberships } = hubDatabase();
  db.prepare('INSERT INTO Member (member_id, Project_id, role) VALUES (?, ?, ?)').run('u1', 'p1', 'owner');
  db.prepare('INSERT INTO Member (member_id, Project_id, role) VALUES (?, ?, ?)').run('u1', 'p2', 'viewer');
  db.prepare('INSERT INTO Member (member_id, Project_id, role) VALUES (?, ?, ?)').run('u2', 'p1', 'editor');
  db.prepare('INSERT INTO Project (id, name, colour, iconUpdatedAt) VALUES (?, ?, ?, ?)').run('p1', 'Alpha', '#ff0000', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO Project (id, name, colour, iconUpdatedAt) VALUES (?, ?, ?, ?)').run('p2', 'Beta', null, null);
  db.prepare('INSERT INTO Notification (id, userId, title, readAt) VALUES (?, ?, ?, ?)').run('n1', 'u1', 'hello', null);
  db.prepare('INSERT INTO Notification (id, userId, title, readAt) VALUES (?, ?, ?, ?)').run('n2', 'u2', 'other', '2026-01-01T00:00:00.000Z');
  // The schema-declared HubItem must still project (backwards compatibility).
  db.prepare('INSERT INTO HubItem (id, recipientId, title) VALUES (?, ?, ?)').run('h1', 'u1', 'hub-row');
  const delivery = createPrincipalSnapshotDelivery({ db, declarations: [memberships], authorize: () => true });
  const app = { db, writeQueue: createWriteQueue(), _principalSnapshotTxActive: false };
  const runtime = createPrincipalSnapshotTransaction(app);
  app.principalSnapshots = { transaction: runtime.transaction };
  runtime._registerDeclaration(memberships);
  runtime._setWakeHook((decl, principal) => delivery.wake(decl, principal));
  return { db, schema, memberships, delivery, app };
}

test('physical-source + join projection is validated and delivered per recipient', async () => {
  const { memberships, schema, delivery } = setup();
  // Physical sources validate against their own explicit columns without app.schema.
  assert.doesNotThrow(() => validatePrincipalSnapshotDeclarations([memberships], schema));
  const scope = principalSnapshotScope({ declaration: memberships.name, principal: { type: 'user', id: 'u1' } });
  const result = await delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.kind, 'snapshot');
  const snapshot = result.snapshot;
  // Join column keys are namespaced by the joined table (Project__name etc.).
  assert.deepEqual(snapshot.memberships, [
    { Member__Project_id: 'p1', Member__role: 'owner', Project__name: 'Alpha', Project__colour: '#ff0000', Project__iconUpdatedAt: '2026-01-01T00:00:00.000Z' },
    { Member__Project_id: 'p2', Member__role: 'viewer', Project__name: 'Beta', Project__colour: null, Project__iconUpdatedAt: null },
  ]);
  // Notification physical source projects only declared columns, per recipient
  // (bare keys — no join, so no namespacing is needed).
  assert.deepEqual(snapshot.notifications, [{ id: 'n1', title: 'hello', readAt: null }]);
  // The schema-declared source still delivers flat keys (unchanged).
  assert.deepEqual(snapshot.items, [{ title: 'hub-row', id: 'h1' }]);
  // Recipient u2 sees only their own rows.
  const scope2 = principalSnapshotScope({ declaration: memberships.name, principal: { type: 'user', id: 'u2' } });
  const r2 = await delivery.bootstrap({ principal: { type: 'user', id: 'u2' }, scope: scope2 });
  assert.equal(r2.kind, 'snapshot');
  assert.deepEqual(r2.snapshot.memberships, [
    { Member__Project_id: 'p1', Member__role: 'editor', Project__name: 'Alpha', Project__colour: '#ff0000', Project__iconUpdatedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(r2.snapshot.notifications, [{ id: 'n2', title: 'other', readAt: '2026-01-01T00:00:00.000Z' }]);
});

test('physical source fails closed on an undeclared field and on a column missing from the table', async () => {
  const memberSource = projectionSourcePhysical('Member', ['member_id', 'Project_id', 'role']);
  // Undeclared field access yields undefined, so the collection build throws.
  assert.equal(memberSource.field['not-a-column'], undefined);
  assert.throws(
    () => principalSnapshot('bad-physical', {
      principalType: 'user',
      output: principalSnapshot.object({
        m: principalSnapshot.many(memberSource, {
          via: memberSource.field.member_id,
          key: memberSource.field.notARealColumn, // undefined -> invalid
          select: principalSnapshot.select(memberSource.field.role),
        }),
      }),
    }),
    /key/,
  );
  // Unknown PHYSICAL table still fails validation against app.schema path is not used,
  // but a physical source naming a non-existent table is a host error caught at
  // projection time (fail closed on the SQL layer as well).
  const ghostSource = projectionSourcePhysical('Ghost', ['id']);
  const ghostDecl = principalSnapshot('ghost-physical', {
    principalType: 'user',
    output: principalSnapshot.object({
      g: principalSnapshot.many(ghostSource, {
        via: ghostSource.field.id,
        key: ghostSource.field.id,
        select: principalSnapshot.select(ghostSource.field.id),
      }),
    }),
  });
  const delivery = createPrincipalSnapshotDelivery({ db: new DatabaseSync(':memory:'), declarations: [ghostDecl], authorize: () => true });
  const scope = principalSnapshotScope({ declaration: 'ghost-physical', principal: { type: 'user', id: 'u' } });
  await assert.rejects(() => delivery.bootstrap({ principal: { type: 'user', id: 'u' }, scope }));
});

test('physical-source invalidation survives and wakes only the recipient', async () => {
  const { memberships, delivery, app } = setup();
  const one = principalSnapshotScope({ declaration: memberships.name, principal: { type: 'user', id: 'u1' } });
  const two = principalSnapshotScope({ declaration: memberships.name, principal: { type: 'user', id: 'u2' } });
  const delivered = [];
  const other = [];
  const a = await delivery.subscribe({ principal: { type: 'user', id: 'u1' }, scope: one, after: 0, signal: new AbortController().signal, deliver: async (batch) => delivered.push(...batch) });
  const b = await delivery.subscribe({ principal: { type: 'user', id: 'u2' }, scope: two, after: 0, signal: new AbortController().signal, deliver: async (batch) => other.push(...batch) });
  await a.activate();
  await b.activate();
  // Rollback (raise) must undo both the host mutation and the invalidation.
  await assert.rejects(() =>
    app.principalSnapshots.transaction((tx) => {
      tx.db.prepare('UPDATE Member SET role = ? WHERE Project_id = ? AND member_id = ?').run('owner', 'p1', 'u1');
      tx.invalidate(memberships, { type: 'user', id: 'u1' });
      throw new Error('boom');
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, []);
  assert.equal(app.db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalId = ?').get(memberships.name, 'u1'), undefined);

  // Committed invalidation wakes only the recipient and is durable.
  await app.principalSnapshots.transaction((tx) => {
    tx.db.prepare('DELETE FROM Member WHERE Project_id = ? AND member_id = ?').run('p2', 'u1');
    tx.invalidate(memberships, { type: 'user', id: 'u1' });
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [{ type: 'resync', seq: 1, reason: 'recipient-snapshot-required' }]);
  assert.deepEqual(other, []);
  assert.equal(app.db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalId = ?').get(memberships.name, 'u1').revision, 1);
});
