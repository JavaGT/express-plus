import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { erasureDirective, erasureDirectivePreparation } from '../src/index.mjs';
import { generateFrameworkDDL, prepareErasureDirective } from '../src/internal.mjs';

const scope = 'Project:project-1';
const oldData = JSON.stringify({ projectId: 'project-1', id: 'artefact-1', sensitive: 'remove-me' });
const refs = JSON.stringify([{ scope, seq: 1 }]);
const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, 1, 'artefact.deleted', oldData, 'old-action', '2026-07-27T00:00:00.000Z');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)').run(scope, 1);
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, 'old-action', '2026-07-27T00:00:00.000Z', refs, 1, 'artefact.delete', JSON.stringify({ id: 'artefact-1' }), 'user:u1', 's1', 'action');
  db.prepare('INSERT INTO _HistoryCursor (principalKey, sessionId, scope, past, future) VALUES (?, ?, ?, ?, ?)')
    .run('user:u1', 's1', scope, JSON.stringify(['before', 'old-action', 'after']), JSON.stringify(['old-action', 'later']));
  return db;
}

function directive(db, overrides = {}) {
  const receipt = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action');
  return erasureDirective({
    kind: 'workbench.erasure', version: 1, owningScope: scope, subject: 'artefact-1',
    actions: [{
      scope, actionId: 'old-action', historyOrder: receipt.historyOrder, committedAt: receipt.committedAt,
      receiptDigest: digest(JSON.stringify({ actionType: receipt.actionType, actionData: receipt.actionData, principalKey: receipt.principalKey, sessionId: receipt.sessionId, operation: receipt.operation, eventRefs: JSON.parse(receipt.eventRefs) })),
      events: [{ scope, seq: 1, actionId: 'old-action', eventType: 'artefact.deleted', committedAt: '2026-07-27T00:00:00.000Z', eventDataDigest: digest(oldData) }],
    }],
    census: { version: 1, rules: [
      { kind: 'action', type: 'artefact.delete', disposition: 'target', identityPointers: ['/id'] },
      { kind: 'event', type: 'artefact.deleted', disposition: 'target', identityPointers: ['/id'] },
      { kind: 'event', type: 'lifecycle.purged', disposition: 'retain', identityPointers: ['/id'] },
    ] },
    ...overrides,
  });
}

function app(db, makeDirective, erasure = true) {
  const privilege = erasure === true ? true : { tables: erasure.tables ?? ['DomainCleanup'], ...erasure };
  return workbench({ db, actions: [{
    type: 'lifecycle.purge', erasure: privilege, history: { cursor: 'excluded' }, authorize: () => true,
    handler(context) {
      return { events: [{ type: 'lifecycle.purged', scope, data: { done: true } }], directive: makeDirective(context.db) };
    },
  }] });
}

test('package prepares the exact frozen structural manifest from the transaction snapshot', () => {
  const db = fixture();
  const prepared = prepareErasureDirective(db, {
    owningScope: scope, subject: 'artefact-1', census: directive(db).census,
  });
  assert.deepEqual(prepared.actions, directive(db).actions);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.actions), true);
  assert.equal(Object.isFrozen(prepared.actions[0].events[0]), true);
});

test('package deep-freezes a shallow-frozen explicit manifest', () => {
  const db = fixture(); const shallow = { ...directive(db), actions: [{ ...directive(db).actions[0] }] };
  Object.freeze(shallow);
  const prepared = erasureDirective(shallow);
  assert.equal(Object.isFrozen(prepared.actions), true);
  assert.equal(Object.isFrozen(prepared.actions[0]), true);
  assert.equal(Object.isFrozen(prepared.actions[0].events), true);
  assert.equal(Object.isFrozen(prepared.census.rules[0]), true);
});

