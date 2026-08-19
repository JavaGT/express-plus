import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotatedText, annotation, entity, ref } from '../build/index.mjs';
import {
  importTextToFamily, applyTextOperation, textFamilyCheckpoint, materializeText,
  textOperationForOffsetEdit, resolveOffsetToEndpoint,
} from '../public/workbench-annotated-text-continuous.mjs';
import {
  materializeAnnotatedTextSnapshot, projectPendingAnnotatedTextDocument, resolveRangeOffsets,
} from '../public/workbench-annotated-text-snapshot.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';

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

// The pending projector and client run in the PUBLIC module graph; the family
// must be created in that same graph so `assertTrustedFamily` accepts it
// (build/ and public/ carry independent trust domains).
function seedHelloWorld() {
  return importTextToFamily('d1', 'a'.repeat(32), 'hello world');
}

/** An empty recipient-v2 document over `family` (no annotations, no ranges). */
function emptyAnchoredDocument(family) {
  return materializeAnnotatedTextSnapshot({
    kind: 'workbench.annotatedText.recipient', version: 2,
    text: 'hello world',
    ranges: [],
    annotations: [],
    measurements: [],
  }, Document.body, { family });
}

function applyAction(annotation, from, to) {
  return {
    payload: {
      version: 9,
      edit: {
        kind: 'annotation.apply',
        annotation,
        from: { offset: from, affinity: 'right' },
        to: { offset: to, affinity: 'right' },
      },
    },
  };
}

