import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { createWriteQueue } from '../build/write-queue.mjs';
import { createDerivedResourceRegistry } from '../build/derived-resource.mjs';

function resource(id, rebuild, prepare = () => {}) {
  return { id, ownedObjects: ['Derived'], prepare, rebuild };
}

async function close(queue, db) { await queue.close(); db.close(); }

test('derived resources run rebuilds in the write coordinator and persist their lifecycle', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createWriteQueue();
  db.exec('CREATE TABLE Derived (id TEXT PRIMARY KEY)');
  const transitions = [];
  const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue, batchSize: 1 });
  registry.register({ ...resource('search', ({ write }) => { assert.equal(queue.owned, true); write({ sql: 'INSERT INTO Derived (id) VALUES (?)', params: ['rebuilt'] }); }), onTransition: (entry) => transitions.push(entry.state) });
  try {
    await registry.prepareAll();
    await registry.markStale('search');
    await registry.reconcileBatches();
    assert.equal(registry.stateOf('search').state, 'current');
    assert.ok(db.prepare('SELECT 1 FROM Derived WHERE id = ?').get('rebuilt'));
    assert.deepEqual(transitions, ['absent', 'preparing', 'current', 'stale', 'rebuilding', 'current']);
  } finally { await close(queue, db); }
});

test('derived callbacks may read sources and write only their own objects', async () => {
  const db = new DatabaseSync(':memory:');
  const queue = createWriteQueue();
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY); CREATE TABLE Derived (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO Source (id) VALUES (?)').run('authoritative');
  const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue });
  registry.register(resource('isolated', ({ query, write }) => {
    assert.equal(query({ sql: 'SELECT id FROM Source' })[0].id, 'authoritative');
    assert.throws(() => write({ sql: 'DELETE FROM Source' }), /not authorized/);
    write({ sql: 'INSERT INTO Derived (id) VALUES (?)', params: ['allowed'] });
  }));
  try {
    await registry.prepareAll();
    await registry.markStale('isolated');
    await registry.reconcileBatches();
    assert.ok(db.prepare('SELECT 1 FROM Source WHERE id = ?').get('authoritative'));
    assert.ok(db.prepare('SELECT 1 FROM Derived WHERE id = ?').get('allowed'));
  } finally { await close(queue, db); }
});

test('derived recovery survives a process crash, close/reopen, and resumes durable work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-derived-'));
  const path = join(dir, 'data.sqlite');
  let db;
  let queue;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { DatabaseSync } from 'node:sqlite';
    import { createWriteQueue } from ${JSON.stringify(new URL('../build/write-queue.mjs', import.meta.url).href)};
    import { createDerivedResourceRegistry } from ${JSON.stringify(new URL('../build/derived-resource.mjs', import.meta.url).href)};
    const db = new DatabaseSync(${JSON.stringify(path)}); const queue = createWriteQueue();
    db.exec('CREATE TABLE Derived (id TEXT PRIMARY KEY)');
    const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue });
    registry.register({ id: 'resume', ownedObjects: ['Derived'], prepare: () => {}, rebuild: () => process.exit(17) });
    await registry.prepareAll(); await registry.markStale('resume'); await registry.reconcileBatches();
  `]);
  try {
    assert.equal(child.status, 17, child.stderr.toString());
    db = new DatabaseSync(path); queue = createWriteQueue();
    let registry = createDerivedResourceRegistry({ db, writeCoordinator: queue });
    registry.register(resource('resume', ({ write }) => write({ sql: 'INSERT OR REPLACE INTO Derived (id) VALUES (?)', params: ['recovered'] })));
    assert.equal(registry.stateOf('resume').state, 'rebuilding', 'the new boot sees the durable crash checkpoint');
    await registry.reconcileBatches();
    assert.equal(registry.stateOf('resume').state, 'current');
    assert.ok(db.prepare('SELECT 1 FROM Derived WHERE id = ?').get('recovered'));
    await close(queue, db); db = undefined; queue = undefined;
  } finally { if (queue && db) await close(queue, db); rmSync(dir, { recursive: true, force: true }); }
});

test('a crash mid-prepare is recovered at boot: engage demotes orphaned preparing rows and rebuild proceeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-derived-'));
  const path = join(dir, 'data.sqlite');
  let db;
  let queue;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { DatabaseSync } from 'node:sqlite';
    import { createWriteQueue } from ${JSON.stringify(new URL('../build/write-queue.mjs', import.meta.url).href)};
    import { createDerivedResourceRegistry } from ${JSON.stringify(new URL('../build/derived-resource.mjs', import.meta.url).href)};
    const db = new DatabaseSync(${JSON.stringify(path)}); const queue = createWriteQueue();
    db.exec('CREATE TABLE Derived (id TEXT PRIMARY KEY)');
    const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue });
    registry.register({ id: 'wedge', ownedObjects: ['Derived'], prepare: () => process.exit(17), rebuild: () => {} });
    await registry.prepareAll();
  `]);
  try {
    assert.equal(child.status, 17, child.stderr.toString());
    db = new DatabaseSync(path); queue = createWriteQueue();
    const seen = [];
    let registry = createDerivedResourceRegistry({ db, writeCoordinator: queue });
    registry.register({ ...resource('wedge', ({ write }) => write({ sql: 'INSERT OR REPLACE INTO Derived (id) VALUES (?)', params: ['rebuilt'] })), onTransition: (entry) => {
      if (entry.state === 'failed') assert.equal(entry.lastError, 'interrupted by process exit', 'the boot sweep records the interruption');
      seen.push(entry.state);
    } });
    assert.equal(registry.stateOf('wedge').state, 'preparing', 'the crash checkpoint survives as preparing');
    await registry.reconcileBatches();
    assert.deepEqual(seen, ['failed', 'rebuilding', 'current'], 'recovery rides the legal preparing→failed edge, then the normal rebuild');
    const state = registry.stateOf('wedge');
    assert.equal(state.state, 'current');
    assert.equal(state.attempts, 1, 'the interrupted attempt is counted');
    assert.ok(db.prepare('SELECT 1 FROM Derived WHERE id = ?').get('rebuilt'));
    await close(queue, db); db = undefined; queue = undefined;
  } finally { if (queue && db) await close(queue, db); rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt durable states are refused and concurrent reconciliation claims one rebuild', async () => {
  const db = new DatabaseSync(':memory:'); const queue = createWriteQueue();
  db.exec('CREATE TABLE Derived (id TEXT PRIMARY KEY)');
  let rebuilds = 0;
  const registry = createDerivedResourceRegistry({ db, writeCoordinator: queue });
  registry.register(resource('once', async () => { rebuilds++; }));
  try {
    await registry.prepareAll(); await registry.markStale('once');
    await Promise.all([registry.reconcileBatches(), registry.reconcileBatches()]);
    assert.equal(rebuilds, 1);
    db.prepare("UPDATE _DerivedResource SET state = 'bogus' WHERE id = ?").run('once');
    assert.throws(() => registry.stateOf('once'), /corrupt durable state/);
  } finally { await close(queue, db); }
});
