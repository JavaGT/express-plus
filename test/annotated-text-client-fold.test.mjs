import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotatedText, annotation, entity, ref } from '../build/index.mjs';
import { createTextState, applyTextOp, textCheckpoint } from '../build/annotated-text.mjs';
import {
  createTextFamily, applyTextOperation, textFamilyCheckpoint, materializeText,
  textOperationForOffsetEdit, resolveOffsetToEndpoint,
} from '../build/annotated-text-continuous.mjs';
import {
  materializeText as publicMaterializeText, restoreTextFamily,
} from '../public/workbench-annotated-text-continuous.mjs';
import {
  materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument, resolveRangeOffsets,
} from '../public/workbench-annotated-text-snapshot.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';
import { bindAnnotatedTextEditor } from '../public/workbench-annotated-text-editor.mjs';
import { JSDOM } from 'jsdom';

const Document = entity('FoldDoc', {
  project: ref('Project'), owner: ref('User'),
  body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
});

function token(label) {
  return `${label}${'x'.repeat(43)}`.slice(0, 43);
}

function authoringEnvelope(cursor, family) {
  return {
    version: 1, stream: token('stream'), lease: token('lease'), snapshot: token(`snapshot${cursor}`),
    acknowledgementFence: cursor, positionFrames: [{ positionToken: token(`position${cursor}`) }],
    ...(family ? { family } : {}),
  };
}

function seedHelloWorld() {
  const A = 'a'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello world']];
  return createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
}

test('fold keeps anchored ranges and resolves them against the advanced family', async () => {
  const baseFamily = seedHelloWorld();
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const insert = textOperationForOffsetEdit(
    baseFamily, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: '^' }, 'b'.repeat(32), 2,
  );
  const nextFamily = applyTextOperation(baseFamily, insert);
  const nextText = materializeText(nextFamily);

  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world',
              ranges: [{ annotationId: 'c1', start, end }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  assert.equal(typeof session.document.ranges[0].start, 'object');
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 6, end: 11 });

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'FoldDoc.body.operated', scope: 'Project:p1', seq: 2, actionId: 'prefix' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [insert] },
      projection: { text: nextText },
      dispositions: [],
      familyElementCount: Object.keys(nextFamily.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.text, '^hello world');
  assert.deepEqual(session.document.ranges[0].start, start);
  assert.deepEqual(session.document.ranges[0].end, end);
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 7, end: 12 });
  session.close();
});

