// maintenance.test.mjs — the shared-state PRAGMA maintenance seam (epic
// scope#23, S1/A5; S1/B1 consumes it). withForeignKeysDisabled must run inside
// ONE coordinated write turn (so it cannot interleave with other writes),
// actually relax FK enforcement, and restore `foreign_keys = ON` in a finally
// even when the body throws. A raw `PRAGMA foreign_keys` toggle is not the
// approved route — the seam is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench from '../build/internal.mjs';
import { createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';
import { createMaintenanceSeam } from '../build/maintenance.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function foreignKeysSetting(db) {
  return db.prepare('PRAGMA foreign_keys').get().foreign_keys;
}

function fkApp() {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))');
  return { db, app };
}

function orphanInsert(db) {
  return () => db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'p1');
}

test('the seam enters through the write coordinator and owns the turn', async () => {
  const { db, app } = fkApp();
  try {
    let ownedInside = null;
    await app.withForeignKeysDisabled(() => {
      ownedInside = app.writeCoordinator.owned;
    });
    assert.equal(ownedInside, true, 'the maintenance body runs inside a coordinated write turn');
    assert.equal(foreignKeysSetting(db), 1, 'foreign_keys restored to ON after the seam');
  } finally {
    db.close();
  }
});

test('FK enforcement is actually relaxed inside the seam and restored after', async () => {
  const { db, app } = fkApp();
  try {
    assert.equal(foreignKeysSetting(db), 1, 'the connection starts with foreign_keys ON');
    assert.throws(orphanInsert(db), /foreign key/i, 'an orphan child is refused with FK on');

    await app.withForeignKeysDisabled(() => {
      assert.equal(foreignKeysSetting(db), 0, 'foreign_keys is OFF inside the seam');
      assert.doesNotThrow(orphanInsert(db), 'the orphan child inserts while FK is disabled');
    });

    assert.equal(foreignKeysSetting(db), 1, 'restored to ON after the seam');
    db.exec('DELETE FROM child');
    assert.throws(orphanInsert(db), /foreign key/i, 'enforcement is back after the seam');
  } finally {
    db.close();
  }
});

test('foreign_keys is restored to ON even when the body throws', async () => {
  const { db, app } = fkApp();
  try {
    await assert.rejects(
      app.withForeignKeysDisabled(() => {
        assert.equal(foreignKeysSetting(db), 0);
        throw new Error('maintenance body failed');
      }),
      /maintenance body failed/,
    );
    assert.equal(foreignKeysSetting(db), 1, 'the finally restored ON after the throw');
  } finally {
    db.close();
  }
});

test('an async body that yields mid-run keeps foreign_keys OFF until it completes', async () => {
  const { db, app } = fkApp();
  try {
    let released;
    const gate = new Promise((resolve) => { released = resolve; });
    let midBody = null;
    const maintenance = app.withForeignKeysDisabled(async () => {
      assert.equal(foreignKeysSetting(db), 0, 'OFF at the start of the async body');
      await gate; // yield mid-body — the restore must NOT happen here
      midBody = foreignKeysSetting(db);
      return 'async-done';
    });

    await delay(10);
    assert.equal(foreignKeysSetting(db), 0, 'foreign_keys stays OFF while the async body is still awaiting');
    assert.equal(midBody, null, 'the body has not resumed yet');

    released();
    assert.equal(await maintenance, 'async-done');
    assert.equal(midBody, 0, 'still OFF at the point right after the yield');
    assert.equal(foreignKeysSetting(db), 1, 'restored to ON only after the async body completed');
  } finally {
    db.close();
  }
});

test('an async body that throws still restores foreign_keys to ON', async () => {
  const { db, app } = fkApp();
  try {
    let released;
    const gate = new Promise((resolve) => { released = resolve; });
    const maintenance = app.withForeignKeysDisabled(async () => {
      await gate;
      throw new Error('async maintenance failed');
    });

    await delay(10);
    assert.equal(foreignKeysSetting(db), 0, 'still OFF while the async body awaits');

    released();
    await assert.rejects(maintenance, /async maintenance failed/);
    assert.equal(foreignKeysSetting(db), 1, 'restored to ON even though the async body threw');
  } finally {
    db.close();
  }
});

test('a thenable whose `then` getter throws still restores foreign_keys to ON', async () => {
  const { db, app } = fkApp();
  try {
    const evilThenable = {
      get then() {
        throw new Error('then getter exploded');
      },
    };
    await assert.rejects(
      app.withForeignKeysDisabled(() => evilThenable),
      /then getter exploded/,
    );
    assert.equal(foreignKeysSetting(db), 1, 'restored to ON even though the thenable\'s `then` getter threw');
  } finally {
    db.close();
  }
});

test('the seam serializes behind an in-flight coordinated write', async () => {
  const { db, app } = fkApp();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = app.writeCoordinator.run(async () => {
      await gate;
      return 'held';
    });
    await delay(10); // let the held write acquire the coordinator

    let started = false;
    const maintenance = app.withForeignKeysDisabled(() => {
      started = true;
      assert.equal(foreignKeysSetting(db), 0);
      return 42;
    });

    await delay(10);
    assert.equal(started, false, 'the seam waits for the in-flight write to release the coordinator');

    release();
    assert.equal(await held, 'held');
    assert.equal(await maintenance, 42, 'the seam ran after the held write, serialized');
    assert.equal(started, true);
    assert.equal(foreignKeysSetting(db), 1);
  } finally {
    db.close();
  }
});

test('the seam fails closed without a db handle', async () => {
  const writeQueue = createWriteQueue();
  const seam = createMaintenanceSeam(() => null, writeQueue);
  await assert.rejects(seam.withForeignKeysDisabled(() => 1), /requires a database/);
  await writeQueue.close();
});

test('an adapter-backed app resolves the db handle at call time', async () => {
  const app = workbench({ db: createSqliteAdapter({ mode: 'memory' }) });
  try {
    await assert.rejects(
      app.withForeignKeysDisabled(() => 1),
      /requires a database/,
      'before the deferred open there is no handle — fail closed',
    );
    await app.ready;
    await app.withForeignKeysDisabled(() => {
      assert.equal(app.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 0);
    });
    assert.equal(app.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally {
    await app.shutdown();
  }
});
