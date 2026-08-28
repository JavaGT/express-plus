import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotatedTextAction } from '../build/annotated-text-action-builder.mjs';

const token = (label) => `${label}${'x'.repeat(43)}`.slice(0, 43);
const entity = { name: 'Doc', fields: { body: { kind: 'annotatedText' } } };
const field = { fieldName: 'body' };
const authoring = { version: 1, stream: token('stream'), lease: token('lease'), mutationId: 'paste-1' };

test('paste action carries copied annotation fields without accepting a destination id', () => {
  const request = annotatedTextAction(entity, field, {
    kind: 'annotation.paste',
    id: 'doc-1',
    authoring,
    at: { positionToken: token('position'), offset: 3, affinity: 'right' },
    text: 'coded',
    annotation: { id: 'source-1', family: 'coding', fields: { label: 'important' } },
  });
  assert.deepEqual(request.payload.edit, {
    kind: 'annotation.paste',
    at: { positionToken: token('position'), offset: 3, affinity: 'right' },
    text: 'coded',
    annotation: { id: 'source-1', family: 'coding', fields: { label: 'important' } },
  });
  assert.equal(Object.isFrozen(request.payload.edit), true);
});
