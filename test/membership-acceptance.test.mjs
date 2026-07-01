// E2-F: end-to-end acceptance for the unified check registry.
//
// E2-A..E proved the pieces in isolation (compile face, runtime face, the map
// write handle, load-time guards). This file proves the WHOLE exemplar contract
// COMPILES AND RUNS: an entity shaped exactly like todo.mjs / doc.mjs —
//
//   owner: ref('User', { role: 'owner' })
//   collaborators: map(ref('User'), { role: ['viewer', 'editor'] })
//   checks: { collaborator: ({ E, principal }) => E.collaborators.has(principal.id) }
//   grant: scope(({ is }) => anyOf(is.owner(), is.collaborator())).can(...)
//
// and that the TWO authorization layers AGREE for every principal:
//
//   1. the ROW SCOPE — bindReadScope(readScope, principal) → the SQL WHERE that
//      decides which rows a scoped read/list returns (the first default-on gate).
//   2. the RUNTIME .can — mayVerb(entity, 'read', row, principal) → the boolean
//      capability gate (the second default-on gate).
//
// The whole point of the unified registry is that these two are ONE source of
// truth: a principal the SQL filter admits is exactly a principal .can grants,
// for owner AND for collaborator. We assert that agreement directly, against a
// real :memory: db with real membership rows written through the row handle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { setActiveDb } from '../src/db.mjs';
import { randomUUID } from 'node:crypto';
import { bindReadScope } from '../src/scope-sql.mjs';
import { mayVerb } from '../src/row-grant.mjs';
import {
  entity,
  ref,
  text,
  map,
  scope,
  grant,
  read,
  write,
  subscribe,
  deny,
  anyOf,
  never,
  createServer,
  executeFrameworkDDL,
} from '../src/index.mjs';
import { principal } from '../src/principal.mjs';

// Build the exemplar entity once. This mirrors todo.mjs's TodoList shape: an
// owner ref-role, a collaborators map, a declared `collaborator` membership
// check, and the dual-capability grant whose scope is anyOf(owner, collaborator).
function buildTodoListEntity() {
  return entity('TodoList', {
    fields: {
      title: text(),
      owner: ref('User', { role: 'owner', readonly: true }),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    checks: {
      collaborator: ({ TodoList, principal: p }) => TodoList.collaborators.has(p.id),
    },
    grant: () => [
      scope(({ is }) => anyOf(is.owner(), is.collaborator())).can(async ({ is }) => {
        if (await is.owner()) return grant(read, write, subscribe);
        if (await is.collaborator()) return grant(read);
        return deny('not an owner or collaborator');
      }),
    ],
  });
}

function seed() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE TodoList (id TEXT PRIMARY KEY, title TEXT, owner TEXT)');
  db.exec(
    'CREATE TABLE TodoList_collaborators (TodoList_id TEXT, member_id TEXT, role TEXT)',
  );
  return db;
}

async function seedWithServer() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE TodoList (id TEXT PRIMARY KEY, title TEXT, owner TEXT)');
  db.exec(
    'CREATE TABLE TodoList_collaborators (TodoList_id TEXT, member_id TEXT, role TEXT)',
  );
  const TodoList = buildTodoListEntity();
  const server = await createServer({
    db,
    handlers: TodoList.crudHandlers,
    projections: [TodoList.projection],
    authorize: async () => true,
    postHandlerAuthorize: async () => true,
  });
  return { db, TodoList, server };
}

// Seed an owned row the trusted server-side way. `owner` is readonly, so a
// client `create({ owner })` is (correctly) rejected — the HTTP create path
// assigns owner server-side from the principal. A test is trusted server code,
// so it writes the row directly (the established precedent: scope-sql.test.mjs,
// principal.test.mjs both seed owned rows via raw INSERT), then loads it back
// through the entity so the row carries its hydrated map write handle.
function seedOwnedRow(db, TodoList, { title, owner }) {
  const id = randomUUID();
  db
    .prepare('INSERT INTO TodoList (id, title, owner) VALUES (:id, :title, :owner)')
    .run({ id, title, owner });
  return TodoList.getOrFail(id);
}

// Seed an owned row with dispatch-hydrated handle for mutation tests.
function seedOwnedRowWithDispatch({ db, TodoList, server }, { title, owner }) {
  const id = randomUUID();
  db
    .prepare('INSERT INTO TodoList (id, title, owner) VALUES (:id, :title, :owner)')
    .run({ id, title, owner });
  return TodoList.hydrate({ id }, null, server.dispatch);
}

// Helper: which rows does the SCOPE SQL admit for this principal?
function scopedRowIds(db, TodoList, who) {
  const bound = bindReadScope(TodoList.readScope, who);
  const where = bound ? bound.sql : '1=1';
  const params = bound ? bound.params : {};
  return db
    .prepare(`SELECT id FROM TodoList AS t0 WHERE ${where}`)
    .all(params)
    .map((r) => r.id);
}

