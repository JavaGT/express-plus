import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createWriteQueue } from '../build/write-queue.mjs';
import { createDerivedResourceRegistry } from '../build/derived-resource.mjs';

test('derived resources persist the absent, preparing, current, stale, and rebuilding lifecycle', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createWriteQueue();
  const transitions = [];
  const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue, batchSize: 1 });
  registry.register({
    id: 'search',
    prepare: () => {},
    rebuild: () => {},
    onTransition: (entry) => transitions.push(entry.state),
  });
  try {
    await registry.engage();
    assert.equal(registry.stateOf('search').state, 'absent');
    await registry.prepareAll();
    assert.equal(registry.stateOf('search').state, 'current');
    await registry.markStale('search');
    assert.equal(registry.stateOf('search').state, 'stale');
    await registry.reconcileBatches();
    assert.equal(registry.stateOf('search').state, 'current');
    assert.deepEqual(transitions, ['absent', 'preparing', 'current', 'stale', 'rebuilding', 'current']);
  } finally {
    await queue.close();
    db.close();
  }
});

test('derived failure is isolated from source data, durable, and retried in bounded batches', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createWriteQueue();
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY); CREATE TABLE Derived (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO Source (id) VALUES (?)').run('authoritative');
  let failures = 1;
  let rebuilds = 0;
  const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue, batchSize: 1 });
  registry.register({
    id: 'first', prepare: () => {}, rebuild: () => { rebuilds += 1; },
  });
  registry.register({
    id: 'second',
    prepare: () => {},
    rebuild: ({ db: handle }) => {
      rebuilds += 1;
      handle.prepare('INSERT OR REPLACE INTO Derived (id) VALUES (?)').run('partial-index');
      if (failures-- > 0) throw new Error('index unavailable');
    },
  });
  try {
    await registry.prepareAll();
    await registry.markStale('first');
    await registry.markStale('second');
    const firstBatch = await registry.reconcileBatches();
    assert.equal(firstBatch.processed, 1, 'only one resource is rebuilt in the bounded batch');
    assert.equal(firstBatch.remaining, 1);
    const secondBatch = await registry.reconcileBatches();
    assert.equal(secondBatch.processed, 1);
    assert.equal(registry.stateOf('second').state, 'failed');
    assert.match(registry.stateOf('second').lastError, /index unavailable/);
    assert.ok(db.prepare('SELECT 1 FROM Source WHERE id = ?').get('authoritative'), 'a derived failure cannot roll back source data');
    assert.ok(db.prepare('SELECT 1 FROM Derived WHERE id = ?').get('partial-index'), 'derived writes are independently retained for an idempotent retry');
    await registry.reconcileBatches();
    assert.equal(registry.stateOf('second').state, 'current');
    assert.equal(rebuilds, 3);
  } finally {
    await queue.close();
    db.close();
  }
});
