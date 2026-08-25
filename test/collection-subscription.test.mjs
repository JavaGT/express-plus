import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createCollectionSubscription, createCollectionSubscriptionRegistry, CollectionSubscriptionBackpressureError } from '../build/collection-subscription.mjs';
import { compileSubscriptionRule } from '../build/subscription-rule.mjs';
import { collectionDeliveryEnvelope } from '../build/live-delivery-envelope.mjs';
import { authorizeSubscription } from '../build/live-admission.mjs';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, rank INTEGER, visible INTEGER); INSERT INTO Note VALUES ('a', 'A', 2, 1), ('b', 'B', 1, 1), ('hidden', 'Hidden', 0, 0)");
  const entity = {
    name: 'Note',
    fields: { title: { kind: 'value' }, rank: { kind: 'value' }, visible: { kind: 'value' } },
    scopeFilter: () => ({ sql: 't0.visible = :visible', params: { visible: 1 } }),
  };
  const rule = { resourceKind: 'Note', select: ['title', 'rank'], sort: [{ field: 'rank' }], boundedResultPolicy: { limit: 2, overflowMarker: 'more' } };
  const authorization = { admit: async (input) => ({ admitted: input.fieldName !== 'visible' }) };
  return { db, entity, rule, authorization };
}

test('collection subscriptions deliver additions, removals, reorderings, access changes, and bounded overflow', async () => {
  const { db, entity, rule, authorization } = setup();
  try {
    const delivered = [];
    const subscription = createCollectionSubscription({ db, entity, principal: { type: 'user', id: 'u1' }, rule, authorization, mayVerb: async () => true, deliver: (change) => delivered.push(change) });
    const first = await subscription.refresh();
    assert.deepEqual(first.rows.map((row) => row.id), ['b', 'a']);
    assert.equal(first.overflow, null);
    assert.equal('visible' in first.rows[0], false, 'unreadable fields are omitted');

    db.exec("INSERT INTO Note VALUES ('c', 'C', 0, 1)");
    await subscription.notify();
    assert.deepEqual(delivered.at(-1).removals, ['a'], 'bounded overflow removes the row displaced by a new member');
    assert.deepEqual(delivered.at(-1).additions.map((row) => row.id), ['c']);
    assert.equal(delivered.at(-1).overflow, 'more');

    db.exec("UPDATE Note SET rank = 1.5 WHERE id = 'c'");
    const reordered = await subscription.refresh();
    assert.ok(reordered.reorderings.length > 0);

    db.exec("UPDATE Note SET visible = 0 WHERE id = 'c'");
    const accessChanged = await subscription.refresh();
    assert.ok(accessChanged.removals.includes('c'), 'a member outside row scope is withheld');
  } finally {
    db.close();
  }
});

test('a malformed or non-compilable collection rule fails during registration', () => {
  const { entity } = setup();
  assert.throws(() => compileSubscriptionRule({ resourceKind: 'Note', filters: [{ field: 'title', op: 'sql', value: 'DROP TABLE Note' }], boundedResultPolicy: { limit: 1 } }, entity), /unsupported operator/);
  assert.throws(() => compileSubscriptionRule({ resourceKind: 'Note', filters: [{ field: 'missing', value: 1 }], boundedResultPolicy: { limit: 1 } }, entity), /unknown field/);
  assert.throws(() => compileSubscriptionRule({ resourceKind: 'Note', filters: [{ field: 'title', value: () => true }], boundedResultPolicy: { limit: 1 } }, entity), /data, not a function/);
  assert.throws(() => compileSubscriptionRule({ resourceKind: 'Note', filters: [{ field: 'title', value: { cannot: 'bind' } }], boundedResultPolicy: { limit: 1 } }, entity), /SQLite scalar/);
});

test('collection admission compiles rules only after subscription authorization', async () => {
  const { db, entity, rule } = setup();
  try {
    const deps = { resolveEntity: (name) => name === 'Note' ? entity : null, mayVerb: async () => true, db, fanout: { subscriptionCount: () => 0, collectionSubscriptionCount: () => 0, hasSubscription: () => false }, authorization: { admit: async () => ({ admitted: true }) } };
    const admitted = await authorizeSubscription({ scope: 'Note', rule }, { principal: { type: 'user', id: 'u1' } }, deps);
    assert.equal(admitted.admitted, true);
    assert.ok('sql' in admitted.interest.rule, 'admission retains the registration-time compiled rule');

    const denied = await authorizeSubscription({ scope: 'Note', rule: { ...rule, filters: [{ field: 'missing' }] } }, { principal: { type: 'user', id: 'u1' } }, { ...deps, authorization: { admit: async () => ({ admitted: false }) } });
    assert.deepEqual(denied, { admitted: false, failure: { category: 'denied', message: 'Forbidden.' } });
  } finally {
    db.close();
  }
});