test('state replacement installs its document and family together without a family-null publication', async () => {
  const family = seedHelloWorld();
  const sources = [];
  let snapshots = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'state-action',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      snapshots += 1;
      return { ok: true, status: 200, json: async () => ({
        kind: 'snapshot', cursor: 1,
        snapshot: { body: { kind: 'workbench.annotatedText.recipient', version: 2, text: 'hello world', ranges: [], annotations: [], orphans: [], measurements: [] } },
        authoring: authoringEnvelope(1, textFamilyCheckpoint(family)),
      }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  const publications = [];
  session.subscribe((document) => publications.push({ document, family: session.family }));
  await session.ready;

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'state', entity: 'Project', id: 'p1', seq: 2,
    state: { body: { kind: 'workbench.annotatedText.recipient', version: 2, text: 'hello world', ranges: [], annotations: [], orphans: [], measurements: [] } },
    authoring: authoringEnvelope(2, textFamilyCheckpoint(family)),
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(snapshots, 1, 'valid state ingestion does not start recovery');
  assert.equal(publications.some(({ document, family: publishedFamily }) => document && publishedFamily == null), false);
  assert.equal(publicMaterializeText(session.family), 'hello world');
  session.close();
});

test('optimistic splice keeps anchored ranges and shifts redacted offsets', () => {
  const family = restoreTextFamily(textFamilyCheckpoint(seedHelloWorld()));
  const start = resolveOffsetToEndpoint(seedHelloWorld(), 6, seedHelloWorld().checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(seedHelloWorld(), 11, seedHelloWorld().checkpoint.frontier, 'right');
  const anchored = materializeAnnotatedTextSnapshot({
    kind: 'workbench.annotatedText.recipient', version: 2,
    text: 'hello world',
    ranges: [{ annotationId: 'c1', start, end }],
    annotations: [{ id: 'c1', family: 'note', fields: {} }],
    measurements: [],
  }, Document.body, { family });
  const afterAnchored = projectPendingAnnotatedTextDocument(anchored, {
    payload: { version: 9, edit: { kind: 'text.insert', at: { offset: 0 }, text: '^' } },
  });
  assert.equal(afterAnchored.text, '^hello world');
  assert.deepEqual(afterAnchored.ranges[0].start, start);
  assert.deepEqual(afterAnchored.ranges[0].end, end);

  const offsetDoc = materializeAnnotatedTextSnapshot({
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: 'hello world',
    ranges: [{ annotationId: 'c1', start: 6, end: 11 }],
    annotations: [{ id: 'c1', family: 'note', fields: {} }],
    measurements: [],
  }, Document.body);
  const afterOffset = projectPendingAnnotatedTextDocument(offsetDoc, {
    payload: { version: 9, edit: { kind: 'text.insert', at: { offset: 0 }, text: '^' } },
  });
  assert.deepEqual(afterOffset.ranges, [{ annotationId: 'c1', start: 7, end: 12 }]);
});

test('session.family tracks every pending insert before its fold arrives', async () => {
  const baseFamily = seedHelloWorld();
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const pending = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return new Promise((resolve) => pending.push(resolve));
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world',
              ranges: [{ annotationId: 'c1', start, end }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const first = session.insert({ mutationId: 'ins-1', at: { offset: 0, affinity: 'right' }, text: '^' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, '^hello world');
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 7, end: 12 });

  const second = session.insert({ mutationId: 'ins-2', at: { offset: 1, affinity: 'right' }, text: '!' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, '^!hello world');
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 8, end: 13 });
  session.close();
  for (const resolve of pending) resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await Promise.allSettled([first, second]);
});

test('queued delete of a repeated character keeps the same anchor through fold', async () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'aaa']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  const start = resolveOffsetToEndpoint(baseFamily, 1, baseFamily.checkpoint.frontier, 'left');
  const end = resolveOffsetToEndpoint(baseFamily, 3, baseFamily.checkpoint.frontier, 'right');
  const deleteOp = textOperationForOffsetEdit(baseFamily, { kind: 'text.delete', from: { offset: 0 }, to: { offset: 1 } }, B, 2);
  const nextFamily = applyTextOperation(baseFamily, deleteOp);
  const nextText = materializeText(nextFamily);
  assert.equal(nextText, 'aa');
  const publicNext = restoreTextFamily(textFamilyCheckpoint(nextFamily));
  assert.equal(resolveRangeOffsets({ annotationId: 'c1', start, end }, publicNext).start, 0);

  const sources = [];
  let number = 0;
  let releaseReceipt;
  const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        await receiptGate;
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      const cursor = ++number;
      const seeded = number === 1 ? baseFamily : nextFamily;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: number === 1 ? 'aaa' : nextText,
              ranges: [{ annotationId: 'c1', start, end }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(seeded)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  const pending = session.delete({
    mutationId: 'del-a',
    from: { offset: 0, affinity: 'right' },
    to: { offset: 1, affinity: 'left' },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, 'aa');
  const optimistic = resolveRangeOffsets(session.document.ranges[0], session.family);
  assert.deepEqual(optimistic, { annotationId: 'c1', start: 0, end: 2 });

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'FoldDoc.body.operated', scope: 'annotated-text:d1', seq: 2, actionId: 'action-1' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [deleteOp] },
      projection: { text: nextText },
      dispositions: [],
      familyElementCount: Object.keys(nextFamily.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseReceipt();
  const result = await pending;
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal((await result.settlement.wait()).status, 'reconciled');
  assert.equal(session.document.text, 'aa');
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), optimistic);
  session.close();
});

