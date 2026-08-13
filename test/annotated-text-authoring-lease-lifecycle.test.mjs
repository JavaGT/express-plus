import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTHORING_STREAM_LIMITS, ensureLease, ensureStream, hashClientNonce, resolveLease,
} from '../build/annotated-text-authoring-stream.mjs';

const prefix = 'Doc_body';

const MAX_LEASES = AUTHORING_STREAM_LIMITS.maxLeasesPerStream;

const docFixture = { documentId: 'opaque-document-alpha', principalType: 'user', principalId: 'opaque-principal-alpha' };
const otherDocFixture = { documentId: 'opaque-document-beta', principalType: 'user', principalId: 'opaque-principal-alpha' };

function leaseCount(db, streamId) {
  return Number(db.prepare(`SELECT COUNT(*) AS cnt FROM ${prefix}_authoring_lease WHERE stream_id = ?`).get(streamId).cnt);
}

function leaseIds(db, streamId) {
  return db.prepare(`SELECT id FROM ${prefix}_authoring_lease WHERE stream_id = ?`).all(streamId)
    .map((row) => row.id);
}

function expireLease(db, leaseId) {
  db.prepare(`UPDATE ${prefix}_authoring_lease SET expires_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', leaseId);
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ${prefix}_authoring_stream (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_lease (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_nonce_hash TEXT NOT NULL, acknowledged_fence INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_checkpoint (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_position (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, block_id TEXT, checkpoint_id TEXT NOT NULL, visible_at_issue INTEGER NOT NULL, redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)), created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_group (token TEXT PRIMARY KEY, lease_id TEXT NOT NULL, issued_fence INTEGER NOT NULL, group_id TEXT, visible_blocks TEXT NOT NULL, assignable INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ${prefix}_authoring_snapshot (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, fence INTEGER NOT NULL, issued_at TEXT NOT NULL, acknowledged_at TEXT);
    CREATE TABLE ${prefix}_authoring_snapshot_position (snapshot_id TEXT NOT NULL, position_token TEXT NOT NULL, PRIMARY KEY (snapshot_id, position_token));
    CREATE TABLE ${prefix}_authoring_split (lease_id TEXT NOT NULL, temporary_block TEXT NOT NULL, authoritative_block_id TEXT NOT NULL, position_token TEXT NOT NULL, action_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fence INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (lease_id, temporary_block));
  `);
  return db;
}

test('repeated ensureLease with the same nonce on one stream reuses a single lease', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, ...docFixture });
  const nonceHash = hashClientNonce('fixture:nonce:alpha');

  const first = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: nonceHash });
  assert.equal(first.created, true);

  for (let index = 0; index < 4; index += 1) {
    const again = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: nonceHash });
    assert.equal(again.id, first.id);
    assert.equal(again.created, false);
    assert.equal(again.acknowledgedFence, 0);
  }

  assert.equal(leaseCount(db, stream.id), 1);
});

test('distinct live nonce leases hit but never exceed maxLeasesPerStream and are not evicted for a stranger', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, ...docFixture });

  const issued = [];
  for (let index = 0; index < MAX_LEASES; index += 1) {
    const lease = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(`fixture:nonce:${index}`) });
    assert.notEqual(lease, null, 'fixture bug: initial fill must succeed');
    issued.push(lease);
  }
  assert.equal(leaseCount(db, stream.id), MAX_LEASES);
  const originalIds = leaseIds(db, stream.id);
  assert.deepEqual(new Set(originalIds), new Set(issued.map((lease) => lease.id)));

  const stranger = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('fixture:nonce:stranger') });
  assert.equal(stranger, null);
  assert.equal(leaseCount(db, stream.id), MAX_LEASES);
  assert.deepEqual(new Set(leaseIds(db, stream.id)), new Set(originalIds), 'live leases must survive a refused newcomer');
});

test('a lease released by expiry allows capacity recovery while staying bounded', () => {
  const db = setup();
  const stream = ensureStream({ db, prefix, ...docFixture });

  const issued = [];
  for (let index = 0; index < MAX_LEASES; index += 1) {
    issued.push(ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(`fixture:nonce:leak-${index}`) }));
  }

  const expiredReference = issued[0];
  expireLease(db, expiredReference.id);

  const recovered = ensureLease({ db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce('fixture:nonce:recovered') });
  assert.equal(recovered.created, true);
  assert.equal(leaseCount(db, stream.id), MAX_LEASES, 'capacity recovery must not grow past the ceiling');

  const remainingIds = new Set(leaseIds(db, stream.id));
  assert.equal(remainingIds.has(expiredReference.id), false, 'expired lease must be evicted to free capacity');
  assert.equal(remainingIds.has(recovered.id), true, 'the recovered lease must be live');
  assert.ok(Array.from(remainingIds).every((id) => id !== expiredReference.id));
  assert.equal(resolveLease({ db, prefix, leaseToken: recovered.id, streamId: stream.id }) !== null, true);
});

test('lease lifecycle is isolated across document identities', () => {
  const db = setup();
  const firstStream = ensureStream({ db, prefix, ...docFixture });
  const sameHandoff = ensureStream({ db, prefix, ...docFixture });
  assert.equal(sameHandoff.created, false);
  assert.equal(sameHandoff.id, firstStream.id);

  const secondStream = ensureStream({ db, prefix, ...otherDocFixture });
  assert.equal(secondStream.created, true);
  assert.notEqual(secondStream.id, firstStream.id);

  const nonceHash = hashClientNonce('fixture:nonce:shared-shape');
  const firstLease = ensureLease({ db, prefix, streamId: firstStream.id, clientNonceHash: nonceHash });
  const secondLease = ensureLease({ db, prefix, streamId: secondStream.id, clientNonceHash: nonceHash });

  assert.equal(leaseCount(db, firstStream.id), 1);
  assert.equal(leaseCount(db, secondStream.id), 1);
  assert.notEqual(firstLease.id, secondLease.id);

  ensureLease({ db, prefix, streamId: firstStream.id, clientNonceHash: nonceHash });
  assert.equal(leaseCount(db, firstStream.id), 1, 'same-nonce reuse must be stream-scoped');
  assert.equal(leaseCount(db, secondStream.id), 1);
});
