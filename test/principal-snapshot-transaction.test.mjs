import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPrincipalSnapshotTransaction } from '../build/principal-snapshot-transaction.mjs';
import { principalSnapshot, projectionSource } from '../build/principal-snapshot-declaration.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

function schema() {
  return Object.freeze({ tables: [] });
}

function makeApp() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const app = { db };
  app.writeQueue = createWriteQueue();
  app._principalSnapshotTxActive = false;
  const runtime = createPrincipalSnapshotTransaction(app);
  app.principalSnapshots = { transaction: runtime.transaction };
  app._principalSnapshotRuntime = runtime;
  return { app, db, runtime };
}

function makeDeclaration(name = 'test-decl', principalType = 'user') {
  const s = projectionSource(schema(), 'MyTable');
  return principalSnapshot(name, {
    principalType,
    output: principalSnapshot.object({
      items: principalSnapshot.many(s, {
        via: s.field.recipientId,
        key: s.field.id,
        select: principalSnapshot.select(s.field.id, s.field.name),
      }),
    }),
  });
}

// ── Host table mutation + revision atomic commit ────────────────────────────

test('host table mutation and revision increment share one atomic transaction', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  const row = db.prepare('SELECT name FROM profile WHERE id = ?').get('u1');
  assert.equal(row.name, 'Alicia');

  const rev = db.prepare(
    'SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?'
  ).get('test-decl', 'user', 'u1');
  assert.equal(rev.revision, 1);
});

// ── Callback error rolls back everything ────────────────────────────────────

test('callback error rolls back host mutation and revision', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
      tx.invalidate(decl, { type: 'user', id: 'u1' });
      throw new Error('boom');
    }),
    /boom/,
  );

  const row = db.prepare('SELECT name FROM profile WHERE id = ?').get('u1');
  assert.equal(row.name, 'Alice');

  const rev = db.prepare(
    'SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?'
  ).get('test-decl', 'user', 'u1');
  assert.equal(rev, undefined);
});

// ── Invalid recipient rejected → rollback ───────────────────────────────────

test('invalid recipient type rolls back host mutation', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
      tx.invalidate(decl, { type: 'system', id: 'u1' });
    }),
    /recipient type/,
  );

  const row = db.prepare('SELECT name FROM profile WHERE id = ?').get('u1');
  assert.equal(row.name, 'Alice');
});

// ── Foreign declaration (brand mismatch) → rollback ─────────────────────────

test('foreign non-branded declaration rejected', async () => {
  const { runtime } = makeApp();
  const forged = { kind: 'principalSnapshot', name: 'test-decl', principalType: 'user', output: null, fields: {} };
  db: null;
  assert.throws(() => runtime._registerDeclaration(forged), /Only principal snapshot declarations/);
});

// ── Same-name declaration from another source → rollback ────────────────────

test('same-name declaration from another source rejected by invalidate', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  const imposter = makeDeclaration('test-decl', 'user');
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
      tx.invalidate(imposter, { type: 'user', id: 'u1' });
    }),
    /from another source/,
  );

  const row = db.prepare('SELECT name FROM profile WHERE id = ?').get('u1');
  assert.equal(row.name, 'Alice');
});

// ── Duplicate invalidations coalesce to one revision increment ──────────────

test('duplicate invalidations coalesce to one revision increment', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  const row = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1');
  assert.equal(row.revision, 1);
});

// ── Separate recipients each get their own revision ─────────────────────────

test('separate recipients each get their own revision', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?), (?, ?)').run('u1', 'Alice', 'u2', 'Bob');

  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    tx.invalidate(decl, { type: 'user', id: 'u2' });
  });

  const r1 = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1');
  const r2 = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u2');
  assert.equal(r1.revision, 1);
  assert.equal(r2.revision, 1);
});

// ── Thenable callback rejection → rollback ──────────────────────────────────

test('thenable callback rejection rolls back', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
      tx.invalidate(decl, { type: 'user', id: 'u1' });
      return { then() { throw new Error('promise-like'); } };
    }),
    /Promise/,
  );

  const row = db.prepare('SELECT name FROM profile WHERE id = ?').get('u1');
  assert.equal(row.name, 'Alice');
});

test('callable thenable callback rejection rolls back', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
      tx.invalidate(decl, { type: 'user', id: 'u1' });
      const callable = () => {};
      callable.then = () => {};
      return callable;
    }),
    /Promise/,
  );

  assert.equal(db.prepare('SELECT name FROM profile WHERE id = ?').get('u1').name, 'Alice');
  assert.equal(db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1'), undefined);
});

// ── Nested transaction rejected ─────────────────────────────────────────────

test('nested transaction rejected', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  let nested;
  await app.principalSnapshots.transaction((tx) => {
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    nested = app.principalSnapshots.transaction((tx2) => {
      tx2.invalidate(decl, { type: 'user', id: 'u1' });
    });
  });
  await assert.rejects(nested, /nested/);
});

// ── invalidate after callback error still works (within callback) ───────────

test('invalidate still works before callback error', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      tx.invalidate(decl, { type: 'user', id: 'u1' });
      throw new Error('oops');
    }),
    /oops/,
  );

  const rev = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1');
  assert.equal(rev, undefined);
});

