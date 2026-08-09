import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';

// Client/session caret seam (issue #9): `createAnnotatedTextHttpSession` with
// a `carets` option owns ONE LiveChannel for recipient-projected presence. The
// durable document surface and the caret channel stay separate; without the
// option the session exposes no caret surface and never constructs a channel.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
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
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function annotatedContext() {
  return {
    entity: { name: 'Doc', fields: { body: { kind: 'annotatedText' } } },
    field: { fieldName: 'body' },
    documentId: 'd1',
  };
}

// A fetch that settles the durable bootstrap as an invalid 200 body; the
// delivery session fails closed to 'unavailable' quickly and spins no retry
// timers, so caret tests never fight background recovery.
function fetchNoServer() {
  return async () => new Response('{}', { status: 200 });
}

function harness({ carets = true } = {}) {
  const sockets = [];
  const options = carets
    ? {
        carets: {
          wsBaseUrl: 'http://example.test',
          socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          },
        },
      }
    : {};
  const session = createAnnotatedTextHttpSession({
    baseUrl: '/live-delivery',
    context: annotatedContext(),
    historySession: 'caret-session-1',
    fetchImpl: fetchNoServer(),
    ...options,
  });
  return { session, sockets };
}

async function openCaretSocket(harness) {
  assert.equal(harness.sockets.length, 1);
  const socket = harness.sockets[0];
  await tick();
  socket.open();
  await tick();
  const subscribe = socket.sent[0];
  assert.equal(subscribe.type, 'subscribe');
  socket.emit('message', { type: 'subscribed', entity: 'Doc', id: 'd1', currentSeq: 1, requestId: subscribe.requestId });
  await tick();
  return socket;
}

function caretFrames() {
  return {
    caret: {
      type: 'annotated-text-caret', version: 1,
      entity: 'Doc', id: 'd1', field: 'body',
      change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3 } },
    },
    edge: {
      type: 'annotated-text-caret', version: 1,
      entity: 'Doc', id: 'd1', field: 'body',
      change: { op: 'upsert', value: { kind: 'edge', presence: 'p2', edge: 'start' } },
    },
    remove: {
      type: 'annotated-text-caret', version: 1,
      entity: 'Doc', id: 'd1', field: 'body',
      change: { op: 'remove', presence: 'p1' },
    },
  };
}

test('subscribe envelope carries carets interest plus entity and id', async () => {
  const h = harness();
  try {
    await openCaretSocket(h);
    const sent = h.sockets[0].sent[0];
    assert.equal(sent.type, 'subscribe');
    assert.equal(sent.entity, 'Doc');
    assert.equal(sent.id, 'd1');
    assert.deepEqual(sent.carets, ['body']);
  } finally {
    h.session.close();
  }
});

test('publishCaret sends an exact caret.update message', async () => {
  const h = harness();
  try {
    const socket = await openCaretSocket(h);
    const result = h.session.publishCaret({ offset: 5 });
    assert.equal(result, true);
    assert.deepEqual(socket.sent.find((m) => m.type === 'caret.update'), {
      type: 'caret.update', entity: 'Doc', id: 'd1', field: 'body', offset: 5,
    });
  } finally {
    h.session.close();
  }
});

test('publishCaret rejects invalid offsets without sending', async () => {
  const h = harness();
  try {
    const socket = await openCaretSocket(h);
    const invalid = [{ offset: -1 }, { offset: 1.5 }, { offset: Infinity }, {}, { offset: '3' }, { offset: null }];
    for (const input of invalid) {
      assert.throws(() => h.session.publishCaret(input), TypeError, `expected TypeError for ${JSON.stringify(input)}`);
    }
    assert.throws(() => h.session.publishCaret(), TypeError, 'no argument is also invalid');
    assert.equal(socket.sent.filter((m) => m.type === 'caret.update').length, 0);
  } finally {
    h.session.close();
  }
});

test('clearCaret sends an exact caret.clear message', async () => {
  const h = harness();
  try {
    const socket = await openCaretSocket(h);
    const result = h.session.clearCaret();
    assert.equal(result, true);
    assert.deepEqual(socket.sent.find((m) => m.type === 'caret.clear'), {
      type: 'caret.clear', entity: 'Doc', id: 'd1', field: 'body',
    });
  } finally {
    h.session.close();
  }
});

test('onCaret receives validated frames and unsubscribe detaches', async () => {
  const h = harness();
  try {
    const socket = await openCaretSocket(h);
    const frames = [];
    const framesCaret = caretFrames();
    const unsubscribe = h.session.onCaret((frame) => frames.push(frame));
    socket.emit('message', framesCaret.caret);
    socket.emit('message', framesCaret.edge);
    socket.emit('message', framesCaret.remove);
    // Malformed / wrong-version / wrong-scope frames are dropped by the channel.
    socket.emit('message', { type: 'annotated-text-caret', version: 2, entity: 'Doc', id: 'd1', field: 'body', change: { op: 'remove', presence: 'pX' } });
    socket.emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'd1', field: 'body', change: { op: 'upsert', value: { kind: 'caret', presence: 'p1', offset: 3, extra: 'x' } } });
    socket.emit('message', { type: 'annotated-text-caret', version: 1, entity: 'Doc', id: 'other', field: 'body', change: { op: 'remove', presence: 'pY' } });
    await tick();
    assert.deepEqual(frames, [framesCaret.caret, framesCaret.edge, framesCaret.remove]);
    unsubscribe();
    socket.emit('message', framesCaret.caret);
    await tick();
    assert.equal(frames.length, 3);
  } finally {
    h.session.close();
  }
});

test('close retracts presence and closes the caret channel', async () => {
  const h = harness();
  const socket = await openCaretSocket(h);
  h.session.close();
  assert.deepEqual(socket.sent.find((m) => m.type === 'caret.clear'), {
    type: 'caret.clear', entity: 'Doc', id: 'd1', field: 'body',
  });
  assert.equal(socket.readyState, 3);
});

test('a session without carets exposes no caret surface and constructs no channel', async () => {
  const h = harness({ carets: false });
  try {
    assert.equal(h.sockets.length, 0);
    assert.equal('publishCaret' in h.session, false);
    assert.equal('clearCaret' in h.session, false);
    assert.equal('onCaret' in h.session, false);
    // The durable surface still exists unchanged.
    assert.equal(typeof h.session.subscribe, 'function');
    assert.equal(typeof h.session.replace, 'function');
  } finally {
    h.session.close();
  }
});

test('carets option without a wsBaseUrl rejects session construction', () => {
  assert.throws(
    () => createAnnotatedTextHttpSession({
      baseUrl: '/live-delivery',
      context: annotatedContext(),
      historySession: 'caret-session-1',
      fetchImpl: fetchNoServer(),
      carets: {},
    }),
    /carets option requires a wsBaseUrl/,
  );
});

test('a truthy non-function socketFactory rejects synchronously instead of degrading to a no-op channel', () => {
  for (const socketFactory of ['not-a-function', 42, {}, true]) {
    assert.throws(
      () => createAnnotatedTextHttpSession({
        baseUrl: '/live-delivery',
        context: annotatedContext(),
        historySession: 'caret-session-1',
        fetchImpl: fetchNoServer(),
        carets: { wsBaseUrl: 'http://example.test', socketFactory },
      }),
      /socketFactory must be a function/,
      `expected a synchronous TypeError for socketFactory ${JSON.stringify(socketFactory)}`,
    );
  }
});
