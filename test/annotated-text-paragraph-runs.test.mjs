import assert from 'node:assert/strict';
import { test } from 'node:test';

import { annotatedText, annotation, entity, ref } from '../build/index.mjs';
import { assertUtf16Range } from '../build/annotated-text.mjs';
import {
  applyTextOperation,
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamily,
  textFamilyCheckpoint,
} from '../build/annotated-text-continuous.mjs';
import {
  planTextOffsetEdit,
  planTextRangeApply,
} from '../build/annotated-text-plan.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';

const ACTOR = 'a'.repeat(32);
const EDIT_ACTOR = 'b'.repeat(32);

function familyFromText(text) {
  return importTextToFamily('doc1', ACTOR, text);
}

function at(offset, affinity = 'right') {
  return { offset, affinity };
}

function input(family, edit, extra = {}) {
  return planTextOffsetEdit({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    actor: EDIT_ACTOR,
    lamport: 2,
    edit,
    ...extra,
  });
}

function familyAfter(family, plan) {
  const operations = plan.operation.kind === 'text.replace' ? plan.operation.operations : [plan.operation.operation];
  return operations.reduce((current, operation) => applyTextOperation(current, operation), family);
}

function materializePlan(family, plan) {
  return materializeText(familyAfter(family, plan));
}

function rangeFor(family, annotationId, startOffset, endOffset) {
  const frontier = family.checkpoint.frontier;
  return {
    annotationId,
    start: resolveOffsetToEndpoint(family, startOffset, frontier, 'left'),
    end: resolveOffsetToEndpoint(family, endOffset, frontier, 'right'),
  };
}

const Document = entity('LiveDocument', {
  project: ref('Project'), owner: ref('User'), body: annotatedText({
    project: 'project', owner: 'owner', annotations: [annotation('note', { fields: {} })],
  }),
});

function sessionSnapshot(text = 'Hello') {
  return {
    body: {
      kind: 'workbench.annotatedText.recipient', version: 1,
      text,
      ranges: [],
      annotations: [],
      orphans: [],
      measurements: [],
    },
  };
}

function token(label) {
  return `${label}${'x'.repeat(43)}`.slice(0, 43);
}

function authoringEnvelope(cursor) {
  return {
    version: 1, stream: token('stream'), lease: token('lease'), snapshot: token(`snapshot${cursor}`), acknowledgementFence: cursor,
    positionFrames: [{ positionToken: token(`position${cursor}`) }],
  };
}

function makeSession(text, historySession = 'tab-a') {
  const requests = [];
  let number = 0;
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession,
    createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: 1 }) };
        requests.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: 2 }) };
      }
      const cursor = ++number;
      const body = sessionSnapshot(text).body;
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => ({ close() {}, onmessage: null, onerror: null }),
  });
  return { session, requests };
}

function applyServerEdit(state, edit) {
  const text = state.text;
  if (edit.kind === 'text.replace') {
    state.text = text.slice(0, edit.from.offset) + edit.text + text.slice(edit.to.offset);
  } else if (edit.kind === 'text.insert') {
    state.text = text.slice(0, edit.at.offset) + edit.text + text.slice(edit.at.offset);
  } else if (edit.kind === 'text.delete') {
    state.text = text.slice(0, edit.from.offset) + text.slice(edit.to.offset);
  } else {
    throw new Error(`unknown server edit kind: ${edit.kind}`);
  }
}

// A stateful mock server: one mutable text shared by every session and GET.
// A POST applies the action to the shared text before returning its receipt, so
// the covering snapshot fetched after a receipt (no SSE fold echo) reflects the
// committed state — the same reload the real server serves.
function makeStatefulSession(state, historySession = 'tab-a') {
  const sources = [];
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: Document, field: Document.body, documentId: 'd1' },
    historySession,
    createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: state.cursor }) };
        const body = JSON.parse(options.body);
        state.requests.push(body);
        applyServerEdit(state, body.payload?.edit);
        return { ok: true, status: 200, json: async () => ({ ok: true, actionId: 'action-1', confirmedThrough: state.cursor }) };
      }
      const cursor = ++state.cursor;
      const body = sessionSnapshot(state.text).body;
      state.snapshotTexts.push(state.text);
      return { ok: true, status: 200, json: async () => ({ kind: 'snapshot', snapshot: { body }, cursor, authoring: authoringEnvelope(cursor) }) };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  return { session, sources };
}

