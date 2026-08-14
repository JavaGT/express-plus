// migration-ledger.test.mjs — S2/A4 namespaced host migration ledger
// (workbench#90). Identity is (namespace, version); checksums are immutable;
// the `workbench` namespace is reserved; cross-namespace dependencies drive the
// execution order from the dependency graph, never registration order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATION_LEDGER_TABLE,
  MIGRATION_DDL,
  runMigrations,
  ledgerRows,
  appliedVersionsByNamespace,
  migrationLedgerStateOf,
  checksumOf,
  validateMigrations,
  NonTransactionalMigrationError,
} from '../build/migrations.mjs';
import * as publicMigrations from '../build/migrations.mjs';

function freshDb() {
  return new DatabaseSync(':memory:');
}

function seq(db) {
  return ledgerRows(db)
    .sort((a, b) => (a.namespace === b.namespace ? a.version - b.version : a.namespace < b.namespace ? -1 : 1))
    .map((row) => `${row.namespace}@${row.version}`);
}

test('ledger: identity is (namespace, version) — the same version in two namespaces does not conflict', () => {
  const db = freshDb();
  try {
    runMigrations(db, [
      { namespace: 'alpha', name: 'a1', version: 1, up: (d) => d.exec('CREATE TABLE IF NOT EXISTS A (id TEXT PRIMARY KEY)') },
      { namespace: 'beta', name: 'b1', version: 1, up: (d) => d.exec('CREATE TABLE IF NOT EXISTS B (id TEXT PRIMARY KEY)') },
      { namespace: 'alpha', name: 'a2', version: 2, up: (d) => d.exec('ALTER TABLE A ADD COLUMN x INTEGER') },
    ]);
    assert.deepEqual(seq(db), ['alpha@1', 'alpha@2', 'beta@1']);
    const byNamespace = appliedVersionsByNamespace(db);
    assert.deepEqual(byNamespace.get('alpha'), [1, 2]);
    assert.deepEqual(byNamespace.get('beta'), [1]);
    // Both namespaces applied their own version 1 — no conflict.
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='A'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='B'").get());
  } finally {
    db.close();
  }
});

test('ledger: records name, checksum, appliedAt, and suppliedBy per row', () => {
  const db = freshDb();
  try {
    const at = '2026-07-14T00:00:00.000Z';
    runMigrations(
      db,
      [
        {
          namespace: 'alpha',
          name: 'seed',
          version: 1,
          up: (d) => d.exec('CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY)'),
        },
      ],
      { now: () => at, suppliedBy: 'scope@0.2.0' },
    );
    const rows = ledgerRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].namespace, 'alpha');
    assert.equal(rows[0].name, 'seed');
    assert.equal(rows[0].appliedAt, at);
    assert.equal(rows[0].suppliedBy, 'scope@0.2.0');
    assert.match(rows[0].checksum, /^[0-9a-f]{64}$/, 'checksum is a sha256 hex fingerprint');
    assert.equal(rows[0].checksum, checksumOf({ namespace: 'alpha', name: 'seed', version: 1, up: (d) => d.exec('CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY)') }));
  } finally {
    db.close();
  }
});

test('ledger: mutating an already-applied migration checksum refuses startup', () => {
  const db = freshDb();
  try {
    const original = {
      namespace: 'alpha',
      name: 'seed',
      version: 1,
      up: (d) => d.exec('CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY)'),
    };
    runMigrations(db, [original]);
    // The same identity re-declared with a DIFFERENT body (mutated source).
    assert.throws(
      () => runMigrations(db, [
        { ...original, up: (d) => d.exec('CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY, extra INTEGER)') },
      ]),
      /different checksum/,
      'a changed applied migration refuses startup',
    );
    // An unchanged re-declaration is a no-op (idempotent).
    runMigrations(db, [original]);
    assert.deepEqual(seq(db), ['alpha@1']);
  } finally {
    db.close();
  }
});

