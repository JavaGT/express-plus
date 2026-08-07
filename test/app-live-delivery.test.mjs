import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotatedTextCreateAction, annotatedTextRetireAction, annotation,
  deny, entity, everyone, exportAnnotatedText, inherit,
  admin, grant, keyed, measurement, object, read, ref, registerAnnotatedTextContract, scope, select, snapshot, subscribe, text, write, principalSnapshot, projectionSource,
} from '../src/index.mjs';
import { executeDDL, executeFrameworkDDL, registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
import { defineSqliteSchema } from '../src/sqlite-schema.mjs';
import { createAnnotatedTextHttpSession, createLiveDeliveryHttpSession } from '../public/workbench-client.mjs';

const user = { type: 'user', id: 'u1', attributes: {} };
registerAnnotatedTextContract('httpDeliveryMeasurement', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('httpDeliveryMeasurement', Object.freeze({
  version: 1, validate() {}, edit() {}, partition() {}, combine() {},
}));

function project() {
  return entity('Project', {
    name: text(),
    grant: () => grant(read, subscribe),
  });
}

function projectAction() {
  return {
    type: 'project.write',
    authorize: ({ principal, payload }) => principal.id === 'u1' && payload.authorized === true,
    handler: ({ payload }) => ({
      events: [{
        type: payload.exists ? 'Project.updated' : 'Project.created',
        scope: `Project:${payload.id}`,
        data: { id: payload.id, name: payload.name },
      }],
      privateFact: { before: payload.before ?? payload, after: payload },
    }),
    projections: [{
      eventTypes: ['Project.created', 'Project.updated'],
      apply(event, tx) {
        tx.prepare(`INSERT INTO Project (id, name) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name`).run(event.data.id, event.data.name);
      },
    }],
  };
}

async function nextSseJson(reader) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) text += decoder.decode((await reader.read()).value, { stream: true });
  const frame = text.split('\n\n').find((entry) => entry.startsWith('data: '));
  return JSON.parse(frame.slice('data: '.length));
}

test('application-integrated live delivery owns registered action wakeup and recipient authority', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()], actions: [projectAction()] });
  app.attachLiveDelivery({ principalOf: () => user, maxSubscriptions: 1 });
  app.listen(0);
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });

  const created = await app.dispatch({
    actionId: 'create-project', type: 'project.write', scope: 'Project:p1',
    payload: { id: 'p1', name: 'before', authorized: true }, principal: user,
  });
  assert.equal(created.ok, true);

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const streamController = new AbortController();
  const response = await fetch(`${origin}/live-delivery/events?scope=Project%3Ap1&after=1`, { signal: streamController.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read(); // package-owned connection comment

  const denied = await app.dispatch({
    actionId: 'denied-project-write', type: 'project.write', scope: 'Project:p1',
    payload: { id: 'p1', name: 'never', exists: true }, principal: { ...user, id: 'u2' },
  });
  assert.equal(denied.ok, false, 'registered-action authorization remains kernel-owned');

  const updated = await app.dispatch({
    actionId: 'update-project', type: 'project.write', scope: 'Project:p1',
    payload: { id: 'p1', name: 'after', exists: true, authorized: true }, principal: user,
  });
  assert.equal(updated.ok, true);
  const [envelope] = await Promise.race([
    nextSseJson(reader),
    new Promise((_, reject) => setTimeout(() => reject(new Error('live delivery timed out')), 1000)),
  ]);
  assert.equal(envelope.event.type, 'Project.updated');
  assert.deepEqual(envelope.event.data, { id: 'p1', name: 'after' });
  assert.equal(JSON.stringify(envelope).includes('update-project'), false);
  await reader.cancel();
  streamController.abort();
});

test('application live delivery rejects duplicate and late attachment', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()] });
  app.attachLiveDelivery({ principalOf: () => user });
  assert.throws(() => app.attachLiveDelivery({ principalOf: () => user }), /already attached/);
  await app.start();
  assert.throws(() => app.attachLiveDelivery({ principalOf: () => user }), /before application startup/);
  await app.shutdown();
  db.close();
});

test('application live delivery validates aggregate declarations without exposing kernel callbacks', () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()] });
  assert.throws(
    () => app.attachLiveDelivery({ principalOf: () => user, snapshots: [{}] }),
    /snapshots accepts only/,
  );
  assert.equal(app._applicationLiveDelivery, undefined);
  db.close();
});

