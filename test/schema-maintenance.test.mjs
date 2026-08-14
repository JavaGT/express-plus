import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createWriteQueue } from '../build/write-queue.mjs';
import { createSchemaMaintenanceRunner } from '../build/schema-maintenance.mjs';

test('maintenance resumes a failed step from its durable checkpoint without rerunning completed work', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createWriteQueue();
  let completedCalls = 0;
  let resumableCalls = 0;
  let fail = true;
  const runner = createSchemaMaintenanceRunner({
    db,
    writeCoordinator: queue,
    steps: [
      { id: 'complete', description: 'completed work', run: () => { completedCalls += 1; } },
      {
        id: 'resume', description: 'checkpointed work', run: ({ progress, checkpoint }) => {
          resumableCalls += 1;
          assert.deepEqual(progress, resumableCalls === 1 ? null : { copied: 10 });
          checkpoint({ copied: 10 });
          if (fail) throw new Error('simulated interruption');
        },
      },
    ],
  });
  try {
    await assert.rejects(runner.run(), /simulated interruption/);
    assert.equal(completedCalls, 1);
    assert.equal(runner.states().find((state) => state.id === 'resume').state, 'failed');

    fail = false;
    await runner.run();
    assert.equal(completedCalls, 1, 'a completed step never runs again');
    assert.equal(resumableCalls, 2, 'the interrupted step resumes');
    assert.deepEqual(runner.states().find((state) => state.id === 'resume').progress, { copied: 10 });
  } finally {
    await queue.close();
    db.close();
  }
});

test('maintenance does not claim transactional atomicity and routes FK changes through its seam', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createWriteQueue();
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE source (id TEXT PRIMARY KEY); CREATE TABLE derived (id TEXT PRIMARY KEY, sourceId TEXT REFERENCES source(id))');
  const runner = createSchemaMaintenanceRunner({
    db,
    writeCoordinator: queue,
    steps: [{
      id: 'non-atomic', description: 'vacuum and FK repair', run: async ({ db: handle, withForeignKeysDisabled }) => {
        handle.prepare('INSERT INTO source (id) VALUES (?)').run('retained');
        handle.exec('VACUUM');
        await withForeignKeysDisabled(() => handle.prepare('INSERT INTO derived (id, sourceId) VALUES (?, ?)').run('d1', 'missing'));
        throw new Error('after durable maintenance work');
      },
    }],
  });
  try {
    await assert.rejects(runner.run(), /after durable maintenance work/);
    assert.ok(db.prepare('SELECT 1 FROM source WHERE id = ?').get('retained'), 'pre-failure maintenance work remains');
    assert.ok(db.prepare('SELECT 1 FROM derived WHERE id = ?').get('d1'), 'FK maintenance used the explicit seam');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'the FK seam restored enforcement');
  } finally {
    await queue.close();
    db.close();
  }
});
