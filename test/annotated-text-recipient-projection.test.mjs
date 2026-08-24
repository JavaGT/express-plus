import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { annotatedText, annotation, entity, grant, measurement, protectingAnnotation, read, ref, registerAnnotatedTextContract } from '../build/index.mjs';
import { registerAnnotatedTextStructuralExtension, projectAnnotatedTextForRecipient } from '../build/internal.mjs';
import { createAnnotatedTextRecipientSource, projectAnnotatedTextRecipient } from '../build/annotated-text-recipient-projection.mjs';

const suffix = 'recipientProjection';
registerAnnotatedTextContract(`${suffix}Measurement`, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(`${suffix}Measurement`, Object.freeze({ version: 1, validate: function validate() {}, edit: function edit() {}, partition: function partition() {}, combine: function combine() {} }));

function descriptor() {
  const body = annotatedText({
    project: 'project', owner: 'owner',
    annotations: [annotation('coding'), protectingAnnotation('confidential', { protects: 'coding', placeholder: '[Private]', access: () => grant(read) })],
    measurements: [measurement('words', { extension: `${suffix}Measurement` })],
    capabilities: { 'body.read': Object.freeze({}), 'body.edit': Object.freeze({}) },
  });
  entity('RecipientProjectionDoc', {
    project: ref('Project'), owner: ref('User'),
    body,
  });
  return body;
}

/** Blockless canonical: one continuous text + document-scoped ranges (issue #33). */
function canonical(hidden = 'secret') {
  const text = `${hidden}visible`;
  const hiddenEnd = hidden.length;
  return {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
    ],
    ranges: [
      { annotationId: 'code', start: 0, end: text.length },
      { annotationId: 'protect', start: 0, end: hiddenEnd },
    ],
    measurements: [
      { id: 'm-hidden', family: 'words', formatVersion: 1, payload: { token: 'meta-hidden' } },
      { id: 'm-visible', family: 'words', formatVersion: 1, payload: { token: 'visible' } },
    ],
    capabilityHints: [],
    orphans: [],
  };
}

/** Single-range document with optional inline protectors over absolute offsets. */
function inlineCanonical({ protectors, hidden = 'SECRET', text = `before ${hidden} after` }) {
  const annotations = [{ id: 'code', family: 'coding', fields: {} }];
  const ranges = [{ annotationId: 'code', start: 0, end: text.length }];
  for (const { id, start, end } of protectors) {
    annotations.push({ id, family: 'confidential', fields: {}, protectedTargetIds: ['code'] });
    ranges.push({ annotationId: id, start, end });
  }
  return {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text, annotations, ranges, measurements: [], capabilityHints: [], orphans: [],
  };
}

test('capability-shaped recipient source is the projection boundary and rejects database handles', () => {
  const value = canonical();
  const source = createAnnotatedTextRecipientSource({
    version: 1,
    text: value.text,
    rangeFormat: 'offset',
    annotations: value.annotations,
    ranges: value.ranges,
    measurements: value.measurements,
    orphans: value.orphans,
  });
  const decisions = { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] };
  assert.equal(
    JSON.stringify(projectAnnotatedTextRecipient({ source, descriptor: descriptor(), decisions })),
    JSON.stringify(projectAnnotatedTextForRecipient(value, descriptor(), decisions)),
  );
  assert.throws(
    () => projectAnnotatedTextRecipient({ source: { ...source, db: {} }, descriptor: descriptor(), decisions }),
    /source has invalid shape/,
  );
  const inherited = Object.assign(Object.create({ db: {} }), source);
  assert.throws(
    () => projectAnnotatedTextRecipient({ source: inherited, descriptor: descriptor(), decisions }),
    /source was not created by the recipient source factory/,
  );
  const _db = {};
  const closureSource = { ...source, annotations: () => (void _db, value.annotations) };
  assert.throws(() => createAnnotatedTextRecipientSource(closureSource), /source data is invalid/);
  assert.throws(
    () => projectAnnotatedTextRecipient({ source: closureSource, descriptor: descriptor(), decisions }),
    /source was not created by the recipient source factory/,
  );
});

