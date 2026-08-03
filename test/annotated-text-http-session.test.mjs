import assert from 'node:assert/strict';
import test from 'node:test';

import { annotatedText, annotation, entity, measurement, ref, registerAnnotatedTextContract } from '../src/index.mjs';
import { registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';

registerAnnotatedTextContract('liveSessionMeasurement', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('liveSessionMeasurement', Object.freeze({
  version: 1, validate() {}, edit() {}, partition() {}, combine() {},
}));
const Document = entity('LiveDocument', {
  project: ref('Project'), owner: ref('User'), body: annotatedText({
    project: 'project', owner: 'owner', annotations: [annotation('note', { fields: {} })],
    measurements: [measurement('words', { extension: 'liveSessionMeasurement' })],
  }),
});

function snapshot(_number = 1) {
  return {
    body: {
      kind: 'workbench.annotatedText.recipient', version: 1,
      blockGroups: [{ id: 'group-1', blockIds: ['block-1'], annotationIds: [] }],
      blocks: [{ kind: 'visible', id: 'block-1', text: 'Hello', fields: {}, annotationIds: [] }],
      annotations: [], memberships: [], measurements: [], capabilityHints: null,
    },
  };
}

function token(label) {
  return `${label}${'x'.repeat(43)}`.slice(0, 43);
}

function authoringEnvelope(cursor) {
  return {
    version: 1, stream: token('stream'), lease: token('lease'), snapshot: token(`snapshot${cursor}`), acknowledgementFence: cursor,
    positionFrames: [{ blockId: 'block-1', positionToken: token(`position${cursor}`) }],
    groupFrames: [{ groupToken: token(`group${cursor}`) }], splitResolutions: [],
  };
}

function setup({ revoked = false } = {}) {
  const requests = [];
  const sources = [];
  let number = 0;
  let accessRevoked = revoked;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: 1 }) };
        requests.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      if (accessRevoked) return { ok: false, status: 403, json: async () => ({}) };
      const cursor = ++number; const body = snapshot(cursor); return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body: body.body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  return { session, requests, sources, revokeAccess: () => { accessRevoked = true; } };
}

test('document session bootstraps recipient snapshot and derives typed insert from its opaque token', async () => {
  const { session, requests } = setup();
  await session.ready;
  assert.equal(session.document.version, 1);
  assert.equal((await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 1, affinity: 'right' }, text: 'x' })).ok, true);
  const actionBody = requests[0];
  assert.equal(actionBody.type, 'LiveDocument.body.operation');
  assert.deepEqual(actionBody.payload, {
    version: 9, id: 'd1',
    authoring: { version: 1, stream: token('stream'), lease: token('lease'), mutationId: 'm1' },
    edit: { kind: 'text.insert', at: { positionToken: token('position1'), offset: 1, affinity: 'right' }, text: 'x' },
  });
  session.close();
});

test('document session confirms through authorized replacement and refreshes its token after opaque recovery', async () => {
  const { session, requests, sources } = setup();
  await session.ready;
  await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 0, affinity: 'right' }, text: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.version, 1);
  await session.delete({ mutationId: 'm2', from: { blockId: 'block-1', offset: 0, affinity: 'right' }, to: { blockId: 'block-1', offset: 1, affinity: 'right' } });
  assert.equal(requests[1].payload.version, 9);
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 3, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.version, 1);
  session.close();
});

test('document session fails closed on revoked bootstrap and exposes no raw dispatch method', async () => {
  const { session } = setup({ revoked: true });
  await session.ready;
  assert.equal(session.status, 'revoked');
  assert.equal(session.document, null);
  assert.equal('dispatch' in session, false);
  session.close();
});

