// LiveChannel end-to-end tests against a real workbench server.
//
// 6 tests exercising connect, subscribe, event delivery, unsubscribe,
// multiplex, reconnect, and close cleanup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import workbench, { entity, text, scope, everyone, grant, read, write, subscribe } from '../src/index.mjs';
import { setActiveDb } from '../src/db.mjs';
import { LiveChannel } from '../public/workbench-client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A public Doc entity — everyone can read, write, and subscribe.
const Doc = entity('Doc', {
  fields: { title: text() },
  grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
});

// Boot an workbench app with an in-memory DB, mount Doc, listen on a random
// port. Returns { app, origin, port }. Caller must close both.
async function bootApp() {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db);
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
