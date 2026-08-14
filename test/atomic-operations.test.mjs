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
  atomicOperation,
  claim,
  executeAtomicOperation,
  executeAtomicOperations,
  increment,
  isAtomicOperation,
  setAdd,
  setRemove,
  toggleTo,
} from '../build/index.mjs';

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
  assert.equal(isAtomicOperation({ kind: 'setAdd', field: 'members', value: () => {} }), false);
  assert.equal(isAtomicOperation({ kind: 'setAdd', field: 'members', value: NaN }), false);
  assert.equal(isAtomicOperation({ kind: 'claim', field: 'owner', value: undefined }), false);
  assert.throws(() => toggleTo('enabled', 'yes'), /boolean/);
  assert.throws(() => executeAtomicOperation({ count: '2' }, increment('count')), /finite number/);
});

test('the pipeline resolves a registered atomic operation inside its write transaction', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
  db.prepare('INSERT INTO Note (id, enabled) VALUES (?, ?)').run('n1', 0);

  let calls = 0;
  const toggle = atomicOperation({
    entity: { fields: { enabled: {} } },
    read: ({ db: transactionDb }) => {
      const stored = transactionDb.prepare('SELECT enabled FROM Note WHERE id = ?').get('n1');
      return { id: 'n1', enabled: stored.enabled === 1 };
    },
  }, ({ atomic }) => {
    calls += 1;
    return [{ type: 'Note.updated', scope: 'Note:n1', data: { id: 'n1', enabled: atomic.row.enabled } }];
  });
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
    authorization: { admit: async () => ({ admitted: true }) },
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

test('field admission denies an atomic operation before its projection', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, secret INTEGER NOT NULL)');
  db.prepare('INSERT INTO Note (id, secret) VALUES (?, ?)').run('n1', 0);
  let projected = false;
  let handlerCalls = 0;
  const acknowledgeSecret = atomicOperation({
    entity: { fields: { secret: {} } },
    read: ({ db: transactionDb }) => ({ id: 'n1', secret: transactionDb.prepare('SELECT secret FROM Note WHERE id = ?').get('n1').secret === 1 }),
  }, ({ atomic }) => {
    handlerCalls += 1;
    return [{ type: 'Note.updated', scope: 'Note:n1', data: { id: 'n1', secret: atomic.row.secret } }];
  });
  const server = createServer({
    db,
    handlers: { 'Note.ack': acknowledgeSecret },
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant({
      admission: { beforeProjection: async () => true, afterProjection: async () => true },
      projectionConsumers: [{ eventTypes: ['Note.updated'], apply: () => { projected = true; } }],
    }),
    tierOfEvent: () => 'live',
    authorize: async () => true,
    authorization: { admit: async ({ fieldName }) => ({ admitted: fieldName !== 'secret' }) },
  });
  const outcome = await server.dispatch({
    actionId: 'denied-ack', type: 'Note.ack', payload: { atomicOperations: [acknowledge('secret')] },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.category, 'denied');
  assert.equal(projected, false);
  assert.equal(handlerCalls, 0, 'the handler never receives a denied field update');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _NoHistoryReceipt').get().count, 0);
  db.close();
});

test('a batch resolves and admits an atomic operation inside its shared transaction', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
  db.prepare('INSERT INTO Note (id, enabled) VALUES (?, ?)').run('n1', 0);
  let handlerCalls = 0;
  const toggle = atomicOperation({
    entity: { fields: { enabled: {} } },
    read: ({ db: transactionDb }) => ({
      id: 'n1',
      enabled: transactionDb.prepare('SELECT enabled FROM Note WHERE id = ?').get('n1').enabled === 1,
    }),
  }, ({ atomic }) => {
    handlerCalls += 1;
    return [{ type: 'Note.updated', scope: 'Note:n1', data: { id: 'n1', enabled: atomic.row.enabled } }];
  });
  const server = createServer({
    db,
    handlers: { 'Note.toggle': toggle },
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Note.updated'],
        apply: (event, txn) => txn.prepare('UPDATE Note SET enabled = ? WHERE id = ?').run(event.data.enabled ? 1 : 0, event.data.id),
      }],
    }),
    tierOfEvent: () => 'live',
    authorize: async () => true,
    authorization: { admit: async ({ fieldName }) => ({ admitted: fieldName !== 'enabled' }) },
  });

  const denied = await server.dispatchBatch({
    actionId: 'batch-denied',
    actions: [{ type: 'Note.toggle', payload: { atomicOperations: [toggleTo('enabled', true)] } }],
    principal: { id: 'alice' },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.failure.category, 'denied');
  assert.equal(denied.failure.details.actionIndex, 0);
  assert.equal(handlerCalls, 0, 'the handler does not run when field admission denies its atomic update');

  const admittedServer = createServer({
    db,
    handlers: { 'Note.toggle': toggle },
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Note.updated'],
        apply: (event, txn) => txn.prepare('UPDATE Note SET enabled = ? WHERE id = ?').run(event.data.enabled ? 1 : 0, event.data.id),
      }],
    }),
    tierOfEvent: () => 'live',
    authorize: async () => true,
    authorization: { admit: async () => ({ admitted: true }) },
  });
  const committed = await admittedServer.dispatchBatch({
    actionId: 'batch-admitted',
    actions: [{ type: 'Note.toggle', payload: { atomicOperations: [toggleTo('enabled', true)] } }],
    principal: { id: 'alice' },
  });
  assert.equal(committed.ok, true);
  assert.equal(handlerCalls, 1);
  assert.equal(db.prepare('SELECT enabled FROM Note WHERE id = ?').get('n1').enabled, 1);
  db.close();
});

test('concurrent atomic operations resolve against the latest row without losing either change', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, members TEXT NOT NULL, count INTEGER NOT NULL)');
  db.prepare('INSERT INTO Note (id, members, count) VALUES (?, ?, ?)').run('n1', '[]', 0);
  const change = atomicOperation({
    entity: { fields: { members: {}, count: {} } },
    read: ({ db: transactionDb }) => {
      const row = transactionDb.prepare('SELECT members, count FROM Note WHERE id = ?').get('n1');
      return { id: 'n1', members: JSON.parse(row.members), count: row.count };
    },
  }, ({ atomic }) => [{ type: 'Note.updated', scope: 'Note:n1', data: atomic.row }]);
  const server = createServer({
    db,
    handlers: { 'Note.change': change },
    pipeline: durableMutationVariant(),
    livePipeline: liveMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Note.updated'],
        apply: (event, txn) => txn.prepare('UPDATE Note SET members = ?, count = ? WHERE id = ?')
          .run(JSON.stringify(event.data.members), event.data.count, event.data.id),
      }],
    }),
    tierOfEvent: () => 'live',
    authorize: async () => true,
    authorization: { admit: async () => ({ admitted: true }) },
  });

  const [membership, count] = await Promise.all([
    server.dispatch({ actionId: 'add-member', type: 'Note.change', payload: { atomicOperations: [setAdd('members', 'alice')] } }),
    server.dispatch({ actionId: 'increment-count', type: 'Note.change', payload: { atomicOperations: [increment('count')] } }),
  ]);
  assert.equal(membership.ok, true);
  assert.equal(count.ok, true);
  assert.deepEqual({ ...db.prepare('SELECT members, count FROM Note WHERE id = ?').get('n1') }, { members: '["alice"]', count: 1 });
  db.close();
});
