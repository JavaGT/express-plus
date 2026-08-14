// Atomic live-field operations (#104). The executor is used by an in-transaction
// handler; its emitted update then follows the normal live mutation pipeline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createServer,
  durableMutationVariant,
  executeFrameworkDDL,
  liveMutationVariant,
} from '../build/internal.mjs';
import {
  acknowledge,
  ATOMIC_OPERATION_KINDS,
  claim,
  executeAtomicOperation,
  executeAtomicOperations,
  increment,
  isAtomicOperation,
  setAdd,
  setRemove,
  toggleTo,
} from '../build/atomic-operations.mjs';

test('membership, increment, claim, acknowledge, and toggle-to-known-value have deterministic results', () => {
  const start = Object.freeze({ members: ['a'], count: 2, owner: null, seen: false, enabled: false });
  const result = executeAtomicOperations(start, [
    setAdd('members', 'b'),
    setAdd('members', 'b'),
    setRemove('members', 'a'),
    increment('count', 3),
    claim('owner', 'alice'),
    acknowledge('seen'),
    toggleTo('enabled', true),
  ]);

  assert.deepEqual(result.row, { members: ['b'], count: 5, owner: 'alice', seen: true, enabled: true });
  assert.equal(result.applied, true);
  assert.deepEqual(executeAtomicOperation(result.row, claim('owner', 'alice')).row, result.row, 'a retry by the same claimant is a no-op');
  assert.throws(() => executeAtomicOperation(result.row, claim('owner', 'bob')), { message: /conflicts/ });
});

test('the grammar has no invert operation and rejects malformed operations', () => {
  assert.deepEqual([...ATOMIC_OPERATION_KINDS].sort(), ['acknowledge', 'claim', 'increment', 'setAdd', 'setRemove', 'toggleTo']);
  assert.equal(ATOMIC_OPERATION_KINDS.includes('invert'), false);
  assert.equal(isAtomicOperation({ kind: 'toggle', field: 'enabled' }), false);
  assert.equal(isAtomicOperation({ kind: 'invert', field: 'enabled' }), false);
  assert.throws(() => toggleTo('enabled', 'yes'), /boolean/);
  assert.throws(() => executeAtomicOperation({ count: '2' }, increment('count')), /finite number/);
});

test('atomic operation envelopes use the live mutation variant and preserve its expected-revision conflict', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
  db.prepare('INSERT INTO Note (id, enabled) VALUES (?, ?)').run('n1', 0);

  let calls = 0;
  const toggle = ({ payload, db: transactionDb }) => {
    calls += 1;
    const stored = transactionDb.prepare('SELECT enabled FROM Note WHERE id = ?').get('n1');
    const resolved = executeAtomicOperations({ enabled: stored.enabled === 1 }, payload.atomicOperations);
    return [{ type: 'Note.updated', scope: 'Note:n1', data: { id: 'n1', enabled: resolved.row.enabled } }];
  };
  Object.defineProperty(toggle, 'inTransaction', { value: true });
  const server = createServer({
    db,
    handlers: {
      'Note.toggle': toggle,
    },
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Note.updated'],
        apply: (event, txn) => txn.prepare('UPDATE Note SET enabled = ? WHERE id = ?').run(event.data.enabled ? 1 : 0, event.data.id),
      }],
    }),
    tierOfEvent: () => 'live',
    authorize: async () => true,
  });

  const request = {
    actionId: 'toggle-1', type: 'Note.toggle', payload: {
      value: true, atomicOperations: [toggleTo('enabled', true)], expectedRevision: 0,
    },
  };
  const first = await server.dispatch(request);
  const retry = await server.dispatch(request);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(calls, 1, 'the no-history receipt prevents a retry from reapplying');
  assert.equal(db.prepare('SELECT enabled FROM Note WHERE id = ?').get('n1').enabled, 1);

  const stale = await server.dispatch({
    actionId: 'toggle-2', type: 'Note.toggle', payload: {
      value: false, atomicOperations: [toggleTo('enabled', false)], expectedRevision: 0,
    },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'conflict');
  assert.equal(db.prepare('SELECT enabled FROM Note WHERE id = ?').get('n1').enabled, 1);
  db.close();
});

test('admission denial rolls back an atomic live operation before its projection', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  let projected = false;
  const server = createServer({
    db,
    handlers: { 'Note.ack': () => [{ type: 'Note.updated', scope: 'Note:n1', data: { id: 'n1' } }] },
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant({
      admission: { beforeProjection: async () => false, afterProjection: async () => true },
      projectionConsumers: [{ eventTypes: ['Note.updated'], apply: () => { projected = true; } }],
    }),
    tierOfEvent: () => 'live',
    authorize: async () => true,
  });
  const outcome = await server.dispatch({
    actionId: 'denied-ack', type: 'Note.ack', payload: { atomicOperations: [acknowledge('seen')] },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.category, 'denied');
  assert.equal(projected, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _NoHistoryReceipt').get().count, 0);
  db.close();
});
