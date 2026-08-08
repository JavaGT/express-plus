// Create-source annotation ranges (issue #216): a diarized transcript imports
// its text AND its speaker/annotation ranges atomically in the create action —
// no post-create applies. Ranges are document-absolute over the concatenated
// block texts, validated at the action + import seams, and seeded by the create
// projection in the same transaction with membership-valid affinity.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  admin, annotatedText, annotation, deny, entity, everyone, executeDDL, executeFrameworkDDL, grant, read, ref, scope, text, write,
} from '../src/internal.mjs';
import { materializeText, restoreTextFamily } from '../src/annotated-text-continuous.mjs';
import { projectRangeToOffsets } from '../src/annotated-text-ranges.mjs';
import { exportAnnotatedText } from '../src/annotated-text-public.mjs';

function doc() {
  return entity('RangeDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('turn', { fields: { label: text({ optional: true, nullable: true }) } }),
        annotation('mention', { fields: { user: ref('User', { optional: true, nullable: true }), label: text({ optional: true, nullable: true }) } }),
        annotation('code', { fields: {} }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function project() {
  return entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
}

async function appFor() {
  const db = new DatabaseSync(':memory:');
  const Document = doc();
  const Project = project();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document] });
  app.start();
  await app.ready;
  return { app, db, Document, Project };
}

function createWithRanges(app, id, ranges, blocks = [{ text: 'hello world' }]) {
  return app.dispatch({
    actionId: `create-${id}`,
    type: 'RangeDoc.create',
    principal: { id: 'u1' },
    payload: { id, project: 'p1', owner: 'u1', body: { version: 1, blocks, ...(ranges ? { ranges } : {}) } },
  });
}

function committedMemberships(db, documentId) {
  return db.prepare('SELECT annotation_id, start_point, end_point FROM RangeDoc_body_membership').all()
    .filter((row) => {
      const annotation = db.prepare('SELECT document_id FROM RangeDoc_body_annotation WHERE id = ?').get(row.annotation_id);
      return annotation?.document_id === documentId;
    });
}

async function committedOffsets(db, documentId, annotationId) {
  const state = db.prepare("SELECT family_checkpoint FROM RangeDoc_body_state WHERE document_id = ?").get(documentId);
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  const membership = db.prepare('SELECT start_point, end_point FROM RangeDoc_body_membership WHERE annotation_id = ?').get(annotationId);
  return {
    text: materializeText(family),
    range: membership
      ? projectRangeToOffsets(family, { annotationId, start: JSON.parse(membership.start_point), end: JSON.parse(membership.end_point) })
      : null,
  };
}