test('blockless import preserves empty LF-delimited runs as pure text', () => {
  assert.equal(materializeText(importTextToFamily('doc1', ACTOR, 'a\n\nb')), 'a\n\nb');
  assert.equal(materializeText(importTextToFamily('doc1', ACTOR, '\na\n')), '\na\n');
});

test('deleting a run body leaves both LF boundaries so the empty run stays representable', () => {
  const family = familyFromText('a\nXY\nb');
  const plan = input(family, { kind: 'text.delete', from: at(2), to: at(4) });
  assert.equal(plan.operation.kind, 'text.apply');
  assert.equal(materializePlan(family, plan), 'a\n\nb');
});

test('insertion at an LF boundary produces visible text and stays converged', () => {
  const family = familyFromText('a\n\nb');
  const plan = input(family, { kind: 'text.insert', text: 'X', at: at(2) });
  assert.equal(plan.operation.kind, 'text.apply');
  assert.equal(materializePlan(family, plan), 'a\nX\nb');
});

test('deleting a single LF joins the adjacent runs', () => {
  const family = familyFromText('a\nb');
  const plan = input(family, { kind: 'text.delete', from: at(1), to: at(2) });
  assert.equal(plan.operation.kind, 'text.apply');
  assert.equal(materializePlan(family, plan), 'ab');
});

test('surrogate-splitting offsets are rejected even adjacent to an LF boundary', () => {
  const family = familyFromText('a\n\u{1F600}\nb');
  const text = materializeText(family);
  assert.throws(
    () => assertUtf16Range(text, 3, 4),
    /offset splits a surrogate pair/,
  );
  for (const edit of [
    { kind: 'text.insert', text: 'x', at: at(3) },
    { kind: 'text.delete', from: at(3), to: at(4) },
    { kind: 'text.replace', text: 'z', from: at(3, 'right'), to: at(4) },
  ]) {
    assert.throws(
      () => input(family, edit),
      /offset splits a surrogate pair/,
    );
  }
});

test('HTTP session round-trips a text with empty runs and replaces across an LF as one action', async () => {
  const { session, requests } = makeSession('x\n\ny');
  await session.ready;
  assert.equal(session.document.text, 'x\n\ny');
  await session.replace({
    mutationId: 'm1', from: at(1), to: at(3), text: 'X',
  });
  assert.equal(requests.length, 1);
  const actionBody = requests[0];
  assert.equal(actionBody.type, 'LiveDocument.body.operation');
  assert.equal(actionBody.payload.edit.kind, 'text.replace');
  assert.equal(actionBody.payload.edit.from.offset, 1);
  assert.equal(actionBody.payload.edit.to.offset, 3);
  assert.ok(actionBody.payload.authoring.mutationId);
  session.close();
});

test('replace across LF runs materializes ordered runs with the replacement', () => {
  const family = familyFromText('alpha\nbeta\ngamma');
  const plan = input(family, { kind: 'text.replace', text: 'XYZ\nDELTA', from: at(2), to: at(11) });
  assert.equal(plan.operation.kind, 'text.replace');
  assert.equal(plan.operation.operations.length, 2);
  assert.equal(materializePlan(family, plan), 'alXYZ\nDELTAgamma');
});

test('replacement at document start and document end is atomic and ordered', () => {
  const startFamily = familyFromText('abc');
  const start = input(startFamily, { kind: 'text.replace', text: 'X', from: at(0), to: at(2) });
  assert.equal(start.operation.kind, 'text.replace');
  assert.equal(start.operation.operations.length, 2, 'a replace is one delete+insert pair');
  assert.equal(materializePlan(startFamily, start), 'Xc');

  const tailFamily = familyFromText('abc');
  const tail = input(tailFamily, { kind: 'text.replace', text: 'X', from: at(2), to: at(3) });
  assert.equal(tail.operation.kind, 'text.replace');
  assert.equal(tail.operation.operations.length, 2);
  assert.equal(materializePlan(tailFamily, tail), 'abX');

  const insertStartFamily = familyFromText('abc');
  const insertStart = input(insertStartFamily, { kind: 'text.insert', text: 'P', at: at(0) });
  assert.equal(insertStart.operation.kind, 'text.apply');
  assert.equal(materializePlan(insertStartFamily, insertStart), 'Pabc');

  const insertEndFamily = familyFromText('abc');
  const insertEnd = input(insertEndFamily, { kind: 'text.insert', text: 'Q', at: at(3) });
  assert.equal(insertEnd.operation.kind, 'text.apply');
  assert.equal(materializePlan(insertEndFamily, insertEnd), 'abcQ');
});

