// Contract test for the shared test fakes in ./fixtures/fake-transport.mjs.
// Guards the canonical channel/fetch contract so future drift is caught by the
// suite: subscribe fires on emit, fetch routes match, and the capability
// superset (checkpoint/resync/_setAck/calls/status/headers) stays intact.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';

describe('fake-transport', () => {
  it('channel: subscribe registers a callback that fires on emit and not after unsubscribe', async () => {
    const channel = makeFakeChannel();
    const received = [];
    const ack = await channel.subscribe('Doc', '1', {}, (envelope) => received.push(envelope));
    assert.deepEqual(ack, { currentSeq: 1 });

    const envelope = { type: 'event', entity: 'Doc', id: '1', seq: 2, event: { type: 'Doc.updated', data: {} } };
    channel.emit(envelope);
    assert.deepEqual(received, [envelope]);

    await channel.unsubscribe('Doc', '1');
    channel.emit(envelope);
    assert.equal(received.length, 1, 'unsubscribed callback must not fire');
  });

  it('channel: _setAck feeds the subscribe ack and calls are recorded', async () => {
    const channel = makeFakeChannel();
    channel._setAck({ currentSeq: 7 });
    const ack = await channel.subscribe('Doc', '1', { fields: { cursor: true } }, () => {});
    assert.deepEqual(ack, { currentSeq: 7 });
    assert.equal(channel.calls.length, 1);
    assert.equal(channel.calls[0].entity, 'Doc');
    assert.equal(channel.calls[0].id, '1');
    assert.deepEqual(channel.calls[0].options.fields, { cursor: true });
  });

  it('channel: checkpoint and resync deliver to the registered option callbacks', async () => {
    const channel = makeFakeChannel();
    const checkpoints = [];
    const resyncs = [];
    await channel.subscribe('Doc', '1', {
      onCheckpoint: ({ currentSeq }) => checkpoints.push(currentSeq),
      onResync: (control) => resyncs.push(control),
    }, () => {});
    channel.checkpoint('Doc', '1', 5);
    channel.resync('Doc', '1', { type: 'resync', entity: 'Doc', id: '1', seq: 9 });
    assert.deepEqual(checkpoints, [5]);
    assert.deepEqual(resyncs, [{ type: 'resync', entity: 'Doc', id: '1', seq: 9 }]);
  });

  it('fetch: routes match by substring with status, headers, responseFn, and 404 fallback', async () => {
    const fetch = makeFakeFetch([
      { match: '/snapshot/Doc/1', response: { snapshot: { id: '1' }, seq: 1 } },
      { match: '/docs', responseFn: (url) => ({ id: 'new', from: url }), headers: { 'x-workbench-seq': '3' } },
    ]);

    const snap = await fetch('http://test/snapshot/Doc/1');
    assert.equal(snap.ok, true);
    assert.equal(snap.status, 200);
    assert.deepEqual(await snap.json(), { snapshot: { id: '1' }, seq: 1 });

    const create = await fetch('http://test/docs');
    assert.equal(create.status, 200);
    assert.equal(create.headers.get('x-workbench-seq'), '3');
    assert.equal(create.headers.get('nope'), null);
    assert.deepEqual(await create.json(), { id: 'new', from: 'http://test/docs' });

    const miss = await fetch('http://test/other');
    assert.equal(miss.ok, false);
    assert.equal(miss.status, 404);
    assert.equal(miss.headers.get('x-workbench-seq'), null);
  });
});
