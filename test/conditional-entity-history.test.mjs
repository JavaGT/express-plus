import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { computed, date, deny, durableHistory, entity, everyone, grant, hash, principal, read, scope, subscribe, text, write } from '../src/index.mjs';

const user = principal({ type: 'user', id: 'conditional-user' });
const session = 'conditional-tab';

function declaration(name = 'ConditionalNote') {
  return entity(name, {
    body: text(),
    secret: text(),
    projectId: text({ immutable: true }),
    grant: () => grant(read, write, subscribe),
    history: { update: 'conditional' },
  });
}

function createHistoryDeclaration(name = 'CreatedNote') {
  return entity(name, {
    body: text(),
    projectId: text({ immutable: true }),
    createdAt: date({ default: () => new Date() }),
    grant: () => grant(read, write, subscribe),
    history: { create: 'conditional' },
  });
}

function history(authorized = () => true) {
  return durableHistory({ authorize: authorized });
}

async function appFor(t, { authorized, historyAuthorized, name } = {}) {
  const db = new DatabaseSync(':memory:');
  const Note = declaration(name);
  const app = workbench({ db, entities: [Note], history: history(historyAuthorized) });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  if (authorized) {
    const original = app.kernel;
    // The entity admission remains the authority; this only lets tests revoke the
    // outer action gate without adding an application action path.
    app.kernel = original;
  }
  return { app, db, Note };
}

async function create(app, id = 'note-1') {
  const result = await app.dispatch({
    actionId: `create-${id}`, type: 'ConditionalNote.create',
    payload: { id, body: 'before', secret: 'private-before', projectId: 'p1' }, principal: user,
  });
  assert.equal(result.ok, true);
}

async function update(app, actionId, payload = { id: 'note-1', body: 'after', secret: 'private-after' }) {
  return app.dispatch({ actionId, type: 'ConditionalNote.update', payload, principal: user, scope: 'ConditionalNote:note-1', history: { session } });
}

async function move(app, operation, actionId) {
  const cursor = await app.history.cursor({ scope: 'ConditionalNote:note-1', principal: user, session });
  return app.history[operation]({ scope: 'ConditionalNote:note-1', principal: user, session, actionId, revision: cursor.revision });
}

