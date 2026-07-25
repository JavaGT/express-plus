import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { assertR5AnnotationDetachPayload } from '../src/annotated-text-r5.mjs';

describe('assertR5AnnotationDetachPayload', () => {
  const validPayload = {
    version: 5,
    id: 'doc-1',
    expected: { structuralRevision: 3, frontier: ['a'] },
    operation: { kind: 'annotation.detach', annotationId: 'ann-1', blockId: 'block-1' },
  };

  test('accepts and freezes a closed detach payload', () => {
    const result = assertR5AnnotationDetachPayload('Doc', 'body', validPayload);
    assert.deepEqual(result, validPayload);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.expected));
    assert.ok(Object.isFrozen(result.operation));
  });

  test('rejects extra, missing, and malformed detach fields', () => {
    assert.throws(() => assertR5AnnotationDetachPayload('Doc', 'body', { ...validPayload, extra: true }), /exactly/);
    assert.throws(() => assertR5AnnotationDetachPayload('Doc', 'body', { ...validPayload, operation: { kind: 'annotation.detach', annotationId: 'ann-1' } }), /requires annotation.detach/);
    assert.throws(() => assertR5AnnotationDetachPayload('Doc', 'body', { ...validPayload, operation: { ...validPayload.operation, blockId: '' } }), /requires annotation.detach/);
  });
});