test('snapshot deletion mutation cannot bypass the common recipient policy', () => {
  const snapshotSource = readFileSync(new URL('../src/annotated-text-snapshot.ts', import.meta.url), 'utf8');
  const assertCommonPolicy = (source) => {
    assert.match(source, /projectAnnotatedTextRecipient\(\{ source, descriptor, decisions \}\)/, 'snapshot bypassed projectAnnotatedTextRecipient');
    assert.doesNotMatch(source, /projectAnnotatedTextForRecipient\(canonical/, 'snapshot restored a second canonical projection path');
  };
  assertCommonPolicy(snapshotSource);
  assert.throws(
    () => assertCommonPolicy(snapshotSource.replace('projectAnnotatedTextRecipient({ source, descriptor, decisions })', 'source.text')),
    /snapshot bypassed projectAnnotatedTextRecipient/,
  );
});

test('denied protector redacts its range without hidden details', () => {
  const projected = projectAnnotatedTextForRecipient(canonical(), descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: ['body.read', 'body.edit'],
  });
  assert.equal(projected.kind, 'workbench.annotatedText.recipient');
  assert.equal(projected.text, 'visible');
  assert.deepEqual(projected.redactions, [{ start: 0, end: 0, placeholder: '[Private]' }]);
  assert.deepEqual(projected.ranges, [{ annotationId: 'code', start: 0, end: 7 }]);
  assert.deepEqual(projected.annotations, [{ id: 'code', family: 'coding', fields: {} }]);
  assert.deepEqual(projected.measurements, [
    { id: 'm-hidden', family: 'words', formatVersion: 1, payload: { token: 'meta-hidden' } },
    { id: 'm-visible', family: 'words', formatVersion: 1, payload: { token: 'visible' } },
  ]);
  assert.deepEqual(projected.capabilityHints, ['body.edit']);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(JSON.stringify(projected).includes('protect'), false);
  assert.ok(Object.isFrozen(projected));
});

test('restricted output is independent of hidden body length and content', () => {
  const decisions = { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] };
  const first = projectAnnotatedTextForRecipient(canonical('x'), descriptor(), decisions);
  const second = projectAnnotatedTextForRecipient(canonical('much longer private body'), descriptor(), decisions);
  assert.equal(first.text, 'visible');
  assert.equal(second.text, 'visible');
  assert.deepEqual(first.redactions, second.redactions);
  assert.deepEqual(first.measurements, second.measurements);
});

test('missing, stale, duplicate, and malformed protection decisions fail closed', () => {
  const doc = descriptor();
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [], capabilityHints: [] }), /exactly match/);
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [{ protectorId: 'other', outcome: 'deny' }], capabilityHints: [] }), /exactly match/);
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }, { protectorId: 'protect', outcome: 'deny' }], capabilityHints: [] }), /exactly match/);
  assert.throws(() => projectAnnotatedTextForRecipient(canonical(), doc, { version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny', extra: true }], capabilityHints: [] }), /invalid shape/);
});

test('all protector allows retain body but protecting annotations stay private', () => {
  const projected = projectAnnotatedTextForRecipient(canonical(), descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: ['body.read'],
  });
  assert.equal(projected.text, 'secretvisible');
  assert.equal(Object.hasOwn(projected, 'redactions'), false);
  assert.equal(JSON.stringify(projected).includes('protectedTargetIds'), false);
  assert.equal(JSON.stringify(projected).includes('protect'), false);
  assert.deepEqual(projected.annotations, [{ id: 'code', family: 'coding', fields: {} }]);
});

test('denied range omits raw text and carries a zero-width redaction marker', () => {
  const hidden = 'SECRET';
  const c = inlineCanonical({ hidden, protectors: [{ id: 'protect', start: 7, end: 13 }] });
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [],
  });
  assert.equal(projected.text, 'before  after');
  assert.deepEqual(projected.redactions, [{ start: 7, end: 7, placeholder: '[Private]' }]);
  assert.deepEqual(projected.ranges, [{ annotationId: 'code', start: 0, end: 13 }]);
  assert.equal(JSON.stringify(projected).includes(hidden), false);
  assert.equal(JSON.stringify(projected).includes('protect'), false);
});

