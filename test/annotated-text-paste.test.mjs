import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotatedTextAction } from '../build/annotated-text-action-builder.mjs';
import { assertV9AnnotatedTextOffsetEditPayload } from '../build/entity/crud.mjs';

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

test('generated CRUD v9 parser admits annotation.paste', () => {
  const command = assertV9AnnotatedTextOffsetEditPayload('Doc', 'body', {
    version: 9,
    id: 'doc-1',
    authoring,
    edit: {
      kind: 'annotation.paste',
      at: { positionToken: token('position'), offset: 3, affinity: 'right' },
      text: 'coded',
      annotation: { id: 'source-1', family: 'coding', fields: { label: 'important' } },
    },
  });
  assert.equal(command.edit.kind, 'annotation.paste');
  assert.equal(command.edit.text, 'coded');
  assert.equal(command.edit.annotation.family, 'coding');
  assert.equal(Object.isFrozen(command.edit), true);
});
