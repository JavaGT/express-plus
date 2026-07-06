// Scope subscription: normalizeSubscribeMsg + end-to-end subscribeScope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubscribeMsg } from '../src/live-admission.mjs';
import { LiveChannel } from '../public/workbench-client.mjs';

test('normalizeSubscribeMsg — old shape {entity, id}', () => {
  const result = normalizeSubscribeMsg({ type: 'subscribe', entity: 'Doc', id: 'd1' });
  assert.deepEqual(result, { scope: 'Doc:d1', interest: { entity: 'Doc', id: 'd1' } });
});

test('normalizeSubscribeMsg — old shape with fields and pace', () => {
  const result = normalizeSubscribeMsg({
    type: 'subscribe', entity: 'Note', id: 'n42',
    fields: { body: true },
    pace: { profile: '15fps' },
  });
  assert.deepEqual(result, {
    scope: 'Note:n42',
    interest: { entity: 'Note', id: 'n42', fields: { body: true }, pace: { profile: '15fps' } },
  });
});

test('normalizeSubscribeMsg — new shape {scope} derives entity/id when scope has colon', () => {
  const result = normalizeSubscribeMsg({ type: 'subscribe', scope: 'project:p1' });
  assert.deepEqual(result, { scope: 'project:p1', interest: { entity: 'project', id: 'p1' } });
});

test('normalizeSubscribeMsg — new shape {scope, interest: {}} keeps empty interest', () => {
  const result = normalizeSubscribeMsg({
    type: 'subscribe', scope: 'room:r1',
    interest: {},
  });
  assert.deepEqual(result, { scope: 'room:r1', interest: {} });
});

test('normalizeSubscribeMsg — new shape {scope, interest} with explicit entity/id', () => {
  const result = normalizeSubscribeMsg({
    type: 'subscribe', scope: 'room:r1',
    interest: { entity: 'Message', id: 'm1' },
  });
  assert.deepEqual(result, {
    scope: 'room:r1',
    interest: { entity: 'Message', id: 'm1' },
  });
});

test('normalizeSubscribeMsg — scope="Entity:id" derives entity/id in interest', () => {
  const result = normalizeSubscribeMsg({ type: 'subscribe', scope: 'Note:n1' });
  assert.deepEqual(result, {
    scope: 'Note:n1',
    interest: { entity: 'Note', id: 'n1' },
  });
});

test('normalizeSubscribeMsg — scope with explicit interest overrides derived entity/id', () => {
  const result = normalizeSubscribeMsg({
    type: 'subscribe', scope: 'project:p1',
    interest: { entity: 'Segment', id: 's42', fields: { text: true } },
  });
  assert.deepEqual(result, {
    scope: 'project:p1',
    interest: { entity: 'Segment', id: 's42', fields: { text: true } },
  });
});

test('normalizeSubscribeMsg — rejects null/undefined/empty scope', () => {
  assert.equal(normalizeSubscribeMsg(null), null);
  assert.equal(normalizeSubscribeMsg({}), null);
  assert.equal(normalizeSubscribeMsg({ type: 'subscribe' }), null);
  assert.equal(normalizeSubscribeMsg({ type: 'subscribe', scope: '' }), null);
  assert.equal(normalizeSubscribeMsg({ type: 'subscribe', entity: 'Doc' }), null);
  assert.equal(normalizeSubscribeMsg([]), null);
  assert.equal(normalizeSubscribeMsg(42), null);
  assert.equal(normalizeSubscribeMsg('hello'), null);
});

test('LiveChannel.subscribe — uses ":" as internal key (not \\0)', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1', { backoffBase: 1, maxBackoff: 1 });
  const sent = [];
  channel._socket = { readyState: 1, send() {} };
  channel._send = (data) => { sent.push(data); };

  channel.subscribe('Doc', 'd1', { fields: { body: true } }, () => {});

  assert.equal(channel._subs.size, 1);
  assert.ok(channel._subs.has('Doc:d1'), 'uses : as key separator');
  assert.equal(channel._pendingSubs.size, 1);
  assert.ok(channel._pendingSubs.has('Doc:d1'));

  channel._handleEnvelope({ type: 'subscribed', scope: 'Doc:d1', entity: 'Doc', id: 'd1', currentSeq: 5 });

  assert.equal(channel._pendingSubs.size, 0);
  channel.close();
});

test('LiveChannel.subscribeScope — sends {scope, interest} wire format', async () => {
  const channel = new LiveChannel('ws://127.0.0.1:1', { backoffBase: 1, maxBackoff: 1 });
  const sent = [];
  channel._socket = { readyState: 1, send() {} };
  channel._send = (data) => { sent.push(data); };

  channel.subscribeScope('project:p1', {
    interest: { entity: 'Segment', id: 's1', fields: { text: true } },
  }, () => {});

  assert.equal(channel._subs.size, 1);
  assert.ok(channel._subs.has('project:p1'));

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: 'subscribe', scope: 'project:p1',
    interest: { entity: 'Segment', id: 's1', fields: { text: true } },
  });

  channel.close();
});

test('LiveChannel.subscribeScope — resolves when subscribed ack received', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1', { backoffBase: 1, maxBackoff: 1 });
  channel._socket = { readyState: 1, send() {} };
  channel._send = () => {};

  const subPromise = channel.subscribeScope('room:r1', () => {});

  channel._handleEnvelope({ type: 'subscribed', scope: 'room:r1', currentSeq: 42 });

  return subPromise.then((ack) => {
    assert.equal(ack.currentSeq, 42);
    assert.equal(channel._pendingSubs.size, 0);
    channel.close();
  });
});

test('LiveChannel.unsubscribeScope — sends {scope} wire format', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1', { backoffBase: 1, maxBackoff: 1 });
  const sent = [];
  channel._socket = { readyState: 1, send() {} };
  channel._send = (data) => { sent.push(data); };
  channel._subs.set('project:p1', { onEvent() {} });

  const unsubPromise = channel.unsubscribeScope('project:p1');

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { type: 'unsubscribe', scope: 'project:p1' });

  channel._handleEnvelope({ type: 'unsubscribed', scope: 'project:p1' });

  return unsubPromise.then(() => {
    assert.equal(channel._subs.size, 0);
    channel.close();
  });
});

test('LiveChannel — backward compat: old subscribe still works end-to-end', () => {
  const channel = new LiveChannel('ws://127.0.0.1:1', { backoffBase: 1, maxBackoff: 1 });
  channel._socket = { readyState: 1, send() {} };
  channel._send = () => {};

  const subPromise = channel.subscribe('Note', 'n1', () => {});

  channel._handleEnvelope({ type: 'subscribed', scope: 'Note:n1', entity: 'Note', id: 'n1', currentSeq: 0 });

  return subPromise.then((ack) => {
    assert.equal(ack.currentSeq, 0);
    assert.ok(channel._subs.has('Note:n1'));
    channel.close();
  });
});