test('application live delivery serves and wakes a principal snapshot through HTTP', async (t) => {
  const db = new DatabaseSync(':memory:');
  const schema = defineSqliteSchema({
    name: 'principal-hub',
    tables: [{ name: 'HubNotice', columns: [
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'recipientId', type: 'text', notNull: true },
      { name: 'body', type: 'text', notNull: true },
    ] }],
  });
  const notices = projectionSource(schema, 'HubNotice');
  const hub = principalSnapshot('user-hub', {
    principalType: 'user',
    output: principalSnapshot.object({
      notices: principalSnapshot.many(notices, {
        via: notices.field.recipientId,
        key: notices.field.id,
        select: principalSnapshot.select(notices.field.body),
      }),
    }),
  });
  const app = workbench({ db, schema });
  app.attachLiveDelivery({ principalOf: () => user, principalSnapshots: [hub] });
  app.listen(0);
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO HubNotice (id, recipientId, body) VALUES (?, ?, ?)').run('n1', 'u1', 'hello');
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const scopeKey = encodeURIComponent('PrincipalSnapshot:user-hub/user/u1');
  const snapshotResult = await fetch(`${origin}/live-delivery/bootstrap?scope=${scopeKey}&mode=snapshot`).then((response) => response.json());
  assert.deepEqual(snapshotResult, { kind: 'snapshot', snapshot: { notices: [{ body: 'hello', id: 'n1' }] }, cursor: 0 });
  const controller = new AbortController();
  const stream = await fetch(`${origin}/live-delivery/events?scope=${scopeKey}&after=0`, { signal: controller.signal });
  const reader = stream.body.getReader();
  await reader.read();
  await app.principalSnapshots.transaction((tx) => {
    tx.db.prepare('UPDATE HubNotice SET body = ? WHERE id = ?').run('updated', 'n1');
    tx.invalidate(hub, { type: 'user', id: 'u1' });
  });
  assert.deepEqual(await nextSseJson(reader), [{ type: 'resync', seq: 1, reason: 'recipient-snapshot-required' }]);
  await reader.cancel();
  controller.abort();
});

test('application live delivery accepts its declared snapshot identity and rejects foreign same-name anchors', async (t) => {
  const Project = entity('OwnedSnapshotProject', {
    name: text(),
    ownerId: text(),
    checks: { owner: ({ entity: row, principal }) => row.ownerId === principal.id },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, subscribe) : deny('not owner')
    ))],
  });
  const declaration = snapshot(Project, { output: object({ name: select(Project.field.name) }) });
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Project] });

  app.attachLiveDelivery({
    principalOf: (request) => ({ type: 'user', id: request.headers['x-user'] ?? 'u1', attributes: {} }),
    snapshots: [declaration],
  });
  app.listen(0);
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  app.entity(Project).insert({ id: 'p1', name: 'Visible', ownerId: 'u1' });

  const endpoint = `http://127.0.0.1:${app.httpServer.address().port}/live-delivery/bootstrap?scope=OwnedSnapshotProject%3Ap1&mode=snapshot`;
  const allowed = await fetch(endpoint, { headers: { 'x-user': 'u1' } }).then((response) => response.json());
  assert.deepEqual(allowed.snapshot, { id: 'p1', name: 'Visible' }, 'bootstrap remains recipient-projected');
  assert.equal((await fetch(endpoint, { headers: { 'x-user': 'u2' } }).then((response) => response.json())).kind, 'revoked');

  const foreign = entity('OwnedSnapshotProject', { name: text(), ownerId: text(), grant: () => grant(read, subscribe) });
  const foreignApp = workbench({ db: new DatabaseSync(':memory:'), entities: [Project] });
  assert.throws(
    () => foreignApp.attachLiveDelivery({ principalOf: () => user, snapshots: [snapshot(foreign, { output: object({ name: select(foreign.field.name) }) })] }),
    /already registered with a different declaration|must be registered/,
  );
  foreignApp.db.close();
});

test('package action transport dispatches registered actions, wakes delivery, and returns opaque receipt fences', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()], actions: [projectAction()] });
  app.attachLiveDelivery({ principalOf: () => user });
  app.listen(0, { principalOf: () => user });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  await app.dispatch({ actionId: 'seed-project', type: 'project.write', scope: 'Project:p1', payload: { id: 'p1', name: 'before', authorized: true }, principal: user });
  const stream = await fetch(`${origin}/live-delivery/events?scope=Project%3Ap1&after=1`);
  const reader = stream.body.getReader();
  await reader.read();

  const request = { actionId: 'http-update', scope: 'Project:p1', type: 'project.write', payload: { id: 'p1', name: 'one', exists: true, authorized: true }, clientId: 'tab-a' };
  const response = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  const receipt = await response.json();
  assert.deepEqual(receipt, { ok: true, actionId: 'http-update', confirmedThrough: 2 });
  const [envelope] = await nextSseJson(reader);
  assert.equal(envelope.event.type, 'Project.updated');
  assert.equal(JSON.stringify(envelope).includes('http-update'), false);

  const duplicate = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  }).then((res) => res.json());
  assert.deepEqual(duplicate, receipt, 'durable action ids return the canonical receipt fence');
  await reader.cancel();
});