test('continuous family checkpoint survives restore and replay across an empty-run document', () => {
  const family = familyFromText('\na\n\nb\n');
  assert.equal(materializeText(family), '\na\n\nb\n');
  const checkpoint = textFamilyCheckpoint(family);
  const restored = restoreTextFamily(checkpoint);
  assert.equal(materializeText(restored), '\na\n\nb\n');

  const plan = input(family, { kind: 'text.insert', text: 'X', at: at(1) });
  const applied = applyTextOperation(family, plan.operation.operation);
  assert.equal(materializeText(applied), '\nXa\n\nb\n');

  const restoredAgain = restoreTextFamily(checkpoint);
  assert.equal(materializeText(restoredAgain), '\na\n\nb\n');
  const replayed = applyTextOperation(restoredAgain, plan.operation.operation);
  assert.equal(materializeText(replayed), materializeText(applied), 'restore + replay converges on the same visible text');
});

test('selection replacement across LF runs is one durable mutation at the HTTP layer', async () => {
  const { session, requests } = makeSession('aa\nbb\ncc');
  await session.ready;
  await session.replace({
    mutationId: 'replace-1', from: at(2), to: at(7), text: 'X',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.edit.kind, 'text.replace');
  assert.equal(requests[0].payload.edit.from.offset, 2);
  assert.equal(requests[0].payload.edit.to.offset, 7);
  session.close();
});

test('a replace across LF runs settles and the covering-snapshot reload reflects ordered runs', async () => {
  const state = { text: 'aa\nbb\ncc', cursor: 0, requests: [], snapshotTexts: [] };
  const { session } = makeStatefulSession(state);
  await session.ready;
  assert.equal(session.document.text, 'aa\nbb\ncc');
  assert.equal(state.snapshotTexts.length, 1);

  const result = await session.replace({ mutationId: 'replace-1', from: at(2), to: at(5), text: 'X' });
  assert.equal((await result.settlement.wait()).status, 'reconciled');
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].payload.edit.kind, 'text.replace');
  // The receipt has no fold echo (inert mock SSE), so the client fetches a
  // covering snapshot; the reload serves the committed text with ordered runs.
  assert.equal(state.snapshotTexts.length, 2, 'a positive receipt without a fold echo falls back to a covering snapshot');
  assert.equal(state.snapshotTexts[1], 'aaX\ncc');
  assert.equal(state.text, 'aaX\ncc');
  assert.equal(session.document.text, 'aaX\ncc');
  session.close();
});

