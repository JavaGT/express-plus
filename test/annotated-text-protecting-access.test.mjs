import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import workbench, { annotatedText, annotation, entity, everyone, grant, inherit, measurement, protectingAnnotation, read, ref, registerAnnotatedTextContract, scope, text, write } from '../src/index.mjs';
import { executeDDL, executeFrameworkDDL, getAnnotatedTextCompiledMetadata, protectingAnnotationCapabilities, registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';

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

test('protecting annotation access resolves checks across multi-hop inheritance', async (t) => {
  const body = protectedBody(async ({ is, annotation }) => (await is.owner()) && annotation.fields.reader === 'alice' ? grant(read) : grant());
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const Project = entity('ProtectingAccessProject', { name: text() });
  const Root = entity('ProtectingAccessRoot', {
    project: ref(Project), owner: ref('User', { role: 'owner' }), body,
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write) : grant())],
  });
  const Mid = entity('ProtectingAccessMid', { rootId: ref(Root), project: ref(Project), owner: ref('User'), body, grant: inherit(Root, { via: 'rootId' }) });
  const Leaf = entity('ProtectingAccessLeaf', { midId: ref(Mid), project: ref(Project), owner: ref('User'), body, grant: inherit(Mid, { via: 'midId' }) });
  executeDDL(Project, db); executeDDL(Root, db); executeDDL(Mid, db); executeDDL(Leaf, db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User (id) VALUES ('alice')");
  db.exec("INSERT INTO ProtectingAccessProject (id, name) VALUES ('p1', 'Study')");
  db.exec("INSERT INTO ProtectingAccessRoot (id, project, owner) VALUES ('d1', 'p1', 'alice')");
  db.exec("INSERT INTO ProtectingAccessMid (id, rootId, project, owner) VALUES ('mid-1', 'd1', 'p1', 'alice')");
  db.exec("INSERT INTO ProtectingAccessLeaf (id, midId, project, owner) VALUES ('leaf-1', 'mid-1', 'p1', 'alice')");
  const app = workbench({ db, entities: [Project, Root, Mid, Leaf] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const access = getAnnotatedTextCompiledMetadata(body).protectingFamilies.confidential.access;
  const annotation = { id: 'p1', fields: { reader: 'alice' } };
  const leafRow = db.prepare("SELECT * FROM ProtectingAccessLeaf WHERE id = 'leaf-1'").get();
  const allowed = await protectingAnnotationCapabilities(app.entity(Leaf), leafRow, annotation, access, { type: 'user', id: 'alice', attributes: {} });
  const denied = await protectingAnnotationCapabilities(app.entity(Leaf), leafRow, annotation, access, { type: 'user', id: 'bob', attributes: {} });
  assert.ok(allowed.capabilities.includes(read), 'owner check resolves through every inherit hop');
  assert.equal(denied.capabilities.includes(read), false);
});

test('protecting annotation declarations require access when they protect another family', () => {
  assert.throws(() => entity('MissingProtectingAccessDoc', {
    project: ref('Project'), owner: ref('User'), body: protectedBody(null),
  }), /access.*must be a function/);
});