test('projectPendingAnnotatedTextDocument applies an anchored range and keeps it positional under a foreign edit', () => {
  const baseFamily = seedHelloWorld();
  const doc = emptyAnchoredDocument(baseFamily);
  const action = applyAction({ id: 'c1', family: 'note', fields: { label: 'x' } }, 6, 11);

  const projected = projectPendingAnnotatedTextDocument(doc, action, { family: baseFamily });
  assert.ok(projected !== doc);
  assert.equal(projected.annotations.length, 1);
  assert.equal(projected.annotations[0].id, 'c1');
  assert.equal(projected.annotations[0].fields.label, 'x');
  assert.equal(projected.ranges.length, 1);
  // The projected range is recipient-v2 ANCHORED endpoints, not offsets bolted
  // onto the document.
  assert.equal(typeof projected.ranges[0].start, 'object');
  assert.equal(typeof projected.ranges[0].end, 'object');
  assert.deepEqual(resolveRangeOffsets(projected.ranges[0], baseFamily), { annotationId: 'c1', start: 6, end: 11 });

  // A concurrent foreign text edit advances the family (e.g. a foreign insert
  // at the document start). The SAME anchored endpoints hold and resolve to the
  // shifted offsets — the pending range did not drift or corrupt.
  const foreignInsert = textOperationForOffsetEdit(
    baseFamily, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: '^' }, 'b'.repeat(32), 2,
  );
  const nextFamily = applyTextOperation(baseFamily, foreignInsert);
  assert.equal(materializeText(nextFamily), '^hello world');
  assert.deepEqual(projected.ranges[0].start, resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right'));
  assert.deepEqual(projected.ranges[0].end, resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right'));
  assert.deepEqual(resolveRangeOffsets(projected.ranges[0], nextFamily), { annotationId: 'c1', start: 7, end: 12 });
});

test('projectPendingAnnotatedTextDocument reapplies by stable annotation id without duplicating', () => {
  const baseFamily = seedHelloWorld();
  const doc = emptyAnchoredDocument(baseFamily);
  const first = projectPendingAnnotatedTextDocument(doc,
    applyAction({ id: 'c1', family: 'note', fields: { label: 'first' } }, 6, 11), { family: baseFamily });
  assert.equal(first.ranges.length, 1);

  // Reapply the SAME stable id at a new selection: the range is replaced at the
  // latest selection (exactly one row), never duplicated.
  const second = projectPendingAnnotatedTextDocument(first,
    applyAction({ id: 'c1', family: 'note', fields: { label: 'second' } }, 0, 5), { family: baseFamily });
  assert.equal(second.annotations.length, 1);
  assert.equal(second.ranges.length, 1);
  assert.equal(second.annotations[0].fields.label, 'second');
  assert.deepEqual(resolveRangeOffsets(second.ranges[0], baseFamily), { annotationId: 'c1', start: 0, end: 5 });
});

test('projectPendingAnnotatedTextDocument leaves an inapplicable apply unprojected (conflict, no guessed mutation)', () => {
  const baseFamily = seedHelloWorld();
  const doc = emptyAnchoredDocument(baseFamily);
  const mutate = (action, options) => projectPendingAnnotatedTextDocument(doc, action, options);

  // Out-of-bounds selection.
  assert.equal(mutate(applyAction({ id: 'c1', family: 'note', fields: {} }, 0, 100), { family: baseFamily }), doc);
  // Empty (non-forward) selection.
  assert.equal(mutate(applyAction({ id: 'c1', family: 'note', fields: {} }, 5, 5), { family: baseFamily }), doc);
  assert.equal(mutate(applyAction({ id: 'c1', family: 'note', fields: {} }, 8, 3), { family: baseFamily }), doc);
  // An anchored document with no family and no pre-resolved range cannot anchor.
  assert.equal(mutate(applyAction({ id: 'c1', family: 'note', fields: {} }, 0, 5), undefined), doc);
  // A malformed annotation (no stable id) is inapplicable.
  assert.equal(mutate({
    payload: { version: 9, edit: { kind: 'annotation.apply', annotation: { family: 'note', fields: {} }, from: { offset: 0, affinity: 'right' }, to: { offset: 5, affinity: 'right' } } },
  }, { family: baseFamily }), doc);
});

test('affinities must fail closed: an invalid or missing affinity leaves the projection unchanged', () => {
  const baseFamily = seedHelloWorld();
  const doc = emptyAnchoredDocument(baseFamily);
  const apply = (from, to) => ({
    payload: {
      version: 9,
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'c1', family: 'note', fields: { label: 'x' } },
        from: { offset: from, affinity: from === 'right' ? 'right' : (from === 'left' ? 'left' : 'up') },
        to: { offset: to, affinity: to === 'right' ? 'right' : (to === 'left' ? 'left' : 'down') },
      },
    },
  });

  // A valid affinity projects as before.
  const valid = projectPendingAnnotatedTextDocument(doc,
    applyAction({ id: 'c1', family: 'note', fields: { label: 'x' } }, 6, 11), { family: baseFamily });
  assert.notEqual(valid, doc);
  assert.equal(valid.ranges.length, 1);

  // Invalid or missing affinities are inapplicable: the document is returned
  // unchanged — never a silently-defaulted ('right') guessed range.
  const invalidFrom = projectPendingAnnotatedTextDocument(doc, apply('up', 'right'), { family: baseFamily });
  assert.equal(invalidFrom, doc);
  const invalidTo = projectPendingAnnotatedTextDocument(doc, apply('right', 'down'), { family: baseFamily });
  assert.equal(invalidTo, doc);
  const missingFrom = projectPendingAnnotatedTextDocument(doc, {
    payload: { version: 9, edit: { kind: 'annotation.apply', annotation: { id: 'c1', family: 'note', fields: {} }, from: { offset: 6 }, to: { offset: 11, affinity: 'right' } } },
  }, { family: baseFamily });
  assert.equal(missingFrom, doc);
});

