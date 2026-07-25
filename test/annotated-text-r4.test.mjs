import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { assertR4AnnotationApplyPayload, isolateAnnotationSelection } from '../src/annotated-text-r4.mjs';
import { createTextState, textCheckpoint } from '../src/annotated-text.mjs';
import { applyTextOperationToBlock, createTextFamily, materializeBlock } from '../src/annotated-text-family.mjs';

describe('assertR4AnnotationApplyPayload', () => {
  const validPayload = {
    version: 4,
    id: 'op-001',
    expected: { structuralRevision: 3, frontier: ['a'] },
    operation: {
      kind: 'annotation.apply',
      annotation: { id: 'ann-1', family: 'theme', fields: { color: 'red', weight: 1 } },
      selection: { blockId: 'block-1', startUtf16Offset: 10, endUtf16Offset: 42 },
    },
  };

  test('accepts a valid payload', () => {
    const result = assertR4AnnotationApplyPayload('Test', 'annotations', validPayload);
    assert.equal(result.version, 4);
    assert.equal(result.id, 'op-001');
    assert.equal(result.expected.structuralRevision, 3);
    assert.deepEqual(result.expected.frontier, ['a']);
    assert.equal(result.operation.kind, 'annotation.apply');
    assert.equal(result.operation.annotation.id, 'ann-1');
    assert.equal(result.operation.annotation.family, 'theme');
    assert.deepEqual(result.operation.annotation.fields, { color: 'red', weight: 1 });
    assert.equal(result.operation.selection.blockId, 'block-1');
    assert.equal(result.operation.selection.startUtf16Offset, 10);
    assert.equal(result.operation.selection.endUtf16Offset, 42);
  });

  test('freezes the returned object', () => {
    const result = assertR4AnnotationApplyPayload('Test', 'annotations', validPayload);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.expected), true);
    assert.equal(Object.isFrozen(result.operation), true);
    assert.equal(Object.isFrozen(result.operation.annotation), true);
    assert.equal(Object.isFrozen(result.operation.selection), true);
  });

  test('rejects non-object payload', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', null), /ValidationError/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', 'string'), /ValidationError/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', []), /ValidationError/);
  });

  test('rejects payload missing keys', () => {
    const { version, ...noVersion } = validPayload;
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', noVersion), /requires exactly/);
    const { id, ...noId } = validPayload;
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', noId), /requires exactly/);
    const { expected, ...noExpected } = validPayload;
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', noExpected), /requires exactly/);
    const { operation, ...noOperation } = validPayload;
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', noOperation), /requires exactly/);
  });

  test('rejects extra keys', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, extra: true }), /requires exactly/);
  });

  test('rejects wrong version', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, version: 3 }), /version 4/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, version: '4' }), /version 4/);
  });

  test('rejects empty id', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, id: '' }), /non-empty id/);
  });

  test('rejects invalid expected', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, expected: null }), /structuralRevision/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, expected: {} }), /structuralRevision/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, expected: { structuralRevision: 0, frontier: [] } }), /structuralRevision/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, expected: { structuralRevision: 1.5, frontier: [] } }), /structuralRevision/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, expected: { structuralRevision: 3, frontier: 'not-array' } }), /frontier/);
  });

  test('rejects missing annotation', () => {
    const { annotation, ...opNoAnn } = validPayload.operation;
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, operation: { ...opNoAnn, kind: 'annotation.apply' } }), /annotation \{/);
  });

  test('rejects empty annotation id', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, annotation: { ...validPayload.operation.annotation, id: '' } },
    }), /annotation \{/);
  });

  test('rejects empty annotation family', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, annotation: { ...validPayload.operation.annotation, family: '' } },
    }), /annotation \{/);
  });

  test('rejects non-object annotation fields', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, annotation: { ...validPayload.operation.annotation, fields: null } },
    }), /annotation \{/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, annotation: { ...validPayload.operation.annotation, fields: 'string' } },
    }), /annotation \{/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, annotation: { ...validPayload.operation.annotation, fields: [] } },
    }), /annotation \{/);
  });

  test('rejects missing selection', () => {
    const { selection, ...opNoSel } = validPayload.operation;
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', { ...validPayload, operation: { ...opNoSel, kind: 'annotation.apply' } }), /annotation \{/);
  });

  test('rejects empty selection blockId', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, selection: { ...validPayload.operation.selection, blockId: '' } },
    }), /selection \{/);
  });

  test('rejects negative offsets', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, selection: { ...validPayload.operation.selection, startUtf16Offset: -1 } },
    }), /selection \{/);
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, selection: { ...validPayload.operation.selection, endUtf16Offset: -1 } },
    }), /selection \{/);
  });

  test('rejects non-integer offsets', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, selection: { ...validPayload.operation.selection, startUtf16Offset: 1.5 } },
    }), /selection \{/);
  });

  test('rejects wrong operation kind', () => {
    assert.throws(() => assertR4AnnotationApplyPayload('T', 'a', {
      ...validPayload,
      operation: { ...validPayload.operation, kind: 'block.split' },
    }), /annotation.apply/);
  });

  test('accepts fields with nested objects and arrays', () => {
    const nested = {
      ...validPayload,
      operation: {
        ...validPayload.operation,
        annotation: { ...validPayload.operation.annotation, fields: { nested: { a: 1 }, list: [1, 2, 3] } },
      },
    };
    const result = assertR4AnnotationApplyPayload('T', 'a', nested);
    assert.deepEqual(result.operation.annotation.fields, { nested: { a: 1 }, list: [1, 2, 3] });
  });

  test('accepts fields with null, boolean, string, number values', () => {
    const mixed = {
      ...validPayload,
      operation: {
        ...validPayload.operation,
        annotation: { ...validPayload.operation.annotation, fields: { n: null, b: true, s: 'hi', num: 42 } },
      },
    };
    const result = assertR4AnnotationApplyPayload('T', 'a', mixed);
    assert.deepEqual(result.operation.annotation.fields, { n: null, b: true, s: 'hi', num: 42 });
  });

  test('includes name and fieldName in error messages', () => {
    try {
      assertR4AnnotationApplyPayload('MyDoc', 'myField', null);
    } catch (e) {
      assert.ok(e.message.includes('MyDoc'));
      assert.ok(e.message.includes('myField'));
    }
  });
});

