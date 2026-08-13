import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotatedText, annotation, entity, ref } from '../build/index.mjs';
import { createTextState, applyTextOp, textCheckpoint } from '../build/annotated-text.mjs';
import {
  createTextFamily, applyTextOperation, textFamilyCheckpoint, materializeText,
  textOperationForOffsetEdit, resolveOffsetToEndpoint,
} from '../build/annotated-text-continuous.mjs';
import {
  applyOffsetTextEdit, createTextFamily as createPublicFamily, projectEndpointToOffset,
  restoreTextFamily,
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

test('draft paint moves the marker and stays correct while an earlier edit awaits its fold', async () => {
  const server = seedHelloWorld();
  const start = resolveOffsetToEndpoint(server, 6, server.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(server, 11, server.checkpoint.frontier, 'right');
  const family = createPublicFamily('d1', server.checkpoint);
  const document = {
    version: 2, text: 'hello world',
    ranges: [{ annotationId: 'c1', start, end }],
    annotations: [{ id: 'c1', family: 'note', fields: {} }],
  };
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  const calls = [];
  let listener = null;
  let releaseReplace;
  const replaceGate = new Promise((resolve) => { releaseReplace = resolve; });
  const session = {
    document,
    family,
    replace: async (input) => {
      calls.push(input);
      await replaceGate;
      return { ok: true };
    },
    reconnect() {},
    subscribe(next) { listener = next; return () => { listener = null; }; },
  };
  const binding = bindAnnotatedTextEditor({ element, session });
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');

  const select = (offset) => {
    const span = element.querySelector('[data-block-id="b"]');
    const walker = span.ownerDocument.createTreeWalker(span, 4);
    let remaining = offset;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.data.length) {
        const range = dom.window.document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = dom.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= node.data.length;
    }
  };
  const type = (data) => {
    element.dispatchEvent(new dom.window.InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data,
    }));
  };

  element.focus();
  select(0);
  type('^');
  assert.equal(element.textContent, '^hello world');
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');

  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(calls.length, 1);

  const optimisticFamily = applyOffsetTextEdit(family, 0, 0, '^');
  session.document = { ...document, text: '^hello world' };
  session.family = optimisticFamily;
  listener?.(session.document);
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');

  select(1);
  type('!');
  assert.equal(element.textContent, '^!hello world');
  assert.equal(element.querySelector('[data-annotation-ids="c1"]')?.textContent, 'world');
  assert.equal(projectEndpointToOffset(applyOffsetTextEdit(optimisticFamily, 1, 1, '!'), start), 8);

  releaseReplace();
  binding.close();
});

test('a render-time endpoint resolution failure recovers by snapshot instead of painting stale ranges', () => {
  const server = seedHelloWorld();
  const family = createPublicFamily('d1', server.checkpoint);
  const lost = {
    point: ['point', ['element', [['deadbeefdeadbeefdeadbeefdeadbeef', 99], 0]], 'left'],
    basisFrontier: [['deadbeefdeadbeefdeadbeefdeadbeef', 99]],
  };
  const document = {
    version: 2, text: 'hello world',
    ranges: [{ annotationId: 'c1', start: lost, end: lost }],
    annotations: [{ id: 'c1', family: 'note', fields: {} }],
  };
  const dom = new JSDOM('<div id="editor"></div>');
  const element = dom.window.document.getElementById('editor');
  let reconnects = 0;
  const session = {
    document, family,
    replace: async () => ({ ok: true }),
    reconnect() { reconnects += 1; },
    subscribe() { return () => {}; },
  };
  const binding = bindAnnotatedTextEditor({ element, session });
  assert.ok(reconnects >= 1);
  assert.equal(element.querySelector('[data-annotation-ids="c1"]'), null);
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