test('draft paint uses the queued display family while an earlier insert awaits its fold', async () => {
  const baseFamily = seedHelloWorld();
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const pending = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return new Promise((resolve) => pending.push(resolve));
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world',
              ranges: [{ annotationId: 'c1', start, end }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const first = session.insert({ mutationId: 'ins-1', at: { offset: 0, affinity: 'right' }, text: '^' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const binding = bindAnnotatedTextEditor({ element, session });
  assert.equal(element.textContent, '^hello world');
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');

  const span = element.querySelector('[data-block-id="b"]');
  const walker = span.ownerDocument.createTreeWalker(span, 4);
  const firstNode = walker.nextNode();
  const range = dom.window.document.createRange();
  range.setStart(firstNode, 1);
  range.collapse(true);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new dom.window.InputEvent('beforeinput', {
    bubbles: true, cancelable: true, inputType: 'insertText', data: '!',
  }));
  assert.equal(element.textContent, '^!hello world');
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');
  binding.close();
  session.close();
  for (const resolve of pending) resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await Promise.allSettled([first]);
});

test('a lost-anchor snapshot recovers through a replacement snapshot', async () => {
  const baseFamily = seedHelloWorld();
  const lost = {
    point: ['point', ['element', [['deadbeefdeadbeefdeadbeefdeadbeef', 99], 0]], 'left'],
    basisFrontier: [['deadbeefdeadbeefdeadbeefdeadbeef', 99]],
  };
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const snapshotRequests = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push(cursor);
      const body = number === 1
        ? {
          kind: 'workbench.annotatedText.recipient', version: 2,
          text: 'hello world',
          ranges: [{ annotationId: 'c1', start: lost, end: lost }],
          annotations: [{ id: 'c1', family: 'note', fields: {} }],
          orphans: [], measurements: [],
        }
        : {
          kind: 'workbench.annotatedText.recipient', version: 2,
          text: 'hello world',
          ranges: [{ annotationId: 'c1', start, end }],
          annotations: [{ id: 'c1', family: 'note', fields: {} }],
          orphans: [], measurements: [],
        };
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot', snapshot: { body }, cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const binding = bindAnnotatedTextEditor({ element, session });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(snapshotRequests.length >= 2, 'lost-anchor paint must recover via snapshot');
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 6, end: 11 });
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');
  binding.close();
  session.close();
});

test('a replacement snapshot that still cannot resolve an endpoint closes the session', async () => {
  const baseFamily = seedHelloWorld();
  const lost = {
    point: ['point', ['element', [['deadbeefdeadbeefdeadbeefdeadbeef', 99], 0]], 'left'],
    basisFrontier: [['deadbeefdeadbeefdeadbeefdeadbeef', 99]],
  };
  const snapshotRequests = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push(cursor);
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world',
              ranges: [{ annotationId: 'c1', start: lost, end: lost }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const binding = bindAnnotatedTextEditor({ element, session });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const recovered = snapshotRequests.length;
  assert.equal(recovered, 2, 'one replacement snapshot, then latch');
  session.recoverFromUnresolvableRange();
  session.recoverFromUnresolvableRange();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(snapshotRequests.length, recovered, 'a latched unresolvable snapshot must not reconnect again');
  binding.close();
});

test('redacted v1 materialize stays offset-only and never requires a family', () => {
  const document = materializeAnnotatedTextSnapshot({
    kind: 'workbench.annotatedText.recipient', version: 1,
    text: 'hello world',
    ranges: [{ annotationId: 'c1', start: 6, end: 11 }],
    annotations: [{ id: 'c1', family: 'note', fields: {} }],
    measurements: [],
    redactions: [{ start: 6, end: 6, placeholder: '[x]' }],
  }, Document.body);
  assert.equal(document.version, 1);
  assert.deepEqual(document.ranges, [{ annotationId: 'c1', start: 6, end: 11 }]);
  assert.deepEqual(resolveRangeOffsets(document.ranges[0], null), { annotationId: 'c1', start: 6, end: 11 });
});

test('a combined ab fold drops both queued inserts and keeps a trailing c', async () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello world']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const insertA = textOperationForOffsetEdit(baseFamily, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'a' }, B, 2);
  const familyA = applyTextOperation(baseFamily, insertA);
  const insertB = textOperationForOffsetEdit(familyA, { kind: 'text.insert', at: { offset: 1, affinity: 'right' }, text: 'b' }, 'c'.repeat(32), 3);
  const familyAB = applyTextOperation(familyA, insertB);
  const textAB = materializeText(familyAB);

  const sources = [];
  let number = 0;
  let actionCounter = 0;
  const pending = [];
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionCounter}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return new Promise((resolve) => pending.push(resolve));
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world',
              ranges: [{ annotationId: 'c1', start, end }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  // a and b are contiguous inserts coalesced into ONE typing burst (one
  // actionId); c carries a caller mutationId, which flushes the burst first and
  // is queued as a separate still-pending action.
  const first = session.insert({ at: { offset: 0, affinity: 'right' }, text: 'a' });
  const second = session.insert({ at: { offset: 1, affinity: 'right' }, text: 'b' });
  const third = session.insert({ mutationId: 'ins-c', at: { offset: 2, affinity: 'right' }, text: 'c' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, 'abchello world');
  const beforeFold = resolveRangeOffsets(session.document.ranges[0], session.family);
  assert.deepEqual(beforeFold, { annotationId: 'c1', start: 9, end: 14 });

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'FoldDoc.body.operated', scope: 'annotated-text:d1', seq: 2, actionId: 'action-1' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [insertA, insertB] },
      projection: { text: textAB },
      dispositions: [],
      familyElementCount: Object.keys(familyAB.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.text, 'abchello world');
  assert.equal(publicMaterializeText(session.family), session.document.text);
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), beforeFold);
  session.close();
  for (const resolve of pending) resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await Promise.allSettled([first, second, third]);
});

