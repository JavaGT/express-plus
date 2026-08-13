import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLiveStore } from '../public/workbench-client.mjs';
import { applyTextOp, createTextState, textCheckpoint } from '../build/annotated-text.mjs';
import { deleteText, insertText } from '../public/workbench-text-edit.mjs';

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function replica() {
  const states = new Map();
  return {
    reserve: async (document, generate) => {
      const state = states.get(document) ?? { actor: ACTOR, counter: 0, lamport: 0, outbox: [] };
      const next = { ...state, counter: state.counter + 1, lamport: state.lamport + 1 };
      const operation = generate(next);
      const record = { operation, actionId: `text:${encodeURIComponent(document)}:${ACTOR}:${next.counter}`, counter: next.counter, replica: ACTOR,
        body: JSON.stringify({ operation }), status: 'pending', failure: null };
      states.set(document, { ...next, outbox: [...state.outbox, record] }); // durable before the caller sends.
      return record;
    },
    head: async (document) => states.get(document)?.outbox[0] ?? null,
    commit: async (document, counter) => {
      const state = states.get(document);
      assert.equal(state.outbox[0].counter, counter);
      states.set(document, { ...state, outbox: state.outbox.slice(1) });
    },
    block: async (document, counter, failure) => {
      const state = states.get(document);
      assert.equal(state.outbox[0].counter, counter);
      states.set(document, { ...state, outbox: [{ ...state.outbox[0], status: 'blocked', failure }, ...state.outbox.slice(1)] });
    },
    reconcile: async (document) => states.get(document)?.outbox ?? [],
  };
}

test('text generation creates canonical inserts, observes counters, and deletes exact visible spans', () => {
  let state = createTextState();
  const first = insertText(state, { actor: ACTOR, counter: 1, lamport: 1 }, 0, 'a😀b');
  assert.deepEqual(first, ['workbench.text', 1, [ACTOR, 1], 1, [], ['insert', ['root'], 'a😀b']]);
  state = applyTextOp(state, first);
  const second = insertText(state, { actor: ACTOR, counter: 2, lamport: 2 }, 3, 'x');
  assert.deepEqual(second[4], [[ACTOR, 1]]);
  assert.deepEqual(second[5][1], ['element', [[ACTOR, 1], 1]]);
  const deleted = deleteText(state, { actor: ACTOR, counter: 2, lamport: 2 }, 1, 3);
  assert.deepEqual(deleted[5], ['delete', [[[ACTOR, 1], 1, 1]]]);
  assert.throws(() => insertText(state, { actor: ACTOR, counter: 2, lamport: 2 }, 2, 'x'), /surrogate/);
  assert.throws(() => deleteText(state, { actor: ACTOR, counter: 2, lamport: 2 }, 2, 3), /surrogate/);
});

test('shared durable reservations retain counter, Lamport clock, and causal dependency across reloads', async () => {
  const storage = replica();
  let state = createTextState();
  const first = (await storage.reserve('Doc\0d1\0body', (reservation) => insertText(state, reservation, 0, 'a'))).operation;
  state = applyTextOp(state, first);
  const second = (await storage.reserve('Doc\0d1\0body', (reservation) => insertText(state, reservation, 1, 'b'))).operation;
  assert.deepEqual(second.slice(2, 5), [[ACTOR, 2], 2, [[ACTOR, 1]]]);
});

test('sibling text fields have distinct durable action identities at the row receipt scope', async () => {
  const storage = replica();
  const state = createTextState();
  const body = await storage.reserve('Doc\0d1\0body', (identity) => insertText(state, identity, 0, 'a'));
  const notes = await storage.reserve('Doc\0d1\0notes', (identity) => insertText(state, identity, 0, 'b'));
  assert.notEqual(body.actionId, notes.actionId);
  assert.match(body.actionId, /Doc%00d1%00body/);
  assert.match(notes.actionId, /Doc%00d1%00notes/);
});

