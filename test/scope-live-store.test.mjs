import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScopeLiveStore } from '../public/workbench-client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeChannel() {
  let onEvent;
  let onCheckpoint;
  return {
    scope: null,
    subscribeScope(scope, options, listener) {
      this.scope = scope;
      onEvent = listener;
      onCheckpoint = options.onCheckpoint;
      return Promise.resolve({ currentSeq: 1 });
    },
    unsubscribeScope() { return Promise.resolve(); },
    close() {},
    emit(seq, type, data, actionId) {
      onEvent({
        type: 'event', scope: this.scope, seq, seqSpan: [seq, seq],
        event: { type, data, actionId },
      });
    },
    reconnect(currentSeq) { onCheckpoint({ currentSeq }); },
  };
}

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function setup({ sendAction, replay = [] } = {}) {
  const channel = fakeChannel();
  const fetchImpl = async (url) => String(url).includes('/snapshot')
    ? response({ snapshot: { values: [] }, cursors: { 'project:p1': 1 } })
    : response({ scope: 'project:p1', events: replay });
  const store = createScopeLiveStore({
    baseUrl: 'http://test',
    scope: 'project:p1',
    channel,
    fetchImpl,
    validateSnapshot(value) {
      if (!value || !Array.isArray(value.values)) throw new Error('invalid snapshot');
      return value;
    },
    fold(snapshot, event) {
      return { values: [...snapshot.values, event.data.value] };
    },
    optimistic(snapshot, action) {
      return { values: [...snapshot.values, `pending:${action.payload.value}`] };
    },
    sendAction: sendAction ?? (async () => ({ ok: true })),
    createActionId: () => 'own-action',
  });
  return { store, channel };
}

describe('ScopeLiveStore', () => {
  it('confirms an optimistic operation through its own echo and the one fold path', async () => {
    const { store, channel } = setup();
    await store.ready;

    const result = await store.dispatch('Value.add', { value: 'own' });
    assert.equal(result.ok, true);
    assert.deepEqual(store.snapshot, { values: ['pending:own'] });
    assert.equal(store.pendingCount(), 1);

    channel.emit(2, 'Value.added', { value: 'own' }, result.opId);
    assert.deepEqual(store.snapshot, { values: ['own'] });
    assert.equal(store.pendingCount(), 0);
    store.close();
  });

  it('folds foreign events without disturbing a pending optimistic operation', async () => {
    const held = deferred();
    const { store, channel } = setup({ sendAction: () => held.promise });
    await store.ready;
    const dispatch = store.dispatch('Value.add', { value: 'own' });

    channel.emit(2, 'Value.added', { value: 'foreign' }, 'foreign-action');
    assert.deepEqual(store.snapshot, { values: ['foreign', 'pending:own'] });
    assert.equal(store.pendingCount(), 1);
    held.resolve({ ok: true });
    await dispatch;
    store.close();
  });

  it('fills a live gap through replay before applying the queued frame', async () => {
    const { store, channel } = setup({
      replay: [
        { scope: 'project:p1', seq: 2, type: 'Value.added', data: { value: 'two' }, actionId: 'a2' },
        { scope: 'project:p1', seq: 3, type: 'Value.added', data: { value: 'three' }, actionId: 'a3' },
      ],
    });
    await store.ready;
    channel.emit(3, 'Value.added', { value: 'three' }, 'a3');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(store.cursor, 3);
    assert.deepEqual(store.snapshot, { values: ['two', 'three'] });
    store.close();
  });

  it('rolls back a failed optimistic projection and keeps failure visible', async () => {
    const { store } = setup({ sendAction: async () => ({ ok: false, failure: { message: 'denied' } }) });
    await store.ready;
    const result = await store.dispatch('Value.add', { value: 'no' });

    assert.equal(result.status, 'failed-rolled-back');
    assert.deepEqual(store.snapshot, { values: [] });
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.failedCount(), 1);
    assert.equal(store.operations()[0].error.message, 'denied');
    store.close();
  });

  it('publishes pending operation status while dispatch is in flight', async () => {
    const held = deferred();
    const { store } = setup({ sendAction: () => held.promise });
    await store.ready;
    const dispatch = store.dispatch('Value.add', { value: 'later' });

    assert.equal(store.pendingCount(), 1);
    assert.equal(store.operations()[0].status, 'pending');
    assert.deepEqual(store.snapshot, { values: ['pending:later'] });
    held.resolve({ ok: true });
    await dispatch;
    store.close();
  });

  it('uses a reconnect checkpoint to replay from the current scope cursor', async () => {
    const replay = [{ scope: 'project:p1', seq: 2, type: 'Value.added', data: { value: 'reconnected' }, actionId: 'a2' }];
    const { store, channel } = setup({ replay });
    await store.ready;
    channel.reconnect(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(store.cursor, 2);
    assert.deepEqual(store.snapshot, { values: ['reconnected'] });
    store.close();
  });
});