test('opted-in preparation receives only the validated manifest and joins the erasure transaction', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY, targetCount INTEGER NOT NULL)');
  let calls = 0; let observed;
  const instance = app(db, (database) => erasureDirectivePreparation({
    owningScope: scope, subject: 'artefact-1', census: directive(database).census,
  }), { prepare({ writes, manifest }) {
    calls += 1; observed = manifest;
    writes.insert('DomainCleanup', { id: 'cleanup', targetCount: manifest.actions.length });
    return { secret: 'must not become a dispatch result' };
  } });
  await instance.start();
  const first = await instance.dispatch({ actionId: 'purge-prepare', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(first.ok, true); assert.equal(calls, 1);
  assert.deepEqual({ ...db.prepare('SELECT * FROM DomainCleanup').get() }, { id: 'cleanup', targetCount: 1 });
  assert.equal(observed.actions[0].actionId, 'old-action');
  assert.equal(JSON.stringify(first).includes('secret'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM _ActionReceipt WHERE actionId = ?').get('purge-prepare')).includes('old-action'), false);
  const retry = await instance.dispatch({ actionId: 'purge-prepare', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(retry.ok, true); assert.equal(retry.deduped, true); assert.equal(calls, 1);
});

test('preparation failure rolls back its writes, purge event, receipt, and erasure', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY)');
  const instance = app(db, directive, { prepare({ writes }) {
    writes.insert('DomainCleanup', { id: 'rolled-back' });
    throw new Error('domain preparation failed');
  } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-fails', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('domain preparation failed'), false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM DomainCleanup').get().count, 0);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE seq = 1').get().eventType, 'artefact.deleted');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE actionId = ?').get('purge-fails'), undefined);
});

test('preparation has no raw Workbench-table authority even if mis-allowlisted', async () => {
  const db = fixture();
  const instance = app(db, directive, { tables: ['_Log'], prepare({ writes }) { writes.delete('_Log', { scope }); } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-raw-db', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE seq = 1').get().eventType, 'artefact.deleted');
});

test('preparation cannot mutate package-owned non-underscore tables', async () => {
  const db = fixture();
  const instance = app(db, directive, { tables: ['BlobStore'], prepare({ writes }) { writes.delete('BlobStore', { id: 'x' }); } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-blobstore', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE seq = 1').get().eventType, 'artefact.deleted');
});

test('preparation rejects allowlisted tables whose triggers could escape the capability', async () => {
  const db = fixture();
  db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY)');
  db.exec('CREATE TRIGGER cleanup_escape AFTER INSERT ON DomainCleanup BEGIN DELETE FROM _ActionReceipt; END');
  const instance = app(db, directive, { prepare({ writes }) { writes.insert('DomainCleanup', { id: 'escape' }); } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-trigger', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE actionId = ?').get('old-action'));
  assert.equal(db.prepare('SELECT COUNT(*) count FROM DomainCleanup').get().count, 0);
});

