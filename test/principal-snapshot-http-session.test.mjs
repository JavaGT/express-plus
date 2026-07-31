import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPrincipalSnapshotHttpSession } from '../public/workbench-client.mjs';

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

test('principal snapshot HTTP session owns scope, recovery, and opaque resync', async () => {
  const sources = [];
  const requests = [];
  const session = createPrincipalSnapshotHttpSession({
    baseUrl: 'http://example.test/live-delivery',
    declaration: 'user-hub',
    principal: { type: 'user', id: 'u/1' },
    validateSnapshot(value) {
      if (!value || !Array.isArray(value.items)) throw new Error('invalid snapshot');
      return value;
    },
    fetchImpl: async (url) => {
      requests.push(String(url));
      return response({ kind: 'snapshot', snapshot: { items: [`v${requests.length}`] }, cursor: requests.length - 1 });
    },
    eventSourceFactory(url) {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push({ url, source });
      return source;
    },
  });
  await session.ready;
  assert.deepEqual(session.snapshot, { items: ['v1'] });
  assert.match(requests[0], /scope=PrincipalSnapshot%3Auser-hub%2Fuser%2Fu%252F1/);
  assert.equal('dispatch' in session, false);
  assert.equal('cursor' in session, false);
  sources[0].source.onmessage({ data: JSON.stringify([{ type: 'resync', seq: 1, reason: 'recipient-snapshot-required' }]) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session.snapshot, { items: ['v2'] });
  session.close();
});

test('principal snapshot HTTP session rejects anonymous and invalid declarations', () => {
  const config = { baseUrl: 'http://example.test/live-delivery', validateSnapshot: (value) => value };
  assert.throws(() => createPrincipalSnapshotHttpSession({ ...config, declaration: 'Bad', principal: { type: 'user', id: 'u1' } }), /declaration/);
  assert.throws(() => createPrincipalSnapshotHttpSession({ ...config, declaration: 'user-hub', principal: { type: 'anonymous', id: 'u1' } }), /principal/);
});
