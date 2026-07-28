import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, grant, read, subscribe, text } from '../src/index.mjs';

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
    handler: ({ payload }) => [{
      type: payload.exists ? 'Project.updated' : 'Project.created',
      scope: `Project:${payload.id}`,
      data: { id: payload.id, name: payload.name },
    }],
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