test('preparation writes cannot escape their transaction-bound callback', async () => {
  const db = fixture(); db.exec('CREATE TABLE DomainCleanup (id TEXT PRIMARY KEY)');
  let escaped;
  const instance = app(db, directive, { prepare({ writes }) { escaped = writes; } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-no-escape', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, true);
  assert.throws(() => escaped.insert('DomainCleanup', { id: 'late' }), /available only during erasure preparation/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM DomainCleanup').get().count, 0);
});

test('private projection replay does not invoke erasure preparation', async () => {
  const db = fixture(); let calls = 0;
  const instance = app(db, directive, { prepare() { calls += 1; } });
  await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-before-replay', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.deepEqual(await instance.replayPrivateFactProjections(), { projected: 0 });
  assert.equal(calls, 1);
});

test('ordinary actions cannot opt into erasure preparation', async () => {
  const db = fixture();
  const ordinary = workbench({ db, actions: [{
    type: 'ordinary.action', erasure: { tables: [], prepare() {} }, authorize: () => true, handler: () => [],
  }] });
  await assert.rejects(ordinary.start(), /must exclude its history cursor/);
});

test('registered erasure atomically tombstones targets, retires receipts/cursors, and sanitizes retries', async () => {
  const db = fixture(); const instance = app(db, directive); await instance.start();
  const first = await instance.dispatch({ actionId: 'purge-1', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(first.ok, true);
  const erased = db.prepare('SELECT * FROM _Log WHERE scope = ? AND seq = 1').get(scope);
  assert.deepEqual({ eventType: erased.eventType, eventData: erased.eventData, actionId: erased.actionId }, { eventType: '$workbench.erased', eventData: '{"version":1}', actionId: '$workbench.erased' });
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action'), undefined);
  const cursor = db.prepare('SELECT past, future FROM _HistoryCursor WHERE scope = ?').get(scope);
  assert.equal(cursor.past, JSON.stringify(['before', 'after'])); assert.equal(cursor.future, JSON.stringify(['later']));
  const receipt = db.prepare('SELECT * FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'purge-1');
  assert.deepEqual({ actionType: receipt.actionType, actionData: receipt.actionData, principalKey: receipt.principalKey, sessionId: receipt.sessionId, operation: receipt.operation }, { actionType: 'lifecycle.purge', actionData: '{"version":1}', principalKey: null, sessionId: null, operation: 'erasure' });
  const second = await instance.dispatch({ actionId: 'purge-1', type: 'lifecycle.purge', payload: { confirmation: 'never persisted' }, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(second.ok, true); assert.equal(second.deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get(scope).count, 2);
});

test('a stale erasure manifest rolls back its new event and leaves existing history untouched', async () => {
  const db = fixture(); const instance = app(db, (database) => directive(database, { actions: [{ ...directive(database).actions[0], receiptDigest: '0'.repeat(64) }] })); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-stale', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action'));
  assert.equal(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'purge-stale'), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get(scope).count, 1);
});

test('only an explicitly privileged, cursor-excluded registered action can return an erasure directive', async () => {
  const db = fixture();
  const unprivileged = workbench({ db, actions: [{
    type: 'not.purge', history: { cursor: 'excluded' }, authorize: () => true,
    handler(context) { return { events: [], directive: directive(context.db) }; },
  }] });
  await unprivileged.start();
  const result = await unprivileged.dispatch({ actionId: 'not-purge', type: 'not.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  const invalid = workbench({ db: new DatabaseSync(':memory:'), actions: [{
    type: 'bad.purge', erasure: true, authorize: () => true, handler: () => [],
  }] });
  await assert.rejects(invalid.start(), /must exclude its history cursor/);
});

test('a retain rule that structurally references the subject aborts without tombstoning', async () => {
  const db = fixture();
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, 2, 'lifecycle.purged', JSON.stringify({ id: 'artefact-1' }), 'retained-action', '2026-07-27T00:00:01.000Z');
  db.prepare('UPDATE _Cursor SET lastSeq = 2 WHERE scope = ?').run(scope);
  const instance = app(db, directive); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-retain', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 2').get(scope).eventType, 'lifecycle.purged');
});

test('a census target omitted from the manifest aborts without partial erasure', async () => {
  const db = fixture();
  const data = JSON.stringify({ projectId: 'project-1', id: 'artefact-1' });
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(scope, 2, 'artefact.deleted', data, 'second-action', '2026-07-27T00:00:01.000Z');
  db.prepare('UPDATE _Cursor SET lastSeq = 2 WHERE scope = ?').run(scope);
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(scope, 'second-action', '2026-07-27T00:00:01.000Z', JSON.stringify([{ scope, seq: 2 }]), 2, 'artefact.delete', JSON.stringify({ id: 'artefact-1' }), 'user:u1', 's1', 'action');
  const instance = app(db, directive); await instance.start();
  const result = await instance.dispatch({ actionId: 'purge-incomplete', type: 'lifecycle.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT eventType FROM _Log WHERE scope = ? AND seq = 1').get(scope).eventType, 'artefact.deleted');
  assert.ok(db.prepare('SELECT 1 FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, 'old-action'));
});
