import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { classifyLiveScope, createLiveDeliveryCore } from '../build/live-delivery-core.mjs';
import { createLiveDelivery } from '../build/live-delivery-public.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { captureDeletedRowAnchor } from '../build/deleted-row-anchor.mjs';
import { writeInvalidationInTxn } from '../build/invalidation-ledger.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT)');
  return db;
}

function entity() {
  return {
    name: 'Note',
    tier: 'live',
    fields: { title: { kind: 'value', type: 'text' } },
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    hydrate: (row) => ({ ...row }),
  };
}

const authorization = {
  admit: async () => ({ admitted: true, reasonCode: null }),
  registerResource() {},
};

test('live scope classification keeps collection identity distinct from row scopes', () => {
  const note = entity();
  const entities = new Map([['Note', note]]);
  const resource = classifyLiveScope('Note:n1', (name) => entities.get(name));
  assert.equal(resource?.kind, 'resource');
  assert.equal(resource?.entity, note);
  assert.equal(resource?.kind === 'resource' ? resource.handle.key : null, 'Note:n1');
  const collection = classifyLiveScope('Note', (name) => entities.get(name));
  assert.equal(collection?.kind, 'collection');
  assert.equal(collection?.entity, note);
});

test('live delivery coalesces revisions to the newest authorized row', async () => {
  const db = database();
  db.prepare('INSERT INTO Note VALUES (?, ?)').run('n1', 'newest');
  db.prepare('INSERT INTO _LiveRevision VALUES (?, ?)').run('Note:n1', 2);
  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', entity()]]),
    mayVerb: async () => true,
    authorization,
    projectRecipient: ({ event, row }) => [{ type: event.eventType, seq: event.seq, title: row?.title }],
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null,
    deliver: async (batch) => delivered.push(...batch),
  });

  assert.deepEqual(delivered, [{ type: 'Note.updated', seq: 2, title: 'newest' }]);
  core.close();
});

test('live catchup resnapshots when its revision cannot be established from the bounded ledger', async () => {
  const db = database();
  db.prepare('INSERT INTO Note VALUES (?, ?)').run('n1', 'current');
  db.prepare('INSERT INTO _LiveRevision VALUES (?, ?)').run('Note:n1', 9);
  const delivery = createLiveDelivery({
    db,
    entities: new Map([['Note', entity()]]),
    mayVerb: async () => true,
    authorization,
  });

  const result = await delivery.catchup({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 1 });
  assert.equal(result.kind, 'snapshot');
  assert.equal(result.cursor, 9);
  assert.deepEqual(result.snapshot, { id: 'n1', title: 'current' });
});

test('live catchup accepts its current ledger revision and resnapshots stale or compacted cursors', async () => {
  const db = database();
  db.prepare('INSERT INTO Note VALUES (?, ?)').run('n1', 'current');
  db.prepare('INSERT INTO _LiveRevision VALUES (?, ?)').run('Note:n1', 3);
  for (const revision of [1, 2, 3]) {
    writeInvalidationInTxn(db, {
      resourceKey: 'Note:n1', kind: 'resource', revision, updatedAt: `2026-01-01T00:00:0${revision}.000Z`,
    }, 2);
  }
  const delivery = createLiveDelivery({
    db,
    entities: new Map([['Note', entity()]]),
    mayVerb: async () => true,
    authorization,
  });
  const principal = { type: 'user', id: 'u1' };

  const current = await delivery.catchup({ principal, scope: 'Note:n1', after: 3 });
  assert.equal(current.kind, 'catchup', 'the latest live revision needs no snapshot');
  assert.equal(current.cursor, 3);

  const stale = await delivery.catchup({ principal, scope: 'Note:n1', after: 2 });
  assert.equal(stale.kind, 'snapshot');
  assert.equal(stale.cursor, 3);

  const compacted = await delivery.catchup({ principal, scope: 'Note:n1', after: 0 });
  assert.equal(compacted.kind, 'snapshot');
  assert.equal(compacted.cursor, 3);
});

test('live deletion projects terminal absence using the deletion-time anchor', async () => {
  const db = database();
  const before = { id: 'n1', title: 'gone' };
  db.prepare('INSERT INTO Note VALUES (?, ?)').run(before.id, before.title);
  captureDeletedRowAnchor(db, 'Note', before.id, before, new Date().toISOString());
  db.prepare('DELETE FROM Note WHERE id = ?').run(before.id);
  db.prepare('INSERT INTO _LiveRevision VALUES (?, ?)').run('Note:n1', 3);
  const delivered = [];
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', entity()]]),
    mayVerb: async (_entity, _verb, row) => row?.title === 'gone',
    authorization,
    projectRecipient: ({ event, row }) => [{ type: event.eventType, seq: event.seq, row }],
  });

  await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 2, signal: null,
    deliver: async (batch) => delivered.push(...batch),
  });

  assert.deepEqual(delivered, [{ type: 'Note.removed', seq: 3, row: null }]);
  core.close();
});