test('a foreign same-text fold never consumes a local pending edit', async () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const insertOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'aaa']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  // Local delete of the FIRST 'a' vs a foreign delete of the SECOND 'a': both
  // materialize 'aa', so text equality alone cannot tell them apart.
  const foreignDeleteOp = textOperationForOffsetEdit(
    baseFamily, { kind: 'text.delete', from: { offset: 1 }, to: { offset: 2 } }, B, 2,
  );
  const foreignFamily = applyTextOperation(baseFamily, foreignDeleteOp);
  assert.equal(materializeText(foreignFamily), 'aa');

  const sources = [];
  let number = 0;
  let actionCounter = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionCounter}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return new Promise(() => {}); // the local delete never confirms
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'aaa', ranges: [], annotations: [], orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  session.delete({ mutationId: 'del-first', from: { offset: 0, affinity: 'right' }, to: { offset: 1, affinity: 'left' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, 'aa');

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'FoldDoc.body.operated', scope: 'annotated-text:d1', seq: 2, actionId: 'foreign' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [foreignDeleteOp] },
      projection: { text: 'aa' },
      dispositions: [],
      familyElementCount: Object.keys(foreignFamily.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The local delete of the FIRST 'a' is still pending: the foreign fold's 'aa'
  // minus the local delete materializes 'a'. Had the foreign fold consumed the
  // local edit, the text would wrongly remain 'aa'.
  assert.equal(session.document.text, 'a');
  assert.equal(publicMaterializeText(session.family), session.document.text);
  session.close();
});

test('a foreign same-text fold never consumes a pending burst insert', async () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const seedOp = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello world']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), seedOp)));
  // Foreign insert of 'x' at offset 0 produces the same text transition as the
  // local pending insert, so text equality alone cannot tell them apart.
  const foreignInsertOp = textOperationForOffsetEdit(
    baseFamily, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'x' }, B, 2,
  );
  const foreignFamily = applyTextOperation(baseFamily, foreignInsertOp);
  assert.equal(materializeText(foreignFamily), 'xhello world');

  const sources = [];
  let number = 0;
  let actionCounter = 0;
  const session = createAnnotatedTextHttpSession({
    // DEFAULT burst path — deliberately no typingBurstIdleMs: 0, so the local
    // insert stays a pending, un-dispatched typing burst when the fold arrives.
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => `action-${++actionCounter}`,
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return new Promise(() => {}); // the local insert never confirms
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world', ranges: [], annotations: [], orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  const pending = session.insert({ at: { offset: 0, affinity: 'right' }, text: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, 'xhello world');

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'FoldDoc.body.operated', scope: 'annotated-text:d1', seq: 2, actionId: 'foreign' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [foreignInsertOp] },
      projection: { text: 'xhello world' },
      dispositions: [],
      familyElementCount: Object.keys(foreignFamily.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Foreign 'x' plus the still-pending local 'x' materializes 'xxhello world'.
  // Had the foreign fold consumed the local insert, the text would wrongly stay
  // 'xhello world'.
  assert.equal(session.document.text, 'xxhello world');
  assert.equal(publicMaterializeText(session.family), session.document.text);
  session.close();
  await pending;
});

