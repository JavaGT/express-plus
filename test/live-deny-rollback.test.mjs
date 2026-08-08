// Real-server overlay rollback after a live server denial (issue #51).
//
// Overlay rollback was only exercised through fake fetch, and the only
// real-server deny was a `create` (create-deny.test.mjs). Here a real workbench
// server denies an UPDATE to a read-only non-owner principal: the client's
// optimistic overlay must roll back to the pre-update value, the pending op must
// vanish, and the dispatch must surface failed-rolled-back with a canonical
// WorkbenchFailure — while the owner's own update still commits and streams live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, everyone, grant, principal, read, ref, scope, subscribe, text, write } from '../src/index.mjs';
import { createLiveStore, LiveChannel, WorkbenchFailureError } from '../public/workbench-client.mjs';

const owner = principal({ type: 'user', id: 'alice' });
const viewer = principal({ type: 'user', id: 'viewer' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

// A public-read Widget: everyone may SEE every row (SQL scope everyone()), but
// only the owner may write/remove — the `.can` capability axis, distinct from
// visibility. A non-owner's update is a live server denial (403).
function makeWidget() {
  return entity('Widget', {
    label: text(), owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(() => everyone()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read, subscribe)),
    ],
  });
}

test('non-owner update denied server-side: client overlay rolls back with a canonical WorkbenchFailure', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db });
  app.mount('/widgets', makeWidget());
  app.listen(0, { principalOf: () => viewer });
  let store = null;
  t.after(() => {
    store?.close();
    app.httpServer.close();
    db.close();
  });
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Owner creates the widget (server-side, as alice); the viewer can read it.
  const created = await app.dispatch({
    actionId: 'create-w1', type: 'Widget.create',
    payload: { id: 'w1', label: 'original' }, principal: owner,
  });
  assert.equal(created.ok, true);

  // The client (viewer) boots from the snapshot.
  const channel = new LiveChannel(origin);
  store = createLiveStore({ baseUrl: origin, name: 'Widget', path: '/widgets', channel });
  const list = store.subscribe('w1');
  await list.ready;
  assert.equal(list.state.label, 'original');

  // A denied update rolls the optimistic overlay back and returns
  // failed-rolled-back with the server's canonical denied failure.
  const result = await store.update('w1', { label: 'hijack' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed-rolled-back');
  assert.equal(result.failure.category, 'denied');
  assert.equal(result.failure.message, 'forbidden');
  assert.doesNotThrow(() => new WorkbenchFailureError(result.failure), 'failure is a canonical WorkbenchFailure');

  assert.equal(store.overlayStatusFor('w1'), null, 'pending op is gone');
  assert.equal(store.overlayFor('w1').label, 'original', 'pre-update value is what the store snapshot shows');
  assert.equal(store.overlayFor('w1').owner, 'alice');

  // Control: the owner's update still commits and streams live to the viewer.
  const control = await app.dispatch({
    actionId: 'alice-edit', type: 'Widget.update',
    payload: { id: 'w1', label: 'alice-edit' }, principal: owner, scope: 'Widget:w1',
  });
  assert.equal(control.ok, true);
  await waitFor(async () => list.state?.label === 'alice-edit');
  assert.equal(store.overlayFor('w1').label, 'alice-edit', 'authorized owner update streams and folds');
});
