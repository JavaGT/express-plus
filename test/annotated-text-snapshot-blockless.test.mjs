import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { annotatedText, annotation, protectingAnnotation, entity, everyone, grant, read, write, ref, scope, admin, subscribe } from '../build/index.mjs';
import { executeDDL, executeFrameworkDDL, registerAnnotatedTextStructuralExtension } from '../build/internal.mjs';
import { registerAnnotatedTextContract } from '../build/index.mjs';
import { importTextToFamily, textFamilyCheckpoint } from '../build/annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot, exportAnnotatedText } from '../build/annotated-text-snapshot.mjs';
import { resolveOffsetToEndpoint } from '../build/annotated-text-continuous.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';

registerAnnotatedTextContract('m', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('m', Object.freeze({ version: 1, validate() {}, edit() {}, partition() {}, combine() {} }));

const ACTOR = 'a'.repeat(32);

function setup() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  const Project = entity('Project', { owner: ref('User', { role: 'owner' }), grant: [scope(() => everyone()).can(() => grant(read, write, admin))] });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  const Doc = entity('Doc', {
    project: ref('Project', { physical: true }), owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [
        annotation('comment', { empty: 'orphan' }),
        annotation('sensitive', { empty: 'delete' }),
        protectingAnnotation('confidential', { protects: 'sensitive', placeholder: '[REDACTED]', access: async ({ is }) => (await is.owner()) ? grant(read) : grant() }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Doc, db);
  const app = workbench({ db, entities: [Project, Doc] });
  return { db, app, Doc, Project };
}

function seedDocument(db, Doc, text, annotations = []) {
  db.prepare("INSERT INTO Doc (id, project, owner) VALUES ('d1', 'p1', 'u1')").run();
  const family = importTextToFamily('d1', ACTOR, text);
  db.prepare('INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)').run('d1', JSON.stringify(textFamilyCheckpoint(family)));
  for (const annotation of annotations) {
    db.prepare('INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(annotation.id, 'd1', 'p1', 'u1', annotation.family);
    const start = resolveOffsetToEndpoint(family, annotation.start, family.checkpoint.frontier, 'right');
    const end = resolveOffsetToEndpoint(family, annotation.end, family.checkpoint.frontier, 'right');
    attachAnnotationRange(db, 'Doc_body', 'd1', annotation.id, start, end, 0);
    if (annotation.protectedTargetIds) {
      for (const target of annotation.protectedTargetIds) {
        db.prepare('INSERT INTO Doc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)').run(annotation.id, target);
      }
    }
  }
  return family;
}

test('snapshot projects one continuous text plus document ranges', async () => {
  const { db, app, Doc } = setup();
  await app.ready;
  const family = seedDocument(db, Doc, 'hello world', [{ id: 'a1', family: 'comment', start: 6, end: 11 }]);
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const snap = await projectAnnotatedTextSnapshot({ db, entity: Doc, row, principal, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false });
  assert.equal(snap.text, 'hello world');
  assert.deepEqual(snap.ranges, [{ annotationId: 'a1', start: 6, end: 11 }]);
  assert.equal(snap.annotations.length, 1);
  await app.shutdown(); db.close();
  void family;
});

test('snapshot redacts a denied protector range', async () => {
  const { db, app, Doc } = setup();
  await app.ready;
  seedDocument(db, Doc, 'open text secret more', [
    { id: 's1', family: 'sensitive', start: 10, end: 16 },
    { id: 'c1', family: 'confidential', start: 10, end: 16, protectedTargetIds: ['s1'] },
  ]);
  // The reader is denied the protector's range and sees the placeholder hole.
  const reader = { type: 'user', id: 'reader', attributes: {} };
  db.prepare("INSERT INTO User (id) VALUES ('reader')").run();
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const snap = await projectAnnotatedTextSnapshot({ db, entity: Doc, row, principal: reader, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false });
  assert.equal(snap.text, 'open text  more');
  assert.deepEqual(snap.redactions, [{ start: 10, end: 10, placeholder: '[REDACTED]' }]);
  await app.shutdown(); db.close();
});

test('export produces the blockless canonical', async () => {
  const { db, app, Doc, Project } = setup();
  await app.ready;
  seedDocument(db, Doc, 'hello world', [{ id: 'a1', family: 'comment', start: 6, end: 11 }]);
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const exported = await exportAnnotatedText({ app, entity: Doc, field: Doc.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' }, principal });
  assert.equal(exported.text, 'hello world');
  assert.deepEqual(exported.ranges, [{ annotationId: 'a1', start: 6, end: 11 }]);
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  await app.shutdown(); db.close();
});

test('orphan with no recorded last range survives as [0, 0]', async () => {
  const { db, app, Doc, Project } = setup();
  await app.ready;
  seedDocument(db, Doc, 'orphaned word', [{ id: 'o1', family: 'comment', start: 0, end: 7 }]);
  // A deletion can orphan without a recorded range; the orphan state carries a
  // JSON null saved range which must project to [0, 0], not brick the document.
  db.prepare("UPDATE Doc_body_annotation SET id = 'o1' WHERE id = 'a1'").run();
  db.prepare("DELETE FROM Doc_body_membership WHERE annotation_id = 'o1'").run();
  db.prepare("INSERT INTO Doc_body_annotation_orphan_state (annotation_id, saved_quote, last_range) VALUES ('o1', 'orphaned', 'null')").run();
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const snap = await projectAnnotatedTextSnapshot({ db, entity: Doc, row, principal, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false });
  assert.equal(snap.text, 'orphaned word');
  // The recipient view discloses the orphan identity + saved quote but not the
  // last range; the CANONICAL export carries the tolerated [0, 0].
  assert.deepEqual(snap.orphans, [{
    id: 'o1', family: 'comment', fields: {}, owner: 'u1', savedQuote: 'orphaned',
  }]);
  const exported = await exportAnnotatedText({ app, entity: Doc, field: Doc.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' }, principal });
  assert.deepEqual(exported.orphans, [{
    id: 'o1', family: 'comment', fields: {}, owner: 'u1', savedQuote: 'orphaned', savedRange: [0, 0],
  }]);
  await app.shutdown(); db.close();
});
