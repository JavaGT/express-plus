import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { defineSqliteSchema } from '../build/sqlite-schema.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { projectionSource, principalSnapshot } from '../build/principal-snapshot-declaration.mjs';
import { principalSnapshotScope } from '../build/principal-snapshot-scope.mjs';
import { createPrincipalSnapshotDelivery } from '../build/principal-snapshot-delivery.mjs';
import { createPrincipalSnapshotTransaction } from '../build/principal-snapshot-transaction.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { validatePrincipalSnapshotDeclarations } from '../build/principal-snapshot-delivery.mjs';
import { createOwnedLiveDelivery } from '../build/live-delivery-public.mjs';

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

test('principal delivery close revokes active subscriptions exactly once and blocks later use', async () => {
  const { delivery, declaration } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const revokes = [];
  const delivered = [];
  const controller = new AbortController();
  const first = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: controller.signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => revokes.push('first'),
  });
  const second = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => revokes.push('second'),
  });
  await first.activate();
  await second.activate();
  assert.deepEqual(revokes, [], 'nothing revoked while open');
  delivery.close();
  assert.deepEqual([...revokes].sort(), ['first', 'second'], 'close revokes every active subscription once');
  controller.abort();
  delivery.close();
  assert.deepEqual([...revokes].sort(), ['first', 'second'], 'abort and repeated close never double-release');
  assert.equal(await first.activate(), undefined, 'closed activation settles without a cursor');
  await assert.rejects(
    () => delivery.subscribe({ principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal, deliver: async () => {} }),
    /is closed/,
  );
  await assert.rejects(() => delivery.bootstrap({ principal: { type: 'user', id: 'u1' }, scope }), /is closed/);
  await assert.rejects(() => delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope, after: 0 }), /is closed/);
  delivery.wake(declaration, { type: 'user', id: 'u1' });
  assert.deepEqual(delivered, [], 'a wake after close reaches no subscription');
});

test('principal delivery close during an awaited drain cannot deliver after shutdown', async () => {
  const { delivery, declaration, db } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let releaseDelivery;
  let markDeliveryEntered;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  const deliveryEntered = new Promise((resolve) => { markDeliveryEntered = resolve; });
  const delivered = [];
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => {
      delivered.push(...batch);
      markDeliveryEntered();
      await deliveryGate;
    },
    revoke: () => { revokes += 1; },
  });
  assert.equal(await activation.activate(), 0, 'quiesced open subscription reports its cursor');
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  const draining = activation.activate();
  await deliveryEntered;
  assert.deepEqual(delivered.map((e) => e.seq), [1], 'the in-flight batch has started');
  delivery.close();
  assert.equal(revokes, 1, 'close revokes the subscription while its drain awaits delivery');
  releaseDelivery();
  assert.equal(await draining, undefined, 'shutdown drain settles without a cursor');
  assert.equal(await activation.activate(), undefined, 'a later activate on the closed subscription settles');
  assert.deepEqual(delivered.map((e) => e.seq), [1], 'no second batch is delivered after close');
});

test('principal delivery close before activation leaves no active subscription', async () => {
  const { delivery, declaration } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let revokes = 0;
  const delivered = [];
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => delivered.push(...batch),
    revoke: () => { revokes += 1; },
  });
  delivery.close();
  assert.equal(revokes, 1, 'close between subscribe and activate revokes once');
  assert.equal(await activation.activate(), undefined, 'activation of a closed subscription settles without a cursor');
  assert.deepEqual(delivered, [], 'nothing delivers after close');
  delivery.close();
  assert.equal(revokes, 1, 'repeated close after removal does not double-release');
});

test('principal delivery abort is idempotent and releases exactly once', async () => {
  const { delivery, declaration } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const controller = new AbortController();
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: controller.signal,
    deliver: async () => {},
    revoke: () => { revokes += 1; },
  });
  controller.abort();
  assert.equal(revokes, 1, 'abort revokes the subscription once');
  controller.abort();
  assert.equal(revokes, 1, 'a second abort does not double-release');
  delivery.close();
  assert.equal(revokes, 1, 'close after abort does not double-release');
  assert.equal(await activation.activate(), undefined, 'aborted activation settles without a cursor');
});

test('owned live delivery forwards signal and revoke to principal snapshot subscriptions', async () => {
  const { db, schema, declaration } = setup();
  const owned = createOwnedLiveDelivery({
    db,
    entities: new Map(),
    mayVerb: async () => true,
    principalSnapshots: [declaration],
    schema,
  });
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  const controller = new AbortController();
  let revokes = 0;
  const activation = await owned.delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: controller.signal,
    deliver: async () => {},
    revoke: () => { revokes += 1; },
  });
  assert.equal(await activation.activate(), 0, 'open subscription quiesces at its cursor');
  controller.abort();
  assert.equal(revokes, 1, 'the owned public seam forwards the transport abort to the principal delivery');
  assert.equal(await activation.activate(), undefined, 'aborted subscription settles without a cursor');
  owned.close();
  assert.equal(revokes, 1, 'close after abort does not double-release');
});

test('principal delivery wake during an active drain delivers the woken revision', async () => {
  const { delivery, declaration, db, app } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  let entered;
  let release;
  const deliveryEntered = new Promise((resolve) => { entered = resolve; });
  const deliveryGate = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  let first = true;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async (batch) => {
      if (first) {
        first = false;
        entered();
        await deliveryGate;
      }
      delivered.push(...batch);
    },
  });
  const draining = activation.activate();
  await deliveryEntered;
  await app.principalSnapshots.transaction((tx) => tx.invalidate(declaration, { type: 'user', id: 'u1' }));
  release();
  assert.equal(await draining, 2, 'the drain picks up the woken second revision and reports the final cursor');
  assert.deepEqual(delivered.map((envelope) => envelope.seq), [1, 2]);
  delivery.close();
});

test('principal delivery terminal drain error removal revokes exactly once', async () => {
  const { delivery, declaration, db } = setup();
  const scope = principalSnapshotScope({ declaration: declaration.name, principal: { type: 'user', id: 'u1' } });
  let revokes = 0;
  const activation = await delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope, after: 0, signal: new AbortController().signal,
    deliver: async () => { throw new Error('drain boom'); },
    revoke: () => { revokes += 1; },
  });
  db.prepare(
    `INSERT INTO _PrincipalSnapshotRevision (declaration, principalType, principalId, revision) VALUES (?, ?, ?, 1)
     ON CONFLICT(declaration, principalType, principalId) DO UPDATE SET revision = revision + 1`,
  ).run(declaration.name, 'user', 'u1');
  await assert.rejects(() => activation.activate(), /drain boom/);
  assert.equal(revokes, 1, 'a terminal drain error revokes exactly once');
  delivery.close();
  assert.equal(revokes, 1, 'close after the removed subscription does not double-release');
});