test('owner is admitted by BOTH the scope filter and the runtime .can', async () => {
  const db = seed();
  const TodoList = buildTodoListEntity();

  const owner = principal({ type: 'user', id: 'owner-1' });
  const row = seedOwnedRow(db, TodoList, { title: 'mine', owner: 'owner-1' });

  // Layer 1: the SQL scope returns the row.
  assert.deepEqual(scopedRowIds(db, TodoList, owner), [row.id]);

  // Layer 2: the runtime .can grants read on that same row.
  assert.equal(await mayVerb(TodoList, 'read', row, owner), true);
});

test('a collaborator (membership row) is admitted by BOTH layers', async (t) => {
  const { db, TodoList, server } = await seedWithServer();
  t.after(() => db.close());

  const row = seedOwnedRowWithDispatch({ db, TodoList, server }, { title: 'shared', owner: 'owner-1' });
  // Add a collaborator THROUGH the row write handle (E2-E), not raw SQL — this
  // also proves the write path and the read/scope paths share one table shape.
  await row.collaborators.set('member-1', { role: 'editor' });

  const member = principal({ type: 'user', id: 'member-1' });

  // Layer 1: the SQL scope admits the row for the collaborator (EXISTS membership).
  assert.deepEqual(scopedRowIds(db, TodoList, member), [row.id]);

  // Layer 2: the runtime .can grants read for the same collaborator.
  assert.equal(await mayVerb(TodoList, 'read', row, member), true);
});

test('a non-member is denied by BOTH layers (the two agree)', async () => {
  const db = seed();
  const TodoList = buildTodoListEntity();

  const row = seedOwnedRow(db, TodoList, { title: 'private', owner: 'owner-1' });
  const stranger = principal({ type: 'user', id: 'stranger-1' });

  // Layer 1: the SQL scope returns NO rows for the stranger.
  assert.deepEqual(scopedRowIds(db, TodoList, stranger), []);

  // Layer 2: the runtime .can denies read on the row.
  assert.equal(await mayVerb(TodoList, 'read', row, stranger), false);
});

test('a photo can inherit album membership through a typed FK in BOTH layers', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  db.exec('CREATE TABLE Album (id TEXT PRIMARY KEY, title TEXT)');
  db.exec('CREATE TABLE Album_collaborators (Album_id TEXT, member_id TEXT, role TEXT)');
  db.exec('CREATE TABLE Photo (id TEXT PRIMARY KEY, title TEXT, album TEXT)');

  entity('Album', {
    fields: {
      title: text(),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    grant: () => [scope(() => never()).can(() => grant(read))],
  });

  const Photo = entity('Photo', {
    fields: {
      title: text(),
      album: ref('Album'),
    },
    checks: {
      albumMember: ({ Photo, principal: p }) => Photo.album.collaborators.has(p.id),
      albumEditor: ({ Photo, principal: p }) =>
        Photo.album.collaborators.get(p.id)?.role === 'editor',
    },
    grant: () => [
      scope(({ is }) => is.albumMember()).can(async ({ is }) => {
        if (await is.albumEditor()) return grant(read, write, subscribe);
        if (await is.albumMember()) return grant(read, subscribe);
        return deny('not an album member');
      }),
    ],
  });

  db.prepare('INSERT INTO Album (id, title) VALUES (:id, :title)').run({ id: 'a1', title: 'Shared' });
  db.prepare('INSERT INTO Photo (id, title, album) VALUES (:id, :title, :album)').run({
    id: 'p1',
    title: 'Lake',
    album: 'a1',
  });
  db.prepare('INSERT INTO Photo (id, title, album) VALUES (:id, :title, :album)').run({
    id: 'p-null',
    title: 'Loose photo',
    album: null,
  });
  db.prepare('INSERT INTO Photo (id, title, album) VALUES (:id, :title, :album)').run({
    id: 'p-dangling',
    title: 'Missing album',
    album: 'missing-album',
  });
  db.prepare('INSERT INTO Album_collaborators (Album_id, member_id, role) VALUES (:owner, :member, :role)').run({
    owner: 'a1',
    member: 'member-1',
    role: 'editor',
  });

  const member = principal({ type: 'user', id: 'member-1' });
  const stranger = principal({ type: 'user', id: 'stranger-1' });
  const row = Photo.getOrFail('p1');
  const nullAlbumRow = Photo.getOrFail('p-null');
  const danglingAlbumRow = Photo.getOrFail('p-dangling');

  assert.deepEqual(scopedPhotoIds(db, Photo, member), ['p1']);
  assert.equal(await mayVerb(Photo, 'read', row, member), true);
  assert.equal(await mayVerb(Photo, 'update', row, member), true);
  assert.equal(await mayVerb(Photo, 'read', nullAlbumRow, member), false);
  assert.equal(await mayVerb(Photo, 'read', danglingAlbumRow, member), false);

  assert.deepEqual(scopedPhotoIds(db, Photo, stranger), []);
  assert.equal(await mayVerb(Photo, 'read', row, stranger), false);
});

