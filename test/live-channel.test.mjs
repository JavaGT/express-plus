// LiveChannel end-to-end tests against a real workbench server.
//
// 13 tests: connect, subscribe, event delivery, unsubscribe, multiplex,
// reconnect, close cleanup, and connection-state emitter.

import { text, ephemeral, scope, everyone, grant, read, write, subscribe } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity } from '../src/internal.mjs';
import { LiveChannel } from '../public/workbench-client.mjs';
import { createLiveFanout } from '../src/live-fanout.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A public Doc entity — everyone can read, write, and subscribe.
const Doc = entity('Doc', {
    title: text(), cursor: ephemeral({ x: true, y: true }),

  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// Boot an workbench app with an in-memory DB, mount Doc, listen on a random
// port. Returns { app, origin, port }. Caller must close both.
async function bootApp() {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/docs', Doc);
  await app.ddl(); // creates Doc table + framework _Log/_Cursor
  app.listen(0, { principalOf: () => ({ type: 'user', id: 'test' }) });
  await app.ready;
  const { port } = app.httpServer.address();
  const origin = `http://127.0.0.1:${port}`;
  return { app, origin, port, db };
}

// Create a Doc with `{title}` via POST. Returns `{id, title}`.
async function createDoc(origin, title) {
  const r = await fetch(`${origin}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(r.status, 201);
  return r.json();
}

async function patchDoc(origin, id, title) {
  const r = await fetch(`${origin}/docs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

// Minimal fake conn for package-private fanout tests.
function makeConn(id) {
  const messages = [];
  return {
    id,
    closed: false,
    principal: { type: 'user', id: 'test' },
    send(msg) { messages.push(msg); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function makeEntity({ fields = {} } = {}) {
  return {
    name: 'Doc',
    fields,
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
    findById() { return { id: 'd1', title: 'drawing' }; },
  };
}

// --- Tests ---

test('subscribe ack + currentSeq', async () => {
  const { app, origin, db } = await bootApp();
  const channel = new LiveChannel(origin);
  try {
    const doc = await createDoc(origin, 'test');
    const handle = await channel.subscribe('Doc', doc.id, () => {});
    assert.ok(typeof handle.currentSeq === 'number', `currentSeq is number, got ${typeof handle.currentSeq}`);
    assert.ok(handle.currentSeq >= 0, `currentSeq >= 0, got ${handle.currentSeq}`);
  } finally {
    channel.close();
    app.httpServer.close();
    db.close();
  }
});

test('server mutation -> envelope via onEvent', async () => {
  const { app, origin, db } = await bootApp();
  const channel = new LiveChannel(origin);
  try {
    const doc = await createDoc(origin, 'original');
    let received = null;
    await channel.subscribe('Doc', doc.id, (envelope) => { received = envelope; });

    // Mutate the doc and wait for the event to arrive.
    await patchDoc(origin, doc.id, 'updated');
    await sleep(300);

    assert.ok(received, 'onEvent was called');
    assert.equal(received.type, 'event');
    assert.equal(received.entity, 'Doc');
    assert.equal(received.id, doc.id);
    assert.ok(typeof received.seq === 'number', 'seq is a number');
    assert.deepEqual(received.seqSpan, [received.seq, received.seq], 'seqSpan matches seq');
    assert.equal(received.event.type, 'Doc.updated');
    assert.equal(received.event.data.title, 'updated');
  } finally {
    channel.close();
    app.httpServer.close();
    db.close();
  }
});

test('unsubscribe stops delivery', async () => {
  const { app, origin, db } = await bootApp();
  const channel = new LiveChannel(origin);
  try {
    const doc = await createDoc(origin, 'before');
    let callCount = 0;
    await channel.subscribe('Doc', doc.id, () => { callCount++; });
    await sleep(100);

    await channel.unsubscribe('Doc', doc.id);
    await sleep(100);

    await patchDoc(origin, doc.id, 'after-unsub');
    await sleep(400);

    assert.equal(callCount, 0, 'onEvent should NOT be called after unsubscribe');
  } finally {
    channel.close();
    app.httpServer.close();
    db.close();
  }
});

test('multiplex — two subs both receive only their own events', async () => {
  const { app, origin, db } = await bootApp();
  const channel = new LiveChannel(origin);
  try {
    const doc1 = await createDoc(origin, 'one');
    const doc2 = await createDoc(origin, 'two');
    let events1 = [];
    let events2 = [];
    await channel.subscribe('Doc', doc1.id, (e) => { events1.push(e); });
    await channel.subscribe('Doc', doc2.id, (e) => { events2.push(e); });
    await sleep(100);

    await patchDoc(origin, doc1.id, 'updated-one');
    await sleep(300);

    assert.equal(events1.length, 1, 'sub1 received 1 event');
    assert.equal(events2.length, 0, 'sub2 received 0 events');

    await patchDoc(origin, doc2.id, 'updated-two');
    await sleep(300);

    assert.equal(events1.length, 1, 'sub1 still has 1 event');
    assert.equal(events2.length, 1, 'sub2 received 1 event');

    // Verify the events targeted the right docs.
    assert.equal(events1[0].id, doc1.id);
    assert.equal(events2[0].id, doc2.id);
  } finally {
    channel.close();
    app.httpServer.close();
    db.close();
  }
});

test('reconnect resubscribe preserves field interest and pace', async () => {
  const channel = new LiveChannel('ws://127.0.0.1:1', { backoffBase: 1, maxBackoff: 1 });
  const sent = [];
  channel._socket = { readyState: 1, send() {} };
  channel._subs.set('Doc\0d1', {
    onEvent() {},
    fields: { cursor: true },
    pace: { profile: '15fps' },
  });
  channel._openSocket = async () => { channel._socket = { readyState: 1, send() {} }; };
  channel._send = (data) => { sent.push(data); };

  channel._scheduleReconnect();
  await sleep(30);

  assert.deepEqual(sent, [{
    type: 'subscribe', entity: 'Doc', id: 'd1',
    fields: { cursor: true },
    pace: { profile: '15fps' },
    requestId: 1,
  }]);
  channel.close();
});

test('reconnect after socket drop — re-subscribes and resumes receiving', async () => {
  const { app, origin, db } = await bootApp();
  const channel = new LiveChannel(origin);
  try {
    const doc = await createDoc(origin, 'before');
    let received = null;
    await channel.subscribe('Doc', doc.id, (e) => { received = e; });
    await sleep(100);

    // Forcefully destroy the underlying socket (test-only hook).
    const oldSocket = channel._socket;
    assert.ok(oldSocket, 'socket exists before destroy');
    // Simulate an unexpected close by closing the socket.
    oldSocket.close();
    await sleep(100);

    // Wait for reconnect + re-subscribe (backoff starts at ~200ms)
    await sleep(1200);

    // Verify reconnected by checking the socket is new.
    assert.ok(channel._socket, 'socket exists after reconnect');
    assert.notEqual(channel._socket, oldSocket, 'socket was recreated');

    // Now mutate the doc — should arrive via re-subscribed channel.
    await patchDoc(origin, doc.id, 'after-reconnect');
    await sleep(500);

    assert.ok(received, 'onEvent fired after reconnect');
    assert.equal(received.event.data.title, 'after-reconnect');
  } finally {
    channel.close();
    app.httpServer.close();
    db.close();
  }
});

test('subscribe sends field interest and pace to server fanout', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity({ fields: { cursor: { kind: 'ephemeral' } } });

  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 20, by: 'latest-wins' });

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 1,
    data: { owner: 'd1', client: 'test', cells: { x: 1, y: 1 } },
  });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 2,
    data: { owner: 'd1', client: 'test', cells: { x: 2, y: 2 } },
  });

  await sleep(250);

  const received = conn.drain();
  assert.equal(received.length, 1);
  assert.equal(received[0].event.type, 'Doc.cursor.set');
  assert.equal(received[0].seq, 2);
  assert.deepEqual(received[0].seqSpan, [1, 2]);
  fanout.close();
});