test('two sessions editing distinct runs converge on the merged text through the session seam', async () => {
  // Both sessions share one mutable server text and cursor, so every GET sees
  // the same evolving state. Each receipt triggers a covering snapshot; both
  // replacements are applied to the one server text before either recovery
  // refetches, so both sessions reconcile to the merged document. No fold echo
  // is involved (the mock SSE is inert) and no fold is faked.
  const state = { text: 'aa\nbb', cursor: 0, requests: [], snapshotTexts: [] };
  const first = makeStatefulSession(state, 'tab-a');
  const second = makeStatefulSession(state, 'tab-b');
  await first.session.ready;
  await second.session.ready;
  assert.equal(first.session.document.text, 'aa\nbb');
  assert.equal(second.session.document.text, 'aa\nbb');

  const a = first.session.replace({ mutationId: 'A', from: at(0), to: at(2), text: 'xx' });
  const b = second.session.replace({ mutationId: 'B', from: at(3), to: at(5), text: 'yy' });
  assert.equal((await (await a).settlement.wait()).status, 'reconciled');
  assert.equal((await (await b).settlement.wait()).status, 'reconciled');

  // Each session issued exactly one text.replace with correct absolute offsets.
  const byId = (id) => state.requests.filter((request) => request.payload.authoring.mutationId === id);
  assert.equal(byId('A').length, 1);
  assert.equal(byId('A')[0].payload.edit.kind, 'text.replace');
  assert.equal(byId('A')[0].payload.edit.from.offset, 0);
  assert.equal(byId('A')[0].payload.edit.to.offset, 2);
  assert.equal(byId('B').length, 1);
  assert.equal(byId('B')[0].payload.edit.kind, 'text.replace');
  assert.equal(byId('B')[0].payload.edit.from.offset, 3);
  assert.equal(byId('B')[0].payload.edit.to.offset, 5);

  // The shared server state and both sessions' document views agree.
  assert.equal(state.text, 'xx\nyy');
  assert.equal(first.session.document.text, 'xx\nyy');
  assert.equal(second.session.document.text, 'xx\nyy');

  // Core seam: applying both planned operations sequentially to one family
  // yields the same merged ordered runs and a stable checkpoint.
  const family = familyFromText('aa\nbb');
  const planA = input(family, { kind: 'text.replace', text: 'xx', from: at(0), to: at(2) });
  const planB = input(family, { kind: 'text.replace', text: 'yy', from: at(3), to: at(5) }, { actor: 'c'.repeat(32) });
  let converged = family;
  for (const operation of [...planA.operation.operations, ...planB.operation.operations]) {
    converged = applyTextOperation(converged, operation);
  }
  assert.equal(materializeText(converged), 'xx\nyy');
  assert.equal(materializeText(restoreTextFamily(textFamilyCheckpoint(converged))), 'xx\nyy');
  first.session.close();
  second.session.close();
});

test('reversed, out-of-range, and surrogate-splitting edits fail atomically with no family change', () => {
  const family = familyFromText('a\n\u{1F600}\nb');
  const before = materializeText(family);
  const rejected = [
    { kind: 'text.delete', from: at(4), to: at(2) },
    { kind: 'text.replace', text: 'z', from: at(0), to: at(99) },
    { kind: 'text.delete', from: at(3), to: at(4) },
  ];
  for (const edit of rejected) {
    assert.throws(() => input(family, edit), (error) => error.code === 'position-invalid'
      || /surrogate pair/.test(error.message));
    assert.equal(materializeText(family), before, 'planning must not mutate the family');
  }
});

test('concurrent distinct-run edits each plan one text.replace with absolute offsets', async () => {
  const first = makeSession('aa\nbb', 'tab-a');
  await first.session.ready;
  await first.session.replace({ mutationId: 'A', from: at(0), to: at(2), text: 'xx' });

  const second = makeSession('aa\nbb', 'tab-b');
  await second.session.ready;
  await second.session.replace({ mutationId: 'B', from: at(3), to: at(5), text: 'yy' });

  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0].payload.edit.kind, 'text.replace');
  assert.equal(first.requests[0].payload.edit.from.offset, 0);
  assert.equal(first.requests[0].payload.edit.to.offset, 2);
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].payload.edit.kind, 'text.replace');
  assert.equal(second.requests[0].payload.edit.from.offset, 3);
  assert.equal(second.requests[0].payload.edit.to.offset, 5);
  first.session.close();
  second.session.close();
});

test('a range spanning LF runs anchors once and projects deterministically through a later replace', () => {
  const family = familyFromText('one\ntwo\nthree');
  const annotation = { id: 'r1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  const plan = planTextRangeApply({
    documentId: 'doc1', structureVersion: 1, family, annotation, from: at(3), to: at(8),
  });
  assert.equal(plan.operation.kind, 'annotation.apply-range');
  assert.deepEqual(plan.operation.selection, { startOffset: 3, endOffset: 8 });
  assert.equal(plan.facts.ranges.length, 1);
  assert.equal(plan.facts.ranges[0].annotationId, 'r1');
  assert.equal(projectEndpointToOffset(family, plan.facts.ranges[0].start), 3);
  assert.equal(projectEndpointToOffset(family, plan.facts.ranges[0].end), 8);

  const replaced = input(family, { kind: 'text.replace', text: 'W', from: at(4), to: at(7) });
  const replacedFamily = familyAfter(family, replaced);
  assert.equal(materializeText(replacedFamily), 'one\nW\nthree');
  const range = plan.facts.ranges[0];
  assert.equal(projectEndpointToOffset(replacedFamily, range.start), 3);
  assert.equal(projectEndpointToOffset(replacedFamily, range.end), 6);
});

