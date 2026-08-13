// RED-first contract for the `log` field constructor (Slice A2 'continue all'
// sub-piece 4). doc.mjs declares:
//
//   chat: log({ sender: ref('User'), body: text() })   // append-only; emits :appended:<id>
//
// `log` is an append-only, internally-keyed owned collection of STRUCTURED
// entries — each entry has named sub-fields (here `sender` a User FK + `body`
// text). Like `map`, it is the `store` KIND's owned-collection (an owned
// relation is a field on the entity, not a join table — AGENTS), distinguished
// as `type: 'log'`. Its per-entry shape is the declared `entry` descriptor map.
//
// SCOPE = import-surface only (mirrors map/Inbox import-now-wiring-later): this
// delivers the `log` symbol + a descriptor the entity compiler accepts at load.
// The append mutation, the `:appended:<id>` event handle, and any per-entry
// query are the `store` kind's Phase-2 behavior (its strategy apply/diff already
// fail closed loud Phase-2). A `store`-kind field is correctly NOT whole-value
// comparable in scope (the existing fieldHandle non-value gate throws).

import { log, ref, text, scope, everyone, grant, read, principal } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity, createServer, durableMutationVariant, executeFrameworkDDL, generateDDL } from '../build/internal.mjs';

test('log() returns a frozen store-kind descriptor of type log', () => {
  const descriptor = log({ sender: ref('User'), body: text() });
  assert.equal(descriptor.kind, 'store');
  assert.equal(descriptor.type, 'log');
  assert.ok(Object.isFrozen(descriptor));
});

test('log() carries its per-entry sub-field descriptors', () => {
  const descriptor = log({ sender: ref('User'), body: text() });
  assert.ok(descriptor.entry, 'descriptor exposes the entry shape');
  assert.equal(descriptor.entry.sender.type, 'ref');
  assert.equal(descriptor.entry.sender.target, 'User');
  assert.equal(descriptor.entry.body.type, 'text');
});

test('log() entry shape is frozen (a declared shape is immutable)', () => {
  const descriptor = log({ sender: ref('User'), body: text() });
  assert.ok(Object.isFrozen(descriptor.entry));
});

test('.can(fn) returns a new frozen descriptor carrying the access function', () => {
  const fn = () => grant(read);
  const descriptor = log({ sender: ref('User'), body: text() }).can(fn);
  assert.equal(descriptor.access, fn);
  assert.ok(Object.isFrozen(descriptor));
  assert.equal(descriptor.kind, 'store');
  assert.equal(descriptor.type, 'log');
});

test('a log field compiles into an entity at import without throwing', () => {
  const Doc = entity('DocWithLog', {
    grant: scope(() => everyone()).can(() => grant(read)),
        chat: log({ sender: ref('User'), body: text() }),

  });
  assert.equal(Doc.name, 'DocWithLog');
});

test('a log field is not whole-value comparable in scope (fail closed)', () => {
  const Doc = entity('DocWithLog2', {
    grant: scope(() => everyone()).can(() => grant(read)),
        chat: log({ sender: ref('User'), body: text() }),

  });
  assert.throws(() => Doc.chat.is('x'), /store field and cannot be compared/);
});

// --- B2 UNIT 1: append → committed pipeline event → side-table projection ---
//
// Store mutations promote to committed pipeline ACTIONS (consult #19). An
// `.append(entry)` dispatches `<Entity>.<field>.append` (own actionId, own txn);
// the handler emits `<Entity>.<field>.appended` carrying the minted entry id;
// the projection applies that event to the side-table. Per-entry query returns
// ONLY the owning-entity's entries. `log` has no prior mutation path (unlike
// map's fireMapEffects), so this is purely additive — no dual-path risk.

const DocLogB = entity('DocLogB', {
    chat: log({ sender: text(), body: text() }),

  grant: () => grant(read),
});

function setupLog() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  for (const sql of generateDDL(DocLogB)) db.exec(sql);
  const app = workbench({ db, entities: [DocLogB] });
  return { db, DocLogB: app.entity(DocLogB) };
}

function seedDoc(db, id) {
  db.prepare(`INSERT INTO DocLogB (id) VALUES (?)`).run(id);
}