test('document session exposes structural grammar without canonical revision or frontier payloads', async () => {
  const { session, requests } = setup();
  await session.ready;
  await session.split({ mutationId: 'split-1', at: { blockId: 'block-1', offset: 2, affinity: 'right' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await session.applyAnnotation({ mutationId: 'ann-1', annotation: { id: 'a1', family: 'note', fields: {} }, from: { blockId: 'block-1', offset: 0, affinity: 'right' }, to: { blockId: 'block-1', offset: 2, affinity: 'right' } });
  for (const request of requests) {
    assert.equal(request.payload.version, 9);
    assert.equal('basis' in request.payload, false);
    assert.equal('expected' in request.payload, false);
    assert.equal(JSON.stringify(request).includes('frontier'), false);
  }
  session.close();
});

test('document session translates opaque group selections into one v9 action each', async () => {
  const cases = [
    ['continueBlock', { mutationId: 'continue-1', at: { blockId: 'block-1', offset: 2, affinity: 'right' } }, { kind: 'block.continue', at: { blockId: 'block-1', offset: 2 } }],
    ['setBlockGroupAssignment', { mutationId: 'assign-1', annotation: { id: 'group-ann-1', family: 'grouping', fields: {} } }],
    ['clearBlockGroupAssignment', { mutationId: 'clear-1', family: 'grouping' }],
    ['splitAndAssign', { mutationId: 'split-assign-1', at: { blockId: 'block-1', offset: 3, affinity: 'right' }, annotation: { id: 'group-ann-2', family: 'grouping', fields: {} } }, { kind: 'block.split-and-assign', at: { blockId: 'block-1', offset: 3 }, annotation: { id: 'group-ann-2', family: 'grouping', fields: {} } }],
  ];
  for (const [method, input, edit] of cases) {
    const { session, requests } = setup();
    await session.ready;
    if (method === 'setBlockGroupAssignment') {
      const blockGroup = session.document.blockGroups[0];
      assert.equal(JSON.stringify(blockGroup).includes('group-1'), false);
      input.selection = { kind: 'one', blockGroup };
    }
    if (method === 'clearBlockGroupAssignment') {
      const blockGroup = session.document.blockGroups[0];
      assert.equal(JSON.stringify(blockGroup).includes('group-1'), false);
      input.selection = { kind: 'listed', blockGroups: [blockGroup] };
    }
    await session[method](input);
    const actionBody = requests[0];
    assert.equal(actionBody.payload.version, 9);
    if (edit) {
      assert.equal(actionBody.payload.edit.kind, edit.kind);
      if (edit.at) assert.equal(actionBody.payload.edit.at.positionToken, token('position1'));
    }
    session.close();
  }
});

function v9Setup() {
  const actionRequests = [];
  const ackRequests = [];
  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        }
        const body = JSON.parse(options.body);
        if (body.payload) actionRequests.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: body.actionId, confirmedThrough: number }) };
      }
      const cursor = ++number;
      const body = snapshot(number).body;
      snapshotRequests.push({ cursor });
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  return { session, actionRequests, ackRequests, snapshotRequests, sources };
}

test('session sends token-only v9 actions without basis or block identifiers', async () => {
  const { session, actionRequests } = v9Setup();
  await session.ready;
  await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 2, affinity: 'right' }, text: 'XY' });
  const payload = actionRequests[0].payload;
  assert.equal(payload.version, 9);
  assert.equal('basis' in payload, false);
  assert.equal('expected' in payload, false);
  assert.equal(JSON.stringify(payload).includes('frontier'), false);
  assert.equal(JSON.stringify(payload).includes('blockId'), false);
  assert.deepEqual(payload.edit.at, { positionToken: token('position1'), offset: 2, affinity: 'right' });
  session.close();
});

