// Scope-support ACCEPTANCE — Google Photos album+photo spine.
//
// This is the capstone for the scope-support series. It declares the
// Photo→Album authorization chain the google-photos stress-test describes —
// with ONLY constructs that have shipped in this branch:
//
//   typed-FK map membership traversal (slice 5),
//   runtime ref scalar traversal via thenables (slice 6),
//   range predicates (slice 4), inherit (slice 3), and
//   the unified check registry / mayVerb runtime (slices 1–2).
//
// The acceptance proof is that BOTH auth layers — the SQL row-scope filter
// AND the runtime .can — agree on every verdict for album owners, members,
// editors, and strangers, against a real node:sqlite DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  text,
  date,
  ref,
  map,
  scope,
  grant,
  deny,
  read,
  write,
  subscribe,
  anyOf,
  never,
  inherit,
  bindReadScope,
  mayVerb,
} from '../src/index.mjs';
import { principal } from '../src/principal.mjs';
import { setActiveDb } from '../src/db.mjs';

// ---- helpers ----

function scopedIds(db, entityRecord, prin) {
  const bound = bindReadScope(entityRecord.readScope, prin);
  return db
    .prepare(`SELECT id FROM ${entityRecord.name} AS t0 WHERE ${bound.sql}`)
    .all(bound.params)
    .map((r) => r.id);
}

async function serve(t, db, routes, who) {
  const app = workbench({ db });
  for (const { path, entity } of routes) app.mount(path, entity);
  app.listen(0, { principalOf: () => who });
  await app.ready;
  t.after(() => {
    app.httpServer.close();
    db.close();
  });
  const { port } = app.httpServer.address();
  return `http://127.0.0.1:${port}`;
}

// ---- DSL: the google-photos auth spine ----

function declareAlbumPhoto() {
  const Album = entity('Album', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
      collaborators: map(ref('User'), {
        role: ['viewer', 'editor', 'coOwner'],
        default: {},
      }),
      updatedAt: date({ touch: true }),
    },
    checks: {
      collaborator: ({ Album, principal }) =>
        Album.collaborators.has(principal.id),
      coOwner: ({ Album, principal }) =>
        Album.collaborators.get(principal.id)?.role === 'coOwner',
      contributor: ({ Album, principal }) =>
        Album.collaborators.get(principal.id)?.role === 'editor',
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.collaborator()))
        .can(async ({ is }) => {
          if (await is.owner()) return grant(read, write, subscribe);
          if (await is.coOwner()) return grant(read, write, subscribe);
          if (await is.contributor()) return grant(read, write, subscribe);
          if (await is.collaborator()) return grant(read, subscribe);
          return deny('not a member of this album');
        }),
    ],
  });

  const Photo = entity('Photo', {
    fields: {
      title: text(),
      album: ref('Album'),
      capturedAt: date({ optional: true }),
      owner: ref('User', { role: 'owner', readonly: true }),
    },
    checks: {
      albumMember: ({ Photo, principal }) =>
        Photo.album.collaborators.has(principal.id),
      albumEditor: ({ Photo, principal }) =>
        Photo.album.collaborators.get(principal.id)?.role === 'editor',
      albumCoOwner: ({ Photo, principal }) =>
        Photo.album.collaborators.get(principal.id)?.role === 'coOwner',
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.albumMember()))
        .can(async ({ is }) => {
          if (await is.owner()) return grant(read, write, subscribe);
          if (await is.albumCoOwner()) return grant(read, write, subscribe);
          if (await is.albumEditor()) return grant(read, write, subscribe);
          if (await is.albumMember()) return grant(read, subscribe);
          return deny('not a member of this photo\'s album');
        }),
    ],
  });

  return { Album, Photo };
}

// ---- seed ----
// album/photo ownership:
//   a-shared: owned by alice, bob is editor, carol is viewer
//   a-private: owned by bob, no collaborators
//   p1 in a-shared, owned by alice
//   p2 in a-private, owned by bob
//   p3 orphan (album=null), owned by dave (not in any test principal set)
//   p4 dangling (album=no-such-album), owned by dave