test('package action transport rejects unauthenticated, unauthorized, malformed, and non-registered requests', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()], actions: [projectAction()] });
  app.listen(0, { principalOf: (request) => request.headers['x-user'] ? user : { type: 'anonymous', id: 'anonymous' } });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const endpoint = `http://127.0.0.1:${app.httpServer.address().port}/workbench/actions`;
  const post = (body, headers = {}) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ actionId: 'a', scope: 'Project:p1', type: 'project.write', payload: {}, principal: user })).status, 400);
  assert.equal((await post({ actionId: 'a', scope: 'Project:p1', type: 'project.write', payload: {} })).status, 403);
  assert.equal((await post({ actionId: 'a', scope: 'Project:p1', type: 'Project.create', payload: {} }, { 'x-user': 'u1' })).status, 404);
  assert.equal((await post({ actionId: 'a', scope: 'Project:p1', type: 'project.write', payload: { id: 'p1', authorized: false } }, { 'x-user': 'u1' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'GET' })).status, 405);
});

test('package batch transport admits only registered actions and returns one durable receipt', async (t) => {
  const db = new DatabaseSync(':memory:');
  const batchAction = {
    ...projectAction(),
    type: 'project.batchWrite',
    handler: ({ payload }) => [{
      type: 'Project.created', scope: `Project:${payload.id}`, data: { id: payload.id, name: payload.name },
    }],
  };
  const app = workbench({ db, entities: [project()], actions: [batchAction] });
  app.listen(0, { principalOf: () => user });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const endpoint = `http://127.0.0.1:${app.httpServer.address().port}/workbench/actions/batch`;
  const request = {
    actionId: 'http-batch', scope: 'Project:p1', clientId: 'tab-a', actions: [{
      type: 'project.batchWrite', payload: { id: 'p1', name: 'one', authorized: true },
    }],
  };
  const post = (body) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const first = await post(request);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, actionId: 'http-batch', confirmedThrough: 1 });
  const retry = await post(request);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { ok: true, actionId: 'http-batch', confirmedThrough: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 1);
  assert.equal((await post({ ...request, actions: [{ type: 'project.batchWrite', payload: { id: 'p1', name: 'two', authorized: true } }] })).status, 409);
  assert.equal((await post({ ...request, actionId: 'generated', actions: [{ type: 'Project.create', payload: {} }] })).status, 404);
  assert.equal((await post({ ...request, actionId: 'forged', cursor: 1 })).status, 400);
});

test('explicit applicationHttpActions admits generated CRUD on project shell scope with parent-scoped events', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
    CREATE TABLE User (id TEXT PRIMARY KEY);
    INSERT INTO User VALUES ('u1');
    INSERT INTO Project VALUES ('p1', 'shell', 'u1'), ('p2', 'other', 'u2');
  `);
  const Project = entity('Project', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not project owner'))],
  });
  const Codebook = entity('Codebook', {
    projectId: ref(Project, { immutable: true }),
    name: text(),
    grant: inherit(Project, { via: 'projectId' }),
    applicationHttpActions: ['create', 'update', 'remove'],
  });
  const Note = entity('Note', {
    projectId: ref(Project, { immutable: true }),
    title: text(),
    grant: inherit(Project, { via: 'projectId' }),
  });
  executeDDL(Codebook, db);
  executeDDL(Note, db);
  const app = workbench({ db, entities: [Project, Codebook, Note] });
  app.attachLiveDelivery({
    principalOf: () => user,
    snapshots: [snapshot(Project, { output: object({ name: select(Project.field.name) }) })],
  });
  app.listen(0, { principalOf: () => user });
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const before = db.prepare("SELECT seq FROM _Log WHERE scope = 'Project:p1' ORDER BY seq DESC LIMIT 1").get()?.seq ?? 0;
  const endpoint = `${origin}/workbench/actions`;
  const post = (body) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const created = await post({
    actionId: 'book-create', scope: 'Project:p1', clientId: 'tab-a',
    type: 'Codebook.create', payload: { id: 'book-1', projectId: 'p1', name: 'Interviews' },
  });
  assert.equal(created.status, 200);
  const receipt = await created.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.actionId, 'book-create');
  assert.ok(receipt.confirmedThrough > before);
  assert.equal(db.prepare('SELECT name FROM Codebook WHERE id = ?').get('book-1')?.name, 'Interviews');
  assert.equal(
    db.prepare("SELECT scope FROM _Log WHERE actionId = 'book-create'").get()?.scope,
    'Project:p1',
  );

  const updated = await post({
    actionId: 'book-update', scope: 'Project:p1', clientId: 'tab-a',
    type: 'Codebook.update', payload: { id: 'book-1', name: 'Fieldwork' },
  });
  assert.equal(updated.status, 200);
  assert.equal(db.prepare('SELECT name FROM Codebook WHERE id = ?').get('book-1')?.name, 'Fieldwork');

  assert.equal((await post({
    actionId: 'note-create', scope: 'Project:p1',
    type: 'Note.create', payload: { id: 'note-1', projectId: 'p1', title: 'private' },
  })).status, 404, 'generated CRUD without applicationHttpActions stays unavailable');

  assert.equal((await post({
    actionId: 'book-spoof', scope: 'Project:p2',
    type: 'Codebook.create', payload: { id: 'book-2', projectId: 'p1', name: 'spoof' },
  })).status, 404, 'mismatched project shell scope is fail-closed');

  assert.equal((await post({
    actionId: 'book-cross', scope: 'Project:p1',
    type: 'Codebook.update', payload: { id: 'book-1', projectId: 'p2', name: 'cross' },
  })).status, 404, 'payload owner spoof on update is fail-closed');

  const batch = await fetch(`${origin}/workbench/actions/batch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      actionId: 'book-batch', scope: 'Project:p1', clientId: 'tab-a',
      actions: [{ type: 'Codebook.update', payload: { id: 'book-1', name: 'Batch' } }],
    }),
  });
  assert.equal(batch.status, 200);
  assert.equal(db.prepare('SELECT name FROM Codebook WHERE id = ?').get('book-1')?.name, 'Batch');

  const removed = await post({
    actionId: 'book-remove', scope: 'Project:p1', clientId: 'tab-a',
    type: 'Codebook.remove', payload: { id: 'book-1' },
  });
  assert.equal(removed.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Codebook').get().count, 0);
});

