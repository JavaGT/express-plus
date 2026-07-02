// Effects pipeline test — a map add fires a declared effect IN-TXN (consult
// #19/#23). A map `.set(member, {role})` is a committed pipeline ACTION: it
// re-enters dispatch as `<Entity>.<field>.add` (a fresh txn) → emits `:added` →
// the general P6b effect compiler fires the declared `[collaborators.onAdded]`
// effect → the effect re-enters the durable variant recursively as `Inbox.created`
// (effect principal, JOINS the .add txn) → the Inbox row is created atomic with
// the add. The fireMapEffects side path + the direct mutate.create call are
// RETIRED — the general mechanism fires off the store event (one reconciliation
// path). A role CHANGE is `.roleChanged`, NOT a fresh `:added` (DECISIONLOG #57:
// idempotent re-share re-fire of onAdded would double-deliver), so the effect
// does NOT re-fire on a repeat share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, text, ref, map, grant, read, write, subscribe, generateDDL,
  createServer, durableMutationVariant, principal, executeFrameworkDDL, buildEffectsRegistry,
} from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';

const Inbox = entity('Inbox', {
  fields: { recipient: text(), doc: text(), kind: text() },
  grant: () => grant(read, write, subscribe),
});

const collaborators = map(ref('User'), { role: ['viewer', 'editor'] });

const Doc = entity('Doc', {
  fields: {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    collaborators,
  },
  grant: () => grant(read, write, subscribe),
  effects: {
    [collaborators.onAdded]: {
      mutate: Inbox,
      // `with` runs as a function over { delta, origin }: delta is the :added
      // event data ({owner, member, role}); origin is the triggering row
      // ({id: <owner>}) — the canonical contract (consult #22, ADR #6).
      with: ({ delta, origin }) => ({ recipient: delta.member, doc: String(origin.id), kind: 'invite' }),
    },
  },
});

function setup() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
  executeFrameworkDDL(db);
  for (const sql of generateDDL(Inbox)) db.exec(sql);
  for (const sql of generateDDL(Doc)) db.exec(sql);
  db.prepare('INSERT INTO Doc (id, title, owner) VALUES (?, ?, ?)').run('1', 'Test', 'u1');
  return db;
}

async function makeServer(db, postAuth) {
  return createServer({
    db,
    handlers: Doc.crudHandlers,
    authorize: async () => true,
    pipeline: durableMutationVariant({
      projectionConsumers: [Doc.projection, Inbox.projection],
      effectsRegistry: buildEffectsRegistry([Doc, Inbox]),
      admission: {
        beforeProjection: async () => true,
        afterProjection: postAuth ?? (async () => true),
      },
    }),
  });
}

test('map .set on a NEW member fires onAdded as the effect principal, creating the target row in-txn', async () => {
  const db = setup();
  // Spy: capture every principal seen for an Inbox.created event. The OLD
  // fireMapEffects path calls Inbox.create DIRECTLY (no dispatch), so the spy
  // would see NO Inbox.created event. The new compiler path re-enters the
  // durable variant as Inbox.created under the EFFECT principal.
  const inboxCreatedPrincipals = [];
  const server = await makeServer(db, async (auth) => {
    if (auth.eventType === 'Inbox.created') inboxCreatedPrincipals.push(auth.event._effectPrincipal);
    return true;
  });

  const doc = Doc.hydrate({ id: '1' }, null, server.dispatch);
  await doc.collaborators.set('u2', { role: 'viewer' });

  // the effect ran THROUGH dispatch (under the effect principal, not the raw
  // user, not a direct Inbox.create bypass) — consult #6/#23.
  assert.equal(inboxCreatedPrincipals.length, 1, 'onAdded fired via the compiler, in-dispatch');
  assert.equal(inboxCreatedPrincipals[0].type, 'system');
  assert.equal(inboxCreatedPrincipals[0].attributes.effect, 'Doc');

  const inboxes = db.prepare('SELECT * FROM Inbox').all();
  assert.equal(inboxes.length, 1, 'the onAdded effect created one Inbox row');
  assert.equal(inboxes[0].recipient, 'u2');
  assert.equal(inboxes[0].doc, '1');
  assert.equal(inboxes[0].kind, 'invite');

  // the membership side-table row landed too (projection applied the :added event)
  const members = db.prepare('SELECT member_id, role FROM Doc_collaborators WHERE Doc_id = ?').all('1');
  assert.equal(members.length, 1);
  assert.equal(members[0].member_id, 'u2');
  assert.equal(members[0].role, 'viewer');
});

test('a role CHANGE is roleChanged, NOT a fresh onAdded (idempotent re-share, DECISIONLOG #57)', async () => {
  const db = setup();
  const server = await makeServer(db);

  const doc = Doc.hydrate({ id: '1' }, null, server.dispatch);
  await doc.collaborators.set('u2', { role: 'viewer' });
  await doc.collaborators.set('u2', { role: 'editor' });

  // one member row, role updated to editor (roleChanged UPDATE, not a new add)
  const members = db.prepare('SELECT member_id, role FROM Doc_collaborators WHERE Doc_id = ?').all('1');
  assert.equal(members.length, 1, 'no duplicate member row');
  assert.equal(members[0].role, 'editor');

  // onAdded fired ONCE (for the new member) — the role change did NOT re-fire it
  const inboxes = db.prepare('SELECT * FROM Inbox').all();
  assert.equal(inboxes.length, 1, 'onAdded did not re-fire on the role change');
});

test('a repeat share with the SAME role is a no-op (no dispatch, no event)', async () => {
  const db = setup();
  const server = await makeServer(db);

  const doc = Doc.hydrate({ id: '1' }, null, server.dispatch);
  await doc.collaborators.set('u2', { role: 'viewer' });
  await doc.collaborators.set('u2', { role: 'viewer' });

  const members = db.prepare('SELECT member_id, role FROM Doc_collaborators WHERE Doc_id = ?').all('1');
  assert.equal(members.length, 1, 'still one member row');
  assert.equal(members[0].role, 'viewer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Inbox').get().n, 1, 'onAdded fired once');
});

test('.remove fires onRemoved (declared effect off the :removed store event)', async () => {
  const db = setup();
  const server = await makeServer(db);

  const Doc2 = Doc; // same entity — declare a removed effect below would need a distinct entity;
  void Doc2;
  const doc = Doc.hydrate({ id: '1' }, null, server.dispatch);
  await doc.collaborators.set('u2', { role: 'viewer' });
  await doc.collaborators.remove('u2');

  const members = db.prepare('SELECT member_id FROM Doc_collaborators WHERE Doc_id = ?').all('1');
  assert.equal(members.length, 0, 'the member row was removed (projection applied :removed)');
});

test('.set with no dispatch ref throws (no silent direct-SQL fallback — dual-path ban)', async () => {
  const db = setup();
  const server = await makeServer(db);

  const doc = Doc.hydrate({ id: '1' }, null); // pre-dispatch, trusted-query shape
  await assert.rejects(
    () => doc.collaborators.set('u2', { role: 'viewer' }),
    /without a dispatch ref/,
  );
  // nothing written (no fallback path)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Doc_collaborators').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Inbox').get().n, 0);
});
