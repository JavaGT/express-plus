// blob-root-relocation.test.mjs — S6/A2 default byte-root relocation. With NO
// blobs config, a FILE-mode app's byte store roots under the owned directory's
// managed `blobs/` (final slots) + `staging/` (pending slots) — inside the
// owned directory when one exists, beside the db file otherwise; never the
// retired `cwd/.blobs` default (a relative database path makes the owned
// directory cwd-relative, so the managed root can legitimately sit under cwd).
// An explicit `blobs: { root }` stays the override (refused on overlap with
// the owned directory). A memory database gets the in-memory fake byte store
// (S6/A1) — no disk root at all. `pathFor` is retired from the portable
// BlobStore surface; it survives only as the `_pathFor` internal/test handle.
// A conforming custom DbAdapter must declare `root` (owned directory for file
// mode, null for memory) or construction fails closed (review #93). The same
// guard covers a PRE-OPENED database result: a file-backed result without a
// declared root is refused (never silently handed the ephemeral in-memory byte
// store), while a pre-opened result with a root roots the durable store under
// it and a pre-opened memory result (root: null) keeps the fake store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSqliteAdapter, openMemoryAdapter, openSqliteAdapter } from '../build/sqlite-adapter.mjs';
import workbench from '../build/internal.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'wb-blob-relocate-'));
}

test('a file-mode app roots the default byte store under <ownedDir>/blobs + /staging — nothing in cwd/.blobs', async () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  const previous = process.cwd();
  process.chdir(base);
  try {
    const app = workbench({ db: { directory: owned, name: 'app', mode: 'file' } });
    await app.ddl();
    try {
      assert.ok(app.blobs, 'blob store constructed with no blobs config');

      const up = app.blobs.upload({ bytes: Buffer.from('relocated-bytes') });
      const pendingPath = path.resolve(app.blobs._pathFor(up.id, { pending: true }));
      const finalPath = path.resolve(app.blobs._pathFor(up.id));
      assert.ok(
        pendingPath.startsWith(path.join(owned, 'staging')),
        `pending slots stage in <ownedDir>/staging (got ${pendingPath})`,
      );
      assert.ok(existsSync(pendingPath), 'the pending bytes landed in staging/');

      app.db.exec('BEGIN IMMEDIATE');
      app.blobs.adopt(app.db, up.id);
      app.db.exec('COMMIT');
      app.blobs.finalize(up.id);

      assert.ok(
        finalPath.startsWith(path.join(owned, 'blobs')),
        `final slots live in <ownedDir>/blobs (got ${finalPath})`,
      );
      assert.ok(existsSync(finalPath), 'the finalized bytes landed in blobs/');
      assert.ok(!existsSync(pendingPath), 'the staging slot was promoted away');

      assert.equal(existsSync(path.join(base, '.blobs')), false, 'nothing lands in cwd/.blobs');
    } finally {
      await app.shutdown();
    }
  } finally {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  }
});

test('an explicit blobs: { root } is the override (legacy single-root layout), refused on overlap', async () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  const sibling = path.join(base, 'sibling');
  try {
    // An explicit root still writes bytes where asked — pending slots keep the
    // legacy `<root>/<id>.pending` layout (existing deployments keep their
    // on-disk files).
    const app = workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root: sibling } });
    await app.ddl();
    try {
      const up = app.blobs.upload({ bytes: Buffer.from('explicit-root') });
      assert.ok(
        existsSync(path.join(sibling, `${up.id}.pending`)),
        'the explicit root receives the bytes',
      );
      assert.ok(
        app.blobs._pathFor(up.id).startsWith(path.resolve(sibling)),
        'the explicit root is the store root',
      );
    } finally {
      await app.shutdown();
    }

    // Refuse-vs-place preserved (S1/A2): an explicit root overlapping the owned
    // directory throws — before the adapter opens, so no ownership lock leaks.
    assert.throws(
      () => workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root: owned } }),
      /overlaps the database-owned directory/,
    );
    assert.throws(
      () => workbench({ db: { directory: owned, name: 'app', mode: 'file' }, blobs: { root: path.join(owned, 'inside') } }),
      /overlaps the database-owned directory/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a memory database gets the in-memory fake byte store — no disk root', async () => {
  const base = tempRoot();
  const previous = process.cwd();
  process.chdir(base);
  try {
    const app = workbench({ db: ':memory:' });
    await app.ddl();
    try {
      assert.equal(app.blobs.capabilities.durability, 'ephemeral', 'the in-memory fake store (S6/A1)');
      const up = app.blobs.upload({ bytes: Buffer.from('in-memory') });
      assert.deepStrictEqual(app.blobs.readRange(up.id), Buffer.from('in-memory'));
      assert.match(app.blobs._pathFor(up.id), /^mem:\/\/blobs\//, 'the synthetic key handle');
      assert.equal(existsSync(path.join(base, '.blobs')), false, 'a memory app never touches cwd/.blobs');
    } finally {
      await app.shutdown();
    }
  } finally {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  }
});