test('applicationHttpActions rejects unknown verbs and duplicates at compile time', () => {
  assert.throws(
    () => entity('BadHttp', { name: text(), grant: () => grant(read), applicationHttpActions: ['create', 'create'] }),
    /more than once/,
  );
  assert.throws(
    () => entity('BadHttpVerb', { name: text(), grant: () => grant(read), applicationHttpActions: ['list'] }),
    /unknown verb/,
  );
});

test('declared annotated text owns generated HTTP admission and package delivery recovery', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES (\'p1\', \'u1\'), (\'p2\', \'u2\'); INSERT INTO User VALUES (\'u1\'); INSERT INTO User VALUES (\'u2\')');
  const Document = entity('HttpAnnotatedDocument', {
    project: ref('Project'), owner: ref('User', { role: 'owner' }),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')], measurements: [measurement('words', { extension: 'httpDeliveryMeasurement' })] }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Document, db);
  let principal = user;
  const principalOf = (request) => request.headers['x-anonymous'] ? { type: 'anonymous', id: 'anonymous' } : principal;
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not project owner'))],
  });
  const history = (await import('../src/index.mjs')).durableHistory({ authorize: () => true });
  const app = workbench({ db, entities: [Project, Document], history });
  app.attachLiveDelivery({ principalOf });
  app.listen(0, { principalOf });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const post = (action, headers = {}) => fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ actionId: action.payload?.version ? `op-${action.payload.mutationId}` : `action-${action.type}-${action.payload?.id ?? ''}`, ...action, clientId: 'tab-a' }),
  });

  const create = annotatedTextCreateAction(Document, Document.body, { id: 'd1', projectId: 'p1', ownerId: 'u1' });
  assert.equal((await post(create, { 'x-anonymous': '1' })).status, 403);
  assert.equal((await post(create)).status, 200);
  const spoofedProject = annotatedTextCreateAction(Document, Document.body, { id: 'forbidden-project', projectId: 'p2', ownerId: 'u1' });
  assert.equal((await post(spoofedProject)).status, 403, 'declared project ownership, not caller-supplied document ownership, authorizes create');
  assert.equal(db.prepare('SELECT 1 FROM HttpAnnotatedDocument WHERE id = ?').get('forbidden-project'), undefined);
  const initialBlockId = 'b';

  const sources = [];
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`, context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `typed-${++actionNumber}`,
    eventSourceFactory: () => { const source = { close() {}, onmessage: null, onerror: null }; sources.push(source); return source; },
  });
  await session.ready.catch((error) => { error.message = `first document ready: ${error.message}`; throw error; });
  assert.equal(session.document.blocks[0].id, initialBlockId);
  const inserted = await session.insert({ mutationId: 'insert-1', at: { blockId: initialBlockId, offset: 0, affinity: 'right' }, text: 'hello' });
  assert.equal(inserted.ok, true);
  assert.equal((await inserted.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.blocks[0].text, 'hello', 'committed receipt recovers through recipient snapshot ingest');
  assert.throws(
    () => session.split({ mutationId: 'split-1', at: { blockId: initialBlockId, offset: 2, affinity: 'right' } }),
    /block-era command is not supported/,
  );
  const splitInsert = await session.insert({ mutationId: 'split-insert', at: { blockId: initialBlockId, offset: 2, affinity: 'right' }, text: ' there' });
  assert.equal(splitInsert.ok, true);
  assert.equal((await splitInsert.settlement.wait()).status, 'reconciled');
  // The fake SSE source delivers NO fold envelope, so the settlement can only
  // converge by fetching a recipient snapshot: the EXACT canonical text proves
  // the committed edit recovered through snapshot ingest — not merely the
  // optimistic splice being retained.
  assert.equal(session.document.blocks.length, 1);
  assert.equal(session.document.blocks[0].text, 'he therello');
  assert.equal('dispatch' in session, false);

  assert.equal((await post(annotatedTextCreateAction(Document, Document.body, {
    id: 'd2', projectId: 'p1', ownerId: 'u1',
  }))).status, 200);
  const second = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`, context: { entity: Document, field: Document.body, documentId: 'd2' },
    historySession: 'tab-a', createActionId: () => `second-${++actionNumber}`,
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await second.ready.catch((error) => { error.message = `second document ready: ${error.message}`; throw error; });
  const secondBlockId = second.document.blocks[0].id;
  const secondInsert = await second.insert({
    mutationId: 'second-insert', at: { blockId: secondBlockId, offset: 0, affinity: 'right' }, text: 'second',
  });
  assert.equal((await secondInsert.settlement.wait()).status, 'reconciled');
  const undoneSecond = await second.history.undo();
  assert.equal(undoneSecond.ok, true);
  assert.equal((await undoneSecond.settlement.wait()).status, 'reconciled');
  assert.equal(second.document.blocks[0].text, '');
  assert.equal(session.document.blocks.map((block) => block.text).join(''), 'he therello', 'same-project document history is isolated');
  second.close();

  const exportRequest = { app, entity: Document, field: Document.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' } };
  const exported = await exportAnnotatedText({ ...exportRequest, principal });
  assert.equal(exported.text, 'he therello');
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { ...user, id: 'u2' } }), /owning scope admin authorization failed/);

  const committedBeforeForbidden = db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get('Project:p1').count;
  for (const forbidden of [
    { type: 'HttpAnnotatedDocument.update', scope: 'Project:p1', payload: { id: 'd1', project: 'p1' } },
    { type: 'HttpAnnotatedDocument.body.apply', scope: 'Project:p1', payload: { id: 'd1', operation: {} } },
    { type: 'HttpAnnotatedDocument.body.operation', scope: 'HttpAnnotatedDocument:other', payload: { id: 'd1', version: 99 } },
    { type: 'HttpAnnotatedDocument.body.operation', scope: 'Project:p1', payload: { version: 1, id: 'd1', expected: { structuralRevision: 2, frontier: [] }, operation: { kind: 'text.apply', operation: ['workbench.text', 1, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1], 1, [], ['insert', ['root'], 'raw']] } } },
  ]) assert.equal((await post(forbidden)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get('Project:p1').count, committedBeforeForbidden);

  principal = { ...user, id: 'u2' };
  const revokedEdit = await session.insert({ mutationId: 'revoked', at: { blockId: initialBlockId, offset: 0, affinity: 'right' }, text: 'x' });
  assert.equal(revokedEdit.ok, false);
  principal = user;
  const retire = annotatedTextRetireAction(Document, 'd1');
  assert.equal((await post({ ...retire, scope: 'Project:p2' })).status, 404, 'retirement rejects a supplied scope other than the document owner');
  assert.equal((await post({ ...retire, scope: 'Project:p1' })).status, 200, 'project-shell actions may supply the matching document owner scope');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM HttpAnnotatedDocument_body_retired WHERE document_id = ?').get('d1').count, 1);
  session.close();
});

