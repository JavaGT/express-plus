import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveChannel } from '../public/workbench-client.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    this.sendError = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, data = undefined) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === 'message' ? { data: JSON.stringify(data) } : {});
    }
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(message) {
    if (this.sendError) throw this.sendError;
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function harness(options = {}) {
  const sockets = [];
  const channel = new LiveChannel('ws://example.test', {
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoffBase: 1,
    maxBackoff: 1,
    ...options,
  });
  return { channel, sockets };
}

test('two concurrent subscriptions share one connection and send desired state once', async () => {
  const { channel, sockets } = harness();
  const first = channel.subscribe('Doc', 'a', () => {});
  const second = channel.subscribe('Doc', 'b', () => {});

  await tick();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  await tick();
  assert.deepEqual(sockets[0].sent, [
    { type: 'subscribe', entity: 'Doc', id: 'a' },
    { type: 'subscribe', entity: 'Doc', id: 'b' },
  ]);

  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'b', currentSeq: 2 });
  assert.deepEqual(await first, { currentSeq: 1 });
  assert.deepEqual(await second, { currentSeq: 2 });
  channel.close();
});

test('late messages and closes from a retired socket generation are ignored', async () => {
  const { channel, sockets } = harness();
  const events = [];
  const checkpoints = [];
  const ready = channel.subscribe('Doc', 'a', {
    onCheckpoint: ({ currentSeq }) => checkpoints.push(currentSeq),
  }, (event) => events.push(event));

  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await ready;
  sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
  sockets[1].open();
  await tick();
  sockets[1].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 4 });

  sockets[0].emit('message', {
    type: 'event', entity: 'Doc', id: 'a', seq: 99, seqSpan: [99, 99],
    event: { type: 'Doc.updated', data: { title: 'stale' } },
  });
  sockets[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(checkpoints, [1, 4]);
  assert.deepEqual(events, []);
  assert.equal(sockets.length, 2);
  channel.close();
});

test('close while connecting rejects pending subscription and prevents reconnect', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  assert.equal(sockets.length, 1);

  const rejected = assert.rejects(pending, /closed/i);
  channel.close();
  await rejected;
  sockets[0].open();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 1);
});

test('unsubscribe while offline is absent from reconnect reconciliation', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await pending;

  sockets[0].close();
  await channel.unsubscribe('Doc', 'a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (sockets[1]) {
    sockets[1].open();
    await tick();
    assert.deepEqual(sockets[1].sent, []);
  }
  channel.close();
});

test('send failure retires the generation and replays desired state exactly once', async () => {
  const { channel, sockets } = harness();
  const pending = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].sendError = new Error('write failed');
  sockets[0].open();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(sockets.length, 2);
  sockets[1].open();
  await tick();
  assert.deepEqual(sockets[1].sent, [{ type: 'subscribe', entity: 'Doc', id: 'a' }]);
  sockets[1].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 2 });
  assert.deepEqual(await pending, { currentSeq: 2 });
  channel.close();
});

test('the same subscription cannot be recreated until unsubscribe is acknowledged', async () => {
  const { channel, sockets } = harness();
  const initial = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].open();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 1 });
  await initial;

  const removing = channel.unsubscribe('Doc', 'a');
  assert.throws(
    () => channel.subscribe('Doc', 'a', () => {}),
    /unsubscribe.*pending/i,
  );

  sockets[0].emit('message', { type: 'unsubscribed', entity: 'Doc', id: 'a' });
  await removing;

  const replacement = channel.subscribe('Doc', 'a', () => {});
  await tick();
  sockets[0].emit('message', { type: 'subscribed', entity: 'Doc', id: 'a', currentSeq: 2 });
  assert.deepEqual(await replacement, { currentSeq: 2 });
  channel.close();
});