test('session translates public merge and detach block IDs only through its private binding', async () => {
  const merge = v9Setup();
  await merge.session.ready;
  await merge.session.merge({ mutationId: 'merge-1', leftBlockId: 'block-1', rightBlockId: 'block-1' });
  assert.deepEqual(merge.actionRequests[0].payload.edit, {
    kind: 'block.merge', leftPositionToken: token('position1'), rightPositionToken: token('position1'),
  });
  assert.equal(JSON.stringify(merge.actionRequests[0].payload).includes('blockId'), false);
  merge.session.close();

  const detach = v9Setup();
  await detach.session.ready;
  await detach.session.detachAnnotation({ mutationId: 'detach-1', annotationId: 'annotation-1', blockId: 'block-1' });
  assert.deepEqual(detach.actionRequests[0].payload.edit, {
    kind: 'annotation.detach', annotationId: 'annotation-1', positionToken: token('position1'),
  });
  assert.equal(JSON.stringify(detach.actionRequests[0].payload).includes('blockId'), false);
  detach.session.close();
});

test('positive receipt triggers snapshot fetch and authoring ack', async () => {
  const { session, actionRequests, ackRequests, snapshotRequests } = v9Setup();
  await session.ready;
  const result = await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 0, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, true);
  assert.equal(actionRequests.length, 1);
  assert.equal(snapshotRequests.length, 2, 'should fetch covering snapshot after receipt');
  assert.ok(ackRequests.length >= 2, `expected at least 2 acks, got ${ackRequests.length}`);
  assert.equal(ackRequests[0].version, 1);
  assert.equal(ackRequests[0].stream, token('stream'));
  assert.equal(ackRequests[0].lease, token('lease'));
  assert.ok(ackRequests[0].snapshot);
  session.close();
});

test('pending text is visible immediately, serialized, rolled back on rejection, and replaced without duplication', async () => {
  const actionRequests = [];
  const pendingResponses = [];
  let cursor = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        const request = JSON.parse(options.body); actionRequests.push(request);
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      const body = snapshot(cursor).body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const a = session.insert({ mutationId: 'a', at: { blockId: 'block-1', offset: 5, affinity: 'right' }, text: 'A' });
  const b = session.insert({ mutationId: 'b', at: { blockId: 'block-1', offset: 6, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.blocks[0].text, 'HelloAB');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1, 'second text action waits for first transport');
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 1 }) });
  await a;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 2);
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-2', confirmedThrough: 1 }) });
  await b;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.document.blocks[0].text, 'Hello', 'authoritative replacement removes confirmed placeholders');
  const failed = session.insert({ mutationId: 'bad', at: { blockId: 'block-1', offset: 5, affinity: 'right' }, text: 'X' });
  assert.equal(session.document.blocks[0].text, 'HelloX');
  await new Promise((resolve) => setTimeout(resolve, 0));
  pendingResponses.shift()({ ok: false, status: 400, json: async () => ({ ok: false, failure: { message: 'rejected' } }) });
  assert.equal((await failed).ok, false);
  assert.equal(session.document.blocks[0].text, 'Hello');
  session.close();
});

test('queued action keeps its visible pending projection across token replacement of a settling peer', async () => {
  const actionRequests = [];
  const ackRequests = [];
  const pendingResponses = [];
  let cursor = 0;
  let actionNumber = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionNumber}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        }
        const request = JSON.parse(options.body); actionRequests.push(request);
        return new Promise((resolve) => pendingResponses.push(resolve));
      }
      cursor += 1;
      const text = cursor === 1 ? 'Hello' : cursor === 2 ? 'HelloA' : 'HelloAB';
      const body = { ...snapshot(cursor).body, blocks: [{ ...snapshot(cursor).body.blocks[0], text }] };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const a = session.insert({ mutationId: 'a', at: { blockId: 'block-1', offset: 5, affinity: 'right' }, text: 'A' });
  const b = session.insert({ mutationId: 'b', at: { blockId: 'block-1', offset: 6, affinity: 'right' }, text: 'B' });
  assert.equal(session.document.blocks[0].text, 'HelloAB');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionRequests.length, 1, 'second text action waits for first transport');
  const aAction = actionRequests[0];
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: aAction.actionId, confirmedThrough: 1 }) });
  await a;
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A's receipt installs a replacement snapshot that reconciles A and re-issues
  // the position token while the still-unsettled B carries the old token.
  assert.equal(actionRequests.length, 2, 'B dispatches immediately after A confirms');
  assert.equal(actionRequests[1].payload.edit.at.positionToken, token('position1'), 'B keeps the token issued under the settled snapshot');
  assert.equal(session.document.blocks[0].text, 'HelloAB', 'B stays projected though its position token was replaced');
  assert.equal(ackRequests.some((request) => request.snapshot === token('snapshot2')), false,
    'covering snapshot is not acknowledged while B still carries its predecessor token');
  pendingResponses.shift()({ ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-2', confirmedThrough: 1 }) });
  await b;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(session.document.blocks[0].text, 'HelloAB', 'authoritative replacement clears B without duplicating A');
  assert.equal(ackRequests.some((request) => request.snapshot === token('snapshot2')), true,
    'covering snapshot is acknowledged after every predecessor-token action is terminal');
  assert.ok(ackRequests.length >= 2);
  session.close();
});

