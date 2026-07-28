import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, grant, read, subscribe, text } from '../src/index.mjs';
import { createLiveDeliveryHttpSession } from '../public/workbench-client.mjs';

const user = { type: 'user', id: 'u1', attributes: {} };

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

test('application live delivery validates providers without exposing kernel callbacks', () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [project()] });
  assert.throws(
    () => app.attachLiveDelivery({ principalOf: () => user, compositeScopes: new Map([['Project', {}]]) }),
    /synchronous snapshot function/,
  );
  assert.equal(app._applicationLiveDelivery, undefined);
  db.close();
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
  session.close();
});
