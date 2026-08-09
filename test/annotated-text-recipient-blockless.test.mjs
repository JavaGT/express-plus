import assert from 'node:assert/strict';
import { test } from 'node:test';

import { entity, annotatedText, annotation, protectingAnnotation, everyone, grant, read, write, ref, scope } from '../src/index.mjs';
import { registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension } from '../src/index.mjs';

import { projectAnnotatedTextForRecipient, authoringRedactionsForRecipient } from '../src/annotated-text-recipient-projection.mjs';

registerAnnotatedTextContract('m', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('m', Object.freeze({ version: 1, validate() {}, edit() {}, partition() {}, combine() {} }));

const accessOwnerOnly = async ({ is }) => (await is.owner()) ? grant(read) : grant();

const Doc = entity('Doc', {
  project: ref('P'), owner: ref('U', { role: 'owner' }),
  body: annotatedText({
    project: 'project', owner: 'owner',
    annotations: [
      annotation('comment', { empty: 'orphan' }),
      annotation('sensitive', { empty: 'delete' }),
      protectingAnnotation('confidential', { protects: 'sensitive', placeholder: '[REDACTED]', access: accessOwnerOnly }),
    ],
  }),
  grant: [scope(() => everyone()).can(() => grant(read, write))],
});
function canonical({ text: docText, annotations, ranges, measurements = [], orphans }) {
  const c = { kind: 'workbench.annotatedText.canonical', version: 1, text: docText, annotations, ranges, measurements, capabilityHints: [] };
  if (orphans !== undefined) c.orphans = orphans;
  return c;
}

function ann(id, family, extra = {}) {
  return { id, family, fields: {}, ...extra };
}

function decisions(protectors) {
  return { version: 1, protectors, capabilityHints: [] };
}

test('recipient projects one text and document ranges', () => {
  const c = canonical({
    text: 'hello world',
    annotations: [ann('a1', 'comment')],
    ranges: [{ annotationId: 'a1', start: 6, end: 11 }],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([]));
  assert.equal(r.text, 'hello world');
  assert.deepEqual(r.ranges, [{ annotationId: 'a1', start: 6, end: 11 }]);
  assert.equal(r.annotations.length, 1);
});

test('a denied protector redacts its range with the placeholder', () => {
  const c = canonical({
    text: 'open text secret more',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 10, end: 16 },
      { annotationId: 'c1', start: 10, end: 16 },
    ],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  // The redacted interval is removed from the visible text; the client renders
  // the placeholder at the zero-width marker.
  assert.equal(r.text, 'open text  more');
  assert.deepEqual(r.redactions, [{ start: 10, end: 10, placeholder: '[REDACTED]' }]);
  const redactions = authoringRedactionsForRecipient(r);
  assert.deepEqual(redactions, [{ visibleStart: 10, start: 10, end: 16 }]);
});

test('an allowed protector discloses the text', () => {
  const c = canonical({
    text: 'open text secret more',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 10, end: 16 },
      { annotationId: 'c1', start: 10, end: 16 },
    ],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'allow' }]));
  assert.equal(r.text, 'open text secret more');
  assert.deepEqual(authoringRedactionsForRecipient(r), []);
});

test('a whole-document denied protector restricts the document (fail closed)', () => {
  const text = 'entire document is protected';
  const c = canonical({
    text,
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: text.length },
      { annotationId: 'c1', start: 0, end: text.length },
    ],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  assert.equal(r.restricted, true);
  assert.deepEqual(authoringRedactionsForRecipient(r), []);
});

test('a range fully inside a redaction drops out of delivery (no show-through)', () => {
  const c = canonical({
    text: 'hello secret tail',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] }), ann('a1', 'comment')],
    ranges: [
      { annotationId: 's1', start: 6, end: 12 },
      { annotationId: 'c1', start: 6, end: 12 },
      { annotationId: 'a1', start: 13, end: 17 },
    ],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  assert.equal(r.text, 'hello  tail');
  // The comment range is entirely AFTER the redaction; its offsets shift left
  // by the hidden width (6).
  assert.deepEqual(r.ranges, [{ annotationId: 'a1', start: 7, end: 11 }]);
  // The protected sensitive annotation is dropped from delivery.
  assert.ok(!r.annotations.some((a) => a.id === 's1'));
});

test('protector decisions must exactly match active protectors', () => {
  const c = canonical({
    text: 'abc',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: 3 },
      { annotationId: 'c1', start: 0, end: 3 },
    ],
  });
  assert.throws(() => projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([])), /exactly match active protectors/);
  assert.throws(() => projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }, { protectorId: 'extra', outcome: 'deny' }])), /exactly match active protectors/);
});

test('orphans project with saved quote when their source range is visible', () => {
  const c = canonical({
    text: 'hello',
    annotations: [ann('a1', 'comment')],
    ranges: [{ annotationId: 'a1', start: 1, end: 5 }],
    orphans: [{ id: 'o1', family: 'comment', fields: {}, savedQuote: 'ello', savedRange: [1, 5] }],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([]));
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].savedQuote, 'ello');
});