test('create with source.ranges lands text and ranges atomically', async () => {
  const { app, db, Document, Project } = await appFor();
  const created = await createWithRanges(app, 'd1', [
    { annotationId: 'turn-1', family: 'turn', start: 0, end: 5, fields: { label: 'SPEAKER_A' } },
    { annotationId: 'turn-2', family: 'turn', start: 6, end: 11, fields: {} },
  ], [{ text: 'hello world' }]);
  assert.equal(created.ok, true, created.failure?.message);

  assert.deepEqual((await committedOffsets(db, 'd1', 'turn-1')).range, { start: 0, end: 5 });
  assert.deepEqual((await committedOffsets(db, 'd1', 'turn-2')).range, { start: 6, end: 11 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM RangeDoc_body_annotation WHERE document_id = 'd1'").get().count, 2);
  assert.equal(db.prepare("SELECT label FROM RangeDoc_body_annotation_turn WHERE annotation_id = 'turn-1'").get().label, 'SPEAKER_A');
  // Absent optional/nullable fields normalize to null.
  assert.equal(db.prepare("SELECT label FROM RangeDoc_body_annotation_turn WHERE annotation_id = 'turn-2'").get().label, null);

  // The canonical export round-trips the ranges.
  const exported = await exportAnnotatedText({ app, entity: Document, field: Document.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' }, principal: { id: 'u1' } });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.text, 'hello world');
  assert.deepEqual(exported.ranges.map((r) => ({ annotationId: r.annotationId, start: r.start, end: r.end })), [
    { annotationId: 'turn-1', start: 0, end: 5 },
    { annotationId: 'turn-2', start: 6, end: 11 },
  ]);
  await app.close?.();
});

test('create with source.ranges seeds one membership per range over multi-block text', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'd2', [
    { annotationId: 'turn-1', family: 'turn', start: 0, end: 6, fields: { label: 'A' } },
    { annotationId: 'turn-2', family: 'turn', start: 6, end: 11, fields: { label: 'B' } },
  ], [{ text: 'hello ' }, { text: 'world' }]);
  assert.equal(created.ok, true, created.failure?.message);
  // Document-absolute offsets over the concatenated 'hello world'.
  assert.deepEqual((await committedOffsets(db, 'd2', 'turn-1')).text, 'hello world');
  assert.deepEqual((await committedOffsets(db, 'd2', 'turn-1')).range, { start: 0, end: 6 });
  assert.deepEqual((await committedOffsets(db, 'd2', 'turn-2')).range, { start: 6, end: 11 });
  assert.equal(committedMemberships(db, 'd2').length, 2);
  await app.close?.();
});

test('create with source.ranges rejects malformed ranges fail-closed', async () => {
  const { app } = await appFor();
  const cases = [
    ['out-of-bounds', [{ annotationId: 'x', family: 'turn', start: 0, end: 99, fields: {} }], /end <= 11|out-of-bounds|offsets/],
    ['unknown family', [{ annotationId: 'x', family: 'nope', start: 0, end: 5, fields: {} }], /family 'nope' is not declared|'nope' is not declared/],
    ['duplicate id', [
      { annotationId: 'x', family: 'turn', start: 0, end: 5, fields: {} },
      { annotationId: 'x', family: 'code', start: 6, end: 11, fields: {} },
    ], /duplicate annotationId 'x'/],
    ['unknown key', [{ annotationId: 'x', family: 'turn', start: 0, end: 5, fields: {}, bogus: 1 }], /unknown key 'bogus'/],
    ['unknown field', [{ annotationId: 'x', family: 'turn', start: 0, end: 5, fields: { bogus: 1 } }], /unknown field 'bogus'|has unknown field 'bogus'/],
    ['zero width', [{ annotationId: 'x', family: 'turn', start: 3, end: 3, fields: {} }], /0 <= start < end/],
  ];
  for (const [label, ranges, pattern] of cases) {
    const result = await createWithRanges(app, `reject-${label}`, ranges);
    assert.equal(result.ok, false, `${label} should fail`);
    assert.match(result.failure?.message ?? '', pattern, label);
  }
  await app.close?.();
});

test('create with source.ranges rejects a range ending mid-surrogate', async () => {
  const { app } = await appFor();
  // '😀' is a surrogate pair at offsets 1-2; a range ending at 2 is mid-scalar.
  const result = await createWithRanges(app, 'surrogate', [
    { annotationId: 's-1', family: 'turn', start: 0, end: 2, fields: {} },
  ], [{ text: 'a😀b' }]);
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /surrogate|scalar|offset/i);
  await app.close?.();
});

test('create with source.ranges stores ref annotation fields and null-nullable refs', async () => {
  const { app, db } = await appFor();
  const created = await createWithRanges(app, 'd4', [
    { annotationId: 'm-1', family: 'mention', start: 0, end: 5, fields: { user: 'u1', label: 'hi' } },
    { annotationId: 'm-2', family: 'mention', start: 6, end: 11, fields: {} },
  ], [{ text: 'hello world' }]);
  assert.equal(created.ok, true, created.failure?.message);
  assert.equal(db.prepare("SELECT user, label FROM RangeDoc_body_annotation_mention WHERE annotation_id = 'm-1'").get().user, 'u1');
  assert.equal(db.prepare("SELECT user, label FROM RangeDoc_body_annotation_mention WHERE annotation_id = 'm-1'").get().label, 'hi');
  // Absent optional/nullable ref + text both normalize to null.
  const m2 = db.prepare("SELECT user, label FROM RangeDoc_body_annotation_mention WHERE annotation_id = 'm-2'").get();
  assert.equal(m2.user, null);
  assert.equal(m2.label, null);
  await app.close?.();
});

test('create with source.ranges leaves the durable state empty when rejected', async () => {
  const { app, db } = await appFor();
  const before = db.serialize();
  const result = await createWithRanges(app, 'd3', [{ annotationId: 'x', family: 'nope', start: 0, end: 5, fields: {} }]);
  assert.equal(result.ok, false);
  assert.deepEqual(db.serialize(), before);
  await app.close?.();
});