test('a typing-burst insert that splits a surrogate pair is rejected without dispatch', async () => {
  const actor = 'a'.repeat(32);
  const insertOp = ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], 'a😀b']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  let number = 0;
  let posted = 0;
  const session = createAnnotatedTextHttpSession({
    // DEFAULT burst path — deliberately no typingBurstIdleMs: 0.
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        posted += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'a😀b', ranges: [], annotations: [], orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  assert.equal(session.document.text, 'a😀b');
  await assert.rejects(
    session.insert({ at: { offset: 2, affinity: 'right' }, text: 'x' }),
    (error) => error instanceof TypeError && error.message === 'annotated text position splits a surrogate pair',
  );
  assert.equal(session.document.text, 'a😀b');
  assert.equal(posted, 0, 'no mutation was dispatched');
  session.close();
});

test('a successful resolution resets the failure latch for a later independent failure', async () => {
  const baseFamily = seedHelloWorld();
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const lost = {
    point: ['point', ['element', [['deadbeefdeadbeefdeadbeefdeadbeef', 99], 0]], 'left'],
    basisFrontier: [['deadbeefdeadbeefdeadbeefdeadbeef', 99]],
  };
  const snapshotRequests = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push(cursor);
      // snapshot 1 lost, snapshot 2 correct, snapshot 3 lost again
      const ranges = number === 2
        ? [{ annotationId: 'c1', start, end }]
        : [{ annotationId: 'c1', start: lost, end: lost }];
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world', ranges,
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const binding = bindAnnotatedTextEditor({ element, session });
  // The lost initial anchor triggers a one-shot recovery that lands on a
  // correct replacement snapshot, rearming the latch.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(snapshotRequests.length >= 2, 'initial failure recovered via replacement snapshot');
  assert.notEqual(session.status, 'closed');
  // A new independent failure must recover again (fetch snapshot 3) instead of
  // immediately closing.
  session.recoverFromUnresolvableRange();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(snapshotRequests.length >= 3, 'a second independent failure recovers again');
  binding.close();
  session.close();
});

test('snapshot recovery mid-queue drops the optimistic overlay', async () => {
  const baseFamily = seedHelloWorld();
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const sources = [];
  let number = 0;
  const pending = [];
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return new Promise((resolve) => pending.push(resolve));
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world',
              ranges: [{ annotationId: 'c1', start, end }],
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  const first = session.insert({ mutationId: 'ins-1', at: { offset: 0, affinity: 'right' }, text: '^' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.document.text, '^hello world');
  sources[0].onmessage({ data: JSON.stringify([{ type: 'resync', seq: 3, reason: 'opaque' }]) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(publicMaterializeText(session.family), session.document.text);
  assert.deepEqual(
    resolveRangeOffsets(session.document.ranges[0], session.family),
    session.document.text.startsWith('^')
      ? { annotationId: 'c1', start: 7, end: 12 }
      : { annotationId: 'c1', start: 6, end: 11 },
  );
  session.close();
  for (const resolve of pending) resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await Promise.allSettled([first]);
});

test('a replacement snapshot with the same ranges but a working family stays live', async () => {
  const baseFamily = seedHelloWorld();
  const start = resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right');
  const lost = {
    point: ['point', ['element', [['deadbeefdeadbeefdeadbeefdeadbeef', 99], 0]], 'left'],
    basisFrontier: [['deadbeefdeadbeefdeadbeefdeadbeef', 99]],
  };
  const snapshotRequests = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push(cursor);
      const ranges = number === 1
        ? [{ annotationId: 'c1', start: lost, end: lost }]
        : [{ annotationId: 'c1', start, end }];
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'hello world', ranges,
              annotations: [{ id: 'c1', family: 'note', fields: {} }],
              orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const binding = bindAnnotatedTextEditor({ element, session });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(snapshotRequests.length >= 2);
  assert.notEqual(session.status, 'closed');
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 6, end: 11 });
  binding.close();
  session.close();
});

test('a queued insert that splits a surrogate pair is rejected', async () => {
  const actor = 'a'.repeat(32);
  const insertOp = ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], 'a😀b']];
  const baseFamily = createTextFamily('d1', textCheckpoint(applyTextOp(createTextState(), insertOp)));
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 2,
              text: 'a😀b', ranges: [], annotations: [], orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: authoringEnvelope(cursor, textFamilyCheckpoint(baseFamily)),
        }),
      };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  await session.ready;
  assert.equal(session.document.text, 'a😀b');
  const pending = session.insert({ mutationId: 'bad', at: { offset: 2, affinity: 'right' }, text: 'x' });
  assert.equal(session.document.text, 'a😀b');
  session.close();
  await Promise.allSettled([pending]);
});
