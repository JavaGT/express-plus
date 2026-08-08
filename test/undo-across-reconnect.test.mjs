// Undo-across-reconnect (archaeology audit T3, issue #50).
//
// The durable-history and live-channel tests never shared a scenario. This test
// proves the undo-then-reconnect-then-replay/redo invariant over a real server:
// a durable action commits and its live echo folds, the socket drops while a
// server-side undo commits, the reconnect resubscribes and the events-since
// catch-up converges the client's folded state to the server's post-undo state
// (no stale value survives the reconnect), and a later redo re-applies and folds
// again on the reconnected client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { durableHistory, entity, grant, principal, read, subscribe, text, write } from '../src/index.mjs';
import { createLiveStore, LiveChannel } from '../public/workbench-client.mjs';

const user = principal({ type: 'user', id: 'u1' });
const session = 'tab-a';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for condition');
}

// A public Note with generated conditional update history: everyone may
// read/write/subscribe, and `Note.update` is undoable.
const Note = entity('Note', {
  body: text(),
  grant: () => grant(read, write, subscribe),
  history: { update: 'conditional' },
});

test('undo committed while offline is caught up on reconnect; redo re-applies', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, history: durableHistory({ authorize: () => true }) });
  app.mount('/notes', Note);
  app.listen(0, { principalOf: () => user });
  let store = null;
  t.after(() => {
    store?.close();
    app.httpServer.close();
    db.close();
  });
  await app.ready;
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  // Seed the row and its first committed event before the client subscribes.
  const created = await app.dispatch({
    actionId: 'create-note-1', type: 'Note.create',
    payload: { id: 'note-1', body: 'first' }, principal: user,
  });
  assert.equal(created.ok, true);

  // Client boots from the snapshot and subscribes on the live channel. The
  // fetchImpl records events-since requests so the test can prove the
  // reconnect resync path fired (not just that state happened to converge via
  // a re-bootstrap or live delivery).
  const eventsSinceRequests = [];
  const recordingFetch = async (url, opts) => {
    if (String(url).includes('/events-since/')) eventsSinceRequests.push(String(url));
    return globalThis.fetch(url, opts);
  };
  const channel = new LiveChannel(origin, { backoffBase: 500, maxBackoff: 500 });
  store = createLiveStore({ baseUrl: origin, name: 'Note', path: '/notes', channel, fetchImpl: recordingFetch });
  const list = store.subscribe('note-1');
  await list.ready;
  assert.equal(list.state.body, 'first');
  assert.equal(list.cursor, 1);
  assert.equal(eventsSinceRequests.length, 0, 'no events-since on a clean first subscribe');

  // A sessioned durable update: the client folds the live echo to 'second'.
  const updated = await app.dispatch({
    actionId: 'update-note-1', type: 'Note.update',
    payload: { id: 'note-1', body: 'second' },
    principal: user, scope: 'Note:note-1', history: { session },
  });
  assert.equal(updated.ok, true);
  await waitFor(async () => list.state?.body === 'second');

  // Drop the socket; while the client is offline the server undoes. The drop
  // and the offline window (500ms backoff) happen BEFORE the undo commits, so
  // the undo event cannot reach the client as a live delivery — only the
  // reconnect resync (events-since) can carry it.
  const oldSocket = channel._socket;
  assert.ok(oldSocket, 'socket exists before drop');
  oldSocket.close();
  await waitFor(async () => channel._socket === null, 2000);
  assert.equal(channel._socket, null, 'socket is closed before the undo commits');
  const beforeUndo = await app.history.cursor({ scope: 'Note:note-1', principal: user, session });
  const undone = await app.history.undo({
    scope: 'Note:note-1', principal: user, session, actionId: 'undo-1', revision: beforeUndo.revision,
  });
  assert.equal(undone.ok, true);

  // Reconnect + resubscribe catch the client up to the post-undo state.
  await waitFor(async () => channel._socket && channel._socket !== oldSocket && list.state?.body === 'first');
  assert.equal(list.state.body, 'first', 'replayed state equals post-undo state');
  assert.equal(store.overlayFor('note-1').body, 'first', 'store snapshot agrees — no stale undo echo');
  assert.ok(
    eventsSinceRequests.length > 0,
    'the reconnect resync (events-since) actually fired — convergence did not come from a re-bootstrap or live delivery',
  );

  // The client's folded cursor matches the server's committed sequence.
  const snap = await (await fetch(`${origin}/snapshot/Note/note-1`)).json();
  assert.equal(snap.snapshot.body, 'first');
  assert.equal(list.cursor, snap.seq, 'client cursor equals server committed seq');

  // Redo re-applies server-side and folds live on the reconnected client.
  const afterUndo = await app.history.cursor({ scope: 'Note:note-1', principal: user, session });
  const redone = await app.history.redo({
    scope: 'Note:note-1', principal: user, session, actionId: 'redo-1', revision: afterUndo.revision,
  });
  assert.equal(redone.ok, true);
  await waitFor(async () => list.state?.body === 'second');
  assert.equal(store.overlayFor('note-1').body, 'second', 'redo re-applied and folded');
  const snap2 = await (await fetch(`${origin}/snapshot/Note/note-1`)).json();
  assert.equal(snap2.snapshot.body, 'second');
});
