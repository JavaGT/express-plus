import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createLiveDelivery,
  declaredTableNames,
  frameworkTableNames,
  readCommittedCursor,
} from '../src/server.mjs';
import { entity, grant, read, subscribe, text } from '../src/index.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';
import { createOwnedLiveDelivery } from '../src/live-delivery-public.mjs';
import { scope } from '../src/scope.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, '2026-07-26T00:00:00.000Z');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq')
    .run(scope, seq);
}

function noteEntity() {
  return {
    name: 'Note',
    fields: { title: { kind: 'value' } },
    grant: [],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
}

test('server exposes committed cursors without raw event delivery', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.prepare(`
    INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'Project:project-1',
    1,
    'Project.renamed',
    JSON.stringify({ name: 'Field notes' }),
    'action-1',
    '2026-07-13T00:00:00.000Z',
  );
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)')
    .run('Project:project-1', 1);

  assert.equal(readCommittedCursor(db, 'Project:project-1'), 1);
  db.close();
});

test('server exposes immutable framework and declaration table censuses', () => {
  const Widget = entity('Widget', { name: text() });

  assert.ok(Object.isFrozen(frameworkTableNames));
  assert.ok(frameworkTableNames.includes('_Log'));
  assert.deepEqual(declaredTableNames([Widget]), ['Widget']);
});

test('server exposes the transport-neutral live delivery factory', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const live = createLiveDelivery({
    db,
    entities: new Map(),
    mayVerb: async () => true,
  });

  assert.equal(typeof live.subscribe, 'function');
  assert.equal(typeof live.bootstrap, 'function');
  assert.equal(typeof live.wake, 'function');
  assert.equal('emit' in live, false);
  assert.equal('close' in live, false);
  db.close();
});

test('public live delivery pairs an authorized snapshot with its committed cursor', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, secret TEXT)');
  db.prepare('INSERT INTO Project (id, name, secret) VALUES (?, ?, ?)').run('p1', 'Field notes', 'raw-secret');
  appendEvent(db, 'Project:p1', 1, 'Source.created', { name: 'raw source data' });

  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } }, grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ id: row.id, name: row.name }),
  };
  const live = createLiveDelivery({
    db,
    entities: new Map([['Project', entity]]),
    mayVerb: () => true,
    compositeScopes: new Map([['Project', { anchor: entity, members: [] }]]),
  });
  const bootstrap = await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' });

  assert.deepEqual(bootstrap, {
    kind: 'snapshot',
    snapshot: { entities: { Project: { p1: { id: 'p1', name: 'Field notes' } } } },
    cursor: { anchor: 1, aggregate: 0 },
  });
  db.close();
});

test('composite scope delivery materializes a checked aggregate and resyncs heterogeneous actions without raw log data', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, secret TEXT)');
  db.prepare('INSERT INTO Project (id, name, secret) VALUES (?, ?, ?)').run('p1', 'Field notes', 'anchor-secret');
  appendEvent(db, 'Project:p1', 1, 'Comment.created', { body: 'raw comment', secret: 'raw event secret' });
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } }, grant: [],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ id: row.id, name: row.name }),
  };
  const live = createLiveDelivery({
    db, entities: new Map([['Project', entity]]), mayVerb: () => true,
    compositeScopes: new Map([['Project', { anchor: entity, members: [] }]]),
  });

  const bootstrap = await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' });
  assert.deepEqual(bootstrap, {
    kind: 'snapshot', cursor: { anchor: 1, aggregate: 0 },
    snapshot: { entities: { Project: { p1: { id: 'p1', name: 'Field notes' } } } },
  });
  const catchup = await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 });
  assert.deepEqual(catchup, {
    kind: 'snapshot', cursor: { anchor: 1, aggregate: 0 },
    snapshot: { entities: { Project: { p1: { id: 'p1', name: 'Field notes' } } } },
  });
  assert.equal(JSON.stringify({ bootstrap, catchup }).includes('secret'), false);
  assert.equal(JSON.stringify({ bootstrap, catchup }).includes('raw comment'), false);
  assert.equal(JSON.stringify({ bootstrap, catchup }).includes('action-1'), false);
  appendEvent(db, 'Project:p1', 2, 'Project.updated', { secret: 'raw anchor event' });
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 1 }),
    { kind: 'snapshot', cursor: { anchor: 2, aggregate: 0 }, snapshot: { entities: { Project: { p1: { id: 'p1', name: 'Field notes' } } } } },
  );
  db.close();
});

test('aggregate snapshots authorize and hydrate every declared member in deterministic entity/id order', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.exec('CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT, body TEXT, secret TEXT, visible INTEGER)');
  db.prepare('INSERT INTO Project VALUES (?, ?)').run('p1', 'Field notes');
  db.prepare('INSERT INTO Comment VALUES (?, ?, ?, ?, ?)').run('c2', 'p1', 'second', 'secret', 1);
  db.prepare('INSERT INTO Comment VALUES (?, ?, ?, ?, ?)').run('c1', 'p1', 'first', 'secret', 1);
  db.prepare('INSERT INTO Comment VALUES (?, ?, ?, ?, ?)').run('hidden', 'p1', 'hidden', 'secret', 0);
  const project = { name: 'Project', fields: { id: {}, name: {} }, grant: [], scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ id: row.id, name: row.name }) };
  const comment = {
    name: 'Comment', fields: { projectId: {}, body: {} }, grant: [],
    scopeFilter: () => ({ sql: 't0.visible = 1', params: {} }),
    hydrate: (row) => row.id === 'c2' ? null : ({ id: row.id, projectId: row.projectId, body: row.body }),
  };
  const live = createLiveDelivery({
    db, entities: new Map([['Project', project], ['Comment', comment]]),
    mayVerb: (_entity, _verb, row) => row.id !== 'c2' || row.id === 'p1',
    compositeScopes: new Map([['Project', { anchor: project, members: [{ entity: comment, where: { field: 'projectId', fromAnchor: 'id' } }] }]]),
  });
  assert.deepEqual(await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }), {
    kind: 'snapshot', cursor: { anchor: 0, aggregate: 0 },
    snapshot: { entities: { Comment: { c1: { id: 'c1', projectId: 'p1', body: 'first' } }, Project: { p1: { id: 'p1', name: 'Field notes' } } } },
  });
  db.close();
});

test('aggregate bootstrap rejects a commit interleaved by asynchronous member authorization', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT)');
  db.prepare('INSERT INTO Project VALUES (?)').run('p1');
  db.prepare('INSERT INTO Comment VALUES (?, ?)').run('c1', 'p1');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { id: {} }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const comment = { name: 'Comment', fields: { projectId: {} }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  let inserted = false;
  const live = createLiveDelivery({
    db, entities: new Map([['Project', project], ['Comment', comment]]),
    mayVerb: async (_entity, _verb, row) => {
      if (row.id === 'c1' && !inserted) {
        inserted = true;
        db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
      }
      return true;
    },
    compositeScopes: new Map([['Project', { anchor: project, members: [{ entity: comment, where: { field: 'projectId', fromAnchor: 'id' } }] }]]),
  });
  await assert.rejects(live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }), /aggregate snapshot changed/);
  db.close();
});

test('aggregate revision never reuses a removed receipt rowid', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.prepare(`INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation)
    VALUES ('Project:p1', 'removed', '2026-07-28T00:00:00.000Z', '[]', 'action')`).run();
  db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
  db.prepare("DELETE FROM _ActionReceipt WHERE scope = 'Project:p1' AND actionId = 'removed'").run();
  db.prepare(`INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation)
    VALUES ('Project:p1', 'replacement', '2026-07-28T00:00:00.000Z', '[]', 'action')`).run();
  db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
  assert.equal(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get().revision, 2);
  db.close();
});

test('member deletion invalidates all possible old/new anchors and reauthorizes before resync delivery', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT)');
  db.prepare('INSERT INTO Project VALUES (?)').run('old');
  db.prepare('INSERT INTO Project VALUES (?)').run('new');
  db.prepare('INSERT INTO Comment VALUES (?, ?)').run('c1', 'old');
  const ownGrant = () => [scope(() => true).can(() => grant(subscribe))];
  const project = { name: 'Project', fields: { id: {} }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const comment = { name: 'Comment', fields: { projectId: {} }, grant: ownGrant, scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  let allowed = true;
  const owned = createOwnedLiveDelivery({
    db, entities: new Map([['Project', project], ['Comment', comment]]), mayVerb: () => allowed,
    compositeScopes: new Map([['Project', { anchor: project, members: [{ entity: comment, where: { field: 'projectId', fromAnchor: 'id' } }] }]]),
  });
  const batches = [];
  let revoked = 0;
  const controllers = [new AbortController(), new AbortController()];
  const subscriptions = await Promise.all(['old', 'new'].map((id, index) => owned.delivery.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: `Project:${id}`, after: { anchor: 0, aggregate: 0 }, signal: controllers[index].signal,
    deliver: async (batch) => batches.push([id, batch]), revoke: () => { revoked += 1; },
  })));
  await Promise.all(subscriptions.map((subscription) => subscription.activate()));
  db.prepare('DELETE FROM Comment WHERE id = ?').run('c1');
  await owned.consumer([{ scope: 'Comment:c1', seq: 1, type: 'Comment.removed' }]);
  await sleep(20);
  assert.deepEqual(batches.map(([id]) => id).sort(), ['new', 'old']);
  batches.length = 0;
  allowed = false;
  await owned.consumer([{ scope: 'Comment:c1', seq: 2, type: 'Comment.updated' }]);
  await sleep(20);
  assert.equal(revoked, 2);
  assert.equal(batches.length, 0);
  controllers.forEach((controller) => controller.abort());
  db.close();
});

test('stale aggregate subscriptions latch recovery after asynchronous admission', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO Project VALUES (?)').run('p1');
  const project = { name: 'Project', fields: { id: {} }, grant: [], scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const live = createLiveDelivery({
    db, entities: new Map([['Project', project]]), mayVerb: async () => true,
    compositeScopes: new Map([['Project', { anchor: project, members: [] }]]),
  });
  const batches = [];
  const controller = new AbortController();
  const subscription = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: { anchor: 0, aggregate: 99 }, signal: controller.signal,
    deliver: async (batch) => batches.push(batch),
  });
  await subscription.activate();
  assert.deepEqual(batches, [[{ type: 'resync', entity: 'Project', id: 'p1', seq: 0, reason: 'recipient-snapshot-required' }]]);
  controller.abort();
  db.close();
});

test('aggregate subscriptions return the post-admission revision and resync when a member commit races admission', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE Comment (id TEXT PRIMARY KEY, projectId TEXT)');
  db.prepare('INSERT INTO Project VALUES (?)').run('p1');
  const project = { name: 'Project', fields: { id: {} }, grant: [], scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  const comment = { name: 'Comment', fields: { projectId: {} }, grant: [], scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }) };
  let authorize;
  const permission = new Promise((resolve) => { authorize = resolve; });
  const live = createLiveDelivery({
    db, entities: new Map([['Project', project], ['Comment', comment]]), mayVerb: async () => permission,
    compositeScopes: new Map([['Project', { anchor: project, members: [{ entity: comment, where: { field: 'projectId', fromAnchor: 'id' } }] }]]),
  });
  const batches = [];
  const controller = new AbortController();
  const pending = live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: { anchor: 0, aggregate: 0 }, signal: controller.signal,
    deliver: async (batch) => batches.push(batch),
  });
  db.prepare('INSERT INTO Comment VALUES (?, ?)').run('c1', 'p1');
  db.prepare("UPDATE _CommittedRevision SET revision = revision + 1 WHERE name = 'actions'").run();
  authorize(true);
  const subscription = await pending;
  const cursor = await subscription.activate();
  assert.deepEqual(batches, [[{ type: 'resync', entity: 'Project', id: 'p1', seq: 0, reason: 'recipient-snapshot-required' }]]);
  assert.deepEqual(cursor, { anchor: 0, aggregate: 1 }, 'the response reports the post-admission aggregate revision while resync keeps it uncovered');
  controller.abort();
  db.close();
});

test('composite scope declarations reject malformed members and preserve a synchronous cursor boundary', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { id: {}, name: { kind: 'value' } }, grant: [],
    scopeFilter: () => ({ sql: '1=1', params: {} }), hydrate: (row) => ({ ...row }),
  };
  assert.throws(() => createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: () => true,
    compositeScopes: new Map([['Project', { anchor: entity, members: [{ entity, where: { field: 'missing', fromAnchor: 'id' } }] }]]),
  }), /undeclared cross-anchor field/);
  db.close();
});

test('composite scope declarations reject malformed grammar and revoke an active aggregate stream', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, visible INTEGER)');
  db.prepare('INSERT INTO Project (id, name, visible) VALUES (?, ?, ?)').run('p1', 'Field notes', 1);
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } }, grant: [],
    scopeFilter: () => ({ sql: 't0.visible = 1', params: {} }), hydrate: (row) => ({ id: row.id, name: row.name }),
  };
  assert.throws(
    () => createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true, compositeScopes: new Map([['Project:bad', {}]]) }),
    /scope entity/,
  );
  const live = createLiveDelivery({
    db, entities: new Map([['Project', entity]]), mayVerb: async () => true,
    compositeScopes: new Map([['Project', { anchor: entity, members: [] }]]),
  });
  const controller = new AbortController();
  let revoked = false;
  const subscription = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', signal: controller.signal,
    deliver: async () => {}, revoke: () => { revoked = true; },
  });
  await subscription.activate();
  db.prepare('UPDATE Project SET visible = 0 WHERE id = ?').run('p1');
  appendEvent(db, 'Project:p1', 1, 'Comment.created', { secret: 'withheld after revocation' });
  live.wake('Project:p1');
  await sleep(30);
  assert.equal(revoked, true);
  controller.abort();
  db.close();
});

test('public live delivery bounds catch-up with a recipient snapshot rather than raw history', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'visible');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { secret: 'raw-one' });
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { secret: 'raw-two' });
  const live = createLiveDelivery({ db, entities: new Map([['Note', noteEntity()]]), mayVerb: async () => true, maxCatchupEvents: 1 });
  const result = await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0 });
  assert.deepEqual(result, { kind: 'snapshot', snapshot: { id: 'n1', title: 'visible' }, cursor: 2 });
  db.close();
});

test('public live delivery bootstrap fails closed and rejects asynchronous snapshot readers', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } }, grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const denied = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => false });
  assert.deepEqual(
    await denied.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }),
    { kind: 'revoked' },
  );

  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  db.close();
});

test('public live delivery bootstrap suppresses a paired snapshot when final authorization is revoked', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  let authorizations = 0;
  const live = createLiveDelivery({
    db, entities: new Map([['Project', entity]]),
    mayVerb: async () => ++authorizations === 1,
  });
  assert.deepEqual(
    await live.bootstrap({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1' }),
    { kind: 'revoked' },
  );
  assert.equal(authorizations, 2);
  db.close();
});

test('public live delivery revokes an active subscription when the anchor is no longer authorized', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  const controller = new AbortController();
  let revoked = false;
  const activation = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', signal: controller.signal,
    deliver: async () => {}, revoke: () => { revoked = true; },
  });
  await activation.activate();
  db.prepare('DELETE FROM Project WHERE id = ?').run('p1');
  live.wake('Project:p1');
  await sleep(30);
  assert.equal(revoked, true);
  controller.abort();
  db.close();
});

test('public live delivery catch-up returns only recipient-safe envelopes and its exact cursor', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  appendEvent(db, 'Project:p1', 1, 'Source.created', { secret: 'raw source data' });
  const live = createLiveDelivery({
    db,
    entities: new Map([['Project', {
      name: 'Project', fields: { name: { kind: 'value' } },
      grant: () => [scope(() => true).can(() => grant(read, subscribe))],
      scopeFilter: () => ({ sql: '1=1', params: {} }),
      hydrate: (row) => ({ id: row.id, name: row.name }),
    }]]),
    mayVerb: async () => true,
  });

  const catchup = await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 });
  assert.deepEqual(catchup, {
    kind: 'catchup',
    cursor: 1,
    envelopes: [{ type: 'resync', entity: 'Project', id: 'p1', seq: 1, reason: 'recipient-snapshot-required' }],
  });
  assert.equal(JSON.stringify(catchup).includes('raw source data'), false);
  db.close();
});

test('public live delivery catch-up revokes when the anchor is unavailable', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 }),
    { kind: 'revoked' },
  );
  db.close();
});

test('public live delivery catch-up maps a second authorization denial to revocation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  let authorizations = 0;
  const live = createLiveDelivery({
    db, entities: new Map([['Project', entity]]),
    mayVerb: async () => ++authorizations === 1,
  });
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 }),
    { kind: 'revoked' },
  );
  assert.equal(authorizations, 2);
  db.close();
});

test('public live delivery catch-up preserves the cursor for a contiguous terminal removal', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO Project (id, name) VALUES (?, ?)').run('p1', 'Field notes');
  const entity = {
    name: 'Project', fields: { name: { kind: 'value' } },
    grant: () => [scope(() => true).can(() => grant(read, subscribe))],
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
  const live = createLiveDelivery({ db, entities: new Map([['Project', entity]]), mayVerb: async () => true });
  db.prepare('DELETE FROM Project WHERE id = ?').run('p1');
  appendEvent(db, 'Project:p1', 1, 'Project.removed');
  assert.deepEqual(
    await live.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', after: 0 }),
    {
      kind: 'catchup', cursor: 1,
      envelopes: [{ type: 'event', entity: 'Project', id: 'p1', seq: 1, seqSpan: [1, 1], event: {
        type: 'Project.removed', scope: 'Project:p1', seq: 1, actionId: 'action-1', committedAt: '2026-07-26T00:00:00.000Z', data: { id: 'p1' },
      } }],
    },
  );
  db.close();
});

test('public live delivery waits for activation, strips raw event data, and requires cancellation', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, secret TEXT)');
  db.prepare('INSERT INTO Note (id, title, secret) VALUES (?, ?, ?)').run('n1', 'visible', 'raw-secret');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible', secret: 'raw-secret', operation: 'raw-operation' });

  const live = createLiveDelivery({
    db,
    entities: new Map([['Note', noteEntity()]]),
    mayVerb: async () => true,
  });
  assert.throws(() => live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, deliver: async () => {},
  }), /requires an AbortSignal/);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: aborted.signal, deliver: async () => {},
  }), /subscription is aborted/);

  const batches = [];
  const controller = new AbortController();
  const subscription = await live.subscribe({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    after: 0,
    signal: controller.signal,
    deliver: async (batch) => { batches.push(batch); },
  });
  live.wake('Note:n1');
  assert.equal(batches.length, 0, 'a paused subscription cannot deliver before acknowledgement');
  await Promise.all([subscription.activate(), subscription.activate()]);

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [{
    type: 'event', entity: 'Note', id: 'n1', seq: 1, seqSpan: [1, 1],
    event: {
      type: 'Note.updated', scope: 'Note:n1', seq: 1, actionId: 'action-1',
      committedAt: '2026-07-26T00:00:00.000Z', data: { id: 'n1', title: 'visible' },
    },
  }]);
  assert.equal(JSON.stringify(batches).includes('raw-secret'), false);
  assert.equal(JSON.stringify(batches).includes('raw-operation'), false);

  appendEvent(db, 'Note:n1', 2, 'Note.title.operated', { operation: 'another-raw-operation' });
  live.wake('Note:n1');
  await sleep(20);
  assert.deepEqual(batches[1], [{
    type: 'resync', entity: 'Note', id: 'n1', seq: 2, reason: 'recipient-snapshot-required',
  }]);
  assert.equal(JSON.stringify(batches).includes('another-raw-operation'), false);

  controller.abort();
  db.close();
});

test('public live delivery does not acknowledge a rejected batch', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'visible');
  appendEvent(db, 'Note:n1', 1, 'Note.updated', { title: 'visible' });

  const live = createLiveDelivery({ db, entities: new Map([['Note', noteEntity()]]), mayVerb: async () => true });
  const failing = new AbortController();
  const failed = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: failing.signal,
    deliver: async () => { throw new Error('SSE write failed'); },
  });
  await assert.rejects(() => failed.activate(), /delivery callback threw/);

  const batches = [];
  const retry = new AbortController();
  const resumed = await live.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: retry.signal,
    deliver: async (batch) => { batches.push(batch); },
  });
  await resumed.activate();
  assert.equal(batches[0][0].seq, 1);

  retry.abort();
  db.close();
});
