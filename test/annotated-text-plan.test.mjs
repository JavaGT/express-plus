import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  importTextToFamily,
  materializeText,
  resolveOffsetToEndpoint,
} from '../src/annotated-text-continuous.mjs';
import {
  planTextOffsetEdit,
  planAnnotationApplyOffsets,
  planAnnotationRemove,
  planTextRangeApply,
} from '../src/annotated-text-plan.mjs';

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

function rangeFor(family, annotationId, startOffset, endOffset) {
  const frontier = family.checkpoint.frontier;
  return {
    annotationId,
    start: resolveOffsetToEndpoint(family, startOffset, frontier, 'left'),
    end: resolveOffsetToEndpoint(family, endOffset, frontier, 'right'),
  };
}

test('plans insert, delete, and replace as unified document-wide operations', () => {
  const family = familyFromText('abc');

  const inserted = input(family, { kind: 'text.insert', text: 'x', at: at(1) });
  assert.equal(inserted.version, 13);
  assert.equal(inserted.operation.kind, 'text.apply');
  assert.equal(inserted.id, 'doc1');
  assert.deepEqual(inserted.before, { structuralRevision: 1, frontier: family.checkpoint.frontier });
  assert.equal(inserted.after.structuralRevision, 1, 'insert does not bump structuralRevision');
  assert.equal(materializeText(inserted.facts.family), 'axbc');
  assert.equal(inserted.operation.operation[0], 'workbench.text');
  assert.equal(inserted.operation.operation[5][0], 'insert');
  assert.equal(inserted.operation.operation[5][2], 'x');
  assert.deepEqual(inserted.facts.emptiedAnnotations, []);

  const deleted = input(family, { kind: 'text.delete', from: at(1), to: at(2) });
  assert.equal(deleted.version, 13);
  assert.equal(deleted.operation.kind, 'text.apply');
  assert.equal(materializeText(deleted.facts.family), 'ac');
  assert.equal(deleted.operation.operation[5][0], 'delete');
  assert.equal(deleted.after.structuralRevision, 1, 'delete without emptied ranges keeps revision');

  const replaced = input(family, { kind: 'text.replace', text: 'xy', from: at(1), to: at(2) });
  assert.equal(replaced.version, 13);
  assert.equal(replaced.operation.kind, 'text.replace');
  assert.equal(replaced.operation.operations.length, 2);
  assert.equal(replaced.operation.operations[0][5][0], 'delete');
  assert.equal(replaced.operation.operations[1][5][0], 'insert');
  assert.equal(replaced.operation.operations[1][5][2], 'xy');
  assert.equal(materializeText(replaced.facts.family), 'axyc');
  assert.equal(replaced.after.structuralRevision, 1);
  assert.ok(Array.isArray(replaced.after.frontier));
});

test('delete empties an orphan-policy annotation and bumps structuralRevision', () => {
  const family = familyFromText('abcd');
  const annotation = { id: 'ann1', family: 'comment', empty: 'orphan', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 2, 4)];
  const plan = input(family, { kind: 'text.delete', from: at(2), to: at(4) }, {
    annotations: [annotation],
    ranges,
  });
  assert.equal(plan.version, 13);
  assert.equal(materializeText(plan.facts.family), 'ab');
  assert.equal(plan.after.structuralRevision, 2, 'emptied range bumps structuralRevision');
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'ann1');
  assert.equal(plan.facts.emptiedAnnotations[0].empty, 'orphan');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'orphaned');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.family, 'comment');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.savedQuote, 'cd');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.lastRange, null);
});

test('replace empties a delete-policy annotation like a delete does', () => {
  const family = familyFromText('abcd');
  const annotation = { id: 'ann1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  // Range endpoints use left affinity so a replace that covers the annotated
  // span can leave start>=end after the delete+insert pair (insert sits after
  // a right-affinity end and would keep the range non-empty).
  const frontier = family.checkpoint.frontier;
  const ranges = [{
    annotationId: 'ann1',
    start: resolveOffsetToEndpoint(family, 1, frontier, 'left'),
    end: resolveOffsetToEndpoint(family, 2, frontier, 'left'),
  }];
  const plan = input(family, {
    kind: 'text.replace',
    text: 'Z',
    from: at(0, 'left'),
    to: at(2, 'left'),
  }, {
    annotations: [annotation],
    ranges,
  });
  assert.equal(plan.operation.kind, 'text.replace');
  assert.equal(plan.operation.operations.length, 2);
  assert.equal(materializeText(plan.facts.family), 'Zcd');
  assert.equal(plan.after.structuralRevision, 2);
  assert.equal(plan.facts.emptiedAnnotations.length, 1);
  assert.equal(plan.facts.emptiedAnnotations[0].annotationId, 'ann1');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.kind, 'deleted');
  assert.equal(plan.facts.emptiedAnnotations[0].disposition.savedQuote, null);
});

test('delete that does not empty a covering range leaves emptiedAnnotations empty', () => {
  const family = familyFromText('abcd');
  const annotation = { id: 'ann1', family: 'comment', empty: 'orphan', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 0, 4)];
  const plan = input(family, { kind: 'text.delete', from: at(1), to: at(2) }, {
    annotations: [annotation],
    ranges,
  });
  assert.equal(materializeText(plan.facts.family), 'acd');
  assert.deepEqual(plan.facts.emptiedAnnotations, []);
  assert.equal(plan.after.structuralRevision, 1);
});

