import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { erasureDirective } from '../src/index.mjs';
import { generateFrameworkDDL } from '../src/internal.mjs';

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

function app(db, makeDirective) {
  return workbench({ db, actions: [{
    type: 'lifecycle.purge', erasure: true, history: { cursor: 'excluded' }, authorize: () => true,
    handler(context) {
      return { events: [{ type: 'lifecycle.purged', scope, data: { done: true } }], directive: makeDirective(context.db) };
    },
  }] });
}

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
