// Map handle: `.set` upsert + `.toArray()` FK population.
//
// `.set(memberId, { role })` is the canonical map mutation (the binding exemplars
// doc.mjs/gdoc.mjs use it for share routes). It is a committed pipeline ACTION
// (consult #19): `.set` RE-ENTERS dispatch as `<Entity>.<field>.add` (a new
// member) or `.setRole` (a role change — DECISIONLOG #57: idempotent re-share is
// roleChanged, NOT a fresh add so native added does not re-fire); `.remove` dispatches
// `.remove`; the projection applies the `:added`/`:roleChanged`/`:removed` event
// to the side-table. The handle needs a `dispatch` ref (threaded via hydrate); a
// repeat share with the SAME role is a no-op (no dispatch). READS (has/get/
// toArray) stay direct-SQL (trusted-query, DECISIONLOG #41). `.toArray()`
// populates each member through `of: ref('User')` so the share list returns
// hydrated member rows — a hash password stays a {verify} handle, not a raw
// digest leaking into the response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { entity, text, ref, map, hash, grant, read, generateDDL, createServer, durableMutationVariant, executeFrameworkDDL } from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

// A User with a hash password — the security reason toArray must hydrate.
const User = entity('User', {
  fields: { username: text(), password: hash() },
  grant: () => grant(read),
});

const Doc = entity('Doc', {
  fields: {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    collaborators: map(ref('User'), { role: ['viewer', 'editor'] }),
  },
  grant: () => grant(read),
});

async function setup() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(User)) db.exec(sql);
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare("INSERT INTO User (id, username, password) VALUES ('1', 'alice', 'salt:digest')")
    .run();
  db.prepare("INSERT INTO User (id, username, password) VALUES ('2', 'bob', 'salt:digest2')")
    .run();
  db.prepare("INSERT INTO Doc (id, title, owner) VALUES ('10', 'Hello', '1')").run();
  const server = await createServer({
    db,
    handlers: Doc.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc.projection],
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    authorize: async () => true,
  });
  return { db, server };
}

// hydrate threading the dispatch ref (3rd arg); principal null = trusted query
// API (mayFieldOp bypassed — mirrors the log-field handle test).
function docWith(server, id) {
  return Doc.hydrate({ id }, null, server.dispatch);
}

test('.set adds a new member; a role change updates the role (no duplicate row)', async () => {
  const { db, server } = await setup();
  const doc = docWith(server, '10');

  await doc.collaborators.set('2', { role: 'viewer' });
  assert.equal(doc.collaborators.has('2'), true);
  assert.equal(doc.collaborators.get('2').role, 'viewer');

  // Role change → roleChanged UPDATE (idempotent re-share), NOT a fresh add.
  await doc.collaborators.set('2', { role: 'editor' });
  const members = db.prepare('SELECT member_id FROM Doc_collaborators WHERE Doc_id = 10').all();
  assert.equal(members.length, 1, 'no duplicate member row');
  assert.equal(doc.collaborators.get('2').role, 'editor');
});

test('.toArray() populates members as hydrated [member, role] pairs', async () => {
  const { server } = await setup();
  const doc = docWith(server, '10');
  await doc.collaborators.set('2', { role: 'viewer' });

  const rows = await doc.collaborators.toArray();
  assert.equal(rows.length, 1);
  const [member, role] = rows[0];
  assert.equal(role, 'viewer');
  assert.equal(member.id, '2');
  assert.equal(member.username, 'bob');
  // The hash password hydrated to a {verify} handle — the raw digest does NOT
  // leak into the populated member row.
  assert.equal(typeof member.password.verify, 'function');
  assert.equal(member.password.digest, undefined, 'no raw digest on the handle');
});

test('.toArray() with no registered target returns [null, role] pairs (graceful degrade)', async () => {
  // A map whose of-target is an entity that was never registered (e.g. a ref to
  // a name with no compiled entity). toArray degrades rather than throwing.
  const Phantom = entity('Phantom', {
    fields: { tag: text(), members: map(ref('Nonexistent')) },
    grant: () => grant(read),
  });
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Phantom)) db.exec(sql);
  db.prepare("INSERT INTO Phantom (id, tag) VALUES ('1', 'p')").run();
  const server = await createServer({
    db,
    handlers: Phantom.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [Phantom.projection],
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    authorize: async () => true,
  });
  const row = Phantom.hydrate({ id: '1' }, null, server.dispatch);
  await row.members.set('m1');
  const rows = await row.members.toArray();
  assert.deepEqual(rows, [[null, null]]);
});
