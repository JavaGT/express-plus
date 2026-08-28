import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProjectPurgePlan, executeProjectPurgePlans, ownedResourcesCapability } from '../build/owned-resource-purge.mjs';

const plugin = (ownedObjects) => ({ id: 'fixture', ownedObjects });
const object = (name, disposition) => ({ kind: 'table', name, ddl: ['CREATE TABLE ' + name], disposition });

test('purge plan rejects missing, foreign, cyclic, and parent-first declarations', () => {
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
});

test('host executes precompiled plan and returns non-sensitive counts', () => {
  const plan = compileProjectPurgePlan(plugin([
    object('root', { kind: 'project-purge-root', projectKey: 'project_id' }),
    object('child', { kind: 'project-purge-dependent', parent: 'root', foreignKey: 'root_id' }),
    object('audit', { kind: 'retained', reason: 'legal retention' }),
  ]));
  const statements = [];
  const db = { prepare(sql) { return { run(id) { statements.push([sql, id]); return { changes: 3 }; } }; } };
  assert.deepEqual(executeProjectPurgePlans(db, [plan], 'p1'), { fixture: { child: 3, root: 3 } });
  assert.equal(statements.length, 2);
  const capability = ownedResourcesCapability(db, [plan]);
  assert.deepEqual(capability.purgeProject('p2'), { fixture: { child: 3, root: 3 } });
  capability.close();
  assert.throws(() => capability.purgeProject('p3'), /closed/);
});
