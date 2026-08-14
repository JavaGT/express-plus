// invalidation-ledger.test.mjs — bounded, payload-free live recovery markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  INVALIDATION_LEDGER_TABLE,
  invalidationLedgerTableDDL,
  invalidationsFor,
  invalidationRecovery,
  writeInvalidation,
  writeInvalidationInTxn,
} from '../build/invalidation-ledger.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(invalidationLedgerTableDDL());
  return db;
}

function entry(revision, { resourceKey = 'Note:n1', kind = 'resource' } = {}) {
  return { resourceKey, kind, revision, updatedAt: `2026-08-15T00:00:0${revision}.000Z` };
}

test('ledger schema contains resource keys and revisions only, never content or actor audit data', () => {
  const db = freshDb();
  try {
    const columns = db.prepare(`PRAGMA table_info(${INVALIDATION_LEDGER_TABLE})`).all().map((column) => column.name).sort();
    assert.deepEqual(columns, ['kind', 'resourceKey', 'revision', 'updatedAt']);
    assert.equal(invalidationLedgerTableDDL().match(/payload|snapshot|prior|actor/gi), null);
  } finally {
    db.close();
  }
});

test('framework boot creates the invalidation ledger table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    executeFrameworkDDL(db);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_InvalidationLedger'").get());
  } finally {
    db.close();
  }
});

test('compaction bounds each resource independently and always retains its latest revision', async () => {
  const db = freshDb();
  try {
    let coordinated = false;
    const writeCoordinator = {
      run(fn) {
        coordinated = true;
        return Promise.resolve(fn());
      },
    };
    db.writeCoordinator = writeCoordinator;
    for (let revision = 1; revision <= 4; revision++) {
      await writeInvalidation(writeCoordinator, db, entry(revision), 2);
    }
    writeInvalidationInTxn(db, entry(1, { resourceKey: 'Note:n2' }), 2);
    assert.equal(coordinated, true, 'standalone writes use the platform coordinator');
    assert.deepEqual(invalidationsFor(db, 'Note:n1', 'resource').map((row) => row.revision), [3, 4]);
    assert.deepEqual(invalidationsFor(db, 'Note:n2', 'resource').map((row) => row.revision), [1]);
  } finally {
    db.close();
  }
});

test('a superseding revision preserves the newest marker and updates the staleness surface', () => {
  const db = freshDb();
  try {
    writeInvalidationInTxn(db, entry(1), 2);
    writeInvalidationInTxn(db, entry(2), 2);
    writeInvalidationInTxn(db, entry(3), 2);
    assert.equal(invalidationRecovery(db, 'Note:n1', 'resource', 3).status, 'current');
    assert.deepEqual(invalidationRecovery(db, 'Note:n1', 'resource', 2), {
      status: 'resnapshot', reason: 'stale', revision: 3, retainedFromRevision: 2,
    });
  } finally {
    db.close();
  }
});

test('a compacted revision forces resnapshot rather than offering replay', () => {
  const db = freshDb();
  try {
    for (let revision = 1; revision <= 4; revision++) writeInvalidationInTxn(db, entry(revision), 2);
    assert.deepEqual(invalidationRecovery(db, 'Note:n1', 'resource', 1), {
      status: 'resnapshot', reason: 'compacted', revision: 4, retainedFromRevision: 3,
    });
  } finally {
    db.close();
  }
});

test('a compaction storage failure is reported and does not lose the newest revision', () => {
  const db = freshDb();
  try {
    writeInvalidationInTxn(db, entry(1), 1);
    db.exec(`CREATE TRIGGER reject_invalidation_compaction BEFORE DELETE ON ${INVALIDATION_LEDGER_TABLE}
      BEGIN SELECT RAISE(ABORT, 'compaction unavailable'); END`);
    assert.throws(() => writeInvalidationInTxn(db, entry(2), 1), /compaction unavailable/);
    assert.deepEqual(invalidationsFor(db, 'Note:n1', 'resource').map((row) => row.revision), [1, 2]);
  } finally {
    db.close();
  }
});

test('a foreign coordinator is refused even when it exposes run()', () => {
  const db = freshDb();
  try {
    const owner = { run: (fn) => Promise.resolve(fn()) };
    db.writeCoordinator = owner;
    assert.throws(
      () => writeInvalidation({ run: (fn) => Promise.resolve(fn()) }, db, entry(1)),
      /foreign write coordinator/,
    );
  } finally {
    db.close();
  }
});

test('resource and collection markers with the same key coexist and compact independently', () => {
  const db = freshDb();
  try {
    writeInvalidationInTxn(db, entry(1, { kind: 'resource' }), 1);
    writeInvalidationInTxn(db, entry(1, { kind: 'collection' }), 1);
    writeInvalidationInTxn(db, entry(2, { kind: 'resource' }), 1);
    assert.deepEqual(invalidationsFor(db, 'Note:n1', 'resource').map((row) => row.revision), [2]);
    assert.deepEqual(invalidationsFor(db, 'Note:n1', 'collection').map((row) => row.revision), [1]);
  } finally {
    db.close();
  }
});