// ── Revision starts at 1 for absent recipients ──────────────────────────────

test('revision absent -> 1 on first invalidation', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  const rev = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1');
  assert.equal(rev.revision, 1);
});

// ── No _Log, _ActionReceipt, _CommittedRevision side effects ────────────────

test('transaction does not affect framework tables', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  const logCount = db.prepare('SELECT COUNT(*) as c FROM _Log').get();
  assert.equal(logCount.c, 0);

  const receiptCount = db.prepare('SELECT COUNT(*) as c FROM _ActionReceipt').get();
  assert.equal(receiptCount.c, 0);
});

// ── No DB rejects valid call ─────────────────────────────────────────────────

test('valid transaction does not reject from db', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  const result = await app.principalSnapshots.transaction((tx) => {
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    return 42;
  });

  assert.equal(result, 42);
});

// ── Write queue serialization: two concurrent calls ─────────────────────────

test('write queue serializes two concurrent transaction calls', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  const order = [];
  const p1 = app.principalSnapshots.transaction((tx) => {
    order.push('tx1-start');
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    order.push('tx1-end');
  });
  const p2 = app.principalSnapshots.transaction((tx) => {
    order.push('tx2-start');
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alice', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    order.push('tx2-end');
  });

  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['tx1-start', 'tx1-end', 'tx2-start', 'tx2-end']);

  const rev = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1');
  assert.equal(rev.revision, 2);
});

// ── Wake hook called only after successful commit ───────────────────────────

test('wake hook called only after successful commit', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  const woken = [];
  runtime._setWakeHook((declaration, recipient) => {
    woken.push({ name: declaration.name, recipient });
  });

  await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  assert.equal(woken.length, 1);
  assert.equal(woken[0].name, 'test-decl');
  assert.deepEqual(woken[0].recipient, { type: 'user', id: 'u1' });
});

// ── Wake not called on failure ──────────────────────────────────────────────

test('wake hook not called on failure', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  const woken = [];
  runtime._setWakeHook(() => woken.push('called'));

  await assert.rejects(
    app.principalSnapshots.transaction((tx) => {
      tx.invalidate(decl, { type: 'user', id: 'u1' });
      throw new Error('fail');
    }),
  );

  assert.equal(woken.length, 0);
});

// ── Wake failure does not propagate to caller ───────────────────────────────

test('wake failure does not propagate to caller', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  runtime._setWakeHook(() => { throw new Error('wake-error'); });

  const result = await app.principalSnapshots.transaction((tx) => {
    db.prepare('UPDATE profile SET name = ? WHERE id = ?').run('Alicia', 'u1');
    tx.invalidate(decl, { type: 'user', id: 'u1' });
    return 42;
  });

  assert.equal(result, 42);
  const rev = db.prepare('SELECT revision FROM _PrincipalSnapshotRevision WHERE declaration = ? AND principalType = ? AND principalId = ?').get('test-decl', 'user', 'u1');
  assert.equal(rev.revision, 1);
});

// ── tx has only db and invalidate (no enumerable _callbackDone) ─────────────

test('tx exposes only db and invalidate', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  let txFromCallback;
  await app.principalSnapshots.transaction((tx) => {
    txFromCallback = tx;
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  assert.equal(typeof txFromCallback.db, 'object');
  assert.equal(typeof txFromCallback.invalidate, 'function');
  assert.equal(txFromCallback._callbackDone, undefined);
  const keys = Object.keys(txFromCallback);
  assert.deepEqual(keys.sort(), ['db', 'invalidate'].sort());
});

// ── invalidate after callback return throws ─────────────────────────────────

test('invalidate after callback return throws', async () => {
  const { app, db, runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  db.exec('CREATE TABLE IF NOT EXISTS profile (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO profile (id, name) VALUES (?, ?)').run('u1', 'Alice');

  let txFromCallback;
  await app.principalSnapshots.transaction((tx) => {
    txFromCallback = tx;
    tx.invalidate(decl, { type: 'user', id: 'u1' });
  });

  assert.throws(
    () => txFromCallback.invalidate(decl, { type: 'user', id: 'u1' }),
    /after transaction callback/,
  );
});

// ── Duplicate registration rejected ─────────────────────────────────────────

test('duplicate registration rejected', async () => {
  const { runtime } = makeApp();
  const decl = makeDeclaration();
  runtime._registerDeclaration(decl);
  assert.throws(() => runtime._registerDeclaration(decl), /already registered/);
});

// ── Transaction callback requires function ──────────────────────────────────

test('transaction callback requires function', async () => {
  const { app } = makeApp();
  await assert.rejects(
    app.principalSnapshots.transaction('not a function'),
    /requires a synchronous callback/,
  );
});

// ── Transaction requires db ─────────────────────────────────────────────────

test('transaction requires db', async () => {
  const app = { writeQueue: createWriteQueue(), _principalSnapshotTxActive: false };
  app._principalSnapshotRuntime = createPrincipalSnapshotTransaction(app);
  app.principalSnapshots = { transaction: app._principalSnapshotRuntime.transaction };
  await assert.rejects(
    app.principalSnapshots.transaction(() => {}),
    /requires a database/,
  );
});
