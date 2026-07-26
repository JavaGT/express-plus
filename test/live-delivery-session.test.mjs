import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup({ bootstrap, fold: foldImpl, optimistic: optimisticImpl, subscribe: subscribeImpl, validateSnapshot: validateSnapshotImpl, sendAction } = {}) {
  let delivery;
  let revoke;
  let subscribedAfter;
  let closed = false;
  const session = createLiveDeliverySession({
    bootstrap: bootstrap ?? (async () => ({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 })),
    subscribe: subscribeImpl ?? (async ({ after, deliver, revoke: revokeDelivery }) => {
      subscribedAfter = after;
      delivery = deliver;
      revoke = revokeDelivery;
      return { close() { closed = true; } };
    }),
    validateSnapshot: validateSnapshotImpl ?? function validateSnapshot(snapshot) { return snapshot; },
    fold: foldImpl ?? function fold(snapshot, envelope) {
      return { values: [...snapshot.values, envelope.event.data.value] };
    },
    optimistic: optimisticImpl ?? function optimistic(snapshot, action) {
      return { values: [...snapshot.values, `pending:${action.payload.value}`] };
    },
    sendAction: sendAction ?? (async () => ({ ok: true })),
    createActionId: () => 'own-action',
  });
  return {
    session,
    deliver: async (envelopes) => delivery(envelopes),
    revoke: (reason) => revoke(reason),
    subscribedAfter: () => subscribedAfter,
    closed: () => closed,
  };
}

function event(seq, value, actionId = `a${seq}`) {
  return {
    type: 'event', seq, seqSpan: [seq, seq],
    event: { type: 'Value.updated', data: { value }, actionId },
  };
}

