import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup({ bootstrap, sendAction } = {}) {
  let delivery;
  let revoke;
  let subscribedAfter;
  let closed = false;
  const session = createLiveDeliverySession({
    bootstrap: bootstrap ?? (async () => ({ kind: 'snapshot', snapshot: { values: [] }, cursor: 1 })),
    subscribe: async ({ after, deliver, revoke: revokeDelivery }) => {
      subscribedAfter = after;
      delivery = deliver;
      revoke = revokeDelivery;
      return { close() { closed = true; } };
    },
    validateSnapshot(snapshot) { return snapshot; },
    fold(snapshot, envelope) {
      return { values: [...snapshot.values, envelope.event.data.value] };
    },
    optimistic(snapshot, action) {
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