test('store.text generates and posts native operations without mutating the LiveList row', async () => {
  const calls = [];
  const store = createLiveStore({
    baseUrl: 'http://test', name: 'Doc', path: '/docs', replicaState: replica(),
    channel: { subscribe: async () => ({ currentSeq: 0 }), unsubscribe: async () => {}, close() {} },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/snapshot/')) return { ok: true, status: 200, json: async () => ({
        snapshot: { id: 'd1', body: '' }, seq: 0,
        reducers: [{ entity: 'Doc', id: 'd1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }],
      }) };
      return { ok: true, status: 200, json: async () => ({ id: 'd1', body: '' }) };
    },
  });
  const list = store.subscribe('d1');
  await list.ready;
  const result = await store.text('d1', 'body').insert({ at: 0, text: 'hello' });
  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(calls.at(-1).options.headers['x-workbench-action-id'], `text:Doc%00d1%00body:${ACTOR}:1`);
  assert.equal(calls.at(-1).url, 'http://test/docs/d1/body/apply');
  assert.deepEqual(list.state, { id: 'd1', body: '' });
  const operation = JSON.parse(calls.at(-1).options.body).operation;
  assert.equal(operation[2][1], 1);
  assert.equal(operation[3], 1);
  store.close();
});

test('LiveList readiness waits for durable replica observation before enabling text edits', async () => {
  let releaseObservation;
  const observed = new Promise((resolve) => { releaseObservation = resolve; });
  let observedBeforeReserve = false;
  const storage = {
    ...replica(),
    reconcile: async () => { await observed; return []; },
    reserve: async (document, generate) => {
      observedBeforeReserve = true;
      return replica().reserve(document, generate);
    },
  };
  const store = createLiveStore({
    baseUrl: 'http://test', name: 'Doc', path: '/docs', replicaState: storage,
    channel: { subscribe: async () => ({ currentSeq: 0 }), unsubscribe: async () => {}, close() {} },
    fetchImpl: async (url) => url.includes('/snapshot/')
      ? { ok: true, status: 200, json: async () => ({
        snapshot: { id: 'd1', body: '' }, seq: 0,
        reducers: [{ entity: 'Doc', id: 'd1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }],
      }) }
      : { ok: true, status: 200, json: async () => ({}) },
  });
  const list = store.subscribe('d1');
  let ready = false;
  list.ready.then(() => { ready = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  releaseObservation();
  await list.ready;
  assert.equal(ready, true);
  await store.text('d1', 'body').insert({ at: 0, text: 'x' });
  assert.equal(observedBeforeReserve, true);
  store.close();
});

test('text editing fails closed without a durable browser replica adapter', async () => {
  const store = createLiveStore({ baseUrl: 'http://test', name: 'Doc', path: '/docs', channel: { close() {} }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(store.text('d1', 'body').insert({ at: 0, text: 'x' }), /ready/);
  store.close();
});

test('two concurrent store.text inserts serialize reservation/generation and create causal counters without rejection', async () => {
  const calls = [];
  const store = createLiveStore({
    baseUrl: 'http://test', name: 'Doc', path: '/docs', replicaState: replica(),
    channel: { subscribe: async () => ({ currentSeq: 0 }), unsubscribe: async () => {}, close() {} },
    fetchImpl: async (url, options = {}) => {
      if (url.includes('/snapshot/')) return { ok: true, status: 200, json: async () => ({
        snapshot: { id: 'd1', body: '' }, seq: 0,
        reducers: [{ entity: 'Doc', id: 'd1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }],
      }) };
      calls.push({ url, method: options?.method, body: options?.body });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const list = store.subscribe('d1');
  await list.ready;
  const [first, second] = await Promise.all([
    store.text('d1', 'body').insert({ at: 0, text: 'hello' }),
    store.text('d1', 'body').insert({ at: 5, text: ' world' }),
  ]);
  // Concurrent inserts serialize allocation and delivery, so both commit in order.
  assert.equal(first.status, 'committed');
  assert.equal(second.status, 'committed');
  const firstBody = JSON.parse(calls[0].body);
  assert.equal(firstBody.operation[2][1], 1);
  assert.equal(calls.length, 2);
  const secondBody = JSON.parse(calls[1].body);
  assert.equal(secondBody.operation[2][1], 2);
  assert.equal(secondBody.operation[3], 2);
  assert.deepEqual(secondBody.operation[4], [[ACTOR, 1]]);
  store.close();
});

test('authoritative remote .applied event rebase preserves pending local operation and next local edit can anchor after remote text', async () => {
  const REMOTE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  let liveCallback;
  const docStates = new Map();
  const storage = {
    reserve: async (document, generate) => {
      const state = docStates.get(document) ?? { actor: ACTOR, counter: 0, lamport: 0, frontier: [], outbox: [] };
      const next = { ...state, counter: state.counter + 1, lamport: state.lamport + 1 };
      const operation = generate(next);
      const record = { operation, actionId: `text:${encodeURIComponent(document)}:${ACTOR}:${next.counter}`, counter: next.counter, replica: ACTOR,
        body: JSON.stringify({ operation }), status: 'pending', failure: null };
      docStates.set(document, { ...next, outbox: [...state.outbox, record] });
      return record;
    },
    head: async (document) => docStates.get(document)?.outbox[0] ?? null,
    commit: async (document, counter) => {
      const state = docStates.get(document);
      assert.equal(state.outbox[0]?.counter, counter);
      state.outbox = state.outbox.slice(1);
      docStates.set(document, state);
    },
    block: async (document, counter, failure) => {
      const state = docStates.get(document);
      assert.equal(state.outbox[0]?.counter, counter);
      state.outbox[0] = { ...state.outbox[0], status: 'blocked', failure };
      docStates.set(document, state);
    },
    reconcile: async (document, observation) => {
      const stored = docStates.get(document) ?? { actor: ACTOR, counter: 0, lamport: 0, frontier: [], outbox: [] };
      const frontier = [...(stored.frontier ?? [])];
      for (const [a, c] of observation.frontier ?? []) {
        const idx = frontier.findIndex(([x]) => x === a);
        if (idx >= 0) frontier[idx] = [a, Math.max(frontier[idx][1], c)];
        else frontier.push([a, c]);
      }
      frontier.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const ownObserved = frontier.find(([a]) => a === ACTOR)?.[1] ?? 0;
      docStates.set(document, {
        ...stored,
        counter: Math.max(stored.counter, ownObserved),
        frontier,
        lamport: Math.max(stored.lamport, observation.lamport ?? 0),
      });
      return [...(stored.outbox ?? [])];
    },
  };
  const calls = [];
  let response = 'unknown';
  const store = createLiveStore({
    baseUrl: 'http://test', name: 'Doc', path: '/docs', replicaState: storage,
    channel: {
      subscribe: async (_entity, _id, _opts, cb) => { liveCallback = cb; return { currentSeq: 0 }; },
      unsubscribe: async () => {}, close() {},
    },
    fetchImpl: async (url, options = {}) => {
      if (url.includes('/snapshot/')) return { ok: true, status: 200, json: async () => ({
        snapshot: { id: 'd1', body: '' }, seq: 0,
        reducers: [{ entity: 'Doc', id: 'd1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }],
      }) };
      calls.push({ url, body: options?.body });
      if (response === 'unknown') throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const list = store.subscribe('d1');
  await list.ready;
  // First insert goes outcome-unknown — local "a" reserved as counter 1
  assert.equal((await store.text('d1', 'body').insert({ at: 0, text: 'a' })).status, 'outcome-unknown');
  // Simulate remote .applied event inserting "bc" at root
  const remoteOp = ['workbench.text', 1, [REMOTE, 1], 1, [], ['insert', ['root'], 'bc']];
  liveCallback({
    seq: 1, seqSpan: [1, 1],
    event: { type: 'Doc.body.applied', data: { operation: remoteOp } },
    delta: undefined, reducers: [],
  });
  await list.textReducerReady;
  // Now the draft state should be remote "bc" + pending local "a" = "bca"
  // Next insert at position 0 anchors at root-left (before remote "bc").
  // The pending head (counter 1) blocks the send, so the insert queues.
  response = 'ok';
  const result = await store.text('d1', 'body').insert({ at: 0, text: 'x' });
  assert.equal(result.status, 'queued');
  // Retry the head (counter 1) to commit it
  assert.equal((await store.retryText('d1', 'body')).status, 'committed');
  // Now counter 2 is the head
  assert.equal((await store.retryText('d1', 'body')).status, 'committed');
  const sentOp = JSON.parse(calls.at(-1).body).operation;
  assert.equal(sentOp[2][1], 2);
  assert.equal(sentOp[5][0], 'insert');
  assert.deepEqual(sentOp[5][1], ['root']);
  assert.ok(sentOp[4].some(([a]) => a === ACTOR), 'depends on own prior op');
  assert.ok(sentOp[4].some(([a]) => a === REMOTE), 'depends on remote op');
  store.close();
});

test('invalid text does not allocate a counter, and an unknown outcome retries exact durable bytes', async () => {
  const calls = [];
  const storage = replica();
  let attempts = 0;
  const store = createLiveStore({
    baseUrl: 'http://test', name: 'Doc', path: '/docs', replicaState: storage,
    channel: { subscribe: async () => ({ currentSeq: 0 }), unsubscribe: async () => {}, close() {} },
    fetchImpl: async (url, options = {}) => {
      if (url.includes('/snapshot/')) return { ok: true, status: 200, json: async () => ({ snapshot: { id: 'd1', body: '' }, seq: 0, reducers: [{ entity: 'Doc', id: 'd1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }] }) };
      calls.push(options);
      if (++attempts === 1) throw new Error('connection lost');
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const list = store.subscribe('d1');
  await list.ready;
  await assert.rejects(store.text('d1', 'body').insert({ at: 1, text: 'x' }));
  assert.equal((await store.text('d1', 'body').insert({ at: 0, text: 'x' })).status, 'outcome-unknown');
  assert.equal((await store.retryText('d1', 'body')).status, 'committed');
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['x-workbench-action-id'], calls[1].headers['x-workbench-action-id']);
  assert.equal(JSON.parse(calls[1].body).operation[2][1], 1);
  store.close();
});

test('text sender holds later counters behind an unknown head and blocks the replica after a definitive failure', async () => {
  const storage = replica();
  const calls = [];
  let response = 'unknown';
  const store = createLiveStore({
    baseUrl: 'http://test', name: 'Doc', path: '/docs', replicaState: storage,
    channel: { subscribe: async () => ({ currentSeq: 0 }), unsubscribe: async () => {}, close() {} },
    fetchImpl: async (url, options = {}) => {
      if (url.includes('/snapshot/')) return { ok: true, status: 200, json: async () => ({ snapshot: { id: 'd1', body: '' }, seq: 0, reducers: [{ entity: 'Doc', id: 'd1', field: 'body', reducer: 'workbench.text', version: 1, checkpoint: textCheckpoint(createTextState()) }] }) };
      calls.push(options);
      if (response === 'unknown') throw new Error('offline');
      return { ok: false, status: 403, json: async () => ({ ok: false, failure: { category: 'denied', message: 'no' } }) };
    },
  });
  const list = store.subscribe('d1');
  await list.ready;
  assert.equal((await store.text('d1', 'body').insert({ at: 0, text: 'a' })).status, 'outcome-unknown');
  assert.equal((await store.text('d1', 'body').insert({ at: 0, text: 'b' })).status, 'queued');
  assert.equal(calls.length, 1, 'counter two was not sent before counter one committed');
  response = 'denied';
  assert.equal((await store.retryText('d1', 'body')).status, 'blocked');
  assert.equal((await store.retryText('d1', 'body')).status, 'blocked');
  assert.equal(calls.length, 2, 'blocked head prevents all future sends');
  store.close();
});