function seed(db) {
  db.exec('CREATE TABLE Album (id TEXT, title TEXT, owner TEXT, updatedAt INTEGER)');
  db.exec(
    'CREATE TABLE Album_collaborators (Album_id TEXT, member_id TEXT, role TEXT)',
  );
  db.exec('CREATE TABLE Photo (id TEXT, title TEXT, album TEXT, capturedAt INTEGER, owner TEXT)');

  db.prepare('INSERT INTO Album (id, title, owner) VALUES (:id, :title, :owner)').run({
    id: 'a-shared', title: 'Shared Album', owner: 'alice',
  });
  db.prepare('INSERT INTO Album (id, title, owner) VALUES (:id, :title, :owner)').run({
    id: 'a-private', title: 'Private Album', owner: 'bob',
  });

  db.prepare(
    'INSERT INTO Album_collaborators (Album_id, member_id, role) VALUES (:aid, :mid, :role)',
  ).run({ aid: 'a-shared', mid: 'bob', role: 'editor' });
  db.prepare(
    'INSERT INTO Album_collaborators (Album_id, member_id, role) VALUES (:aid, :mid, :role)',
  ).run({ aid: 'a-shared', mid: 'carol', role: 'viewer' });

  db.prepare(
    'INSERT INTO Photo (id, title, album, owner) VALUES (:id, :title, :album, :owner)',
  ).run({ id: 'p1', title: 'Sunset', album: 'a-shared', owner: 'alice' });
  db.prepare(
    'INSERT INTO Photo (id, title, album, owner) VALUES (:id, :title, :album, :owner)',
  ).run({ id: 'p2', title: 'Portrait', album: 'a-private', owner: 'bob' });
  // Orphan — owned by dave so no test principal sees it through ownership.
  db.prepare(
    'INSERT INTO Photo (id, title, album, owner) VALUES (:id, :title, :album, :owner)',
  ).run({ id: 'p3', title: 'Orphan', album: null, owner: 'dave' });
  // Dangling FK — owned by dave so no test principal sees it through ownership.
  db.prepare(
    'INSERT INTO Photo (id, title, album, owner) VALUES (:id, :title, :album, :owner)',
  ).run({ id: 'p4', title: 'Missing', album: 'no-such-album', owner: 'dave' });
}

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });
const carol = principal({ type: 'user', id: 'carol' });
const stranger = principal({ type: 'user', id: 'stranger' });

// ---- ACCEPTANCE 1: the spine compiles ----

test('Album and Photo entities compile with the full google-photos grant', () => {
  const { Album, Photo } = declareAlbumPhoto();
  for (const e of [Album, Photo]) {
    assert.ok(e.readScope && typeof e.readScope.sql === 'string', `${e.name} has a compiled read-scope`);
  }
  const sql = Photo.readScope.sql.replace(/\s+/g, ' ');
  assert.match(sql, /EXISTS.*FROM Album_collaborators/i);
  assert.match(sql, /Album_id = t0\.album/);
});

// ---- ACCEPTANCE 2: SQL scope filters by album membership ----

test('SQL scope returns only photos whose album the principal can access (or owns)', () => {
  const { Album, Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);
  setActiveDb(db);

  // Alice owns a-shared → sees p1 (in a-shared).
  assert.deepEqual(scopedIds(db, Photo, alice), ['p1']);
  // Bob is editor on a-shared AND owns a-private → sees p1 + p2.
  assert.deepEqual(scopedIds(db, Photo, bob).sort(), ['p1', 'p2']);
  // Carol is viewer on a-shared → sees only p1.
  assert.deepEqual(scopedIds(db, Photo, carol), ['p1']);
  // Stranger has no album access and owns nothing → sees nothing.
  assert.deepEqual(scopedIds(db, Photo, stranger), []);

  db.close();
});

// ---- ACCEPTANCE 3: runtime .can agrees with scope per role ----

test('runtime mayVerb grants the correct capabilities per album role', async () => {
  const { Album, Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);
  setActiveDb(db);

  const p1 = Photo.getOrFail('p1');

  assert.equal(await mayVerb(Photo, 'read', p1, alice), true);
  assert.equal(await mayVerb(Photo, 'update', p1, alice), true);
  assert.equal(await mayVerb(Photo, 'read', p1, bob), true);
  assert.equal(await mayVerb(Photo, 'update', p1, bob), true);
  assert.equal(await mayVerb(Photo, 'read', p1, carol), true);
  assert.equal(await mayVerb(Photo, 'update', p1, carol), false);
  assert.equal(await mayVerb(Photo, 'read', p1, stranger), false);

  db.close();
});

// ---- ACCEPTANCE 4: null/dangling FK fails closed for non-owners ----

test('null and dangling album FKs fail closed for non-owning principals', async () => {
  const { Album, Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);
  setActiveDb(db);

  // Orphan (album=null, owner=dave) — not visible to any test principal
  const p3 = Photo.getOrFail('p3');
  assert.equal(await mayVerb(Photo, 'read', p3, carol), false);
  assert.equal(await mayVerb(Photo, 'read', p3, bob), false);
  assert.equal(await mayVerb(Photo, 'read', p3, alice), false);

  // Dangling (album=no-such-album, owner=dave) — no one gets in
  const p4 = Photo.getOrFail('p4');
  assert.equal(await mayVerb(Photo, 'read', p4, bob), false);
  assert.equal(await mayVerb(Photo, 'read', p4, alice), false);

  // Scoped IDs exclude orphan and dangling for everyone
  const allIds = scopedIds(db, Photo, alice)
    .concat(scopedIds(db, Photo, bob))
    .concat(scopedIds(db, Photo, carol));
  assert.ok(!allIds.includes('p3'), 'orphan photo not visible to anyone');
  assert.ok(!allIds.includes('p4'), 'dangling photo not visible to anyone');

  db.close();
});

// ---- ACCEPTANCE 5: removing a collaborator revokes both layers ----

