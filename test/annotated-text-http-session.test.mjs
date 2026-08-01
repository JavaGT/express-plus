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

function snapshot(basis = 'basis-1') {
  return {
    body: {
      kind: 'workbench.annotatedText.recipient', version: 1, basis,
      blockGroups: [{ id: 'group-1', blockIds: ['block-1'], annotationIds: [] }],
      blocks: [{ kind: 'visible', id: 'block-1', text: 'Hello', fields: {}, annotationIds: [] }],
      annotations: [], memberships: [], measurements: [], capabilityHints: null,
    },
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
    fetchImpl: async (_url, options) => {
      if (options?.method === 'POST') {
        requests.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      if (accessRevoked) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: snapshot(`basis-${++number}`), cursor: number }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  return { session, requests, sources, revokeAccess: () => { accessRevoked = true; } };
}

test('document session bootstraps recipient snapshot and derives typed insert from its opaque basis', async () => {
  const { session, requests } = setup();
  await session.ready;
  assert.equal(session.document.basis, 'basis-1');
  assert.equal((await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 1 }, text: 'x' })).ok, true);
  assert.deepEqual(requests[0], {
    actionId: 'action-1', clientId: 'tab-a', type: 'LiveDocument.body.operation',
    payload: { version: 6, id: 'd1', basis: 'basis-1', mutationId: 'm1', edit: { kind: 'text.insert', at: { blockId: 'block-1', offset: 1 }, text: 'x' } },
  });
  session.close();
});

test('document session confirms through authorized replacement and refreshes its basis after opaque recovery', async () => {
  const { session, requests, sources } = setup();
  await session.ready;
  await session.insert({ mutationId: 'm1', at: { blockId: 'block-1', offset: 0 }, text: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.basis, 'basis-2');
  await session.delete({ mutationId: 'm2', from: { blockId: 'block-1', offset: 0 }, to: { blockId: 'block-1', offset: 1 } });
  assert.equal(requests[1].payload.basis, 'basis-2');
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 3, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.document.basis, 'basis-4');
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
  await session.split({ mutationId: 'split-1', at: { blockId: 'block-1', offset: 2 } });
  await session.applyAnnotation({ mutationId: 'ann-1', annotation: { id: 'a1', family: 'note', fields: {} }, from: { blockId: 'block-1', offset: 0 }, to: { blockId: 'block-1', offset: 2 } });
  for (const request of requests) {
    assert.equal(request.payload.version, 7);
    assert.equal(request.payload.basis, 'basis-1');
    assert.equal('expected' in request.payload, false);
    assert.equal(JSON.stringify(request).includes('frontier'), false);
  }
  session.close();
});

test('document session translates opaque group selections into one v8 action each', async () => {
  const cases = [
    ['continueBlock', { mutationId: 'continue-1', at: { blockId: 'block-1', offset: 2 } }, { kind: 'block.continue', at: { blockId: 'block-1', offset: 2 } }],
    ['setBlockGroupAssignment', { mutationId: 'assign-1', annotation: { id: 'group-ann-1', family: 'grouping', fields: {} } }, { kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: 'group-1' }, annotation: { id: 'group-ann-1', family: 'grouping', fields: {} } }],
    ['clearBlockGroupAssignment', { mutationId: 'clear-1', family: 'grouping' }, { kind: 'block-group.assignment.clear', selection: { kind: 'listed', blockGroupIds: ['group-1'] }, family: 'grouping' }],
    ['splitAndAssign', { mutationId: 'split-assign-1', at: { blockId: 'block-1', offset: 3 }, annotation: { id: 'group-ann-2', family: 'grouping', fields: {} } }, { kind: 'block.split-and-assign', at: { blockId: 'block-1', offset: 3 }, annotation: { id: 'group-ann-2', family: 'grouping', fields: {} } }],
  ];
  for (const [method, input, edit] of cases) {
    const { session, requests } = setup();
    await session.ready;
    if (method === 'setBlockGroupAssignment' || method === 'clearBlockGroupAssignment') {
      const blockGroup = session.document.blockGroups[0];
      assert.equal(JSON.stringify(blockGroup).includes('group-1'), false);
      input.selection = method === 'setBlockGroupAssignment'
        ? { kind: 'one', blockGroup }
        : { kind: 'listed', blockGroups: [blockGroup] };
    }
    await session[method](input);
    assert.deepEqual(requests[0].payload, { version: 8, id: 'd1', basis: 'basis-1', mutationId: input.mutationId, edit });
    session.close();
  }
});