test('identical, adjacent, crossing, contained, containing, and multiline ranges all coexist', () => {
  // The trailing LF lets the multiline spec span a run boundary.
  const family = familyFromText('abcdef\n');
  // r7 is IDENTICAL to r1 (same offsets, different annotation id); r8 spans the
  // LF at offset 6, so its spec crosses two runs.
  const specs = [['r1', 1, 3], ['r2', 3, 5], ['r3', 1, 5], ['r4', 2, 4], ['r5', 0, 2], ['r6', 4, 6], ['r7', 1, 3], ['r8', 3, 7]];
  let ranges = [];
  for (const [id, startOffset, endOffset] of specs) {
    const plan = planTextRangeApply({
      documentId: 'doc1', structureVersion: 1, family,
      annotation: { id, family: 'comment', empty: 'delete', protectedTargetIds: [] },
      from: at(startOffset), to: at(endOffset), ranges,
    });
    ranges = plan.facts.ranges;
  }
  assert.equal(ranges.length, 8);
  const byId = Object.fromEntries(ranges.map((entry) => [entry.annotationId, entry]));
  assert.notEqual(byId.r7, byId.r1, 'an identical-offset range under another id is a distinct range');
  for (const [id, startOffset, endOffset] of specs) {
    assert.equal(projectEndpointToOffset(family, byId[id].start), startOffset);
    assert.equal(projectEndpointToOffset(family, byId[id].end), endOffset);
  }
  // A genuine crossing pair (partial overlap a < c < b < d): r1[1,3] and r4[2,4]
  // both survive as independent ranges, neither is absorbed by the other.
  assert.ok(1 < 2 && 2 < 3 && 3 < 4, 'r1/r4 is a partial-overlap crossing pair');
  assert.equal(projectEndpointToOffset(family, byId.r1.start), 1);
  assert.equal(projectEndpointToOffset(family, byId.r1.end), 3);
  assert.equal(projectEndpointToOffset(family, byId.r4.start), 2);
  assert.equal(projectEndpointToOffset(family, byId.r4.end), 4);
});

test('boundary affinity over LF runs: start, inside, end, before, and after insertions', () => {
  const family = familyFromText('a\nb\nc\nd');
  const annotation = { id: 'c1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  const plan = planTextRangeApply({
    documentId: 'doc1', structureVersion: 1, family, annotation, from: at(2), to: at(5),
  });
  const range = plan.facts.ranges[0];
  assert.equal(projectEndpointToOffset(family, range.start), 2);
  assert.equal(projectEndpointToOffset(family, range.end), 5);

  const atStart = input(family, { kind: 'text.insert', text: 'I', at: at(2) });
  const atStartFamily = familyAfter(family, atStart);
  assert.equal(materializeText(atStartFamily), 'a\nIb\nc\nd');
  assert.equal(projectEndpointToOffset(atStartFamily, range.start), 2);
  assert.equal(projectEndpointToOffset(atStartFamily, range.end), 6);

  const atEnd = input(family, { kind: 'text.insert', text: 'I', at: at(5) });
  const atEndFamily = familyAfter(family, atEnd);
  assert.equal(materializeText(atEndFamily), 'a\nb\ncI\nd');
  assert.equal(projectEndpointToOffset(atEndFamily, range.start), 2);
  assert.equal(projectEndpointToOffset(atEndFamily, range.end), 5);

  const inside = input(family, { kind: 'text.insert', text: 'I', at: at(3) });
  const insideFamily = familyAfter(family, inside);
  assert.equal(materializeText(insideFamily), 'a\nbI\nc\nd');
  assert.equal(projectEndpointToOffset(insideFamily, range.start), 2, 'a strictly-inside insertion keeps the start endpoint');
  assert.equal(projectEndpointToOffset(insideFamily, range.end), 6, 'a strictly-inside insertion is absorbed, tracking the end endpoint');

  const before = input(family, { kind: 'text.insert', text: 'I', at: at(0) });
  const beforeFamily = familyAfter(family, before);
  assert.equal(materializeText(beforeFamily), 'Ia\nb\nc\nd');
  assert.equal(projectEndpointToOffset(beforeFamily, range.start), 3, 'an insertion before the range stays excluded');
  assert.equal(projectEndpointToOffset(beforeFamily, range.end), 6);

  const after = input(family, { kind: 'text.insert', text: 'I', at: at(7) });
  const afterFamily = familyAfter(family, after);
  assert.equal(materializeText(afterFamily), 'a\nb\nc\ndI');
  assert.equal(projectEndpointToOffset(afterFamily, range.start), 2, 'an insertion after the range stays excluded');
  assert.equal(projectEndpointToOffset(afterFamily, range.end), 5);
});