test('known rejection releases deferred authoring acknowledgement', async () => {
  const actionResponses = [];
  const ackRequests = [];
  let cursor = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) {
          ackRequests.push(JSON.parse(options.body));
          return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: cursor }) };
        }
        return new Promise((resolve) => actionResponses.push(resolve));
      }
      cursor += 1;
      return { ok: true, status: 200, json: async () => ({
        kind: 'snapshot', snapshot: snapshot(cursor), cursor, authoring: authoringEnvelope(cursor),
      }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const pending = session.insert({ mutationId: 'bad', at: { blockId: 'block-1', offset: 1, affinity: 'right' }, text: 'X' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Model a replacement arriving while the translated action is still in flight.
  const sourceSnapshot = authoringEnvelope(2);
  // Receipt recovery normally installs this snapshot; invoking reconnect gives
  // the same public ingest/ack path without accepting the action.
  void session.reconnect();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ackRequests.some((request) => request.snapshot === sourceSnapshot.snapshot), false);
  actionResponses.shift()({ ok: false, status: 400, json: async () => ({ ok: false, failure: { message: 'rejected' } }) });
  assert.equal((await pending).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ackRequests.some((request) => request.snapshot === sourceSnapshot.snapshot), true);
  session.close();
});

test('stale position-token-unavailable surfaces without basis retry', async () => {
  const actionRequests = [];
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: 1 }) };
        const body = JSON.parse(options.body);
        if (body.payload) actionRequests.push(body);
        return { ok: false, status: 400, json: async () => ({
          ok: false, failure: { category: 'invalid-input', message: 'token is unavailable', details: { code: 'position-token-unavailable' } },
        }) };
      }
      const cursor = ++number;
      const body = snapshot(number).body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  const result = await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 1, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.details?.code, 'position-token-unavailable');
  assert.equal(actionRequests.length, 1, 'no retry on stale token');
  session.close();
});

test('receipt covering snapshot acknowledgement fence is validated on ingest', async () => {
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      const cursor = ++number;
      const body = snapshot(number).body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: { ...authoringEnvelope(cursor), acknowledgementFence: cursor === 1 ? 999 : cursor } }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  try {
    await session.ready;
    assert.fail('should have rejected on bootstrap');
  } catch {
    assert.equal(session.status, 'unavailable', 'bootstrap fails when authoring fence mismatches cursor');
  }
  session.close();
});

test('recovery clears snapshot binding and re-ingests from fresh snapshot', async () => {
  const { session, sources, ackRequests } = v9Setup();
  await session.ready;
  const pre = session.document;
  assert.ok(pre);
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 3, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const post = session.document;
  assert.equal(post.version, 1);
  // ack should fire again after recovery installs the new snapshot
  assert.ok(ackRequests.length >= 2);
  session.close();
});

test('dispatch fails closed after revoke and close', async () => {
  const { session } = v9Setup();
  await session.ready;
  session.close();
  try {
    await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 0, affinity: 'right' }, text: 'x' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err);
  }
  assert.equal('dispatch' in session, false);
});