test('collection rules reject unknown and malformed optional grammar', () => {
  const { entity, rule } = setup();
  for (const invalid of [
    { ...rule, unknown: true },
    { ...rule, select: 42 },
    { ...rule, filters: null },
    { ...rule, parent: null },
    { ...rule, sort: [{ field: 'rank', extra: true }] },
  ]) {
    assert.throws(() => compileSubscriptionRule(invalid, entity), /Invalid collection subscription rule/);
  }
  assert.equal(compileSubscriptionRule({ ...rule, boundedResultPolicy: { limit: 1, overflowMarker: null } }, entity).boundedResultPolicy.overflowMarker, null);
});

test('collection bounds only admitted rows and serializes direct refreshes', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, rank INTEGER); INSERT INTO Note VALUES ('hidden', 'Hidden', 0), ('a', 'A', 1), ('b', 'B', 2)");
  try {
    const entity = { name: 'Note', fields: { title: {}, rank: {} }, scopeFilter: () => ({ sql: '1=1', params: {} }) };
    const subscription = createCollectionSubscription({
      db, entity, principal: { type: 'user', id: 'u1' }, authorization: { admit: async ({ row }) => ({ admitted: row.id !== 'hidden' }) }, mayVerb: async () => true,
      rule: { resourceKind: 'Note', sort: [{ field: 'rank' }], boundedResultPolicy: { limit: 2, overflowMarker: 'more' } }, deliver: () => {},
    });
    const [first, second] = await Promise.all([subscription.refresh(), subscription.refresh()]);
    assert.deepEqual(first.rows.map((row) => row.id), ['a', 'b']);
    assert.equal(first.overflow, null, 'an inaccessible row neither consumes a slot nor overflows it');
    assert.equal(second, null, 'concurrent refreshes observe a serialized baseline');
  } finally {
    db.close();
  }
});

test('an initial-empty collection delivers its authoritative empty state without any write (#163)', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, rank INTEGER)');
  try {
    const entity = { name: 'Note', fields: { title: {}, rank: {} }, scopeFilter: () => ({ sql: '1=1', params: {} }) };
    const rule = { resourceKind: 'Note', select: ['title', 'rank'], sort: [{ field: 'rank' }], boundedResultPolicy: { limit: 2 } };
    const delivered = [];
    const subscription = createCollectionSubscription({ db, entity, principal: { type: 'user', id: 'u1' }, rule, authorization: { admit: async () => ({ admitted: true }) }, mayVerb: async () => true, deliver: (change) => delivered.push(change) });

    const baseline = await subscription.refresh();
    assert.deepEqual(baseline.rows, [], 'the first refresh is an authoritative empty snapshot');
    assert.equal(baseline.overflow, null);
    assert.deepEqual(baseline.additions, []);
    assert.deepEqual(baseline.removals, []);

    // Wire contract: the baseline maps to the same `state` envelope shape as a
    // normal catch-up delivery, and an unchanged later refresh stays silent.
    assert.deepEqual(collectionDeliveryEnvelope(baseline, { entityName: 'Note', revision: 0 }), { type: 'state', entity: 'Note', id: 'Note', seq: 0, additions: [], removals: [], reorderings: [], rows: [] });
    assert.equal(await subscription.refresh(), null, 'unchanged refreshes after the baseline stay silent');

    await subscription.notify();
    assert.equal(delivered.length, 0, 'a wake without writes emits nothing beyond the baseline');

    db.exec("INSERT INTO Note VALUES ('a', 'A', 1)");
    await subscription.notify();
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].additions.map((row) => row.id), ['a'], 'the subscription still delivers real changes');
  } finally {
    db.close();
  }
});

test('collection connection and pending-delivery limits fail instead of dropping updates', async () => {
  const { db, entity, rule, authorization } = setup();
  try {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const subscription = createCollectionSubscription({ db, entity, principal: { type: 'user', id: 'u1' }, rule, authorization, mayVerb: async () => true, maxPendingDeliveries: 1, deliver: () => blocked });
    const first = subscription.notify();
    await assert.rejects(subscription.notify(), CollectionSubscriptionBackpressureError);
    release();
    await first;

    const registry = createCollectionSubscriptionRegistry(1);
    const connection = {};
    registry.add(connection, subscription);
    assert.throws(() => registry.add(connection, createCollectionSubscription({ db, entity, principal: { type: 'user', id: 'u1' }, rule, authorization, mayVerb: async () => true, deliver: () => {} })), CollectionSubscriptionBackpressureError);
  } finally {
    db.close();
  }
});
