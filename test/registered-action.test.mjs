import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench from '../src/index.mjs';
import { readCommittedCursor } from '../src/server.mjs';

function sourceAction(_db, authorize = () => true) {
  return {
    type: 'source.create',
    authorize,
    handler: ({ payload, now }) => [{
      type: 'source.created',
      scope: `project:${payload.projectId}`,
      data: { id: payload.id, entity: { ...payload, createdAt: now } },
    }],
    projections: [{
      eventTypes: ['source.created'],
      apply(event, tx) {
        tx.prepare('INSERT INTO Source (id, projectId, name) VALUES (?, ?, ?)').run(
          event.data.entity.id,
          event.data.entity.projectId,
          event.data.entity.name,
        );
      },
    }],
  };
}

async function appWith(action) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL)');
  const app = workbench({ db, actions: [action(db)] });
  await app.start();
  return { app, db };
}

test('registered action commits projection, project event, cursor, and receipt once', async () => {
  const { app, db } = await appWith(sourceAction);
  const request = {
    actionId: 'action-1', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  };

  const first = await app.dispatch(request);
  const duplicate = await app.dispatch(request);

  assert.equal(first.ok, true);
  assert.equal(first.events[0].type, 'source.created');
  assert.equal(first.events[0].scope, 'project:p1');
  assert.equal(first.events[0].seq, 1);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(readCommittedCursor(db, 'project:p1'), 1);
});

test('registered action handler receives the exact caller-selected owning scope', async () => {
  let receivedScope = null;
  const scopeAware = (db) => {
    const declaration = sourceAction(db);
    return {
      ...declaration,
      handler: ({ scope, ...context }) => {
        receivedScope = scope;
        return declaration.handler(context);
      },
    };
  };
  const { app } = await appWith(scopeAware);
  const result = await app.dispatch({
    actionId: 'scope-aware', scope: 'project:distinct-scope', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, true);
  assert.equal(receivedScope, 'project:distinct-scope');
});

test('registered action receipt commits immutable request attribution', async () => {
  const { app, db } = await appWith(sourceAction);
  const request = {
    actionId: 'attributed-action', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: 'session-1',
  };

  assert.equal((await app.dispatch(request)).ok, true);
  assert.equal((await app.dispatch({ ...request, principal: { type: 'user', id: 'u2', attributes: {} }, clientId: 'session-2' })).deduped, true);
  const receipt = db.prepare('SELECT principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?').get('attributed-action');
  assert.equal(receipt.principalKey, 'user:u1');
  assert.equal(receipt.sessionId, 'session-1');

  assert.equal((await app.dispatch({
    ...request, actionId: 'anonymous-attribution', payload: { id: 's2', projectId: 'p1', name: 'Anonymous' },
    principal: { type: 'anonymous', id: null, attributes: {} }, clientId: 'session-3',
  })).ok, true);
  const anonymousReceipt = db.prepare('SELECT principalKey, sessionId FROM _ActionReceipt WHERE actionId = ?').get('anonymous-attribution');
  assert.equal(anonymousReceipt.principalKey, null);
  assert.equal(anonymousReceipt.sessionId, 'session-3');
});

test('registered actions reject malformed receipt client attribution before writes', async () => {
  const { app, db } = await appWith(sourceAction);
  const result = await app.dispatch({
    actionId: 'invalid-attribution', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: '',
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);

  const mismatch = await app.dispatch({
    actionId: 'mismatched-attribution', scope: 'project:p1', type: 'source.create',
    payload: { id: 's2', projectId: 'p1', name: 'Interview' },
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: 'session-1', history: { session: 'session-2' },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);

  const emptyBatch = await app.batch([], {
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: '',
  });
  assert.equal(emptyBatch.ok, false);
  assert.equal(emptyBatch.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);
});

test('registered action batch commits request attribution once', async () => {
  const { app, db } = await appWith(sourceAction);
  const result = await app.batch([{
    type: 'source.create', payload: { id: 's1', projectId: 'p1', name: 'Interview' },
  }], {
    principal: { type: 'user', id: 'u1', attributes: {} }, clientId: 'session-1',
  });

  assert.equal(result.ok, true);
  const receipt = db.prepare('SELECT principalKey, sessionId FROM _ActionReceipt').get();
  assert.equal(receipt.principalKey, 'user:u1');
  assert.equal(receipt.sessionId, 'session-1');
});

test('registered action authorization denies before handler and projection', async () => {
  let handled = false;
  const denied = (db) => {
    const declaration = sourceAction(db, () => false);
    return { ...declaration, handler: (context) => { handled = true; return declaration.handler(context); } };
  };
  const { app, db } = await appWith(denied);

  const result = await app.dispatch({
    actionId: 'denied', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Denied' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'denied');
  assert.equal(handled, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
});

test('registered action projection failure rolls back log, cursor, row, and receipt', async () => {
  const broken = (db) => {
    const declaration = sourceAction(db);
    return {
      ...declaration,
      projections: [{
        eventTypes: ['source.created'],
        apply(event, tx) {
          declaration.projections[0].apply(event, tx);
          throw new Error('injected projection failure');
        },
      }],
    };
  };
  const { app, db } = await appWith(broken);

  const result = await app.dispatch({
    actionId: 'broken', scope: 'project:p1', type: 'source.create',
    payload: { id: 's1', projectId: 'p1', name: 'Broken' },
    principal: { type: 'user', id: 'u1', attributes: {} },
  });

  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Source').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Cursor').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 0);
});