test('removing a collaborator revokes SQL scope AND runtime .can', async () => {
  const { Album, Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);
  setActiveDb(db);

  const p1 = Photo.getOrFail('p1');
  // Carol is a viewer on a-shared → sees p1
  assert.equal(await mayVerb(Photo, 'read', p1, carol), true);

  // Remove carol from the album
  db.prepare(
    'DELETE FROM Album_collaborators WHERE Album_id = :aid AND member_id = :mid',
  ).run({ aid: 'a-shared', mid: 'carol' });

  // Now carol is denied by BOTH layers
  assert.equal(await mayVerb(Photo, 'read', p1, carol), false);
  assert.deepEqual(scopedIds(db, Photo, carol), []);

  db.close();
});

// ---- ACCEPTANCE 6: runtime thenable ref traversal (Slice 6) ----

test('async declared checks use await to read target scalar fields', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);

  db.exec('CREATE TABLE Album2 (id TEXT, owner TEXT, title TEXT)');
  db.exec('CREATE TABLE Album2_collaborators (Album2_id TEXT, member_id TEXT, role TEXT)');
  db.exec('CREATE TABLE Photo2 (id TEXT, title TEXT, album TEXT, owner TEXT)');

  db.prepare('INSERT INTO Album2 (id, owner, title) VALUES (:id, :owner, :title)').run({
    id: 'a1', owner: 'alice', title: 'Test',
  });
  db.prepare(
    'INSERT INTO Album2_collaborators (Album2_id, member_id, role) VALUES (:aid, :mid, :role)',
  ).run({ aid: 'a1', mid: 'bob', role: 'editor' });
  db.prepare('INSERT INTO Photo2 (id, title, album, owner) VALUES (:id, :title, :album, :owner)').run({
    id: 'p1', title: 'Sunset', album: 'a1', owner: 'alice',
  });

  const Album2 = entity('Album2', {
    fields: {
      owner: ref('User', { role: 'owner' }),
      title: text(),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    grant: () => [scope(() => never()).can(() => grant(read))],
  });

  const Photo2 = entity('Photo2', {
    fields: {
      title: text(),
      album: ref('Album2'),
      owner: ref('User', { role: 'owner' }),
    },
    checks: {
      albumOwner: async ({ entity, principal }) => {
        const a = await entity.album;
        return a.owner === principal.id;
      },
    },
    grant: () => [scope(() => never()).can(async ({ is }) => {
      if (await is.albumOwner()) return grant(read, write, subscribe);
      return deny('not the album owner');
    })],
  });

  const p1Row = Photo2.getOrFail('p1');

  assert.equal(await mayVerb(Photo2, 'read', p1Row, alice), true);
  assert.equal(await mayVerb(Photo2, 'update', p1Row, alice), true);
  assert.equal(await mayVerb(Photo2, 'read', p1Row, bob), false);
  assert.equal(await mayVerb(Photo2, 'read', p1Row, stranger), false);

  db.close();
});

// ---- ACCEPTANCE 7: E2E HTTP — album-scoped photo listing ----

test('HTTP list returns only photos in albums the principal can access', async (t) => {
  const { Album, Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);

  const origin = await serve(t, db, [{ path: '/photos', entity: Photo }], bob);

  const res = await fetch(`${origin}/photos`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  const ids = rows.map((r) => r.id).sort();
  // Bob owns p2 (a-private) + is editor on a-shared → sees p1 + p2.
  // Bob does NOT own p3/p4 (dave owns them) so those are excluded.
  assert.deepEqual(ids, ['p1', 'p2']);
});

test('HTTP list for a viewer returns only shared-album photos', async (t) => {
  const { Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);

  const origin = await serve(t, db, [{ path: '/photos', entity: Photo }], carol);

  const res = await fetch(`${origin}/photos`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  // Carol is viewer on a-shared → sees p1. p3/p4 owned by dave → excluded.
  assert.deepEqual(rows.map((r) => r.id), ['p1']);
});

test('HTTP list for a stranger returns empty', async (t) => {
  const { Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);

  const origin = await serve(t, db, [{ path: '/photos', entity: Photo }], stranger);

  const res = await fetch(`${origin}/photos`);
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.deepEqual(rows, []);
});

test('HTTP read of a photo in a visible album returns 200', async (t) => {
  const { Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);

  const origin = await serve(t, db, [{ path: '/photos', entity: Photo }], bob);

  const res = await fetch(`${origin}/photos/p1`);
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.id, 'p1');
  assert.equal(row.title, 'Sunset');
});

test('HTTP read of a photo in a forbidden album returns 404', async (t) => {
  const { Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);

  const origin = await serve(t, db, [{ path: '/photos', entity: Photo }], carol);

  // p2 is in a-private (bob's album) → carol has no access
  const res = await fetch(`${origin}/photos/p2`);
  assert.equal(res.status, 404);
});

test('HTTP read returns 404 for orphan photo not owned by the principal', async (t) => {
  const { Photo } = declareAlbumPhoto();
  const db = new DatabaseSync(':memory:');
  seed(db);

  // p3 is orphan (album=null) owned by dave → carol has no access
  const origin = await serve(t, db, [{ path: '/photos', entity: Photo }], carol);

  const res = await fetch(`${origin}/photos/p3`);
  assert.equal(res.status, 404);
});
