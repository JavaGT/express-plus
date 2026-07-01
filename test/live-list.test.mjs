// LiveList tests — pure JS, NO real server. Injects a fake channel + fake fetch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LiveList } from '../public/express-plus-client.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deferred promise { promise, resolve, reject }. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Build a FakeChannel. */
function makeFakeChannel() {
  const subs = new Map();
  let subscribeAck = { currentSeq: 1 };

  const channel = {
    _setAck(ack) { subscribeAck = ack; },
    subscribe(entity, id, onEvent) {
      const key = `${entity}\0${String(id)}`;
      if (subs.has(key)) throw new Error(`already subscribed to ${entity}:${id}`);
      subs.set(key, onEvent);
      return Promise.resolve(subscribeAck);
    },
    unsubscribe(entity, id) {
      subs.delete(`${entity}\0${String(id)}`);
      return Promise.resolve();
    },
    close() {},
    emit(envelope) {
      const key = `${envelope.entity}\0${String(envelope.id)}`;
      const onEvent = subs.get(key);
      if (onEvent) onEvent(envelope);
    },
  };
  return channel;
}

/** Build a fake fetch with routes: [{ match, response }] or [{ match, responseFn }]. */
function makeFakeFetch(routes) {
  return async (url) => {
    const urlStr = typeof url === 'string' ? url : String(url);
    for (const route of routes) {
      if (urlStr.includes(route.match)) {
        const body = typeof route.responseFn === 'function'
          ? route.responseFn(urlStr)
          : route.response;
        return { ok: true, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
}

function snapshotUrl(e, id) { return `/api/${e}/${id}/snapshot`; }
function eventsSinceUrl(e, id, cursor) { return `/api/${e}/${id}/events?cursor=${cursor}`; }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveList', () => {

  // --- 1. Bootstrap ---
  it('bootstrap: snapshot sets initial state + cursor; ready resolves; onRender fired', async () => {
    const channel = makeFakeChannel();
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello', score: 10 }, seq: 42 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });

    const renders = [];
    list.onRender(s => renders.push(s));

    await list.subscribe();
    assert.equal(list.cursor, 42);
    assert.deepEqual(list.state, { title: 'hello', score: 10 });
    assert.equal(renders.length, 1);
    assert.deepEqual(renders[0], { title: 'hello', score: 10 });
    await list.close();
  });

  // --- 2. Live .updated value delta ---
  it('live .updated value delta applies + advances cursor + re-renders', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    const renders = [];
    list.onRender(s => renders.push(s));

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'world' } },
    });

    assert.equal(list.cursor, 2);
    assert.equal(list.state.title, 'world');
    assert.equal(renders.length, 1);
    assert.deepEqual(renders[0], { title: 'world' });
    await list.close();
  });

  // --- 3. Queued-before-ready (deferred ack) ---
  it('queued-before-ready: deferred ack, emit before resolve, queue applied after ready', async () => {
    const subs = new Map();
    const deferredAck = deferred();

    const channel = {
      subscribe(e, id, onEvent) {
        subs.set(`${e}\0${id}`, onEvent);
        return deferredAck.promise;
      },
      unsubscribe(e, id) {
        subs.delete(`${e}\0${id}`);
        return Promise.resolve();
      },
      close() {},
      emit(envelope) {
        const onEvent = subs.get(`${envelope.entity}\0${envelope.id}`);
        if (onEvent) onEvent(envelope);
      },
      _resolveAck(ack) { deferredAck.resolve(ack); },
    };

    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello', count: 0 }, seq: 5 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });

    const renders = [];
    list.onRender(s => renders.push(s));

    // Start subscribe — pauses at channel.subscribe waiting on deferred ack.
    const subPromise = list.subscribe();

    // Yield to let the async subscribe() reach channel.subscribe() and
    // register the onEvent callback.
    await new Promise(r => setTimeout(r, 0));

    // Now the callback is registered; emit an envelope — it will be queued
    // because _ready is still false.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 6, seqSpan: [6, 6],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'queued-update' } },
    });

    // Resolve the ack — this should trigger the queue drain.
    channel._resolveAck({ currentSeq: 5 });

    await subPromise;

    assert.equal(list.cursor, 6);
    assert.equal(list.state.title, 'queued-update');
    assert.equal(renders.length, 2); // bootstrap render + queued render
    await list.close();
  });

  // --- 4. Span-aware dup skip ---
  it('span-aware: envelope with seqSpan below cursor is skipped', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 5 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { val: 1 }, seq: 5 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: {} },
      delta: { val: { set: 99 } },
    });

    assert.equal(list.cursor, 5);
    assert.equal(list.state.val, 1);
    await list.close();
  });

  // --- 5. Span-aware gap → resync ---
  it('span-aware gap triggers resync via events-since, state catches up', async () => {
    const channel = makeFakeChannel();

    // Use a responseFn for /events so we can return different results for the
    // bootstrap resync (cursor=3, fill events 4-5) and the gap resync
    // (cursor=5, fill event 6).
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { val: 'a' }, seq: 3 } },
      {
        match: '/events',
        responseFn: (url) => {
          const m = url.match(/cursor=(\d+)/);
          const cursor = m ? parseInt(m[1], 10) : 0;
          if (cursor <= 3) {
            // Bootstrap resync: fill events 4-5
            return { events: [
              { type: 'ticket.updated', scope: 'ticket', seq: 4, data: { val: 'b' }, actionId: 'a1', committedAt: 1 },
              { type: 'ticket.updated', scope: 'ticket', seq: 5, data: { val: 'c' }, actionId: 'a2', committedAt: 2 },
            ] };
          }
          // Gap resync: fill event 6
          return { events: [
            { type: 'ticket.updated', scope: 'ticket', seq: 6, data: { val: 'd' }, actionId: 'a3', committedAt: 3 },
          ] };
        },
      },
    ]);

    // Bootstrap: snapshot gives seq 3, but ack reports currentSeq 5 →
    // subscribe() triggers a bootstrap resync that fills seq 4-5.
    channel._setAck({ currentSeq: 5 });

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();
    assert.equal(list.cursor, 5);
    assert.equal(list.state.val, 'c');

    // Emit a live event at seq 7 (gap at seq 6) — triggers resync.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 7, seqSpan: [7, 7],
      event: { type: 'ticket.updated', data: {} },
      delta: { val: { set: 'e' } },
    });

    // Wait for the async resync to complete.
    await new Promise(r => setTimeout(r, 20));

    assert.equal(list.cursor, 7);
    assert.equal(list.state.val, 'e');
    await list.close();
  });

  // --- 6. CRDT delta ---
  it('crdt delta: insert then delete then replace on a string field', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { text: 'Hello World' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    // Insert " beautiful" at position 5 (after "Hello", before " World")
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { text: { insert: { at: 5, text: ' beautiful' } } },
    });
    assert.equal(list.state.text, 'Hello beautiful World');

    // Delete length 9 at position 6 — removes "beautiful"
    // "Hello beautiful World" → pos 6 is 'b', del 9 chars → removes 'beautiful'
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: {} },
      delta: { text: { delete: { at: 6, length: 9 } } },
    });
    assert.equal(list.state.text, 'Hello  World');

    // Delete+insert at same offset: replace " World" with " Bob"
    // "Hello  World" → delete at 6 length 6 → removes " World", insert at 6 " Bob"
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 4, seqSpan: [4, 4],
      event: { type: 'ticket.updated', data: {} },
      delta: {
        text: {
          delete: { at: 6, length: 6 },
          insert: { at: 6, text: ' Bob' },
        },
      },
    });
    assert.equal(list.state.text, 'Hello  Bob');

    await list.close();
  });

  // --- 7. Ordered ops ---
  it('ordered: inserted items sorted by fractional key; moved re-sorts; removed drops', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { items: [] }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    // NOTE: keys are NUMERIC (server column is `key REAL`, entity.mjs keyBetween
    // produces numbers). The client must sort numerically to match SQLite
    // `ORDER BY key`. Keys 2 and 10 below are the divergence guard: a string sort
    // would order "10" before "2" — a numeric sort orders 2 before 10.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.items.inserted', data: { owner: 'u1', id: 'a', key: 3, value: 'alpha' } },
    });
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.items.inserted', data: { owner: 'u1', id: 'b', key: 2, value: 'beta' } },
    });
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 4, seqSpan: [4, 4],
      event: { type: 'ticket.items.inserted', data: { owner: 'u1', id: 'c', key: 10, value: 'gamma' } },
    });

    // Numeric sort by key: 2='beta', 3='alpha', 10='gamma'.
    // (A string sort would give beta, gamma[="10"], alpha — the divergence.)
    assert.deepEqual(list.state.items, ['beta', 'alpha', 'gamma']);

    // Move 'c' to key 2.5 → beta, gamma, alpha (2, 2.5, 3)
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 5, seqSpan: [5, 5],
      event: { type: 'ticket.items.moved', data: { owner: 'u1', id: 'c', key: 2.5 } },
    });
    assert.deepEqual(list.state.items, ['beta', 'gamma', 'alpha']);

    // Remove 'a' → beta, gamma
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 6, seqSpan: [6, 6],
      event: { type: 'ticket.items.removed', data: { owner: 'u1', id: 'a' } },
    });
    assert.deepEqual(list.state.items, ['beta', 'gamma']);

    await list.close();
  });

  // --- 8. Map delta ---
  it('map delta: added/changed/removed produce correct map object', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { members: { alice: 'owner' } }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { members: { added: [{ member: 'bob', role: 'editor' }] } },
    });
    assert.deepEqual(list.state.members, { alice: 'owner', bob: 'editor' });

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 3, seqSpan: [3, 3],
      event: { type: 'ticket.updated', data: {} },
      delta: { members: { changed: [{ member: 'alice', role: 'viewer' }] } },
    });
    assert.deepEqual(list.state.members, { alice: 'viewer', bob: 'editor' });

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 4, seqSpan: [4, 4],
      event: { type: 'ticket.updated', data: {} },
      delta: { members: { removed: ['bob'] } },
    });
    assert.deepEqual(list.state.members, { alice: 'viewer' });

    await list.close();
  });

  // --- 9. Struct delta ---
  it('struct delta: cells set updates nested struct object', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { config: { theme: 'dark' } }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { config: { cells: { theme: { set: 'light' }, fontSize: { set: 14 } } } },
    });

    assert.deepEqual(list.state.config, { theme: 'light', fontSize: 14 });
    await list.close();
  });

  // --- 10. .removed CRUD ---
  it('.removed CRUD → state becomes null', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { title: 'hello' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.removed', data: {} },
    });

    assert.equal(list.state, null);
    assert.equal(list.cursor, 2);
    await list.close();
  });

  // --- 11. Resync stale → re-bootstrap ---
  it('events-since resync stale forces re-bootstrap from fresh snapshot', async () => {
    let snapshotCalls = 0;
    const channel = makeFakeChannel();

    // Bootstrap: ack.currentSeq matches snapshot seq so no bootstrap resync.
    channel._setAck({ currentSeq: 3 });

    const fetch = makeFakeFetch([
      {
        match: '/snapshot',
        responseFn: () => {
          snapshotCalls++;
          if (snapshotCalls === 1) return { snapshot: { title: 'old' }, seq: 3 };
          return { snapshot: { title: 'fresh' }, seq: 10 };
        },
      },
      {
        match: '/events',
        response: { resync: 'stale', reason: 'server restarted' },
      },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();
    assert.equal(snapshotCalls, 1);
    assert.equal(list.cursor, 3);
    assert.equal(list.state.title, 'old');

    // Emit a gap to trigger resync (expects seq 5, got seq 7).
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 7, seqSpan: [7, 7],
      event: { type: 'ticket.updated', data: {} },
      delta: { title: { set: 'ignored' } },
    });

    await new Promise(r => setTimeout(r, 20));

    assert.equal(snapshotCalls, 2);
    assert.equal(list.state.title, 'fresh');
    assert.equal(list.cursor, 10);
    await list.close();
  });

  // --- 12. Close ---
  it('close(): after close, further emitted envelopes do not change state or render', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 1 });
    const fetch = makeFakeFetch([
      { match: '/snapshot', response: { snapshot: { val: 'initial' }, seq: 1 } },
    ]);

    const list = new LiveList({
      entity: 'ticket', id: '1', channel, fetchImpl: fetch,
      snapshotUrl, eventsSinceUrl,
    });
    await list.subscribe();

    const renders = [];
    list.onRender(s => renders.push(s));

    await list.close();

    // After close, emits should be ignored.
    channel.emit({
      type: 'event', entity: 'ticket', id: '1',
      seq: 2, seqSpan: [2, 2],
      event: { type: 'ticket.updated', data: {} },
      delta: { val: { set: 'should-not-apply' } },
    });

    assert.equal(list.state.val, 'initial');
    assert.equal(renders.length, 0);
    await list.close(); // idempotent — should not throw
  });

});