test('a captured anchored range is not re-rejected against current text bounds after a foreign delete', () => {
  const baseFamily = seedHelloWorld();
  const doc = emptyAnchoredDocument(baseFamily);
  // Capture [6, 11] ("world") against the original family, exactly as the
  // session does at apply time.
  const action = applyAction({ id: 'c1', family: 'note', fields: { label: 'x' } }, 6, 11);
  const captured = Object.freeze({
    annotationId: 'c1',
    start: resolveOffsetToEndpoint(baseFamily, 6, baseFamily.checkpoint.frontier, 'right'),
    end: resolveOffsetToEndpoint(baseFamily, 11, baseFamily.checkpoint.frontier, 'right'),
  });
  const projected = projectPendingAnnotatedTextDocument(doc, action, { range: captured });
  assert.ok(projected !== doc);
  assert.equal(projected.ranges.length, 1);
  assert.deepEqual(resolveRangeOffsets(projected.ranges[0], baseFamily), { annotationId: 'c1', start: 6, end: 11 });

  // A FOREIGN delete removes the leading character. Current text is now one
  // char shorter, so the fresh-offset bounds check (toOffset > text.length)
  // would wrongly reject [6, 11] — but the CAPTURED structural range must be
  // honored verbatim and rebase to [5, 10] against the advanced family.
  const foreignDelete = textOperationForOffsetEdit(
    baseFamily, { kind: 'text.delete', from: { offset: 0, affinity: 'right' }, to: { offset: 1, affinity: 'right' } }, 'b'.repeat(32), 2,
  );
  const nextFamily = applyTextOperation(baseFamily, foreignDelete);
  assert.equal(materializeText(nextFamily), 'ello world');
  const reprojected = projectPendingAnnotatedTextDocument(doc, action, { range: captured });
  assert.ok(reprojected !== doc, 'captured range must survive a foreign delete that shifts current text length');
  assert.equal(reprojected.ranges.length, 1);
  assert.deepEqual(resolveRangeOffsets(reprojected.ranges[0], nextFamily), { annotationId: 'c1', start: 5, end: 10 });
});

test('a pending annotation apply stays correct across a concurrent remote insert', async () => {
  const baseFamily = seedHelloWorld();
  const sources = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    typingBurstIdleMs: 0,
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-apply',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
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

  // Dispatch a pending annotation apply (no echo yet — we never push its own
  // fold). The optimistic projection should make it visible immediately.
  const pending = session.applyAnnotation({
    mutationId: 'm1',
    annotation: { id: 'c1', family: 'note', fields: { note: 'a' } },
    from: { offset: 6, affinity: 'right' },
    to: { offset: 11, affinity: 'right' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.text, 'hello world');
  assert.equal(session.document.annotations.length, 1);
  assert.equal(session.document.annotations[0].id, 'c1');
  assert.equal(session.document.ranges.length, 1);
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 6, end: 11 });

  // A FOREIGN remote insert arrives while the apply is still pending (a fold
  // whose actionId is not ours). The pending projection must keep the anchored
  // range correct against the advanced family, not re-anchor against a shifted
  // basis or drop it.
  const foreignInsert = textOperationForOffsetEdit(
    baseFamily, { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: '^' }, 'b'.repeat(32), 2,
  );
  const nextFamily = applyTextOperation(baseFamily, foreignInsert);
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'FoldDoc.body.operated', scope: 'Project:p1', seq: 2, actionId: 'prefix' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [foreignInsert] },
      projection: { text: materializeText(nextFamily) },
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
  assert.equal(session.document.annotations.length, 1);
  assert.equal(session.document.annotations[0].id, 'c1');
  assert.equal(session.document.ranges.length, 1);
  // The pending apply tracked the foreign insert: the anchored range now
  // resolves at [7, 12] (world), instead of being lost or re-anchored wrongly.
  assert.deepEqual(resolveRangeOffsets(session.document.ranges[0], session.family), { annotationId: 'c1', start: 7, end: 12 });
  // The mock never delivers a fold echo for this op, so its settlement only
  // resolves on close (settleOperation(status:'closed')). Await AFTER close so
  // the dispatch's settlement.wait() drains instead of hanging the test.
  session.close();
  await pending;
});