test('a protector whose range does not intersect its target is not active', () => {
  const text = '0123456789';
  // Target `code` covers [0,2); the protector covers [5,8) — disjoint ranges.
  const c = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
    ],
    ranges: [
      { annotationId: 'code', start: 0, end: 2 },
      { annotationId: 'protect', start: 5, end: 8 },
    ],
    measurements: [], capabilityHints: [], orphans: [],
  };
  // No protector decision is expected because the protector is not active.
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [], capabilityHints: [],
  });
  assert.equal(projected.text, text);
  assert.equal(Object.hasOwn(projected, 'redactions'), false);
  assert.deepEqual(projected.ranges, [{ annotationId: 'code', start: 0, end: 2 }]);
});

test('document-scoped measurements are retained on partial redaction', () => {
  const hidden = 'SECRET';
  const c = inlineCanonical({ hidden, protectors: [{ id: 'protect', start: 7, end: 13 }] });
  c.measurements = [{ id: 'm-a', family: 'words', formatVersion: 1, payload: { token: 'count' } }];
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [],
  });
  assert.deepEqual(projected.measurements, [{ id: 'm-a', family: 'words', formatVersion: 1, payload: { token: 'count' } }]);
  assert.equal(JSON.stringify(projected).includes(hidden), false);
});

test('overlapping denied ranges merge to one marker and nesting uses every denied span', () => {
  const text = '0123456789';
  const c = inlineCanonical({ text, protectors: [
    { id: 'outer-denied', start: 2, end: 8 },
    { id: 'inner-allowed', start: 3, end: 5 },
    { id: 'overlap-denied', start: 6, end: 9 },
  ] });
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1,
    protectors: [
      { protectorId: 'outer-denied', outcome: 'deny' },
      { protectorId: 'inner-allowed', outcome: 'allow' },
      { protectorId: 'overlap-denied', outcome: 'deny' },
    ], capabilityHints: [],
  });
  assert.equal(projected.text, '019');
  assert.deepEqual(projected.redactions, [{ start: 2, end: 2, placeholder: '[Private]' }]);
  assert.equal(JSON.stringify(projected).includes('2345678'), false);
});

test('allowed outer does not reveal denied inner and authorized recipients receive full text without markers', () => {
  const c = inlineCanonical({ protectors: [
    { id: 'outer-allowed', start: 0, end: 19 }, { id: 'inner-denied', start: 7, end: 13 },
  ] });
  const denied = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'outer-allowed', outcome: 'allow' }, { protectorId: 'inner-denied', outcome: 'deny' }], capabilityHints: [],
  });
  assert.equal(denied.text, 'before  after');
  assert.deepEqual(denied.redactions, [{ start: 7, end: 7, placeholder: '[Private]' }]);
  const allowed = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'outer-allowed', outcome: 'allow' }, { protectorId: 'inner-denied', outcome: 'allow' }], capabilityHints: [],
  });
  assert.equal(allowed.text, 'before SECRET after');
  assert.equal(Object.hasOwn(allowed, 'redactions'), false);
});

test('malformed canonical ranges and measurements fail closed', () => {
  const decisions = { version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [] };
  // Multiple ranges per annotation are LEGAL (an exclusive 'one'-family apply
  // leaves a trimmed annotation's left/right remnants), so a duplicate range is
  // accepted and delivered as-is.
  const duplicateRange = canonical();
  duplicateRange.ranges.push({ annotationId: 'code', start: 0, end: 1 });
  const projected = projectAnnotatedTextForRecipient(duplicateRange, descriptor(), decisions);
  assert.deepEqual(projected.ranges, [
    { annotationId: 'code', start: 0, end: 13 },
    { annotationId: 'code', start: 0, end: 1 },
  ]);
  // Genuinely malformed ranges still fail closed before any output.
  const outOfBounds = canonical();
  outOfBounds.ranges[0] = { annotationId: 'code', start: 0, end: 99 };
  assert.throws(() => projectAnnotatedTextForRecipient(outOfBounds, descriptor(), decisions), /range is invalid/);
  const inverted = canonical();
  inverted.ranges[0] = { annotationId: 'code', start: 5, end: 2 };
  assert.throws(() => projectAnnotatedTextForRecipient(inverted, descriptor(), decisions), /range is invalid/);
  const unknownAnnotation = canonical();
  unknownAnnotation.ranges.push({ annotationId: 'nope', start: 0, end: 1 });
  assert.throws(() => projectAnnotatedTextForRecipient(unknownAnnotation, descriptor(), decisions), /range is invalid/);
  const extraMeasurement = canonical();
  extraMeasurement.measurements[0].private = 'leak';
  assert.throws(() => projectAnnotatedTextForRecipient(extraMeasurement, descriptor(), decisions), /invalid shape/);
});

