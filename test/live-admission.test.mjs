import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { authorizeSubscription } from '../src/live-admission.mjs';
import { scope } from '../src/internal.mjs';

function annotatedEntity() {
  return {
    name: 'Doc',
    fields: { body: { kind: 'annotatedText' }, cursor: { kind: 'ephemeral' }, title: { kind: 'value' } },
    scopeFilter: () => ({ sql: '1 = 1', params: {} }),
    hydrate: (row) => row,
    grant: [scope().can(() => true)],
  };
}

function dependencies({ allowed = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare("INSERT INTO Doc (id, title) VALUES ('d1', 'visible')").run();
  const conn = { principal: { type: 'user', id: 'alice' } };
  return {
    db,
    conn,
    dependencies: {
      resolveEntity: (name) => name === 'Doc' ? annotatedEntity() : null,
      mayVerb: async () => allowed,
      fanout: { subscriptionCount: () => 0, hasSubscription: () => false },
      db,
    },
  };
}

test('annotated entities reject explicit generic ephemeral interest after subscription authorization', async () => {
  const { db, conn, dependencies: deps } = dependencies();
  try {
    const result = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1', fields: { cursor: true } }, conn, deps);
    assert.deepEqual(result, {
      admitted: false,
      failure: { category: 'invalid-input', message: 'Ephemeral interest is unavailable for annotated-text entities.' },
    });
  } finally {
    db.close();
  }
});

test('annotated ephemeral-interest rejection does not disclose itself before subscription authorization', async () => {
  const { db, conn, dependencies: deps } = dependencies({ allowed: false });
  try {
    const result = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1', fields: { cursor: true } }, conn, deps);
    assert.deepEqual(result, {
      admitted: false,
      failure: { category: 'denied', message: 'Forbidden.' },
    });
  } finally {
    db.close();
  }
});

test('annotated entities retain ordinary no-field and non-ephemeral subscriptions', async () => {
  const { db, conn, dependencies: deps } = dependencies();
  try {
    const noFields = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1' }, conn, deps);
    assert.equal(noFields.admitted, true);
    assert.equal(noFields.fields, null);
    const title = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1', fields: { title: true } }, conn, deps);
    assert.equal(title.admitted, true);
    assert.deepEqual(title.fields, { title: true });
  } finally {
    db.close();
  }
});