async function makeServer(db, boundEntity) {
  return createServer({
    db,
    handlers: boundEntity.crudHandlers,
    pipeline: durableMutationVariant({
      projectionConsumers: [boundEntity.projection],
      admission: { beforeProjection: () => true, afterProjection: async () => true },
    }),
    authorize: async () => true,
  });
}

test('A: dispatch .append action emits :appended and writes the side-table row', async () => {
  const { db, DocLogB } = setupLog();
  seedDoc(db, 'r1');
  const server = await makeServer(db, DocLogB);

  const result = await server.dispatch({
    actionId: randomUUID(),
    type: 'DocLogB.chat.append',
    payload: { owner: 'r1', sender: 'u1', body: 'hi' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(result.ok, true);
  const appended = result.events.find((e) => e.type === 'DocLogB.chat.appended');
  assert.ok(appended, 'an :appended event was emitted');
  assert.equal(appended.data.owner, 'r1');
  assert.equal(appended.data.sender, 'u1');
  assert.equal(appended.data.body, 'hi');
  assert.ok(appended.data.id, 'the entry id was minted');

  const row = db.prepare('SELECT DocLogB_id, id, sender, body FROM DocLogB_chat').get();
  assert.equal(row.DocLogB_id, 'r1');
  assert.equal(row.sender, 'u1');
  assert.equal(row.body, 'hi');
});

test('B: per-entry query returns ONLY the owning-entity entries', async () => {
  const { db, DocLogB } = setupLog();
  seedDoc(db, 'r1');
  seedDoc(db, 'r2');
  const server = await makeServer(db, DocLogB);

  const append = (owner, sender, body) =>
    server.dispatch({
      actionId: randomUUID(),
      type: 'DocLogB.chat.append',
      payload: { owner, sender, body },
      principal: principal({ type: 'user', id: sender }),
    });

  await append('r1', 'u1', 'one');
  await append('r1', 'u2', 'two');
  await append('r2', 'u1', 'other');

  const r1 = DocLogB.findById('r1');
  const r2 = DocLogB.findById('r2');
  const r1Entries = await r1.chat.entries();
  const r2Entries = await r2.chat.entries();

  assert.equal(r1Entries.length, 2, 'r1 owns its 2 entries');
  assert.equal(r2Entries.length, 1, 'r2 owns its 1 entry');
  assert.deepEqual(
    r1Entries.map((e) => e.body).sort(),
    ['one', 'two'],
    'r1 entries are isolated to r1 (no leak from r2)',
  );
  assert.equal(r2Entries[0].body, 'other');
});

test('C: handle .append(entry) via hydrate-with-dispatch routes to the action + writes the row', async () => {
  const { db, DocLogB } = setupLog();
  seedDoc(db, 'r1');
  const server = await makeServer(db, DocLogB);

  // hydrate threading the dispatch ref (3rd arg); principal null = trusted query
  // API (mayFieldOp bypassed, same as map-handle.test).
  const doc = DocLogB.hydrate({ id: 'r1' }, null, server.dispatch);
  const id = await doc.chat.append({ sender: 'u1', body: 'via-handle' });

  assert.ok(id, 'the handle returned the minted entry id');
  const row = db.prepare('SELECT sender, body FROM DocLogB_chat WHERE id = ?').get(id);
  assert.equal(row.sender, 'u1');
  assert.equal(row.body, 'via-handle');
});

test('D: dispatch .append with an unknown entry sub-field is rejected (fail closed)', async () => {
  const { db, DocLogB } = setupLog();
  seedDoc(db, 'r1');
  const server = await makeServer(db, DocLogB);

  const result = await server.dispatch({
    actionId: randomUUID(),
    type: 'DocLogB.chat.append',
    payload: { owner: 'r1', sender: 'u1', bogus: 'x' },
    principal: principal({ type: 'user', id: 'u1' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /unknown entry field/);
  // nothing written
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM DocLogB_chat').get().n, 0);
});

test('E: handle .append() with no dispatch ref throws (cannot re-enter dispatch)', async () => {
  const { db, DocLogB } = setupLog();
  seedDoc(db, 'r1');

  // hydrate with NO dispatch ref (the trusted-query, pre-dispatch shape)
  const doc = DocLogB.hydrate({ id: 'r1' }, null);
  await assert.rejects(
    () => doc.chat.append({ sender: 'u1', body: 'x' }),
    /without a dispatch ref/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM DocLogB_chat').get().n, 0);
});