describe('isolateAnnotationSelection', () => {
  const replica = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function familyWith(text) {
    const initial = createTextFamily('d1', textCheckpoint(createTextState()), 'block-1');
    return applyTextOperationToBlock(initial, 'block-1', ['workbench.text', 1, [replica, 1], 1, [], ['insert', ['root'], text]]);
  }

  test('keeps a whole-block selection intact without a split', () => {
    const family = familyWith('abcdef');
    const result = isolateAnnotationSelection(family, 'block-1', 0, 6, []);
    assert.equal(result.selectedBlockId, 'block-1');
    assert.deepEqual(result.splitBlockIds, []);
    assert.equal(materializeBlock(result.family, 'block-1'), 'abcdef');
    assert.equal(result.family, family);
  });

  test('isolates prefix, suffix, and interior selections with canonical split counts', () => {
    const prefix = isolateAnnotationSelection(familyWith('abcdef'), 'block-1', 0, 2, ['tail']);
    assert.equal(materializeBlock(prefix.family, prefix.selectedBlockId), 'ab');
    assert.deepEqual(prefix.family.blocks.map((block) => block.id), ['block-1', 'tail']);

    const suffix = isolateAnnotationSelection(familyWith('abcdef'), 'block-1', 4, 6, ['selected']);
    assert.equal(suffix.selectedBlockId, 'selected');
    assert.equal(materializeBlock(suffix.family, suffix.selectedBlockId), 'ef');
    assert.deepEqual(suffix.family.blocks.map((block) => block.id), ['block-1', 'selected']);

    const interior = isolateAnnotationSelection(familyWith('abcdef'), 'block-1', 2, 4, ['selected', 'tail']);
    assert.equal(interior.selectedBlockId, 'selected');
    assert.equal(materializeBlock(interior.family, interior.selectedBlockId), 'cd');
    assert.deepEqual(interior.family.blocks.map((block) => block.id), ['block-1', 'selected', 'tail']);
    assert.deepEqual(interior.splitBlockIds, ['selected', 'tail']);
  });

  test('rejects invalid, empty, surrogate-splitting, and malformed split-ID selections', () => {
    const family = familyWith('a😀b');
    assert.throws(() => isolateAnnotationSelection(family, 'block-1', 1, 1, ['x']), /non-empty/);
    assert.throws(() => isolateAnnotationSelection(family, 'block-1', 3, 1, ['x']), /non-empty/);
    assert.throws(() => isolateAnnotationSelection(family, 'block-1', 0, 5, []), /non-empty/);
    assert.throws(() => isolateAnnotationSelection(family, 'block-1', 1, 2, ['x', 'y']), /splits a surrogate pair/);
    assert.throws(() => isolateAnnotationSelection(family, 'block-1', 0, 1, []), /exactly 1/);
    assert.throws(() => isolateAnnotationSelection(family, 'block-1', 1, 3, ['x', 'x']), /unique/);
  });

  test('returns an immutable result without changing the source family', () => {
    const family = familyWith('abcdef');
    const result = isolateAnnotationSelection(family, 'block-1', 2, 4, ['selected', 'tail']);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.splitBlockIds), true);
    assert.equal(materializeBlock(family, 'block-1'), 'abcdef');
    assert.throws(() => { result.splitBlockIds.push('other'); }, TypeError);
  });
});
