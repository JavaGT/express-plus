import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveFanout } from '../src/live-fanout.mjs';
import { scope } from '../src/internal.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeConn(id, principalId = id) {
  const messages = [];
  return {
    id,
    closed: false,
    principal: { type: 'user', id: principalId },
    send(message) { messages.push(message); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function makeEntity({ fields = {}, row = { id: 'd1', title: 'v1' } } = {}) {
  return {
    name: 'Doc',
    fields,
    grant: () => [scope().can(() => true)],
    findById() { return row; },
  };
}

test('live fanout stores subscriptions and removes them per connection', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1');
  const entity = makeEntity();

  fanout.addSubscription('Doc', 'd1', conn);
  fanout.addSubscription('Doc', 'd2', conn);

  assert.equal(fanout.subscriptionCount(conn), 2);
  assert.equal(fanout.hasSubscription(conn, 'Doc', 'd1'), true);

  fanout.removeSubscription('Doc', 'd1', conn);
  assert.equal(fanout.subscriptionCount(conn), 1);
  assert.equal(fanout.hasSubscription(conn, 'Doc', 'd1'), false);

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'ignored' }, { type: 'Doc.created', seq: 1, data: { id: 'd1' } });
  assert.deepEqual(conn.drain(), []);

  fanout.removeAll(conn);
  assert.equal(fanout.subscriptionCount(conn), 0);
  assert.equal(fanout.hasSubscription(conn, 'Doc', 'd2'), false);
});

test('live fanout re-authorizes delivery through the injected mayVerb engine', async () => {
  const calls = [];
  const fanout = createLiveFanout({
    mayVerb: async (entity, verb, row, principal) => {
      calls.push({ entity: entity.name, verb, row, principal });
      return principal.id === 'alice';
    },
  });
  const alice = makeConn('c1', 'alice');
  const bob = makeConn('c2', 'bob');
  const entity = makeEntity({ row: { id: 'd1', title: 'new' } });

  fanout.addSubscription('Doc', 'd1', alice);
  fanout.addSubscription('Doc', 'd1', bob);

  await fanout.emit(entity, 'd1', { id: 'd1', title: 'new' }, {
    type: 'Doc.created', seq: 7, data: { id: 'd1', title: 'new' },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.verb), ['subscribe', 'subscribe']);
  assert.deepEqual(alice.drain(), [{
    type: 'event', entity: 'Doc', id: 'd1', seq: 7,
    seqSpan: [7, 7], event: { type: 'Doc.created', seq: 7, data: { id: 'd1', title: 'new' } },
  }]);
  assert.deepEqual(bob.drain(), []);
  assert.equal(fanout.hasSubscription(bob, 'Doc', 'd1'), true, 'denied subscriber remains registered');
});

test('live fanout delivers removed events without re-authorization', async () => {
  let calls = 0;
  const fanout = createLiveFanout({
    mayVerb: async () => { calls += 1; return false; },
  });
  const conn = makeConn('c1', 'revoked');
  const entity = makeEntity();

  fanout.addSubscription('Doc', 'd1', conn);
  await fanout.emit(entity, 'd1', undefined, { type: 'Doc.removed', seq: 3 });

  assert.equal(calls, 0, 'remove is the revocation signal, so delivery skips mayVerb');
  assert.deepEqual(conn.drain(), [{
    type: 'event', entity: 'Doc', id: 'd1', seq: 3,
    seqSpan: [3, 3], event: { type: 'Doc.removed', seq: 3 },
  }]);
});

test('live fanout re-authorizes paced flush and clears the buffer on denial', async () => {
  let allowed = true;
  const fanout = createLiveFanout({ mayVerb: async () => allowed });
  const conn = makeConn('c1', 'alice');
  const entity = makeEntity({
    fields: { cursor: { kind: 'ephemeral' } },
    row: { id: 'd1', title: 'drawing' },
  });

  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 20, by: 'latest-wins' });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 1, data: { x: 1 },
  });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 2, data: { x: 2 },
  });

  allowed = false;
  await sleep(60);

  assert.deepEqual(conn.drain(), [], 'revoked subscriber receives nothing at flush time');

  allowed = true;
  await sleep(30);
  assert.deepEqual(conn.drain(), [], 'denied flush clears the buffer instead of retrying stale events');
});

test('live fanout close clears paced timers before they emit', async () => {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const conn = makeConn('c1', 'alice');
  const entity = makeEntity({
    fields: { cursor: { kind: 'ephemeral' } },
    row: { id: 'd1', title: 'drawing' },
  });

  fanout.addSubscription('Doc', 'd1', conn, { cursor: true }, { window: 20, by: 'latest-wins' });
  await fanout.emit(entity, 'd1', { id: 'd1', title: 'drawing' }, {
    type: 'Doc.cursor.set', seq: 1, data: { x: 1 },
  });

  fanout.close();
  await sleep(60);

  assert.deepEqual(conn.drain(), []);
  assert.equal(fanout.subscriptionCount(conn), 0);
});
