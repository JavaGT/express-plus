import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createLiveDeliveryHttpHandler } from '../src/server.mjs';
import { createLiveDeliveryHttpSession } from '../public/workbench-client.mjs';

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res).then((handled) => {
    if (!handled && !res.writableEnded) res.writeHead(404).end();
  }));
  server.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/live-delivery` };
}

test('HTTP delivery binds bootstrap, catch-up, recipient envelopes, and abort cleanup without application replay state', async () => {
  const subscriptions = [];
  const delivery = {
    async bootstrap({ principal, scope }) {
      assert.equal(principal.id, 'u1');
      assert.equal(scope, 'Project:p1');
      return { kind: 'snapshot', snapshot: { id: 'p1', name: 'one' }, cursor: 1 };
    },
    async catchup({ after }) {
      return { kind: 'catchup', envelopes: [{ type: 'event', seq: after + 1, event: { type: 'Project.updated', data: { name: 'two' } } }], cursor: after + 1 };
    },
    async subscribe(input) { subscriptions.push(input); return { activate: async () => input.after }; },
  };
  const handler = createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }), maxSubscriptions: 1 });
  const { server, baseUrl } = await serve(handler);
  try {
    const bootstrap = await fetch(`${baseUrl}/bootstrap?scope=Project%3Ap1&mode=snapshot`).then((response) => response.json());
    assert.deepEqual(bootstrap, { kind: 'snapshot', snapshot: { id: 'p1', name: 'one' }, cursor: 1 });
    const catchup = await fetch(`${baseUrl}/bootstrap?scope=Project%3Ap1&mode=catchup&after=1`).then((response) => response.json());
    assert.equal(catchup.envelopes[0].event.data.name, 'two');

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/events?scope=Project%3Ap1&after=1`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    await subscriptions[0].deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(subscriptions[0].signal.aborted, true);
  } finally {
    server.close();
  }
});

test('HTTP delivery rejects malformed requests and enforces a stream cap', async () => {
  const delivery = { bootstrap: async () => ({ kind: 'revoked' }), catchup: async () => ({ kind: 'revoked' }), subscribe: async () => ({ activate: async () => 0 }) };
  const { server, baseUrl } = await serve(createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }) }));
  try {
    assert.equal((await fetch(`${baseUrl}/bootstrap?scope=x&mode=bad`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/bootstrap?scope=x&mode=catchup&after=-1`)).status, 400);
  } finally { server.close(); }
});

test('HTTP delivery reports an initial subscription revocation as forbidden', async () => {
  const delivery = {
    bootstrap: async () => ({ kind: 'revoked' }),
    catchup: async () => ({ kind: 'revoked' }),
    subscribe: async ({ revoke }) => { revoke(); return { activate: async () => undefined }; },
  };
  const { server, baseUrl } = await serve(createLiveDeliveryHttpHandler({ delivery, principalOf: () => ({ type: 'user', id: 'u1' }) }));
  try {
    assert.equal((await fetch(`${baseUrl}/events?scope=x&after=0`)).status, 403);
  } finally { server.close(); }
});

test('HTTP session delegates duplicate, gap and opaque resync recovery to the package session', async () => {
  const requests = [];
  const sources = [];
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (url) => {
      requests.push(url);
      const parsed = new URL(url);
      const mode = parsed.searchParams.get('mode');
      return { ok: true, json: async () => mode === 'catchup'
        ? { kind: 'catchup', envelopes: [{ type: 'event', seq: 2, event: { type: 'update', data: 2 } }], cursor: 2 }
        : { kind: 'snapshot', snapshot: { values: mode === 'snapshot' && requests.length > 2 ? ['fresh'] : [] }, cursor: 1 } };
    },
    eventSourceFactory: (url) => {
      const source = { url, close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
    validateSnapshot: (value) => value,
    fold: (snapshot, envelope) => ({ values: [...snapshot.values, envelope.event.data] }),
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  sources[0].onmessage({ data: JSON.stringify([{ type: 'event', seq: 3, event: { type: 'update', data: 3 } }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.snapshot, { values: [2, 3] });
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 4, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.snapshot, { values: ['fresh'] });
  assert.ok(requests.some((url) => new URL(url).searchParams.get('mode') === 'catchup'));
  session.close();
});

test('HTTP session reserves revocation for authorization responses', async () => {
  for (const [status, expected] of [[403, 'revoked'], [503, 'unavailable']]) {
    const session = createLiveDeliveryHttpSession({
      baseUrl: 'https://example.test/live-delivery', scope: 'Project:p1',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
      eventSourceFactory: () => ({ close() {} }),
      validateSnapshot: (value) => value,
      fold: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
    });
    if (status === 503) await assert.rejects(session.ready, /HTTP 503/);
    else await session.ready;
    assert.equal(session.status, expected);
    session.close();
  }
});

test('HTTP session includes credentials for both bootstrap and SSE', async () => {
  let fetchOptions;
  let sourceOptions;
  const session = createLiveDeliveryHttpSession({
    baseUrl: 'https://live.example.test/live-delivery', scope: 'Project:p1',
    fetchImpl: async (_url, options) => { fetchOptions = options; return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: {}, cursor: 0 }) }; },
    eventSourceFactory: (_url, options) => { sourceOptions = options; return { close() {} }; },
    validateSnapshot: (value) => value,
    fold: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  assert.equal(fetchOptions.credentials, 'include');
  assert.deepEqual(sourceOptions, { withCredentials: true });
  session.close();
});
