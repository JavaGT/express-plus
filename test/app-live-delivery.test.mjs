import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotatedTextCreateAction, annotatedTextRetireAction, annotation,
  deny, entity, everyone, exportAnnotatedText,
  admin, grant, measurement, object, read, ref, registerAnnotatedTextContract, scope, select, snapshot, subscribe, text, write,
} from '../src/index.mjs';
import { executeDDL, executeFrameworkDDL, registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
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

test('declared annotated text owns generated HTTP admission and package delivery recovery', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES (\'p1\', \'u1\'); INSERT INTO User VALUES (\'u1\'); INSERT INTO User VALUES (\'u2\')');
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
  const app = workbench({ db, entities: [Project, Document] });
  app.attachLiveDelivery({ principalOf });
  app.listen(0, { principalOf });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const post = (action, headers = {}) => fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ actionId: action.payload?.version ? `op-${action.payload.mutationId}` : `action-${action.type}`, ...action, clientId: 'tab-a' }),
  });

  const create = annotatedTextCreateAction(Document, { id: 'd1', project: 'p1', owner: 'u1' });
  assert.equal((await post(create, { 'x-anonymous': '1' })).status, 403);
  assert.equal((await post(create)).status, 200);
  const initialBlockId = db.prepare('SELECT id FROM HttpAnnotatedDocument_body_block WHERE document_id = ?').get('d1').id;

  const sources = [];
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${origin}/live-delivery`, context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `typed-${++actionNumber}`,
    eventSourceFactory: () => { const source = { close() {}, onmessage: null, onerror: null }; sources.push(source); return source; },
  });
  await session.ready;
  assert.equal(session.document.blocks[0].id, initialBlockId);
  assert.equal((await session.insert({ mutationId: 'insert-1', at: { blockId: initialBlockId, offset: 0 }, text: 'hello' })).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.blocks[0].text, 'hello', 'committed receipt recovers through recipient snapshot ingest');
  assert.equal((await session.split({ mutationId: 'split-1', at: { blockId: initialBlockId, offset: 2 } })).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.blocks.length, 2);
  assert.equal('dispatch' in session, false);

  const exportRequest = { app, entity: Document, field: Document.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' } };
  const exported = await exportAnnotatedText({ ...exportRequest, principal });
  assert.equal(exported.blocks.map((block) => block.text).join(''), 'hello');
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { ...user, id: 'u2' } }), /owning scope admin authorization failed/);

  const committedBeforeForbidden = db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get('Project:p1').count;
  for (const forbidden of [
    { type: 'HttpAnnotatedDocument.update', scope: 'Project:p1', payload: { id: 'd1', project: 'p1' } },
    { type: 'HttpAnnotatedDocument.body.apply', scope: 'Project:p1', payload: { id: 'd1', operation: {} } },
    { type: 'HttpAnnotatedDocument.body.operation', scope: 'HttpAnnotatedDocument:other', payload: { id: 'd1', version: 99 } },
    { type: 'HttpAnnotatedDocument.body.operation', scope: 'Project:p1', payload: { version: 1, id: 'd1', expected: { structuralRevision: 2, frontier: [] }, operation: { kind: 'text.apply', blockId: initialBlockId, operation: ['workbench.text', 1, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1], 1, [], ['insert', ['root'], 'raw']] } } },
  ]) assert.equal((await post(forbidden)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE scope = ?').get('Project:p1').count, committedBeforeForbidden);

  principal = { ...user, id: 'u2' };
  const revokedEdit = await session.insert({ mutationId: 'revoked', at: { blockId: initialBlockId, offset: 0 }, text: 'x' });
  assert.equal(revokedEdit.ok, false);
  principal = user;
  assert.equal((await post(annotatedTextRetireAction(Document, 'd1'))).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM HttpAnnotatedDocument_body_retired WHERE document_id = ?').get('d1').count, 1);
  session.close();
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
  const history = (await import('../src/index.mjs')).durableHistory({ authorize: () => true, actions: {
    'project.write': {
      inverse: ({ fact }) => ({ type: 'project.write', payload: { ...fact.before, authorized: true, exists: true } }),
      redo: ({ fact }) => ({ type: 'project.write', payload: { ...fact.after, authorized: true, exists: true } }),
    },
  } });
  const app = workbench({ db, entities: [project()], history, actions: [projectAction()] });
  app.attachLiveDelivery({ principalOf: () => user });
  app.listen(0, { principalOf: () => user });
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
  assert.partialDeepStrictEqual(await app.history.cursor({ scope: 'Project:p1', session: 'tab-a', principal: user }), { undo: 1, redo: 0 });
  // A browser cannot inject an old, forged, or cross-session cursor into the
  // package-owned HTTP contract.
  assert.equal((await postHistory({
    actionId: 'forged-revision', command: 'undo', scope: 'Project:p1', session: 'tab-a', revision: 'forged',
  })).status, 400);
  const response = await postHistory({ actionId: 'history-http-undo', command: 'undo', scope: 'Project:p1', session: 'tab-a' });
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