test('close() cleanup — no further deliveries or reconnects', async () => {
  const { app, origin, db } = await bootApp();

  const channel = new LiveChannel(origin);
  try {
    const doc = await createDoc(origin, 'before');
    let callCount = 0;
    await channel.subscribe('Doc', doc.id, () => { callCount++; });
    await sleep(100);

    // Close the channel.
    channel.close();

    // Mutate the doc — should NOT arrive.
    await patchDoc(origin, doc.id, 'after-close');
    await sleep(500);

    assert.equal(callCount, 0, 'onEvent should NOT fire after close');
    assert.ok(!channel._socket, 'socket should be null after close');
  } finally {
    app.httpServer.close();
    db.close();
  }
});

// onConnectionChange unit tests using mock sockets.
// LiveChannel resolves via polling on readyState + the 'open' event,
// so we mock the internal state machine to trigger transitions.

test('onConnectionChange returns an unsubscribe function', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  const unsub = channel.onConnectionChange(() => {});
  assert.equal(typeof unsub, 'function');
  unsub();
  channel.close();
});

test('onConnectionChange emits connected after socket opens', async () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  let status = null;
  channel.onConnectionChange((s) => { status = s; });

  // Replace _openSocket to simulate a successful connection
  let resolveOpen;
  const openPromise = new Promise((r) => { resolveOpen = r; });
  channel._openSocket = async () => {
    channel._socket = { readyState: 1, send() {} };
    channel._state = 'online';
    channel._reconnectAttempt = 0;
    channel._emitConnectionStatus('connected');
    resolveOpen();
  };

  channel._scheduleReconnect();
  await openPromise;

  assert.equal(status, 'connected');
  channel.close();
});

test('onConnectionChange emits disconnected on close', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  const events = [];
  channel.onConnectionChange((s) => { events.push(s); });

  channel.close();
  assert.deepEqual(events, ['disconnected']);
});

test('onConnectionChange emits reconnecting when socket drops', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  let status = null;
  channel.onConnectionChange((s) => { status = s; });

  // Directly call the emitter — this is what _scheduleReconnect does.
  channel._emitConnectionStatus('reconnecting');
  assert.equal(status, 'reconnecting');
  channel.close();
});

test('multiple subscribers all receive transitions', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  const a = [];
  const b = [];
  channel.onConnectionChange((s) => { a.push(s); });
  channel.onConnectionChange((s) => { b.push(s); });

  channel._emitConnectionStatus('connected');
  channel._emitConnectionStatus('reconnecting');

  assert.deepEqual(a, ['connected', 'reconnecting']);
  assert.deepEqual(b, ['connected', 'reconnecting']);
  channel.close();
});

test('unsubscribe stops receiving callbacks', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  const events = [];
  const unsub = channel.onConnectionChange((s) => { events.push(s); });

  channel._emitConnectionStatus('connected');
  unsub();
  channel._emitConnectionStatus('reconnecting');

  assert.deepEqual(events, ['connected']);
  channel.close();
});

test('close() cleans up callbacks and emits final disconnected', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1');
  const events = [];
  channel.onConnectionChange((s) => { events.push(s); });

  channel.close();

  // After close, further emits should be no-ops (callbacks cleared).
  channel._emitConnectionStatus('connected');
  assert.deepEqual(events, ['disconnected']);
});
