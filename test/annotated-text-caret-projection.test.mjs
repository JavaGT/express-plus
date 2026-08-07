import assert from 'node:assert/strict';
import test from 'node:test';

import { annotatedText, annotation, ephemeral, entity, measurement, protectingAnnotation, ref, registerAnnotatedTextContract } from '../src/index.mjs';
import { projectAnnotatedTextCaretForRecipient, registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';

const extension = 'caretProjectionMeasurement';
registerAnnotatedTextContract(extension, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(extension, Object.freeze({ version: 1, validate: function validate() {}, edit: function edit() {}, partition: function partition() {}, combine: function combine() {} }));

function descriptor() {
  const Doc = entity('CaretProjectionDoc', {
    project: ref('Project'), owner: ref('User'),
    presence: ephemeral({ caret: true }),
    body: annotatedText({
      project: 'project', owner: 'owner', carets: { field: 'presence', cell: 'caret' },
      annotations: [annotation('coding'), protectingAnnotation('confidential', { protects: 'coding', access: () => null, placeholder: '[Private]' })],
      measurements: [measurement('words', { extension })],
    }),
  });
  return Doc.fields.body;
}

function canonical(text = 'secret') {
  return {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations: [
      { id: 'a1', family: 'coding', fields: {} },
      { id: 'p1', family: 'confidential', fields: {}, protectedTargetIds: ['a1'] },
    ],
    ranges: [
      { annotationId: 'a1', start: 0, end: text.length },
      { annotationId: 'p1', start: 0, end: text.length },
    ],
    orphans: [], measurements: [], capabilityHints: [],
  };
}

test('caret declaration links an annotated field to a declared ephemeral cell', () => {
  const body = descriptor();
  const projected = projectAnnotatedTextCaretForRecipient(canonical(), body,
    { version: 1, protectors: [{ protectorId: 'p1', outcome: 'allow' }], capabilityHints: [] },
    { offset: 2 }, 'session-1');
  assert.deepEqual(projected, { kind: 'caret', presence: 'session-1', offset: 2 });
});

test('caret declaration rejects unknown cells, non-ephemeral fields, and duplicate links', () => {
  const options = {
    project: 'project', owner: 'owner', annotations: [annotation('coding')],
    measurements: [measurement('words', { extension })],
  };
  assert.throws(() => entity('BadCaretCellDoc', {
    project: ref('Project'), owner: ref('User'), presence: ephemeral({ caret: true }),
    body: annotatedText({ ...options, carets: { field: 'presence', cell: 'missing' } }),
  }), /declared ephemeral cell/);
  assert.throws(() => entity('BadCaretFieldDoc', {
    project: ref('Project'), owner: ref('User'), presence: ref('Presence'),
    body: annotatedText({ ...options, carets: { field: 'presence', cell: 'caret' } }),
  }), /enclosing ephemeral field/);
  assert.throws(() => entity('DuplicateCaretLinkDoc', {
    project: ref('Project'), owner: ref('User'), presence: ephemeral({ caret: true }),
    body: annotatedText({ ...options, carets: { field: 'presence', cell: 'caret' } }),
    notes: annotatedText({ ...options, carets: { field: 'presence', cell: 'caret' } }),
  }), /linked to more than one/);
});

test('restricted caret exposes only a deterministic edge and opaque presence identity', () => {
  const body = descriptor();
  const left = projectAnnotatedTextCaretForRecipient(canonical('secret'), body,
    { version: 1, protectors: [{ protectorId: 'p1', outcome: 'deny' }], capabilityHints: [] },
    { offset: 1 }, 'session-1');
  const right = projectAnnotatedTextCaretForRecipient(canonical('much longer secret'), body,
    { version: 1, protectors: [{ protectorId: 'p1', outcome: 'deny' }], capabilityHints: [] },
    { offset: 17 }, 'session-1');
  assert.deepEqual(left, { kind: 'edge', presence: 'session-1', edge: 'start' });
  assert.deepEqual(right, { kind: 'edge', presence: 'session-1', edge: 'start' });
  assert.equal(JSON.stringify([left, right]).includes('secret'), false);
  assert.equal(JSON.stringify([left, right]).includes('offset'), false);
});

test('caret projection rejects malformed, stale, and surrogate-splitting locations', () => {
  const body = descriptor();
  const decisions = { version: 1, protectors: [{ protectorId: 'p1', outcome: 'allow' }], capabilityHints: [] };
  assert.throws(() => projectAnnotatedTextCaretForRecipient(canonical(), body, decisions, { blockId: 'b1', offset: 0 }, 'session-1'), /caret has invalid shape/);
  assert.throws(() => projectAnnotatedTextCaretForRecipient(canonical(), body, decisions, { offset: 99 }, 'session-1'), /outside the canonical text/);
  assert.throws(() => projectAnnotatedTextCaretForRecipient(canonical('a😀b'), body, decisions, { offset: 2 }, 'session-1'), /outside the canonical text/);
  assert.throws(() => projectAnnotatedTextCaretForRecipient(canonical(), body, { version: 1, protectors: [], capabilityHints: [] }, { offset: 0 }, 'session-1'), /exactly match/);
});
