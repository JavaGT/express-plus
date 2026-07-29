import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createLiveDelivery } from '../src/server.mjs';
import { entity, ref, snapshot, text } from '../src/index.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { grant, subscribe } from '../src/grant.mjs';
import { scope } from '../src/scope.mjs';
import { everyone } from '../src/scope-sql.mjs';

function setup({ mayVerb = () => true, relatedScope = () => ({ sql: 't0.visible = 1', params: {} }), relatedHydrate = (row) => ({ ...row }) } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY);
    CREATE TABLE Codebook (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), visible INTEGER);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), codebookId TEXT REFERENCES Codebook(id), label TEXT);
    CREATE TABLE Tombstone (id TEXT PRIMARY KEY, entityId TEXT REFERENCES Codebook(id), kind TEXT, state TEXT);
  `);
  for (const id of ['p1', 'p2']) db.prepare('INSERT INTO Project VALUES (?)').run(id);
  for (const row of [['ok', 'p1', 1], ['cross', 'p2', 1], ['scoped', 'p1', 0], ['deleted', 'p1', 1]]) {
    db.prepare('INSERT INTO Codebook VALUES (?, ?, ?)').run(...row);
  }
  for (const row of [['ok', 'p1', 'ok', 'ok'], ['cross', 'p1', 'cross', 'cross'], ['scoped', 'p1', 'scoped', 'scoped'], ['deleted', 'p1', 'deleted', 'deleted'], ['missing', 'p1', null, 'missing']]) {
    db.prepare('INSERT INTO Code VALUES (?, ?, ?, ?)').run(...row);
  }
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?)').run('t1', 'deleted', 'codebook', 'deleted');
  const permitted = () => [scope(() => everyone()).can(() => grant(subscribe))];
  const project = entity('Project', { grant: permitted });
  const codebook = entity('Codebook', { projectId: ref(project), visible: text(), grant: permitted });
  const code = entity('Code', { projectId: ref(project), codebookId: ref(codebook), label: text(), grant: permitted });
  const tombstone = entity('Tombstone', { entityId: ref(codebook), kind: text(), state: text(), grant: permitted });
  const bound = (declaration, scopeFilter, hydrate) => ({ ...declaration, declaration, scopeFilter, hydrate });
  const projectBound = bound(project, () => ({ sql: '1=1', params: {} }), (row) => ({ ...row }));
  const codebookBound = bound(codebook, relatedScope, relatedHydrate);
  const codeBound = bound(code, () => ({ sql: '1=1', params: {} }), (row) => ({ ...row }));
  const tombstoneBound = bound(tombstone, () => ({ sql: '1=1', params: {} }), (row) => ({ ...row }));
  const required = snapshot.related(code.field.codebookId, { via: codebook.field.projectId });
  const visibility = snapshot.tombstones(codebook, { entity: tombstone, entityId: tombstone.field.entityId, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'codebook', hidden: ['deleted'] });
  const output = snapshot.object({
    codes: snapshot.many(code, { via: code.field.projectId, require: required, select: snapshot.select(code.field.label) }),
    keyed: snapshot.keyed(code, { via: code.field.projectId, require: required, select: snapshot.select(code.field.label) }),
    count: snapshot.count(code, { via: code.field.projectId, require: required }),
  });
  const entities = (name, declaration) => {
    if (declaration === project || name === 'Project') return projectBound;
    if (declaration === codebook || name === 'Codebook') return codebookBound;
    if (declaration === code || name === 'Code') return codeBound;
    if (declaration === tombstone || name === 'Tombstone') return tombstoneBound;
    return null;
  };
  const live = createLiveDelivery({ db, entities, mayVerb, snapshots: [snapshot(codebook, { tombstones: visibility, output: snapshot.object({}) }), snapshot(project, { output })] });
  return { db, live, project, codebook, code, required, entities, permitted };
}

test('required related rows are co-owned recipient filters for many, keyed, and count', async () => {
  const { db, live } = setup();
  const result = await live.bootstrap({ principal: {}, scope: 'Project:p1' });
  assert.equal(result.kind, 'snapshot');
  assert.deepEqual(result.snapshot, {
    id: 'p1', codes: [{ id: 'ok', label: 'ok' }], keyed: { ok: { id: 'ok', label: 'ok' } }, count: 1,
  });
  assert.equal(JSON.stringify(result.snapshot).includes('codebookId'), false, 'related row and reference stay unprojected');
  db.close();
});

test('required related rows fail closed for scope denial, subscribe denial, authorization errors, and malformed hydration', async () => {
  for (const [name, options] of [
    ['scope', { relatedScope: () => ({ sql: '0=1', params: {} }) }],
    ['denial', { mayVerb: (entity, _verb, row) => entity.name !== 'Codebook' || row.id !== 'ok' }],
    ['exception', { mayVerb: (entity, _verb, row) => { if (entity.name === 'Codebook' && row.id === 'ok') throw new Error('policy outage'); return true; } }],
    ['hydrate', { relatedHydrate: () => null }],
  ]) {
    const { db, live } = setup(options);
    const result = await live.bootstrap({ principal: {}, scope: 'Project:p1' });
    assert.deepEqual(result.snapshot, { id: 'p1', codes: [], keyed: {}, count: 0 }, name);
    db.close();
  }
  const { db, live } = setup();
  assert.ok(live);
  db.close();
});

test('required relation authorization is shared by many, keyed, and count', async () => {
  let codebookChecks = 0;
  const { db, live } = setup({
    mayVerb: (entity, _verb, row) => {
      if (entity.name !== 'Codebook' || row.id !== 'ok') return true;
      codebookChecks += 1;
      return codebookChecks === 1;
    },
  });
  const result = await live.bootstrap({ principal: {}, scope: 'Project:p1' });
  assert.deepEqual(result.snapshot, { id: 'p1', codes: [{ id: 'ok', label: 'ok' }], keyed: { ok: { id: 'ok', label: 'ok' } }, count: 1 });
  assert.equal(codebookChecks, 1);
  db.close();
});

test('required relation declaration rejects open grammar, one, wrong handles, unregistered targets, and bad physical keys', () => {
  const { db, project, codebook, code, required, entities, permitted } = setup();
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Codebook', codebook], ['Code', code]]), mayVerb: () => true, snapshots: [snapshot(project, { output: snapshot.object({ code: snapshot.one(code, { via: code.field.projectId, require: required, select: snapshot.select(code.field.label) }) }) })] }), /cannot use require on one/);
  assert.throws(() => snapshot.related(project.field.id, { via: codebook.field.projectId }), /declared field handles/);
  const raw = Object.freeze({ kind: 'related', childRef: 'codebookId', via: 'projectId', callback: () => true });
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', project], ['Codebook', codebook], ['Code', code]]), mayVerb: () => true, snapshots: [snapshot(project, { output: snapshot.object({ codes: snapshot.many(code, { via: code.field.projectId, require: raw, select: snapshot.select(code.field.label) }) }) })] }), /must use related/);
  const forged = { fieldName: 'codebookId', entityName: 'Code' };
  for (const marker of Object.getOwnPropertySymbols(code.field.codebookId)) forged[marker] = true;
  assert.throws(() => snapshot.related(forged, { via: codebook.field.projectId }), /declared field handles/);
  db.exec('CREATE TABLE Broken (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), codebookId TEXT);');
  const broken = entity('Broken', { projectId: ref(project), codebookId: ref(codebook), label: text(), grant: permitted });
  const brokenBound = { ...broken, declaration: broken, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const withBroken = (name, declaration) => declaration === broken || name === 'Broken' ? brokenBound : entities(name, declaration);
  assert.throws(() => createLiveDelivery({ db, entities: withBroken, mayVerb: () => true, snapshots: [snapshot(project, { output: snapshot.object({ codes: snapshot.many(broken, { via: broken.field.projectId, require: snapshot.related(broken.field.codebookId, { via: codebook.field.projectId }), select: snapshot.select(broken.field.label) }) }) })] }), /physical FOREIGN KEY/);
  db.close();
});
