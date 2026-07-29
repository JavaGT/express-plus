import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createLiveDelivery } from '../src/server.mjs';
import { snapshot } from '../src/index.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { grant, subscribe } from '../src/grant.mjs';
import { scope } from '../src/scope.mjs';

function setup(mayVerb) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), body TEXT);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'one');
  db.prepare('INSERT INTO Comment VALUES (?, ?, ?)').run('c1', 'p1', 'visible');
  const permitted = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { name: { kind: 'value', type: 'text' } }, field: { name: { fieldName: 'name' } }, grant: permitted, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const comment = { name: 'Comment', fields: { projectId: { kind: 'value', type: 'ref', target: project }, body: { kind: 'value', type: 'text' } }, field: { projectId: { fieldName: 'projectId' }, body: { fieldName: 'body' } }, grant: permitted, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const declaration = snapshot(project, { output: snapshot.object({ name: snapshot.select(project.field.name), comments: snapshot.many(comment, { via: comment.field.projectId, select: snapshot.select(comment.field.body) }) }) });
  return { db, live: createLiveDelivery({ db, entities: new Map([['Project', project], ['Comment', comment]]), mayVerb, snapshots: [declaration] }) };
}

test('relational snapshot retries boundedly and never advances an unstable cursor', async () => {
  let calls = 0;
  const { db, live } = setup(async () => {
    calls += 1;
    db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
    return true;
  });
  assert.deepEqual(await live.bootstrap({ principal: {}, scope: 'Project:p1' }), { kind: 'retry' });
  assert.equal(calls, 6, 'anchor and member are checked on each of three attempts');
  assert.equal(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get().revision, 6);
  db.close();
});

test('relational snapshot fails closed on anchor revocation, member denial, and authorization exceptions', async () => {
  for (const authorization of [
    async (_entity, _verb, row) => row.id !== 'p1',
    async (_entity, _verb, row) => row.id !== 'c1',
    async () => { throw new Error('policy outage'); },
  ]) {
    const { db, live } = setup(authorization);
    const result = await live.bootstrap({ principal: {}, scope: 'Project:p1' });
    if (result.kind === 'snapshot') assert.deepEqual(result.snapshot.comments, []);
    else assert.deepEqual(result, { kind: 'revoked' });
    db.close();
  }
});

test('aggregate catch-up bootstraps when admission observes a newer aggregate revision', async () => {
  let admitted = false;
  const { db, live } = setup(async () => {
    if (!admitted) {
      admitted = true;
      db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
    }
    return true;
  });
  const result = await live.catchup({ principal: {}, scope: 'Project:p1', after: { anchor: 0, aggregate: 0 } });
  assert.deepEqual(result, {
    kind: 'snapshot', snapshot: { id: 'p1', name: 'one', comments: [{ id: 'c1', body: 'visible' }] }, cursor: { anchor: 0, aggregate: 1 },
  });
  db.close();
});

test('relational snapshot authorizes when entity hydrate mutates the row in place', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), body TEXT);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'one');
  db.prepare('INSERT INTO Comment VALUES (?, ?, ?)').run('c1', 'p1', 'visible');
  const permitted = () => [scope(() => true).can(() => grant(subscribe))];
  // Mirror the real entity hydrator: deserialize by mutating the supplied row.
  // A frozen capture candidate must not fail closed here.
  const inPlaceHydrate = (row) => {
    row._hydrated = true;
    return row;
  };
  const project = {
    name: 'Project',
    fields: { name: { kind: 'value', type: 'text' } },
    field: { name: { fieldName: 'name' } },
    grant: permitted,
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: inPlaceHydrate,
  };
  const comment = {
    name: 'Comment',
    fields: {
      projectId: { kind: 'value', type: 'ref', target: project },
      body: { kind: 'value', type: 'text' },
    },
    field: { projectId: { fieldName: 'projectId' }, body: { fieldName: 'body' } },
    grant: permitted,
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: inPlaceHydrate,
  };
  const declaration = snapshot(project, {
    output: snapshot.object({
      name: snapshot.select(project.field.name),
      comments: snapshot.many(comment, {
        via: comment.field.projectId,
        select: snapshot.select(comment.field.body),
      }),
    }),
  });
  const live = createLiveDelivery({
    db,
    entities: new Map([
      ['Project', project],
      ['Comment', comment],
    ]),
    mayVerb: async () => true,
    snapshots: [declaration],
  });
  const result = await live.bootstrap({ principal: {}, scope: 'Project:p1' });
  assert.equal(result.kind, 'snapshot');
  assert.deepEqual(result.snapshot, {
    id: 'p1',
    name: 'one',
    comments: [{ id: 'c1', body: 'visible' }],
  });
  db.close();
});

test('relational snapshot binds declaration entities to application runtime before authorize', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT);');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'one');
  const permitted = () => [scope(() => true).can(() => grant(subscribe))];
  // Unbound declaration (what app authors write) — no hydrate / runtime.db.
  const projectDeclaration = {
    name: 'Project',
    fields: { name: { kind: 'value', type: 'text' } },
    field: { name: { fieldName: 'name' } },
    grant: permitted,
    scopeFilter: () => ({ sql: '1=1', params: {} }),
  };
  // Application-bound entity: hydrate + membership checks need runtime.db.
  const projectBound = {
    ...projectDeclaration,
    declaration: projectDeclaration,
    runtime: { db },
    hydrate: (row) => {
      row._hydrated = true;
      return row;
    },
  };
  const declaration = snapshot(projectDeclaration, {
    output: snapshot.object({ name: snapshot.select(projectDeclaration.field.name) }),
  });
  const live = createLiveDelivery({
    db,
    entities: (name, entity) => {
      if (entity === projectDeclaration || name === 'Project') return projectBound;
      return null;
    },
    mayVerb: async (_entity, _verb, row) => row?._hydrated === true,
    snapshots: [declaration],
  });
  const result = await live.bootstrap({ principal: {}, scope: 'Project:p1' });
  assert.equal(result.kind, 'snapshot');
  assert.deepEqual(result.snapshot, { id: 'p1', name: 'one' });
  db.close();
});
