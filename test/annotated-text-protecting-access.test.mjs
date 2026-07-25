import assert from 'node:assert/strict';
import test from 'node:test';
import { annotatedText, annotation, entity, grant, measurement, protectingAnnotation, read, ref, registerAnnotatedTextContract } from '../src/index.mjs';
import { getAnnotatedTextCompiledMetadata, protectingAnnotationCapabilities, registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';

const extension = 'protectingAccessMeasurement';
registerAnnotatedTextContract(extension, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(extension, Object.freeze({ version: 1, validate: function validate() {}, edit: function edit() {}, partition: function partition() {}, combine: function combine() {} }));

function protectedBody(access) {
  return annotatedText({
    project: 'project', owner: 'owner', annotations: [annotation('coding'), protectingAnnotation('confidential', { protects: 'coding', access })],
    measurements: [measurement('words', { extension })],
  });
}

test('protecting annotation access uses the existing entity check registry and grant tokens', async () => {
  const body = protectedBody(async ({ is, annotation }) => (await is.owner()) && annotation.fields.reader === 'alice' ? grant(read) : grant());
  const Doc = entity('ProtectingAccessDoc', {
    project: ref('Project'), owner: ref('User', { role: 'owner' }),
    body,
  });
  const access = getAnnotatedTextCompiledMetadata(body).protectingFamilies.confidential.access;
  const annotation = { id: 'p1', fields: { reader: 'alice' } };
  const allowed = await protectingAnnotationCapabilities(Doc, { id: 'd1', owner: 'alice' }, annotation, access, { id: 'alice' });
  const denied = await protectingAnnotationCapabilities(Doc, { id: 'd1', owner: 'alice' }, annotation, access, { id: 'bob' });
  assert.ok(allowed.capabilities.includes(read));
  assert.equal(denied.capabilities.includes(read), false);
});

test('protecting annotation declarations require access when they protect another family', () => {
  assert.throws(() => entity('MissingProtectingAccessDoc', {
    project: ref('Project'), owner: ref('User'), body: protectedBody(null),
  }), /access.*must be a function/);
});
