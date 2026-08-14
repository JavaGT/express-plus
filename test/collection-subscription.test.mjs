import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createCollectionSubscription, createCollectionSubscriptionRegistry, CollectionSubscriptionBackpressureError } from '../build/collection-subscription.mjs';
import { compileSubscriptionRule } from '../build/subscription-rule.mjs';
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
    const deps = { resolveEntity: (name) => name === 'Note' ? entity : null, mayVerb: async () => true, db, fanout: { subscriptionCount: () => 0, hasSubscription: () => false }, authorization: { admit: async () => ({ admitted: true }) } };
    const admitted = await authorizeSubscription({ scope: 'Note', rule }, { principal: { type: 'user', id: 'u1' } }, deps);
    assert.equal(admitted.admitted, true);
    assert.ok('sql' in admitted.interest.rule, 'admission retains the registration-time compiled rule');

    const denied = await authorizeSubscription({ scope: 'Note', rule: { ...rule, filters: [{ field: 'missing' }] } }, { principal: { type: 'user', id: 'u1' } }, { ...deps, authorization: { admit: async () => ({ admitted: false }) } });
    assert.deepEqual(denied, { admitted: false, failure: { category: 'denied', message: 'Forbidden.' } });
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