test('planAnnotationApplyOffsets is rejected as block-era', () => {
  assert.throws(
    () => planAnnotationApplyOffsets(),
    (error) => error.code === 'position-invalid' && /block-era|planTextRangeApply/.test(error.message),
  );
});

test('removes an annotation and freezes the v13 result', () => {
  const family = familyFromText('abc');
  const annotation = { id: 'ann1', family: 'comment', empty: 'delete', protectedTargetIds: [] };
  const ranges = [rangeFor(family, 'ann1', 0, 3)];
  const plan = planAnnotationRemove({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    annotationId: 'ann1',
    annotations: [annotation],
    ranges,
  });
  assert.equal(plan.version, 13);
  assert.equal(plan.operation.kind, 'annotation.remove');
  assert.equal(plan.operation.annotationId, 'ann1');
  assert.equal(plan.facts.result.disposition.kind, 'deleted');
  assert.deepEqual(plan.facts.removedAnnotationIds, ['ann1']);
  assert.deepEqual(plan.facts.ranges, []);
  assert.equal(plan.after.structuralRevision, 1);
  assert.equal(plan.facts.family.id, 'doc1');
  assert.ok(Object.isFrozen(plan));
});

test('plans a text-range apply as one document range with no family change', () => {
  const family = familyFromText('A diarized transcript');
  const annotation = { id: 'code1', family: 'code', fields: {} };
  const plan = planTextRangeApply({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    annotation,
    from: at(2),
    to: at(12),
  });
  assert.equal(plan.version, 13);
  assert.equal(plan.operation.kind, 'annotation.apply-range');
  assert.deepEqual(plan.operation.selection, { startOffset: 2, endOffset: 12 });
  assert.equal(plan.operation.annotation.id, 'code1');
  assert.equal(plan.after.structuralRevision, 1, 'revision unchanged');
  assert.deepEqual(plan.after.frontier, family.checkpoint.frontier);
  assert.equal(plan.facts.family.id, 'doc1');
  assert.equal(materializeText(plan.facts.family), 'A diarized transcript');
  assert.equal(plan.facts.ranges.length, 1);
  assert.equal(plan.facts.ranges[0].annotationId, 'code1');
  assert.ok(plan.facts.ranges[0].start.point, 'carries structural start endpoint');
  assert.ok(plan.facts.ranges[0].end.point, 'carries structural end endpoint');
  assert.equal(plan.facts.selectedRange.annotationId, 'code1');
  assert.ok(plan.facts.selectedRange.start.point);
  assert.ok(plan.facts.selectedRange.end.point);
  assert.deepEqual(plan.facts.measurements, []);
});

test('text-range apply replaces an existing range for the same annotation', () => {
  const family = familyFromText('hello world');
  const annotation = { id: 'code1', family: 'code', fields: {} };
  const existing = [rangeFor(family, 'code1', 0, 5), rangeFor(family, 'other', 6, 11)];
  const plan = planTextRangeApply({
    documentId: 'doc1',
    structureVersion: 1,
    family,
    annotation,
    from: at(6),
    to: at(11),
    ranges: existing,
  });
  assert.equal(plan.facts.ranges.length, 2);
  const byId = Object.fromEntries(plan.facts.ranges.map((entry) => [entry.annotationId, entry]));
  assert.ok(byId.code1);
  assert.ok(byId.other);
  assert.equal(plan.operation.selection.startOffset, 6);
  assert.equal(plan.operation.selection.endOffset, 11);
});

test('rejects out-of-bounds offsets and empty delete ranges', () => {
  const family = familyFromText('abc');
  assert.throws(
    () => input(family, { kind: 'text.insert', text: 'x', at: at(9) }),
    (error) => error.code === 'position-invalid',
  );
  assert.throws(
    () => input(family, { kind: 'text.delete', from: at(1), to: at(1) }),
    (error) => error.code === 'position-invalid' && /non-empty/.test(error.message),
  );
  assert.throws(
    () => input(family, { kind: 'text.delete', from: at(2), to: at(1) }),
    (error) => error.code === 'position-invalid',
  );
  assert.throws(
    () => input(family, { kind: 'text.replace', text: 'z', from: at(0), to: at(99) }),
    (error) => error.code === 'position-invalid',
  );
});

test('annotation remove requires the annotation to exist', () => {
  const family = familyFromText('abc');
  assert.throws(
    () => planAnnotationRemove({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotationId: 'missing',
      annotations: [],
      ranges: [],
    }),
    /annotation not found/,
  );
});

test('text-range apply rejects empty or inverted selections', () => {
  const family = familyFromText('hello world');
  const annotation = { id: 'code1', family: 'code', fields: {} };
  assert.throws(
    () => planTextRangeApply({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotation,
      from: at(2),
      to: at(2),
    }),
    (error) => error.code === 'position-invalid' && /forward, non-empty range/.test(error.message),
  );
  assert.throws(
    () => planTextRangeApply({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotation,
      from: at(5),
      to: at(2),
    }),
    (error) => error.code === 'position-invalid',
  );
  assert.throws(
    () => planTextRangeApply({
      documentId: 'doc1',
      structureVersion: 1,
      family,
      annotation,
      from: at(0),
      to: at(99),
    }),
    (error) => error.code === 'position-invalid',
  );
});