describe('LiveDeliverySession', () => {
  it('pairs the validated snapshot with its cursor before subscribing', async () => {
    const { session, subscribedAfter } = setup();
    await session.ready;

    assert.equal(session.cursor, 1);
    assert.deepEqual(session.snapshot, { values: [] });
    assert.equal(subscribedAfter(), 1);
    session.close();
  });

  it('silently drops duplicate delivery and confirms pending work only through its echo', async () => {
    const { session, deliver } = setup();
    await session.ready;

    const dispatched = await session.dispatch('Value.add', { value: 'own' });
    assert.equal(session.pendingCount(), 1);
    await deliver([event(1, 'old')]);
    assert.deepEqual(session.snapshot, { values: ['pending:own'] });

    await deliver([event(2, 'own', dispatched.opId)]);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('does not dispatch an optimistic action before the snapshot cursor is confirmed', async () => {
    const boot = deferred();
    const { session } = setup({ bootstrap: () => boot.promise });
    const result = await session.dispatch('Value.add', { value: 'early' });
    assert.equal(result.ok, false);
    assert.equal(session.pendingCount(), 0);
    boot.resolve({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 });
    await session.ready;
    session.close();
  });

  it('does not publish or dispatch when optimistic projection revokes access', async () => {
    let revoke;
    let sendCount = 0;
    const { session } = setup({
      subscribe: async ({ revoke: revokeDelivery }) => {
        revoke = revokeDelivery;
        return { close() {} };
      },
      optimistic(snapshot) {
        revoke({ code: 'access-revoked' });
        return snapshot;
      },
      sendAction: async () => { sendCount += 1; return { ok: true }; },
    });
    await session.ready;
    const seen = [];
    session.subscribe((snapshot) => seen.push(snapshot));
    const result = await session.dispatch('Value.add', { value: 'blocked' });

    assert.equal(result.ok, false);
    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(sendCount, 0);
    assert.deepEqual(seen, [{ values: [] }, null]);
  });

  it('uses a package-owned contiguous catch-up after a live gap', async () => {
    const calls = [];
    const { session, deliver } = setup({
      bootstrap: async ({ after, mode }) => {
        calls.push({ after, mode });
        if (mode === 'catchup') {
          return { kind: 'catchup', envelopes: [event(2, 'two'), event(3, 'three')], cursor: 3 };
        }
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await deliver([event(3, 'three')]);

    assert.deepEqual(calls, [{ after: undefined, mode: 'snapshot' }, { after: 1, mode: 'catchup' }]);
    assert.equal(session.cursor, 3);
    assert.deepEqual(session.snapshot, { values: ['two', 'three'] });
    session.close();
  });

  it('continues accepting delivery after a rejected malformed batch', async () => {
    const { session, deliver } = setup();
    await session.ready;
    await assert.rejects(deliver([{ type: 'invalid' }]));
    await deliver([event(2, 'two')]);
    assert.deepEqual(session.snapshot, { values: ['two'] });
    session.close();
  });

  it('freshly bootstraps on opaque resync rather than exposing its reason to the fold', async () => {
    const calls = [];
    const { session, deliver } = setup({
      bootstrap: async ({ after, mode }) => {
        calls.push({ after, mode });
        return mode === 'snapshot' && calls.length > 1
          ? { kind: 'snapshot', snapshot: { values: ['fresh'] }, cursor: 4 }
          : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);

    assert.deepEqual(calls, [{ after: undefined, mode: 'snapshot' }, { after: undefined, mode: 'snapshot' }]);
    assert.equal(session.cursor, 4);
    assert.deepEqual(session.snapshot, { values: ['fresh'] });
    session.close();
  });

  it('discards a stale resync snapshot when reconnect catch-up finishes first', async () => {
    const resyncRecovery = deferred();
    const resyncStarted = deferred();
    let snapshotCalls = 0;
    const { session, deliver } = setup({
      bootstrap: async ({ mode }) => {
        if (mode === 'catchup') return { kind: 'catchup', envelopes: [event(2, 'new')], cursor: 2 };
        snapshotCalls += 1;
        if (snapshotCalls > 1) {
          resyncStarted.resolve();
          return resyncRecovery.promise;
        }
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    const resync = deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    await resyncStarted.promise;
    await session.reconnect();
    resyncRecovery.resolve({ kind: 'snapshot', snapshot: { values: ['old'] }, cursor: 1 });
    await resync;

    assert.equal(session.cursor, 2);
    assert.deepEqual(session.snapshot, { values: ['new'] });
    session.close();
  });

  it('reconnects from its confirmed cursor and drops replay overlap', async () => {
    const calls = [];
    const { session, deliver, subscribedAfter } = setup({
      bootstrap: async ({ after, mode }) => {
        calls.push({ after, mode });
        if (mode === 'catchup') return { kind: 'catchup', envelopes: [event(2, 'two')], cursor: 2 };
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await deliver([event(2, 'two')]);
    await session.reconnect();

    assert.deepEqual(calls, [{ after: undefined, mode: 'snapshot' }, { after: 2, mode: 'catchup' }]);
    assert.equal(subscribedAfter(), 2);
    assert.deepEqual(session.snapshot, { values: ['two'] });
    session.close();
  });

  it('fails closed on revoked delivery and clears confirmed and pending state', async () => {
    const held = deferred();
    const { session, closed, revoke } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    assert.equal(session.pendingCount(), 1);

    revoke({ code: 'access-revoked' });
    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(session.pendingCount(), 0);
    assert.equal(closed(), true);
    held.resolve({ ok: true });
    assert.equal((await dispatch).ok, false);
  });

  it('does not report a delivered echo as rolled back when its request fails late', async () => {
    const held = deferred();
    const { session, deliver } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    held.resolve({ ok: false, failure: { message: 'timeout' } });

    assert.equal((await dispatch).ok, true);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('does not report a delivered echo as rolled back when its request rejects late', async () => {
    const held = deferred();
    const { session, deliver } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    held.resolve(Promise.reject(new Error('network reset')));

    assert.equal((await dispatch).ok, true);
    assert.deepEqual(session.snapshot, { values: ['own'] });
    assert.equal(session.pendingCount(), 0);
    session.close();
  });

  it('becomes unavailable when its initial subscription fails', async () => {
    const { session } = setup({ subscribe: async () => { throw new Error('offline'); } });
    await assert.rejects(session.ready, /offline/);
    assert.equal(session.status, 'unavailable');
    assert.equal((await session.dispatch('Value.add', { value: 'blocked' })).ok, false);
    session.close();
  });

  it('closes a subscription that resolves after delivery access is revoked', async () => {
    const subscribed = deferred();
    let closeCount = 0;
    let revoke;
    const { session } = setup({
      subscribe: ({ revoke: revokeDelivery }) => {
        revoke = revokeDelivery;
        return subscribed.promise;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    revoke({ code: 'access-revoked' });
    subscribed.resolve({ close() { closeCount += 1; } });
    await session.ready;
    assert.equal(session.status, 'revoked');
    assert.equal(closeCount, 1);
  });

  it('becomes unavailable when an opaque resync snapshot recovery fails', async () => {
    let calls = 0;
    const { session, deliver } = setup({
      bootstrap: async () => {
        calls += 1;
        if (calls > 1) throw new Error('offline');
        return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
    });
    await session.ready;
    await assert.rejects(deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]), /offline/);
    assert.equal(session.status, 'unavailable');
    session.close();
  });

  it('does not rematerialize state when access is revoked during resync recovery', async () => {
    const recovery = deferred();
    let calls = 0;
    const { session, deliver, revoke } = setup({
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : recovery.promise;
      },
    });
    await session.ready;
    const resync = deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    revoke({ code: 'access-revoked' });
    recovery.resolve({ kind: 'snapshot', snapshot: { values: ['leak'] }, cursor: 2 });
    await resync;

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
  });

  it('does not rematerialize state when snapshot validation revokes access', async () => {
    let calls = 0;
    let revoke;
    let delivery;
    const { session } = setup({
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: ['late'] }, cursor: 2 };
      },
      validateSnapshot(snapshot) {
        if (calls > 1) revoke({ code: 'access-revoked' });
        return snapshot;
      },
      subscribe: async ({ deliver, revoke: revokeDelivery }) => {
        delivery = deliver;
        revoke = revokeDelivery;
        return { close() {} };
      },
    });
    await session.ready;
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(session.cursor, 1);
  });

  it('does not restore live state when a snapshot listener revokes access', async () => {
    let calls = 0;
    let revoke;
    let delivery;
    const { session } = setup({
      bootstrap: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: ['late'] }, cursor: 2 };
      },
      subscribe: async ({ deliver, revoke: revokeDelivery }) => {
        delivery = deliver;
        revoke = revokeDelivery;
        return { close() {} };
      },
    });
    await session.ready;
    let published = 0;
    session.subscribe(() => {
      published += 1;
      if (published === 2) revoke({ code: 'access-revoked' });
    });
    await delivery([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal(session.cursor, 2);
  });

  it('becomes unavailable when catch-up does not cover the delivered gap', async () => {
    const { session, deliver } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? { kind: 'catchup', envelopes: [event(2, 'two')], cursor: 2 }
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
    });
    await session.ready;
    await assert.rejects(deliver([event(5, 'five')]), /remains gapped/);
    assert.equal(session.status, 'unavailable');
    assert.equal((await session.dispatch('Value.add', { value: 'blocked' })).ok, false);
    session.close();
  });

  it('does not restore live state when access is revoked while catch-up folds', async () => {
    let revoke;
    let delivery;
    const { session } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? { kind: 'catchup', envelopes: [event(2, 'two')], cursor: 2 }
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
      fold(snapshot, envelope) {
        revoke({ code: 'access-revoked' });
        return { values: [...snapshot.values, envelope.event.data.value] };
      },
      subscribe: async ({ deliver, revoke: revokeDelivery }) => {
        delivery = deliver;
        revoke = revokeDelivery;
        return { close() {} };
      },
    });
    await session.ready;
    await delivery([event(3, 'three')]);

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
    assert.equal((await session.dispatch('Value.add', { value: 'blocked' })).ok, false);
  });

  it('ignores a delayed close notification from a replaced subscription', async () => {
    const subscriptions = [];
    const bootstrapCalls = [];
    const { session } = setup({
      bootstrap: async (input) => {
        bootstrapCalls.push(input);
        return input.mode === 'catchup'
          ? { kind: 'catchup', envelopes: [], cursor: 1 }
          : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
      },
      subscribe: async ({ closed }) => {
        const entry = { closeCount: 0, closed };
        subscriptions.push(entry);
        return { close() { entry.closeCount += 1; } };
      },
    });
    await session.ready;
    await session.reconnect();
    subscriptions[0].closed();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(subscriptions.length, 2);
    assert.equal(subscriptions[1].closeCount, 0);
    assert.equal(bootstrapCalls.length, 2);
    session.close();
  });

  it('ignores an old transport envelope while reconnect authorization is pending', async () => {
    const recovery = deferred();
    const subscriptions = [];
    const { session } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? recovery.promise
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
      subscribe: async ({ deliver }) => {
        subscriptions.push({ deliver });
        return { close() {} };
      },
    });
    await session.ready;
    const reconnect = session.reconnect();
    await subscriptions[0].deliver([event(2, 'stale')]);
    recovery.resolve({ kind: 'revoked', reason: { code: 'access-revoked' } });
    await reconnect;

    assert.equal(session.status, 'revoked');
    assert.equal(session.snapshot, null);
  });

  it('ignores an old queued resync after reconnect invalidates its transport', async () => {
    const resyncRecovery = deferred();
    const catchupRecovery = deferred();
    const subscriptions = [];
    let snapshotCalls = 0;
    const { session } = setup({
      bootstrap: async ({ mode }) => {
        if (mode === 'catchup') return catchupRecovery.promise;
        snapshotCalls += 1;
        return snapshotCalls === 1
          ? { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 }
          : resyncRecovery.promise;
      },
      subscribe: async ({ deliver }) => {
        subscriptions.push({ deliver });
        return { close() {} };
      },
    });
    await session.ready;
    const staleResync = subscriptions[0].deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    const reconnect = session.reconnect();
    catchupRecovery.resolve({ kind: 'catchup', envelopes: [event(2, 'new')], cursor: 2 });
    await reconnect;
    await subscriptions[1].deliver([event(3, 'newer')]);
    resyncRecovery.resolve({ kind: 'snapshot', snapshot: { values: ['old'] }, cursor: 1 });
    await staleResync;

    assert.equal(session.cursor, 3);
    assert.deepEqual(session.snapshot, { values: ['new', 'newer'] });
    session.close();
  });

  it('does not replay an old gapped envelope after reconnect replaces its transport', async () => {
    const oldCatchup = deferred();
    const reconnectCatchup = deferred();
    const subscriptions = [];
    let catchupCalls = 0;
    const { session } = setup({
      bootstrap: async ({ mode }) => {
        if (mode !== 'catchup') return { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 };
        catchupCalls += 1;
        return catchupCalls === 1 ? oldCatchup.promise : reconnectCatchup.promise;
      },
      subscribe: async ({ deliver }) => {
        subscriptions.push({ deliver });
        return { close() {} };
      },
    });
    await session.ready;
    const oldGap = subscriptions[0].deliver([event(3, 'stale')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reconnect = session.reconnect();
    reconnectCatchup.resolve({ kind: 'catchup', envelopes: [event(2, 'new')], cursor: 2 });
    await reconnect;
    oldCatchup.resolve({ kind: 'catchup', envelopes: [event(2, 'old')], cursor: 2 });
    await oldGap;

    assert.deepEqual(session.snapshot, { values: ['new'] });
    assert.equal(session.cursor, 2);
    session.close();
  });

  it('returns revoked when a post-echo request rejects after access is revoked', async () => {
    const held = deferred();
    const { session, deliver, revoke } = setup({ sendAction: () => held.promise });
    await session.ready;
    const dispatch = session.dispatch('Value.add', { value: 'own' });
    await deliver([event(2, 'own', 'own-action')]);
    revoke({ code: 'access-revoked' });
    held.resolve(Promise.reject(new Error('network reset')));

    assert.equal((await dispatch).ok, false);
  });

  it('accepts a revoked catch-up as terminal rather than failing delivery', async () => {
    const { session, deliver } = setup({
      bootstrap: async ({ mode }) => mode === 'catchup'
        ? { kind: 'revoked', reason: { code: 'access-revoked' } }
        : { kind: 'snapshot', snapshot: { values: [] }, cursor: 1 },
    });
    await session.ready;
    await deliver([event(3, 'late')]);
    assert.equal(session.status, 'revoked');
  });
});