test('annotated text text-insert is delivered as a fold envelope over the live SSE stream (no snapshot)', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES (\'p1\', \'u1\'); INSERT INTO User VALUES (\'u1\'); INSERT INTO User VALUES (\'u2\')');
  const Document = entity('FoldDeliverDoc', {
    project: ref('Project'), owner: ref('User', { role: 'owner' }),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Document, db);
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not project owner'))],
  });
  const app = workbench({ db, entities: [Project, Document], history: (await import('../src/index.mjs')).durableHistory({ authorize: () => true }) });
  app.attachLiveDelivery({ principalOf: () => user });
  app.listen(0, { principalOf: () => user });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const create = annotatedTextCreateAction(Document, Document.body, { id: 'd1', projectId: 'p1', ownerId: 'u1' });
  const createRes = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'create-fold', type: create.type, payload: create.payload, scope: 'Project:p1', clientId: 'tab-a' }),
  });
  assert.equal(createRes.status, 200);
  const initialBlockId = 'b';

  // Open a real SSE events stream as the owner, with document identity so the
  // delivery can resolve the annotated-text document and emit a fold envelope.
  const clientNonce = 'x'.repeat(43);
  const streamController = new AbortController();
  const eventsUrl = `${origin}/live-delivery/events?entity=FoldDeliverDoc&field=body&documentId=d1&authoringClient=${clientNonce}&after=1`;
  const streamResponse = await fetch(eventsUrl, { signal: streamController.signal });
  assert.equal(streamResponse.status, 200);
  const reader = streamResponse.body.getReader();
  await reader.read(); // package-owned connection comment

  // Dispatch a text insert through the authoring transport.
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`, context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'typed-fold',
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready.catch((error) => { error.message = `fold-ready: ${error.message}`; throw error; });
  const inserted = await session.insert({ mutationId: 'fold-insert', at: { blockId: initialBlockId, offset: 0, affinity: 'right' }, text: 'hello' });
  assert.equal(inserted.ok, true);
  await inserted.settlement.wait();

  const [envelope] = await Promise.race([
    nextSseJson(reader),
    new Promise((_, reject) => setTimeout(() => reject(new Error('fold delivery timed out')), 2000)),
  ]);
  assert.equal(envelope.type, 'event');
  assert.ok(envelope.fold, 'annotated text text-insert must deliver a fold envelope, not a snapshot recovery');
  assert.equal(envelope.fold.kind, 'annotatedText');
  // The complete blockless v3 fold shape: a malformed fold — or one with the
  // wrong projected text — must not pass as "usable fold delivery".
  assert.equal(envelope.fold.version, 3);
  assert.equal(envelope.fold.field, 'body');
  assert.ok(Number.isSafeInteger(envelope.fold.baseCursor) && envelope.fold.baseCursor >= 0);
  assert.equal(envelope.fold.text?.reducer, 'workbench.text');
  assert.ok(Array.isArray(envelope.fold.text?.operations) && envelope.fold.text.operations.length > 0);
  assert.equal(envelope.fold.projection?.text, 'hello');
  assert.ok(Number.isSafeInteger(envelope.fold.familyElementCount) && envelope.fold.familyElementCount > 0);
  assert.ok(typeof envelope.fold.authoring?.positionFrames?.[0]?.positionToken === 'string');
  assert.equal(envelope.fold.fence, envelope.seq);
  assert.equal(envelope.fold.authoring?.acknowledgementFence, envelope.seq);
  assert.equal(envelope.event?.actionId, 'typed-fold');
  session.close();
  await reader.cancel();
  streamController.abort();
});

test('HTTP delivery session uses package action transport by default and retains explicit senders', async () => {
  const calls = [];
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 1 }) };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 1 }) };
    },
    eventSourceFactory: () => ({ close() {} }), validateSnapshot: (value) => value,
    createActionId: () => 'action-1', historySession: 'tab-a',
  });
  await session.ready;
  assert.equal((await session.dispatch('project.write', { name: 'one' })).ok, true);
  const [, actionOptions] = calls.find(([, options]) => options?.method === 'POST');
  assert.deepEqual(JSON.parse(actionOptions.body), { actionId: 'action-1', type: 'project.write', payload: { name: 'one' }, scope: 'Project:p1', clientId: 'tab-a' });
  assert.equal(calls.find(([, options]) => options?.method === 'POST')[0], 'https://example.test/workbench/actions');
  session.close();
});

test('HTTP delivery session posts its package-owned batch envelope to the fixed batch endpoint', async () => {
  const calls = [];
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'batch-1', confirmedThrough: 1 }) };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 1 }) };
    },
    eventSourceFactory: () => ({ close() {} }), validateSnapshot: (value) => value,
    createActionId: () => 'batch-1', historySession: 'tab-a',
  });
  await session.ready;
  assert.equal((await session.batch([{ type: 'project.write', payload: { name: 'one' } }])).ok, true);
  const [url, options] = calls.find(([, options]) => options?.method === 'POST');
  assert.equal(url, 'https://example.test/workbench/actions/batch');
  assert.deepEqual(JSON.parse(options.body), {
    actionId: 'batch-1', actions: [{ type: 'project.write', payload: { name: 'one' } }], scope: 'Project:p1', clientId: 'tab-a',
  });
  session.close();
});

test('package history transport uses durable authorization, wakes delivery, and returns the receipt fence', async (t) => {
  const db = new DatabaseSync(':memory:');
  const HistoryDocument = entity('HistoryDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  const history = (await import('../src/index.mjs')).durableHistory({ authorize: () => true, actions: {
    'project.write': {
      inverse: ({ fact }) => ({ type: 'project.write', payload: { ...fact.before, authorized: true, exists: true } }),
      redo: ({ fact }) => ({ type: 'project.write', payload: { ...fact.after, authorized: true, exists: true } }),
    },
  } });
  let historyPrincipal = user;
  const principalOf = () => historyPrincipal;
  const app = workbench({ db, entities: [project(), HistoryDocument], history, actions: [projectAction()] });
  app.attachLiveDelivery({ principalOf });
  app.listen(0, { principalOf });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  assert.equal('_historyHttp' in app, false);
  assert.equal('undoCurrent' in app.kernel.history, false);
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const actionEndpoint = `${origin}/workbench/actions`;
  const historyEndpoint = `${origin}/workbench/history`;
  const postAction = (body) => fetch(actionEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const postHistory = (body) => fetch(historyEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const action = await postAction({
    actionId: 'history-seed', type: 'project.write', scope: 'Project:p1', clientId: 'tab-a',
    payload: { id: 'p1', name: 'before', authorized: true, before: { id: 'p1', name: 'initial' } },
  });
  assert.equal(action.status, 200);
  db.prepare('INSERT INTO HistoryDocument (id, project, owner) VALUES (?, ?, ?)').run('history-doc', 'p1', 'u1');
  assert.partialDeepStrictEqual(await app.history.cursor({ scope: 'Project:p1', session: 'tab-a', principal: user }), { undo: 1, redo: 0 });
  // A browser cannot inject an old, forged, or cross-session cursor into the
  // package-owned HTTP contract.
  assert.equal((await postHistory({
    actionId: 'forged-revision', command: 'undo', scope: 'Project:p1', session: 'tab-a', revision: 'forged',
  })).status, 400);
  historyPrincipal = { type: 'anonymous', id: 'anonymous' };
  assert.equal((await postHistory({
    actionId: 'hidden-document', command: 'undo',
    document: { entity: 'HistoryDocument', field: 'body', documentId: 'missing' }, session: 'tab-a',
  })).status, 403, 'authentication runs before document lookup');
  historyPrincipal = user;
  const response = await postHistory({
    actionId: 'history-http-undo', command: 'undo', scope: 'Project:p1', session: 'tab-a',
  });
  const receipt = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(receipt).sort(), ['actionId', 'confirmedThrough', 'ok']);
  assert.equal(receipt.actionId, 'history-http-undo');
  assert.equal(db.prepare('SELECT name FROM Project WHERE id = ?').get('p1').name, 'initial');
  assert.equal((await postHistory({ actionId: 'history-http-redo', command: 'redo', scope: 'Project:p1', session: 'tab-a' })).status, 200);
  assert.equal((await postHistory({ actionId: 'history-http-point', command: 'undoToPoint', scope: 'Project:p1', session: 'tab-a', seq: 1 })).status, 400);
  assert.partialDeepStrictEqual(await app.history.cursor({ scope: 'Project:p1', session: 'tab-a', principal: user }), { undo: 1, redo: 0 });
  assert.equal((await postHistory({})).status, 400);
});

test('HTTP delivery session reserves history commands for the package history endpoint', async () => {
  const calls = [];
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return { ok: true, status: 200, json: async () => options?.method === 'POST'
        ? { ok: true, actionId: 'history-action', confirmedThrough: 1 }
        : { kind: 'snapshot', snapshot: {}, cursor: 1 } };
    },
    eventSourceFactory: () => ({ close() {} }), validateSnapshot: (value) => value,
    sendAction: async () => { throw new Error('history must not use app sender'); },
    createActionId: () => 'history-action', historySession: 'tab-a',
  });
  await session.ready;
  assert.equal((await session.history.undo()).ok, true);
  const [historyUrl, historyOptions] = calls.find(([, options]) => options?.method === 'POST');
  assert.equal(historyUrl, 'https://example.test/workbench/history');
  assert.deepEqual(JSON.parse(historyOptions.body), { actionId: 'history-action', command: 'undo', scope: 'Project:p1', session: 'tab-a' });
  await session.history.redo();
  assert.deepEqual(JSON.parse(calls.filter(([, options]) => options?.method === 'POST').at(-1)[1].body), {
    actionId: 'history-action', command: 'redo', scope: 'Project:p1', session: 'tab-a',
  });
  session.close();
});

test('composite snapshot resync gate: member events resync only when they touch output', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  const Project = entity('Project', {
    name: text(), description: text({ optional: true }), owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not project owner'))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, name, owner) VALUES ('p1', 'proj', 'u1')");
  const Codebook = entity('Codebook', {
    projectId: ref(Project, { immutable: true, physical: true, onRemove: 'cascade' }), name: text(), description: text({ optional: true }),
    grant: inherit(Project, { via: 'projectId' }),
    applicationHttpActions: ['create', 'update', 'remove'],
  });
  executeDDL(Codebook, db);
  const app = workbench({ db, entities: [Project, Codebook] });
  app.attachLiveDelivery({
    principalOf: () => user,
    snapshots: [snapshot(Project, {
      output: object({
        name: select(Project.field.name),
        codebooks: keyed(Codebook, { via: Codebook.field.projectId, select: select(Codebook.field.name) }),
      }),
    })],
  });
  t.after(async () => { await app.shutdown(); db.close(); });

  const { buildSnapshotResyncRelevance, snapshotEventTouchesComposite } = await import('../src/live-delivery-public.mjs');
  const { tryParseScopeKey } = await import('../src/scope-handle.mjs');
  const compiled = await (async () => {
    const { compileSnapshots } = await import('../src/snapshot-projection.mjs');
    const resolveEntity = (name) => name === 'Project' ? app.entities.get('Project') : name === 'Codebook' ? app.entities.get('Codebook') : undefined;
    return compileSnapshots([snapshot(Project, {
      output: object({
        name: select(Project.field.name),
        codebooks: keyed(Codebook, { via: Codebook.field.projectId, select: select(Codebook.field.name) }),
      }),
    })], resolveEntity, db);
  })();
  const declaration = compiled.get('Project');
  const relevance = buildSnapshotResyncRelevance(compiled);
  const touches = (eventType, scope, data) => snapshotEventTouchesComposite(relevance, declaration, { eventType, scope, data });

  // Anchor selected-field update resyncs.
  assert.equal(touches('Project.updated', 'Project:p1', { id: 'p1', name: 'x' }), true);
  // Anchor non-selected-field update does NOT resync.
  assert.equal(touches('Project.updated', 'Project:p1', { id: 'p1', description: 'x' }), false);
  // Member selected-field update resyncs.
  assert.equal(touches('Codebook.updated', 'Codebook:cb-1', { id: 'cb-1', name: 'x' }), true);
  // Member non-selected-field update does NOT resync.
  assert.equal(touches('Codebook.updated', 'Codebook:cb-1', { id: 'cb-1', description: 'x' }), false);
  // Member create resyncs (presence).
  assert.equal(touches('Codebook.created', 'Codebook:cb-1', { id: 'cb-1', name: 'x' }), true);
  // An entity absent from the output never resyncs.
  assert.equal(touches('Foreign.updated', 'Foreign:f1', { id: 'f1', anything: 1 }), false);
  void tryParseScopeKey;
});

test('composite shell subscriber does not resync for annotated-text body edits on its own scope', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  const Project = entity('Project', {
    name: text(), owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not project owner'))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, name, owner) VALUES ('p1', 'proj', 'u1')");
  const ShellDoc = entity('ShellDoc', {
    project: ref(Project, { physical: true }), owner: ref('User', { role: 'owner' }),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(ShellDoc, db);
  const Codebook = entity('Codebook', {
    projectId: ref(Project, { immutable: true, physical: true }), name: text(),
    grant: inherit(Project, { via: 'projectId' }),
    applicationHttpActions: ['create'],
  });
  executeDDL(Codebook, db);
  const app = workbench({ db, entities: [Project, ShellDoc, Codebook], history: (await import('../src/index.mjs')).durableHistory({ authorize: () => true }) });
  app.attachLiveDelivery({
    principalOf: () => user,
    snapshots: [snapshot(Project, {
      output: object({
        name: select(Project.field.name),
        codebooks: keyed(Codebook, { via: Codebook.field.projectId, select: select(Codebook.field.name) }),
      }),
    })],
  });
  app.listen(0, { principalOf: () => user });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const create = annotatedTextCreateAction(ShellDoc, ShellDoc.body, { id: 'd1', projectId: 'p1', ownerId: 'u1' });
  const createRes = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'create-shell', type: create.type, payload: create.payload, scope: 'Project:p1', clientId: 'tab-a' }),
  });
  assert.equal(createRes.status, 200);
  const initialBlockId = 'b';

  const anchor = Number(db.prepare("SELECT MAX(seq) AS s FROM _Log WHERE scope = 'Project:p1'").get().s ?? 0);
  const aggregate = Number(db.prepare("SELECT revision FROM _CommittedRevision WHERE name = 'actions'").get().revision);
  const cursor = encodeURIComponent(JSON.stringify({ anchor, aggregate }));

  // Bare composite shell subscription (no document identity) on the Project scope.
  const streamController = new AbortController();
  const shellUrl = `${origin}/live-delivery/events?scope=Project%3Ap1&after=${cursor}`;
  const shellResponse = await fetch(shellUrl, { signal: streamController.signal });
  assert.equal(shellResponse.status, 200);
  const shellReader = shellResponse.body.getReader();
  await shellReader.read();

  // A text insert commits an annotated-text operated event to the Project scope.
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`, context: { entity: ShellDoc, field: ShellDoc.body, documentId: 'd1' },
    historySession: 'tab-b', createActionId: () => 'shell-typed',
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready.catch((error) => { error.message = `shell-ready: ${error.message}`; throw error; });
  const inserted = await session.insert({ mutationId: 'shell-insert', at: { blockId: initialBlockId, offset: 0, affinity: 'right' }, text: 'hi' });
  assert.equal(inserted.ok, true);
  await inserted.settlement.wait();
  const insertSeq = Number(db.prepare("SELECT MAX(seq) AS s FROM _Log WHERE scope = 'Project:p1'").get().s ?? 0);

  // Then a genuinely composite-touching event: a member create on the same
  // scope (Codebook presence changes the composite output).
  const createBookRes = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'shell-book', type: 'Codebook.create', scope: 'Project:p1', clientId: 'tab-c', payload: { id: 'book-1', projectId: 'p1', name: 'Interviews' } }),
  });
  assert.equal(createBookRes.status, 200);
  const updateSeq = Number(db.prepare("SELECT MAX(seq) AS s FROM _Log WHERE scope = 'Project:p1'").get().s ?? 0);

  // Read frames until the member create's resync arrives; the annotated-text
  // insert (same scope, seq insertSeq) must never produce a frame.
  const envelopes = [];
  let sawUpdate = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const batch = await Promise.race([
      nextSseJson(shellReader),
      new Promise((_, reject) => setTimeout(() => reject(new Error('composite shell resync timed out')), 300)),
    ]);
    for (const frame of batch) {
      envelopes.push(frame);
      if (frame.type === 'resync' && frame.seq === updateSeq) sawUpdate = true;
    }
    if (sawUpdate) break;
  }
  assert.ok(sawUpdate, `expected a resync for the member create, got batches: ${JSON.stringify(envelopes)}`);
  for (const frame of envelopes) {
    assert.notEqual(frame.seq, insertSeq, `annotated-text body edit must not resync the composite shell`);
  }
  session.close();
  await shellReader.cancel();
  streamController.abort();
});