test('duplicate ranges are delivered; out-of-bounds ranges are rejected', () => {
  // Multiple ranges per annotation are LEGAL (an exclusive 'one'-family apply
  // leaves a trimmed annotation's left/right remnants).
  const c1 = canonical({
    text: 'abc',
    annotations: [ann('a1', 'comment')],
    ranges: [{ annotationId: 'a1', start: 0, end: 3 }, { annotationId: 'a1', start: 1, end: 2 }],
  });
  const r1 = projectAnnotatedTextForRecipient(c1, Doc.fields.body, decisions([]));
  assert.deepEqual(r1.ranges, [
    { annotationId: 'a1', start: 0, end: 3 },
    { annotationId: 'a1', start: 1, end: 2 },
  ]);
  assert.deepEqual(r1.annotations.map((a) => a.id), ['a1']);
  const c2 = canonical({
    text: 'abc',
    annotations: [ann('a1', 'comment')],
    ranges: [{ annotationId: 'a1', start: 0, end: 9 }],
  });
  assert.throws(() => projectAnnotatedTextForRecipient(c2, Doc.fields.body, decisions([])), /range is invalid/);
});

test('a restricted projection never carries the canonical text (fail closed)', () => {
  const c = canonical({
    text: 'SECRET',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: 6 },
      { annotationId: 'c1', start: 0, end: 6 },
    ],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  assert.equal(r.restricted, true);
  assert.equal(r.text, '');
  assert.deepEqual(r.ranges, []);
  assert.deepEqual(r.annotations, []);
  assert.deepEqual(authoringRedactionsForRecipient(r), []);
});

test('an orphan whose saved range is redacted is NOT disclosed', () => {
  const c = canonical({
    text: 'SECRET tail',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: 6 },
      { annotationId: 'c1', start: 0, end: 6 },
    ],
    orphans: [{ id: 'o1', family: 'comment', fields: {}, savedQuote: 'SECRET', savedRange: [0, 6] }],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  assert.equal(r.text, ' tail');
  assert.deepEqual(r.orphans, [], 'orphan quote overlapping a redaction must not be disclosed');
});

test('an orphan is disclosed only when the document has NO redactions for this recipient', () => {
  // No redaction -> disclosed.
  const clean = canonical({
    text: 'SECRET tail',
    annotations: [ann('a1', 'comment')],
    ranges: [{ annotationId: 'a1', start: 0, end: 11 }],
    orphans: [{ id: 'o1', family: 'comment', fields: {}, savedQuote: 'tail', savedRange: [7, 11] }],
  });
  const cleanRecipient = projectAnnotatedTextForRecipient(clean, Doc.fields.body, decisions([]));
  assert.deepEqual(cleanRecipient.orphans.map((o) => o.savedQuote), ['tail']);

  // Any redaction -> suppressed (the historical quote cannot be provenance-checked).
  const redacted = canonical({
    text: 'SECRET tail',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: 6 },
      { annotationId: 'c1', start: 0, end: 6 },
    ],
    orphans: [{ id: 'o1', family: 'comment', fields: {}, savedQuote: 'tail', savedRange: [7, 11] }],
  });
  const redactedRecipient = projectAnnotatedTextForRecipient(redacted, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  assert.deepEqual(redactedRecipient.orphans, [], 'orphans are suppressed when any redaction is present');
});

test('a stale protected target id fails closed even when another target is valid', () => {
  const c = canonical({
    text: 'SECRET tail',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['missing', 's1'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: 6 },
      { annotationId: 'c1', start: 0, end: 11 },
    ],
  });
  assert.throws(() => projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([])), /unknown protected target/);
});

test('a stale protected target id fails closed', () => {
  const c = canonical({
    text: 'SECRET tail',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['missing'] })],
    ranges: [
      { annotationId: 's1', start: 0, end: 6 },
      { annotationId: 'c1', start: 0, end: 11 },
    ],
  });
  assert.throws(() => projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([])), /unknown protected target/);
});

test('a range starting inside a redaction clamps to the marker, not an unrelated offset', () => {
  const c = canonical({
    text: '0123456789',
    annotations: [ann('s1', 'sensitive'), ann('c1', 'confidential', { protectedTargetIds: ['s1'] }), ann('a1', 'comment')],
    ranges: [
      { annotationId: 's1', start: 2, end: 5 },
      { annotationId: 'c1', start: 2, end: 5 },
      { annotationId: 'a1', start: 3, end: 8 },
    ],
  });
  const r = projectAnnotatedTextForRecipient(c, Doc.fields.body, decisions([{ protectorId: 'c1', outcome: 'deny' }]));
  assert.equal(r.text, '0156789');
  // Canonical 3 (inside the redaction) clamps to the marker at visible 2;
  // canonical 8 maps to visible 5.
  assert.deepEqual(r.ranges, [{ annotationId: 'a1', start: 2, end: 5 }]);
});
