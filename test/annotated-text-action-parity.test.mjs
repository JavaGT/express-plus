import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { annotatedTextAction as publicBuilder } from '../public/workbench-annotated-text-action.mjs';
import { annotatedTextAction as builder } from '../src/annotated-text-action-builder.mjs';
import { annotatedTextAction as serverAction } from '../src/annotated-text-action.mjs';
import { annotatedText, annotation } from '../src/field.mjs';
import { annotatedTextClientHandle, entity, ref, grant, read } from '../src/index.mjs';

const token = (label) => `${label}${'x'.repeat(43)}`.slice(0, 43);

const Document = entity('BuilderParityDocument', {
  project: ref('Project'),
  owner: ref('User'),
  body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('coding')], measurements: [] }),
  grant: grant(read),
});

const ClientDocument = annotatedTextClientHandle(Document, Document.body);

const authoring = { version: 1, stream: token('stream'), lease: token('lease'), mutationId: 'm1' };

test('public browser re-export IS the pure builder function reference', () => {
  assert.equal(publicBuilder, builder);
});

test('server annotatedTextAction matches the pure builder on representative blockless operations', () => {
  const commands = [
    {
      kind: 'text.insert', id: 'doc-1', authoring,
      at: { positionToken: token('pos'), offset: 0, affinity: 'right' }, text: 'hello',
    },
    {
      kind: 'text.delete', id: 'doc-1', authoring,
      from: { positionToken: token('p1'), offset: 0, affinity: 'left' },
      to: { positionToken: token('p2'), offset: 1, affinity: 'right' },
    },
    {
      kind: 'text.replace', id: 'doc-1', authoring,
      from: { positionToken: token('p1'), offset: 0, affinity: 'left' },
      to: { positionToken: token('p2'), offset: 1, affinity: 'right' },
      text: 'x',
    },
    {
      kind: 'annotation.apply', id: 'doc-1', authoring,
      annotation: { id: 'ann-1', family: 'coding', fields: { value: 'x' } },
      from: { positionToken: token('p1'), offset: 0, affinity: 'left' },
      to: { positionToken: token('p2'), offset: 5, affinity: 'right' },
    },
    {
      kind: 'annotation.remove', id: 'doc-1', authoring,
      annotationId: 'ann-1',
    },
  ];
  for (const command of commands) {
    assert.deepEqual(
      serverAction(Document, Document.body, command),
      builder(ClientDocument, ClientDocument.body, command),
      command.kind,
    );
  }
});

test('pure builder serves the package contract (v9, no scope) on the client handle', () => {
  const request = builder(ClientDocument, ClientDocument.body, {
    kind: 'text.insert', id: 'doc-1', authoring,
    at: { positionToken: token('pos'), offset: 0, affinity: 'right' }, text: 'hello',
  });
  assert.equal(request.payload.version, 9);
  assert.equal('scope' in request, false);
  assert.deepEqual(request, serverAction(Document, Document.body, {
    kind: 'text.insert', id: 'doc-1', authoring,
    at: { positionToken: token('pos'), offset: 0, affinity: 'right' }, text: 'hello',
  }));
});

test('pure builder throws on a non-annotatedText field', () => {
  assert.throws(
    () => builder(ClientDocument, ClientDocument.fields.project, {
      kind: 'text.insert', id: 'doc-1', authoring,
      at: { positionToken: token('pos'), offset: 0, affinity: 'right' }, text: 'hello',
    }),
    /field must be an annotatedText field handle|not an annotatedText field/,
  );
});

test('builder has zero import statements (browser serve-safe)', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/annotated-text-action-builder.mjs', import.meta.url)), 'utf8');
  for (const line of source.split('\n')) {
    assert.ok(!line.startsWith('import '), `unexpected import: ${line}`);
  }
});

test('HTTP path constant serves the pure builder', () => {
  const routes = readFileSync(fileURLToPath(new URL('../src/http-framework-routes.mjs', import.meta.url)), 'utf8');
  assert.match(routes, /annotated-text-action-builder\.mjs/);
});