test('canonical annotations may be rangeless or own several ranges (exclusive trimming)', () => {
  // A rangeless annotation is legal (its only range was fully displaced by an
  // exclusive apply); it discloses no ranges and drops out of delivery rather
  // than failing the whole document.
  const ordinary = canonical();
  ordinary.annotations.push({ id: 'rangeless', family: 'coding', fields: {} });
  const projected = projectAnnotatedTextForRecipient(ordinary, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
  });
  assert.equal(projected.text, 'secretvisible');
  assert.deepEqual(projected.annotations.map((a) => a.id).sort(), ['code']);
  assert.deepEqual(projected.ranges, [{ annotationId: 'code', start: 0, end: 13 }]);

  // A rangeless PROTECTOR is legal too: it has no range to redact, so it is
  // never active and never disclosed.
  const protector = canonical();
  protector.annotations.push({ id: 'rangeless-protector', family: 'confidential', fields: {}, protectedTargetIds: ['code'] });
  const projectedProtector = projectAnnotatedTextForRecipient(protector, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
  });
  assert.equal(Object.hasOwn(projectedProtector, 'redactions'), false);
  assert.deepEqual(projectedProtector.annotations.map((a) => a.id).sort(), ['code']);

  // A protector whose TARGET became rangeless stays legal and inactive.
  const targetless = canonical();
  targetless.annotations.push({ id: 'targetless', family: 'coding', fields: {} });
  targetless.annotations.push({ id: 'range-tracking', family: 'confidential', fields: {}, protectedTargetIds: ['targetless'] });
  const projectedTargetless = projectAnnotatedTextForRecipient(targetless, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
  });
  assert.deepEqual(projectedTargetless.annotations.map((a) => a.id).sort(), ['code']);
});

test('whole-document denied protector restricts the recipient fail-closed', () => {
  const text = 'entirely secret body';
  const c = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
    ],
    ranges: [
      { annotationId: 'code', start: 0, end: text.length },
      { annotationId: 'protect', start: 0, end: text.length },
    ],
    measurements: [{ id: 'm1', family: 'words', formatVersion: 1, payload: { token: 'leak' } }],
    capabilityHints: [],
    orphans: [{ id: 'orphan-r', family: 'coding', fields: {}, savedQuote: 'hidden quote', savedRange: [0, 6] }],
  };
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: ['body.read'],
  });
  assert.deepEqual(projected, {
    kind: 'workbench.annotatedText.recipient', version: 1, restricted: true, text: '', ranges: [], annotations: [], measurements: [], capabilityHints: [], orphans: [],
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('entirely'), false);
  assert.equal(serialized.includes('orphan-r'), false);
  assert.equal(serialized.includes('hidden quote'), false);
  assert.equal(serialized.includes('leak'), false);
});

test('annotation fully inside a redaction shows through at the redaction marker', () => {
  const text = 'before SECRET after';
  const c = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text,
    annotations: [
      { id: 'code', family: 'coding', fields: {} },
      { id: 'inner', family: 'coding', fields: { note: 'inside' } },
      { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
    ],
    ranges: [
      { annotationId: 'code', start: 0, end: text.length },
      { annotationId: 'inner', start: 7, end: 13 },
      { annotationId: 'protect', start: 7, end: 13 },
    ],
    measurements: [], capabilityHints: [], orphans: [],
  };
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [],
  });
  assert.equal(projected.text, 'before  after');
  assert.deepEqual(projected.redactions, [{ start: 7, end: 7, placeholder: '[Private]' }]);
  assert.deepEqual(projected.ranges, [
    { annotationId: 'code', start: 0, end: 13 },
    { annotationId: 'inner', start: 7, end: 7 },
  ]);
  assert.deepEqual(projected.annotations.map((a) => a.id), ['code', 'inner']);
  assert.deepEqual(projected.annotations.find((a) => a.id === 'inner').fields, { note: 'inside' });
  assert.equal(JSON.stringify(projected).includes('SECRET'), false);
});