function scopedPhotoIds(db, Photo, who) {
  const bound = bindReadScope(Photo.readScope, who);
  return db
    .prepare(`SELECT id FROM Photo AS t0 WHERE ${bound.sql}`)
    .all(bound.params)
    .map((r) => r.id);
}

test('runtime ref traversal resolves target scalar fields through await', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);

  db.exec(`CREATE TABLE Canvas (id TEXT, owner TEXT, title TEXT)`);
  db.exec(`CREATE TABLE Canvas_collaborators (Canvas_id TEXT, member_id TEXT, role TEXT)`);
  db.exec(`CREATE TABLE RasterLayer (id TEXT, canvas TEXT, name TEXT)`);

  const Canvas = entity('Canvas', {
    fields: {
      owner: ref('User', { role: 'owner' }),
      title: text(),
      collaborators: map(ref('User'), { role: ['viewer', 'editor'], default: {} }),
    },
    grant: () => [scope(() => never()).can(() => grant(read))],
  });

  const RasterLayer = entity('RasterLayer', {
    fields: {
      canvas: ref('Canvas'),
      name: text(),
    },
    checks: {
      layerOwner: async ({ entity, principal }) => {
        const c = await entity.canvas;
        return c.owner === principal.id;
      },
      layerEditor: async ({ entity, principal }) => {
        const c = await entity.canvas;
        return c.collaborators.get(principal.id)?.role === 'editor';
      },
    },
    grant: () => [scope(() => never()).can(async ({ is }) => {
      if (await is.layerEditor()) return grant(read, write, subscribe);
      if (await is.layerOwner()) return grant(read, subscribe);
      return deny('no access');
    })],
  });

  db.prepare('INSERT INTO Canvas (id, owner, title) VALUES (:id, :owner, :title)').run({
    id: 'c1', owner: 'owner-1', title: 'My Canvas',
  });
  db.prepare('INSERT INTO Canvas_collaborators (Canvas_id, member_id, role) VALUES (:cid, :mid, :role)').run({
    cid: 'c1', mid: 'editor-1', role: 'editor',
  });
  db.prepare('INSERT INTO RasterLayer (id, canvas, name) VALUES (:id, :canvas, :name)').run({
    id: 'L1', canvas: 'c1', name: 'Layer 1',
  });
  db.prepare('INSERT INTO RasterLayer (id, canvas, name) VALUES (:id, :canvas, :name)').run({
    id: 'L2', canvas: null, name: 'Orphan',
  });

  const owner = principal({ type: 'user', id: 'owner-1' });
  const editor = principal({ type: 'user', id: 'editor-1' });
  const stranger = principal({ type: 'user', id: 'stranger-1' });

  const L1 = RasterLayer.getOrFail('L1');
  const L2 = RasterLayer.getOrFail('L2');

  assert.equal(await mayVerb(RasterLayer, 'read', L1, owner), true);
  assert.equal(await mayVerb(RasterLayer, 'subscribe', L1, owner), true);
  assert.equal(await mayVerb(RasterLayer, 'update', L1, editor), true);
  assert.equal(await mayVerb(RasterLayer, 'read', L1, editor), true);
  assert.equal(await mayVerb(RasterLayer, 'read', L1, stranger), false);

  assert.equal(await mayVerb(RasterLayer, 'read', L2, owner), false);
  assert.equal(await mayVerb(RasterLayer, 'read', L2, editor), false);
});

test('removing a collaborator revokes BOTH layers (scope + .can)', async (t) => {
  const { db, TodoList, server } = await seedWithServer();
  t.after(() => db.close());

  const row = seedOwnedRowWithDispatch({ db, TodoList, server }, { title: 'shared', owner: 'owner-1' });
  await row.collaborators.set('member-1', { role: 'viewer' });

  const member = principal({ type: 'user', id: 'member-1' });
  // Admitted while a member.
  assert.deepEqual(scopedRowIds(db, TodoList, member), [row.id]);
  assert.equal(await mayVerb(TodoList, 'read', row, member), true);

  // Revoke membership through the same handle.
  await row.collaborators.remove('member-1');

  // Now denied by BOTH layers — they revoke together.
  assert.deepEqual(scopedRowIds(db, TodoList, member), []);
  assert.equal(await mayVerb(TodoList, 'read', row, member), false);
});