test('ledger: a pinned checksum field is used verbatim', () => {
  const db = freshDb();
  try {
    const pinned = 'deadbeef'.repeat(8);
    runMigrations(db, [
      { namespace: 'alpha', name: 'pinned', version: 1, checksum: pinned, up: () => {} },
    ]);
    assert.equal(ledgerRows(db)[0].checksum, pinned);
  } finally {
    db.close();
  }
});

test('ledger: a failed migration rolls back with no half-recorded version', () => {
  const db = freshDb();
  try {
    db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('1', 'dupe');
    db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run('2', 'dupe');
    runMigrations(db, [{ namespace: 'alpha', name: 'baseline', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x INTEGER') }]);
    // version 2 fails: a unique index on the duplicated body column.
    assert.throws(
      () => runMigrations(db, [
        { namespace: 'alpha', name: 'unique', version: 2, up: (d) => d.exec('CREATE UNIQUE INDEX idx_note_body ON Note(body)') },
      ]),
      /migration alpha@2 failed/,
    );
    assert.deepEqual(seq(db), ['alpha@1'], 'no version 2 row recorded on failure');
    assert.ok(!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_note_body'").get(), 'failed index rolled back');
  } finally {
    db.close();
  }
});

test('ledger: a foreign_keys toggle is refused as non-transactional and never ledgered', () => {
  const db = freshDb();
  try {
    const refused = [];
    assert.throws(
      () => runMigrations(db, [{
        namespace: 'alpha', name: 'foreign-keys', version: 1,
        up: (d) => d.exec('PRAGMA foreign_keys = OFF'),
      }], { onNonTransactionalMigration: (error) => refused.push(error) }),
      NonTransactionalMigrationError,
    );
    assert.equal(refused.length, 1);
    assert.equal(refused[0].operation, 'PRAGMA foreign_keys');
    assert.deepEqual(seq(db), []);
  } finally {
    db.close();
  }
});

test('ledger: a mid-up failure rolls back the partial DDL with the record', () => {
  const db = freshDb();
  try {
    db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT)');
    runMigrations(db, [{ namespace: 'alpha', name: 'base', version: 1, up: (d) => d.exec('ALTER TABLE Note ADD COLUMN x INTEGER') }]);
    assert.throws(
      () => runMigrations(db, [
        {
          namespace: 'alpha',
          name: 'boom',
          version: 2,
          up: (d) => {
            d.exec('ALTER TABLE Note ADD COLUMN y INTEGER');
            throw new Error('boom mid-migration');
          },
        },
      ]),
      /migration alpha@2 failed/,
    );
    const cols = db.prepare("SELECT name FROM pragma_table_info('Note')").all().map((r) => r.name);
    assert.ok(!cols.includes('y'), 'partial ALTER rolled back');
    assert.deepEqual(seq(db), ['alpha@1']);
  } finally {
    db.close();
  }
});

test('ledger: migrations run in version order per namespace regardless of declaration order', () => {
  const db = freshDb();
  try {
    const order = [];
    runMigrations(db, [
      { namespace: 'alpha', name: 'v3', version: 3, up: (d) => { order.push('alpha@3'); d.exec('CREATE TABLE IF NOT EXISTS T3 (id TEXT PRIMARY KEY)'); } },
      { namespace: 'alpha', name: 'v1', version: 1, up: (d) => { order.push('alpha@1'); d.exec('CREATE TABLE IF NOT EXISTS T1 (id TEXT PRIMARY KEY)'); } },
      { namespace: 'alpha', name: 'v2', version: 2, up: (d) => { order.push('alpha@2'); d.exec('CREATE TABLE IF NOT EXISTS T2 (id TEXT PRIMARY KEY)'); } },
    ]);
    assert.deepEqual(order, ['alpha@1', 'alpha@2', 'alpha@3']);
  } finally {
    db.close();
  }
});

test('ledger: cross-namespace dependencies derive the execution order, never registration order', () => {
  const db = freshDb();
  try {
    const order = [];
    runMigrations(db, [
      { namespace: 'app', name: 'needs-schema', version: 1, dependencies: ['schema@5'], up: () => { order.push('app@1'); } },
      { namespace: 'gateway', name: 'depends-on-app', version: 1, dependencies: ['app@1'], up: () => { order.push('gateway@1'); } },
      { namespace: 'schema', name: 'foundation', version: 5, up: () => { order.push('schema@5'); } },
    ]);
    // schema@5 runs first (dependency of app@1), then app@1, then the gateway
    // that depends on app@1 — NOT registration order.
    assert.deepEqual(order, ['schema@5', 'app@1', 'gateway@1']);
  } finally {
    db.close();
  }
});

test('ledger: a cross-namespace dependency on an already-applied version is satisfied without ordering', () => {
  const db = freshDb();
  try {
    const order = [];
    runMigrations(db, [
      { namespace: 'other', name: 'solo', version: 1, up: () => { order.push('other@1'); } },
    ]);
    // `app@1` depends on `other@1`, which is already applied — no ordering edge.
    runMigrations(db, [
      { namespace: 'app', name: 'after', version: 1, dependencies: ['other@1'], up: () => { order.push('app@1'); } },
    ]);
    assert.deepEqual(order, ['other@1', 'app@1']);
  } finally {
    db.close();
  }
});

test('ledger: a dependency on a never-declared and never-applied migration is refused', () => {
  const db = freshDb();
  try {
    assert.throws(
      () => runMigrations(db, [
        { namespace: 'app', name: 'orphan', version: 1, dependencies: ['missing@9'], up: () => {} },
      ]),
      /neither declared nor already applied/,
    );
    assert.deepEqual(seq(db), []);
  } finally {
    db.close();
  }
});

test('ledger: a dependency cycle is refused and nothing is recorded', () => {
  const db = freshDb();
  try {
    assert.throws(
      () => runMigrations(db, [
        { namespace: 'alpha', name: 'a', version: 1, dependencies: ['beta@1'], up: () => {} },
        { namespace: 'beta', name: 'b', version: 1, dependencies: ['alpha@1'], up: () => {} },
      ]),
      /dependency cycle/,
    );
    assert.deepEqual(seq(db), []);
  } finally {
    db.close();
  }
});

test('ledger: a self-dependency is refused', () => {
  const db = freshDb();
  try {
    assert.throws(
      () => runMigrations(db, [
        { namespace: 'alpha', name: 'self', version: 1, dependencies: ['alpha@1'], up: () => {} },
      ]),
      /depends on itself/,
    );
  } finally {
    db.close();
  }
});

test('ledger: duplicate (namespace, version) and duplicate name within a namespace are refused', () => {
  assert.throws(
    () => validateMigrations([
      { namespace: 'alpha', name: 'a', version: 1, up: () => {} },
      { namespace: 'alpha', name: 'b', version: 1, up: () => {} },
    ]),
    /duplicate migration version 1 in namespace "alpha"/,
  );
  assert.throws(
    () => validateMigrations([
      { namespace: 'alpha', name: 'same', version: 1, up: () => {} },
      { namespace: 'alpha', name: 'SAME', version: 2, up: () => {} },
    ]),
    /duplicate migration name "SAME" in namespace "alpha"/,
  );
  // The same version in DIFFERENT namespaces is legitimate.
  validateMigrations([
    { namespace: 'alpha', name: 'a', version: 1, up: () => {} },
    { namespace: 'beta', name: 'b', version: 1, up: () => {} },
  ]);
});

test('ledger: the reserved workbench namespace is refused for applications (case-insensitive)', () => {
  const db = freshDb();
  try {
    for (const namespace of ['workbench', 'WorkBench', 'WORKBENCH']) {
      assert.throws(
        () => runMigrations(db, [{ namespace, name: 'impersonator', version: 1, up: () => {} }]),
        /reserved namespace "workbench".*only the Workbench package may own it/,
        `namespace "${namespace}" is impersonation`,
      );
      assert.deepEqual(seq(db), [], 'nothing recorded for the refused lane');
    }
  } finally {
    db.close();
  }
});

test('ledger: the public migration surface cannot access the package-owned runner', () => {
  assert.equal('runLedgerMigrations' in publicMigrations, false);
  assert.equal('LedgerRunnerOptions' in publicMigrations, false);
});

test('ledger: monotonic/gap policy — a gap in declared versions is refused', () => {
  const db = freshDb();
  try {
    assert.throws(
      () => runMigrations(db, [
        { namespace: 'alpha', name: 'v1', version: 1, up: () => {} },
        { namespace: 'alpha', name: 'v3', version: 3, up: () => {} },
      ]),
      /not contiguous: gap between versions 1 and 3/,
    );
    assert.deepEqual(seq(db), []);
  } finally {
    db.close();
  }
});

test('ledger: monotonic/gap policy — a new migration at or below an applied version is refused', () => {
  const db = freshDb();
  try {
    runMigrations(db, [
      { namespace: 'alpha', name: 'v2', version: 2, up: (d) => d.exec('CREATE TABLE IF NOT EXISTS T (id TEXT PRIMARY KEY)') },
    ]);
    // A fresh namespace starts at any positive version, but a NEW migration must
    // sit ABOVE the already-applied versions of its namespace.
    assert.throws(
      () => runMigrations(db, [
        { namespace: 'alpha', name: 'v1', version: 1, up: () => {} },
      ]),
      /versions must be contiguous per namespace/,
    );
    // An incremental declaration ABOVE the applied max is fine.
    runMigrations(db, [
      { namespace: 'alpha', name: 'v3', version: 3, up: () => {} },
    ]);
    assert.deepEqual(seq(db), ['alpha@2', 'alpha@3']);
  } finally {
    db.close();
  }
});

test('ledger: restart declarations cannot skip a version after the applied ledger', () => {
  const db = freshDb();
  try {
    runMigrations(db, [{ namespace: 'alpha', name: 'v1', version: 1, up: () => {} }]);
    assert.throws(
      () => runMigrations(db, [{ namespace: 'alpha', name: 'v3', version: 3, up: () => {} }]),
      /leaves a gap after already-applied version 1/,
    );
    assert.deepEqual(seq(db), ['alpha@1']);
  } finally {
    db.close();
  }
});

test('ledger: DDL declares the single namespaced table and the census captures it', () => {
  const db = freshDb();
  try {
    assert.match(MIGRATION_DDL, /CREATE TABLE IF NOT EXISTS _SchemaMigration/);
    assert.match(MIGRATION_DDL, /PRIMARY KEY \(namespace, version\)/);
    runMigrations(db, [{ namespace: 'alpha', name: 'a', version: 1, up: () => {} }]);
    const state = migrationLedgerStateOf(db);
    assert.equal(state.table, MIGRATION_LEDGER_TABLE);
    assert.deepEqual(state.appliedVersions, [{ namespace: 'alpha', version: 1 }]);
    assert.equal(state.maxVersion, 1);
    // Empty when no ledger exists yet (capture never creates the table).
    const empty = new DatabaseSync(':memory:');
    try {
      assert.deepEqual(migrationLedgerStateOf(empty), { table: MIGRATION_LEDGER_TABLE, appliedVersions: [], maxVersion: 0 });
    } finally {
      empty.close();
    }
  } finally {
    db.close();
  }
});

test('ledger: migrations must declare namespace, name, positive version, and an up function', () => {
  assert.throws(() => validateMigrations([{ name: 'x', version: 1, up: () => {} }]), /migration namespace/);
  assert.throws(() => validateMigrations([{ namespace: 'alpha', version: 1, up: () => {} }]), /must declare a name/);
  assert.throws(() => validateMigrations([{ namespace: 'alpha', name: 'x', version: 0, up: () => {} }]), /positive safe integer/);
  assert.throws(() => validateMigrations([{ namespace: 'alpha', name: 'x', version: 1.5, up: () => {} }]), /positive safe integer/);
  assert.throws(() => validateMigrations([{ namespace: 'alpha', name: 'x', version: 1 }]), /must declare an up function/);
});