test('pathFor is retired from the portable BlobStore surface (test/debug handle only)', async () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  try {
    const app = workbench({ db: { directory: owned, name: 'app', mode: 'file' } });
    await app.ddl();
    try {
      assert.equal(typeof app.blobs.pathFor, 'undefined', 'no portable pathFor on the app blob store');
      assert.equal(typeof app.blobs._pathFor, 'function', 'the explicit internal/test handle survives');
      assert.equal(app.blobs._pathFor('x'), app.blobs._pathFor('x'), 'the handle is a pure function');
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a file-backed custom DbAdapter without `root` fails closed instead of silently going memory (review #93)', () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  try {
    // A file-backed DbAdapter (A1 contract) that does not declare its owned
    // root. The app cannot classify it file-vs-memory, so it must REFUSE with a
    // named error — never silently hand it the in-memory fake byte store.
    const fileBackedWithoutRoot = {
      readMirror() {
        return {
          kind: 'read-mirror', mode: 'read-only', readOnly: true,
          connectionString: `file:${path.join(owned, 'app.db')}?mode=ro`,
        };
      },
      open() {
        return Promise.reject(new Error('must not open: construction should fail closed first'));
      },
    };
    assert.throws(
      () => workbench({ db: fileBackedWithoutRoot }),
      /must declare its `root`/,
      'construction names the missing owned-directory declaration',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a memory-mode custom DbAdapter (root: null) still gets the in-memory fake byte store', async () => {
  const base = tempRoot();
  const previous = process.cwd();
  process.chdir(base);
  try {
    const app = workbench({ db: createSqliteAdapter({ mode: 'memory' }) });
    await app.ddl();
    try {
      assert.equal(app.blobs.capabilities.durability, 'ephemeral', 'the in-memory fake store (S6/A1)');
      assert.match(app.blobs._pathFor('any-id'), /^mem:\/\/blobs\//, 'the synthetic key handle');
      assert.equal(existsSync(path.join(base, '.blobs')), false, 'a memory adapter never touches a disk root');
    } finally {
      await app.shutdown();
    }
  } finally {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  }
});

test('a file-backed custom DbAdapter (root: owned directory) roots the default byte store under it — never memory', async () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  try {
    const app = workbench({ db: createSqliteAdapter({ directory: owned, name: 'app', mode: 'file' }) });
    await app.ddl();
    try {
      assert.equal(app.blobs.capabilities.durability, 'durable', 'a file-backed adapter gets a durable store');
      assert.ok(
        path.resolve(app.blobs._pathFor('any-id')).startsWith(path.join(owned, 'blobs')),
        'the default byte root sits under the adapter-owned blobs/',
      );
      assert.ok(
        path.resolve(app.blobs._pathFor('any-id', { pending: true })).startsWith(path.join(owned, 'staging')),
        'pending slots stage under the adapter-owned staging/',
      );
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a pre-opened file-backed database without `root` fails closed instead of silently going memory (review #93)', () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  const opened = openSqliteAdapter({ directory: owned, name: 'app' });
  try {
    // A pre-opened result that lacks the owned-directory declaration. The app
    // cannot classify it file-vs-memory, so it must REFUSE — never silently
    // hand a file-backed database the in-memory fake byte store.
    const withoutRoot = { ...opened, root: undefined };
    assert.throws(
      () => workbench({ db: withoutRoot }),
      /must declare its `root`/,
      'construction names the missing owned-directory declaration',
    );
  } finally {
    opened.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a pre-opened file-backed database (root: owned directory) roots the default byte store under it — never memory', async () => {
  const base = tempRoot();
  const owned = path.join(base, 'owned');
  const opened = openSqliteAdapter({ directory: owned, name: 'app' });
  try {
    const app = workbench({ db: opened });
    await app.ddl();
    try {
      assert.equal(app.blobs.capabilities.durability, 'durable', 'a pre-opened file-backed database gets a durable store');
      assert.ok(
        path.resolve(app.blobs._pathFor('any-id')).startsWith(path.join(owned, 'blobs')),
        'the default byte root sits under the adapter-owned blobs/',
      );
      assert.ok(
        path.resolve(app.blobs._pathFor('any-id', { pending: true })).startsWith(path.join(owned, 'staging')),
        'pending slots stage under the adapter-owned staging/',
      );
    } finally {
      await app.shutdown();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a pre-opened memory database (root: null) gets the in-memory fake byte store', async () => {
  const base = tempRoot();
  const previous = process.cwd();
  process.chdir(base);
  try {
    const app = workbench({ db: openMemoryAdapter() });
    await app.ddl();
    try {
      assert.equal(app.blobs.capabilities.durability, 'ephemeral', 'the in-memory fake store (S6/A1)');
      assert.match(app.blobs._pathFor('any-id'), /^mem:\/\/blobs\//, 'the synthetic key handle');
      assert.equal(existsSync(path.join(base, '.blobs')), false, 'a memory app never touches a disk root');
    } finally {
      await app.shutdown();
    }
  } finally {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  }
});