test('orphan projection passes safe fields and excludes savedRange', () => {
  const c = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text: 'visible only',
    annotations: [],
    ranges: [],
    measurements: [],
    capabilityHints: [],
    orphans: [{ id: 'orphan-1', family: 'coding', fields: { color: 'blue' }, owner: 'user-7', savedQuote: 'secret', savedRange: [0, 6] }],
  };
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [], capabilityHints: [],
  });
  assert.deepEqual(projected.orphans, [{
    id: 'orphan-1', family: 'coding', fields: { color: 'blue' }, savedQuote: 'secret', owner: 'user-7',
  }]);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('savedRange'), false);
  assert.equal(serialized.includes('last_memberships'), false);
  assert.equal(serialized.includes('endpoint'), false);
  assert.equal(serialized.includes('frontier'), false);
  assert.equal(serialized.includes('structuralRevision'), false);
});

test('recipient projection carries annotation owner', () => {
  const c = canonical();
  c.annotations = [
    { id: 'code', family: 'coding', fields: {}, owner: 'user-42' },
    { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['code'] },
  ];
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
  });
  const code = projected.annotations.find((a) => a.id === 'code');
  assert.equal(code?.owner, 'user-42');
});

test('orphan with conflicting annotation id fails closed', () => {
  assert.throws(() => {
    const c = canonical();
    c.orphans = [{ id: 'code', family: 'coding', fields: {}, savedQuote: 'quote', savedRange: [0, 5] }];
    projectAnnotatedTextForRecipient(c, descriptor(), {
      version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
    });
  }, /orphan id conflicts/);
});

test('orphan with unknown family fails closed', () => {
  assert.throws(() => {
    const c = canonical();
    c.orphans = [{ id: 'orphan-x', family: 'unknown', fields: {}, savedQuote: 'quote', savedRange: [0, 5] }];
    projectAnnotatedTextForRecipient(c, descriptor(), {
      version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
    });
  }, /orphan is invalid/);
});

test('orphan with malformed shape fails closed', () => {
  assert.throws(() => {
    const c = canonical();
    c.orphans = [{ id: 'orphan-x', family: 'coding', fields: {} }];
    projectAnnotatedTextForRecipient(c, descriptor(), {
      version: 1, protectors: [{ protectorId: 'protect', outcome: 'allow' }], capabilityHints: [],
    });
  }, /orphan has invalid shape/);
});

test('orphans are withheld when any range is redacted', () => {
  const c = canonical();
  c.orphans = [{ id: 'orphan-hidden', family: 'coding', fields: {}, savedQuote: 'quote', savedRange: [0, 5] }];
  const projected = projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [],
  });
  assert.deepEqual(projected.orphans, []);
  assert.equal(Object.hasOwn(projected, 'redactions'), true);
  assert.equal(JSON.stringify(projected).includes('orphan-hidden'), false);
  assert.equal(JSON.stringify(projected).includes('quote'), false);
});

test('protecting orphans are never recipient-visible', () => {
  const c = {
    kind: 'workbench.annotatedText.canonical', version: 1,
    text: 'visible only',
    annotations: [],
    ranges: [],
    measurements: [],
    capabilityHints: [],
    orphans: [{ id: 'protect-orphan', family: 'confidential', fields: {}, savedQuote: 'secret', savedRange: [0, 6] }],
  };
  assert.deepEqual(projectAnnotatedTextForRecipient(c, descriptor(), { version: 1, protectors: [], capabilityHints: [] }).orphans, []);
});

test('stale protector target id fails closed', () => {
  const c = canonical();
  c.annotations[1] = { id: 'protect', family: 'confidential', fields: {}, protectedTargetIds: ['missing'] };
  assert.throws(() => projectAnnotatedTextForRecipient(c, descriptor(), {
    version: 1, protectors: [{ protectorId: 'protect', outcome: 'deny' }], capabilityHints: [],
  }), /unknown protected target/);
});