test('conditional generated update keeps its preimage private, projects once, and supports undo and redo', async (t) => {
  const { app, db } = await appFor(t);
  await create(app);
  const result = await update(app, 'update-1');
  assert.equal(result.ok, true);
  assert.deepEqual(result.events[0].data, { id: 'note-1', body: 'after', secret: 'private-after' });
  assert.equal(JSON.stringify(result.events).includes('private-before'), false);
  assert.deepEqual({ ...db.prepare('SELECT body, secret FROM ConditionalNote WHERE id = ?').get('note-1') }, { body: 'after', secret: 'private-after' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('update-1').count, 1);
  const fact = JSON.parse(db.prepare('SELECT fact FROM _PrivateActionFact WHERE actionId = ?').get('update-1').fact);
  assert.equal(fact.before.secret, 'private-before');
  assert.equal(fact.after.secret, 'private-after');

  assert.equal((await move(app, 'undo', 'undo-1')).ok, true);
  assert.deepEqual({ ...db.prepare('SELECT body, secret FROM ConditionalNote WHERE id = ?').get('note-1') }, { body: 'before', secret: 'private-before' });
  assert.equal((await move(app, 'redo', 'redo-1')).ok, true);
  assert.deepEqual({ ...db.prepare('SELECT body, secret FROM ConditionalNote WHERE id = ?').get('note-1') }, { body: 'after', secret: 'private-after' });
});

test('conditional projection CAS conflicts atomically without appending a stale commit', async (t) => {
  const { app, db } = await appFor(t);
  await create(app);
  const first = await update(app, 'update-1');
  assert.equal(first.ok, true);
  db.prepare('UPDATE ConditionalNote SET body = ? WHERE id = ?').run('concurrent', 'note-1');
  const stale = await move(app, 'undo', 'stale-history');
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('stale-history').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = ?').get('stale-history').count, 0);
  assert.equal(db.prepare('SELECT body FROM ConditionalNote WHERE id = ?').get('note-1').body, 'concurrent');
});

test('conditional history fails closed for stale state, erased facts, deleted rows, and revoked authorization', async (t) => {
  let historyAllowed = true;
  const { app, db } = await appFor(t, { historyAuthorized: () => historyAllowed });
  await create(app);
  assert.equal((await update(app, 'update-1')).ok, true);
  db.prepare('UPDATE ConditionalNote SET body = ? WHERE id = ?').run('newer', 'note-1');
  const stale = await move(app, 'undo', 'undo-stale');
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'conflict');
  assert.equal(db.prepare('SELECT body FROM ConditionalNote WHERE id = ?').get('note-1').body, 'newer');

  db.prepare('DELETE FROM _PrivateActionFact WHERE actionId = ?').run('update-1');
  await assert.rejects(() => move(app, 'undo', 'undo-erased'), /missing or erased/);
  assert.equal(db.prepare('SELECT body FROM ConditionalNote WHERE id = ?').get('note-1').body, 'newer');
  historyAllowed = false;
  await assert.rejects(() => move(app, 'undo', 'undo-revoked'), /forbidden/);
  historyAllowed = true;
  app.entities.get('ConditionalNote').grant = () => [scope(() => everyone()).can(() => deny('revoked'))];
  const denied = await update(app, 'update-revoked');
  assert.equal(denied.ok, false);
  assert.equal(denied.failure.category, 'denied');
  const deniedMissing = await app.dispatch({ actionId: 'update-denied-missing', type: 'ConditionalNote.update', payload: { id: 'missing', body: 'x' }, principal: user, scope: 'ConditionalNote:missing' });
  assert.equal(deniedMissing.ok, false);
  assert.equal(deniedMissing.failure.category, 'denied');
  app.entities.get('ConditionalNote').grant = () => grant(read, write, subscribe);
  db.prepare('DELETE FROM ConditionalNote WHERE id = ?').run('note-1');
  const missing = await update(app, 'update-missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.failure.category, 'denied');
});

test('conditional declaration is closed and ordinary generated updates stay patch-only', async (t) => {
  assert.throws(() => entity('BadConditionalHistory', { body: text(), history: { update: 'anything' } }), /history must/);
  assert.throws(() => entity('BadConditionalHistoryKeys', { body: text(), history: { remove: 'conditional' } }), /history must/);
  assert.throws(() => entity('ConditionalCreateHash', { password: hash(), history: { create: 'conditional' } }), /replayable stored value/);
  assert.throws(() => entity('ConditionalComputed', { body: text(), summary: computed.stored({ compute: () => 'summary' }), history: { update: 'conditional' } }), /does not support stored computed/);
  const db = new DatabaseSync(':memory:');
  const Plain = entity('PlainNote', { body: text(), grant: () => grant(read, write, subscribe) });
  const app = workbench({ db, entities: [Plain], history: history() });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  await app.dispatch({ actionId: 'plain-create', type: 'PlainNote.create', payload: { id: 'plain-1', body: 'before' }, principal: user });
  const result = await app.dispatch({ actionId: 'plain-update', type: 'PlainNote.update', payload: { id: 'plain-1', body: 'after' }, principal: user, scope: 'PlainNote:plain-1', history: { session } });
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact WHERE actionId = ?').get('plain-update').count, 0);
  assert.equal((await app.history.cursor({ scope: 'PlainNote:plain-1', principal: user, session })).undo, 0);
});

test('conditional generated create restores an exact private row and excludes ordinary removal from history', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Created = createHistoryDeclaration();
  const app = workbench({ db, entities: [Created], history: history() });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  const create = await app.dispatch({
    actionId: 'created-create', type: 'CreatedNote.create',
    payload: { id: 'created-1', body: 'private body', projectId: 'p1' }, principal: user,
    scope: 'CreatedNote:created-1', history: { session },
  });
  assert.equal(create.ok, true);
  assert.equal(JSON.stringify(create.events).includes('private body'), true);
  const fact = JSON.parse(db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'created-create'").get().fact);
  assert.equal(fact.before, null);
  assert.equal(fact.after.body, 'private body');
  assert.equal(typeof fact.after.createdAt, 'number');
  assert.equal((await app.history.cursor({ scope: 'CreatedNote:created-1', principal: user, session })).undo, 1);

  const undo = await app.history.undo({ scope: 'CreatedNote:created-1', principal: user, session, actionId: 'created-undo', revision: (await app.history.cursor({ scope: 'CreatedNote:created-1', principal: user, session })).revision });
  assert.equal(undo.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM CreatedNote WHERE id = ?').get('created-1').count, 0);
  const redo = await app.history.redo({ scope: 'CreatedNote:created-1', principal: user, session, actionId: 'created-redo', revision: (await app.history.cursor({ scope: 'CreatedNote:created-1', principal: user, session })).revision });
  assert.equal(redo.ok, true);
  assert.deepEqual({ ...db.prepare('SELECT * FROM CreatedNote WHERE id = ?').get('created-1') }, fact.after);

  const remove = await app.dispatch({ actionId: 'created-remove', type: 'CreatedNote.remove', payload: { id: 'created-1' }, principal: user, scope: 'CreatedNote:created-1', history: { session } });
  assert.equal(remove.ok, true);
  assert.equal((await app.history.cursor({ scope: 'CreatedNote:created-1', principal: user, session })).undo, 1);
});

test('conditional generated create rolls stale lifecycle history back and fails closed for erased facts', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Created = createHistoryDeclaration('CreatedConflict');
  const app = workbench({ db, entities: [Created], history: history() });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  await app.dispatch({ actionId: 'conflict-create', type: 'CreatedConflict.create', payload: { id: 'created-1', body: 'before', projectId: 'p1' }, principal: user, scope: 'CreatedConflict:created-1', history: { session } });
  db.prepare('UPDATE CreatedConflict SET body = ? WHERE id = ?').run('changed', 'created-1');
  const cursor = await app.history.cursor({ scope: 'CreatedConflict:created-1', principal: user, session });
  const stale = await app.history.undo({ scope: 'CreatedConflict:created-1', principal: user, session, actionId: 'conflict-undo', revision: cursor.revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'conflict');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'conflict-undo'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = 'conflict-undo'").get().count, 0);
  db.prepare("DELETE FROM _PrivateActionFact WHERE actionId = 'conflict-create'").run();
  const erasedCursor = await app.history.cursor({ scope: 'CreatedConflict:created-1', principal: user, session });
  await assert.rejects(() => app.history.undo({ scope: 'CreatedConflict:created-1', principal: user, session, actionId: 'erased-undo', revision: erasedCursor.revision }), /missing or erased/);
});

test('conditional generated create reauthorizes the current row before private fact access', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Created = createHistoryDeclaration('CreatedDenied');
  const app = workbench({ db, entities: [Created], history: history() });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  await app.dispatch({ actionId: 'denied-create', type: 'CreatedDenied.create', payload: { id: 'created-1', body: 'secret', projectId: 'p1' }, principal: user, scope: 'CreatedDenied:created-1', history: { session } });
  app.entities.get('CreatedDenied').grant = () => [scope(() => everyone()).can(() => deny('revoked'))];
  const cursor = await app.history.cursor({ scope: 'CreatedDenied:created-1', principal: user, session });
  await assert.rejects(() => app.history.undo({ scope: 'CreatedDenied:created-1', principal: user, session, actionId: 'denied-undo', revision: cursor.revision }), /forbidden/);
  assert.equal(db.prepare('SELECT body FROM CreatedDenied WHERE id = ?').get('created-1').body, 'secret');
});

test('conditional generated create records projected defaults for omitted optional fields', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Created = entity('CreatedOptional', {
    body: text({ optional: true }),
    projectId: text({ immutable: true }),
    grant: () => grant(read, write, subscribe),
    history: { create: 'conditional' },
  });
  const app = workbench({ db, entities: [Created], history: history() });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();
  const create = await app.dispatch({ actionId: 'optional-create', type: 'CreatedOptional.create', payload: { id: 'created-1', projectId: 'p1' }, principal: user, scope: 'CreatedOptional:created-1', history: { session } });
  assert.equal(create.ok, true);
  const fact = JSON.parse(db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'optional-create'").get().fact);
  assert.equal(fact.after.body, null);
});