test('a covering delete follows each annotation empty policy', () => {
  const family = familyFromText('abcd');
  const orphaned = input(family, { kind: 'text.delete', from: at(1), to: at(3) }, {
    annotations: [{ id: 'o1', family: 'comment', empty: 'orphan', protectedTargetIds: [] }],
    ranges: [rangeFor(family, 'o1', 1, 3)],
  });
  assert.equal(materializePlan(family, orphaned), 'ad');
  assert.equal(orphaned.facts.emptiedAnnotations.length, 1);
  assert.equal(orphaned.facts.emptiedAnnotations[0].annotationId, 'o1');
  assert.equal(orphaned.facts.emptiedAnnotations[0].empty, 'orphan');
  assert.equal(orphaned.facts.emptiedAnnotations[0].disposition.kind, 'orphaned');
  assert.equal(orphaned.facts.emptiedAnnotations[0].disposition.family, 'comment');
  assert.equal(orphaned.facts.emptiedAnnotations[0].disposition.savedQuote, 'bc');
  assert.equal(orphaned.facts.emptiedAnnotations[0].disposition.lastRange, null);
  assert.equal(orphaned.after.structuralRevision, 2);

  const deleted = input(family, { kind: 'text.delete', from: at(1), to: at(3) }, {
    annotations: [{ id: 'd1', family: 'comment', empty: 'delete', protectedTargetIds: [] }],
    ranges: [rangeFor(family, 'd1', 1, 3)],
  });
  assert.equal(materializePlan(family, deleted), 'ad');
  assert.equal(deleted.facts.emptiedAnnotations.length, 1);
  assert.equal(deleted.facts.emptiedAnnotations[0].annotationId, 'd1');
  assert.equal(deleted.facts.emptiedAnnotations[0].empty, 'delete');
  assert.equal(deleted.facts.emptiedAnnotations[0].disposition.kind, 'deleted');
  assert.equal(deleted.facts.emptiedAnnotations[0].disposition.savedQuote, null);
  assert.equal(deleted.after.structuralRevision, 2);
});

test('a replace overlapping two annotations transforms every overlapping range deterministically', () => {
  const family = familyFromText('abcde');
  const annotations = [
    { id: 'r1', family: 'comment', empty: 'delete', protectedTargetIds: [] },
    { id: 'r2', family: 'comment', empty: 'delete', protectedTargetIds: [] },
  ];
  const ranges = [rangeFor(family, 'r1', 1, 3), rangeFor(family, 'r2', 2, 4)];
  const plan = input(family, { kind: 'text.replace', text: 'X', from: at(1), to: at(4) }, { annotations, ranges });
  assert.equal(plan.operation.kind, 'text.replace');
  const nextFamily = familyAfter(family, plan);
  assert.equal(materializeText(nextFamily), 'aXe');
  // Both ranges are fully covered by [1,4); each collapses to the same
  // zero-width point at the replacement offset, projecting identically.
  for (const range of ranges) {
    assert.equal(projectEndpointToOffset(nextFamily, range.start), 2);
    assert.equal(projectEndpointToOffset(nextFamily, range.end), 2);
  }
  assert.deepEqual(plan.facts.emptiedAnnotations.map((entry) => entry.annotationId), ['r1', 'r2']);
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'deleted');
  assert.equal(plan.facts.emptiedAnnotations[1].disposition.kind, 'deleted');
  assert.equal(plan.after.structuralRevision, 2);
});
