import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { compileProjectPurgePlan, executeProjectPurgePlans, ownedResourcesCapability } from '../build/owned-resource-purge.mjs';

const plugin = (ownedObjects) => ({ id: 'fixture', ownedObjects });
const object = (name, disposition) => ({ kind: 'table', name, ddl: ['CREATE TABLE ' + name], disposition });

test('purge plan rejects missing, foreign, and cyclic declarations; compiles order-agnostically children-first', () => {
  assert.throws(() => compileProjectPurgePlan(plugin([object('root', undefined)])), /missing.*disposition/);
  assert.throws(() => compileProjectPurgePlan(plugin([object('child', { kind: 'project-purge-dependent', parent: 'other', foreignKey: 'root_id' })])), /foreign purge parent/);
  const cycle = [
    object('a', { kind: 'project-purge-dependent', parent: 'b', foreignKey: 'b_id' }),
    object('b', { kind: 'project-purge-dependent', parent: 'a', foreignKey: 'a_id' }),
  ];
  assert.throws(() => compileProjectPurgePlan(plugin(cycle)), /cycle/);
  const plan = compileProjectPurgePlan(plugin([
    object('root', { kind: 'project-purge-root', projectKey: 'project_id' }),
    object('child', { kind: 'project-purge-dependent', parent: 'root', foreignKey: 'root_id' }),
  ]));
  assert.deepEqual(plan.objects.map(({ name }) => name), ['child', 'root']);
  const reversed = compileProjectPurgePlan(plugin([
    object('child', { kind: 'project-purge-dependent', parent: 'root', foreignKey: 'root_id' }),
    object('root', { kind: 'project-purge-root', projectKey: 'project_id' }),
  ]));
  assert.deepEqual(reversed.objects.map(({ name }) => name), ['child', 'root']);
  assert.throws(() => compileProjectPurgePlan(plugin([{ kind: 'index', name: 'bad', ddl: ['x'], disposition: { kind: 'project-purge-root', projectKey: 'project_id' } }])), /not a table/);
});

test('host executes project-scoped SQL with matching parameters and preserves retained rows', () => {
  const plan = compileProjectPurgePlan(plugin([
    object('root', { kind: 'project-purge-root', projectKey: 'project_id' }),
    object('child', { kind: 'project-purge-dependent', parent: 'root', foreignKey: 'root_id' }),
    object('audit', { kind: 'retained', reason: 'legal retention' }),
  ]));
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE root (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE child (id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
    CREATE TABLE audit (id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
    INSERT INTO root VALUES ('r1', 'p1'), ('r2', 'p2');
    INSERT INTO child VALUES ('c1', 'r1'), ('c2', 'r2');
    INSERT INTO audit VALUES ('a1', 'r1'), ('a2', 'r2');
  `);
  assert.deepEqual(executeProjectPurgePlans(db, [plan], 'p1'), { fixture: { child: 1, root: 1 } });
  assert.deepEqual(db.prepare('SELECT id FROM root ORDER BY id').all().map((row) => ({ ...row })), [{ id: 'r2' }]);
  assert.deepEqual(db.prepare('SELECT id FROM child ORDER BY id').all().map((row) => ({ ...row })), [{ id: 'c2' }]);
  assert.deepEqual(db.prepare('SELECT id FROM audit ORDER BY id').all().map((row) => ({ ...row })), [{ id: 'a1' }, { id: 'a2' }]);

  const capability = ownedResourcesCapability(db, [plan]);
  assert.deepEqual(capability.purgeProject('p2'), { fixture: { child: 1, root: 1 } });
  capability.close();
  assert.throws(() => capability.purgeProject('p3'), /closed/);
});

test('nested dependents remain project-scoped and are deleted before their parents', () => {
  const plan = compileProjectPurgePlan(plugin([
    object('root', { kind: 'project-purge-root', projectKey: 'project_id' }),
    object('grandchild', { kind: 'project-purge-dependent', parent: 'child', foreignKey: 'child_id' }),
    object('child', { kind: 'project-purge-dependent', parent: 'root', foreignKey: 'root_id' }),
  ]));
  assert.deepEqual(plan.objects.map(({ name }) => name), ['grandchild', 'child', 'root']);
  assert.ok(plan.objects.every(({ sql }) => (sql.match(/\?/g) ?? []).length === 1));

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE root (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE child (id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
    CREATE TABLE grandchild (id TEXT PRIMARY KEY, child_id TEXT NOT NULL);
    INSERT INTO root VALUES ('r1', 'p1'), ('r2', 'p2');
    INSERT INTO child VALUES ('c1', 'r1'), ('c2', 'r2');
    INSERT INTO grandchild VALUES ('g1', 'c1'), ('g2', 'c2');
  `);
  assert.deepEqual(executeProjectPurgePlans(db, [plan], 'p1'), { fixture: { grandchild: 1, child: 1, root: 1 } });
  assert.deepEqual(db.prepare('SELECT id FROM grandchild').all().map((row) => ({ ...row })), [{ id: 'g2' }]);
  assert.deepEqual(db.prepare('SELECT id FROM child').all().map((row) => ({ ...row })), [{ id: 'c2' }]);
  assert.deepEqual(db.prepare('SELECT id, project_id FROM root').all().map((row) => ({ ...row })), [{ id: 'r2', project_id: 'p2' }]);
});
