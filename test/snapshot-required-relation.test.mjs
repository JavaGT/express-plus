import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { once } from 'node:events';

import { createLiveDelivery, createLiveDeliveryHttpHandler } from '../build/server.mjs';
import { entity, ref, snapshot, text } from '../build/index.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { grant, subscribe } from '../build/grant.mjs';
import { scope } from '../build/scope.mjs';
import { everyone } from '../build/scope-sql.mjs';

function setup({ mayVerb = () => true, relatedScope = () => ({ sql: 't0.visible = 1', params: {} }), relatedHydrate = (row) => ({ ...row }) } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY);
    CREATE TABLE ProjectErasureIdentity (id TEXT PRIMARY KEY);
    CREATE TABLE Codebook (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), visible INTEGER);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), codebookId TEXT REFERENCES Codebook(id), label TEXT);
    CREATE TABLE Tombstone (id TEXT PRIMARY KEY, projectId TEXT REFERENCES ProjectErasureIdentity(id) ON DELETE RESTRICT, entityId TEXT, kind TEXT, state TEXT);
  `);
  for (const id of ['p1', 'p2']) {
    db.prepare('INSERT INTO Project VALUES (?)').run(id);
    db.prepare('INSERT INTO ProjectErasureIdentity VALUES (?)').run(id);
  }
  for (const row of [['ok', 'p1', 1], ['cross', 'p2', 1], ['scoped', 'p1', 0], ['deleted', 'p1', 1]]) {
    db.prepare('INSERT INTO Codebook VALUES (?, ?, ?)').run(...row);
  }
  for (const row of [['ok', 'p1', 'ok', 'ok'], ['cross', 'p1', 'cross', 'cross'], ['scoped', 'p1', 'scoped', 'scoped'], ['deleted', 'p1', 'deleted', 'deleted'], ['missing', 'p1', null, 'missing']]) {
    db.prepare('INSERT INTO Code VALUES (?, ?, ?, ?)').run(...row);
  }
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('t1', 'p1', 'deleted', 'codebook', 'deleted');
  db.prepare('INSERT INTO Tombstone VALUES (?, ?, ?, ?, ?)').run('t2', 'p2', 'ok', 'codebook', 'deleted');
  const permitted = () => [scope(() => everyone()).can(() => grant(subscribe))];
  const project = entity('Project', { grant: permitted });
  const terminalScope = entity('ProjectErasureIdentity', { grant: permitted });
  const codebook = entity('Codebook', { projectId: ref(project), visible: text(), grant: permitted });
  const code = entity('Code', { projectId: ref(project), codebookId: ref(codebook), label: text(), grant: permitted });
  const tombstone = entity('Tombstone', { projectId: ref(terminalScope), entityId: text(), kind: text(), state: text(), grant: permitted });
  const bound = (declaration, scopeFilter, hydrate) => ({ ...declaration, declaration, scopeFilter, hydrate });
  const projectBound = bound(project, () => ({ sql: '1=1', params: {} }), (row) => ({ ...row }));
  const terminalScopeBound = bound(terminalScope, () => ({ sql: '0=1', params: {} }), (row) => ({ ...row }));
  const codebookBound = bound(codebook, relatedScope, relatedHydrate);
  const codeBound = bound(code, () => ({ sql: '1=1', params: {} }), (row) => ({ ...row }));
  const tombstoneBound = bound(tombstone, () => ({ sql: '1=1', params: {} }), (row) => ({ ...row }));
  const required = snapshot.related(code.field.codebookId, { via: codebook.field.projectId });
  const visibility = snapshot.tombstones(codebook, { entity: tombstone, entityId: tombstone.field.entityId, scopeId: tombstone.field.projectId, targetScopeId: codebook.field.projectId, targetScope: project, terminalScope, kind: tombstone.field.kind, state: tombstone.field.state, kindValue: 'codebook', hidden: ['deleted'] });
  const output = snapshot.object({
    codes: snapshot.many(code, { via: code.field.projectId, require: required, select: snapshot.select(code.field.label) }),
    keyed: snapshot.keyed(code, { via: code.field.projectId, require: required, select: snapshot.select(code.field.label) }),
    count: snapshot.count(code, { via: code.field.projectId, require: required }),
  });
  const entities = (name, declaration) => {
    if (declaration === project || name === 'Project') return projectBound;
    if (declaration === terminalScope || name === 'ProjectErasureIdentity') return terminalScopeBound;
    if (declaration === codebook || name === 'Codebook') return codebookBound;
    if (declaration === code || name === 'Code') return codeBound;
    if (declaration === tombstone || name === 'Tombstone') return tombstoneBound;
    return null;
  };
  const live = createLiveDelivery({ db, entities, mayVerb, snapshots: [snapshot(codebook, { tombstones: visibility, output: snapshot.object({}) }), snapshot(project, { output })] });
  return { db, live, project, codebook, code, required, entities, permitted };
}

test('terminal Project-owner tombstones filter child and required Codebook rows by owner scope', async () => {
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

test('a required relation constrains every exposure path and forbids standalone anchors', () => {
  const { db, project, code, required, entities } = setup();
  const secured = snapshot.many(code, { via: code.field.projectId, require: required, select: snapshot.select(code.field.label) });
  const unsecured = snapshot.many(code, { via: code.field.projectId, select: snapshot.select(code.field.label) });
  assert.throws(() => createLiveDelivery({
    db, entities, mayVerb: () => true,
    snapshots: [
      snapshot(project, { output: snapshot.object({ secured, unsecured }) }),
    ],
  }), /must use its declared required relation on every exposure path/);
  assert.throws(() => createLiveDelivery({
    db, entities, mayVerb: () => true,
    snapshots: [
      snapshot(project, { output: snapshot.object({ secured }) }),
      snapshot(code, { output: snapshot.object({ label: snapshot.select(code.field.label) }) }),
    ],
  }), /cannot be a standalone anchor/);
  db.close();
});

test('a required relation denies undeclared direct bootstrap, catch-up, and subscription', async () => {
  const { db, live } = setup();
  assert.deepEqual(await live.bootstrap({ principal: {}, scope: 'Code:ok' }), { kind: 'revoked' });
  assert.deepEqual(await live.catchup({ principal: {}, scope: 'Code:ok', after: 0 }), { kind: 'revoked' });
  let revoked = false;
  const controller = new AbortController();
  const subscription = await live.subscribe({ principal: {}, scope: 'Code:ok', after: 0, signal: controller.signal, revoke: () => { revoked = true; } });
  assert.equal(revoked, true);
  assert.equal(await subscription.activate(), undefined);
  controller.abort();
  db.close();
});

test('a required relation denies annotated-text document bootstrap, catch-up, and live routes', async () => {
  const { db, live, code } = setup();
  const document = { entity: code, scope: 'Project:p1', documentId: 'ok' };
  assert.deepEqual(await live.bootstrap({ principal: {}, scope: 'Project:p1', document }), { kind: 'revoked' });
  assert.deepEqual(await live.catchup({ principal: {}, scope: 'Project:p1', after: 0, document }), { kind: 'revoked' });
  let revoked = false;
  const controller = new AbortController();
  const subscription = await live.subscribe({ principal: {}, scope: 'Project:p1', after: 0, document, signal: controller.signal, revoke: () => { revoked = true; } });
  assert.equal(revoked, true);
  assert.equal(await subscription.activate(), undefined);
  controller.abort();

  const delivery = { ...live, resolveAnnotatedTextDocument: () => document };
  const handler = createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({}) });
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(0);
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/live-delivery`;
  const query = 'entity=Code&field=body&documentId=ok';
  try {
    assert.deepEqual(await fetch(`${endpoint}/bootstrap?mode=snapshot&${query}`).then((response) => response.json()), { kind: 'revoked' });
    assert.deepEqual(await fetch(`${endpoint}/bootstrap?mode=catchup&after=0&${query}`).then((response) => response.json()), { kind: 'revoked' });
    assert.equal((await fetch(`${endpoint}/events?after=0&${query}`)).status, 403);
  } finally {
    server.close();
  }
  db.close();
});
