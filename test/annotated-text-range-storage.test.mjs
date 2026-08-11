// Hostile + bounded-loading proofs for normalized immutable shared range
// storage (issue #61 / #62). Ranges are immutable records; identical complete
// structural endpoints intern to one range row regardless of annotation type;
// reanchoring replaces only the annotation's membership link; a one-cardinality
// exclusivity invariant survives both commit orders; forged operated events
// that violate exclusivity fail closed in the projection; and eager snapshot
// loading performs a bounded number of queries independent of annotation count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, number as numberField, parseEventType, read, ref, scope, write,
} from '../src/internal.mjs';
import { rowToEvent } from '../src/committed-log.mjs';
import { projectEndpointToOffset, restoreTextFamily } from '../src/annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

function docDecl() {
  return entity('RangeStoreDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('timing', { fields: { startMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }), durationMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }) } }),
        annotation('transcriptionConfidence', { fields: { confidence: numberField({ validate: (value) => typeof value === 'number' && value >= 0 && value <= 1 }) } }),
        annotation('speaker', { cardinality: 'one' }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function projectDecl() {
  return entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  const Doc = docDecl();
  const Project = projectDecl();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Doc, db);
  const app = workbench({ db, entities: [Project, Doc] });
  app.start();
  await app.ready;
  const created = await app.dispatch({
    actionId: 'create', type: 'RangeStoreDoc.create', scope: 'Project:p1',
    payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world' }] } },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, Doc, Project };
}

async function bindingFor(db, Doc, principalId = 'u1') {
  const row = db.prepare("SELECT * FROM RangeStoreDoc WHERE id = 'd1'").get();
  return withAuthoringBinding({
    db, entity: Doc, Document: Doc, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: Doc.fields.body,
  });
}

async function applyRange(ctx, actionId, annotation, fromOffset, toOffset) {
  const binding = await bindingFor(ctx.db, ctx.Doc);
  return ctx.app.dispatch({
    actionId, principal: { id: 'u1' }, scope: 'Project:p1',
    type: 'RangeStoreDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: {
        kind: 'annotation.apply', annotation,
        from: { positionToken: binding.documentPositionToken, offset: fromOffset, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: toOffset, affinity: 'right' },
      },
    },
  });
}

function committedOffsets(db, annotationId) {
  const membership = db.prepare('SELECT range.start_point, range.end_point FROM RangeStoreDoc_body_membership AS membership JOIN RangeStoreDoc_body_range AS range ON range.id = membership.range_id WHERE membership.annotation_id = ? ORDER BY membership.ordinal').all(annotationId);
  const state = db.prepare("SELECT family_checkpoint FROM RangeStoreDoc_body_state WHERE document_id = 'd1'").get();
  const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
  return membership.map((row) => ({
    start: projectEndpointToOffset(family, JSON.parse(row.start_point)),
    end: projectEndpointToOffset(family, JSON.parse(row.end_point)),
  }));
}

function rangeIdOf(db, annotationId) {
  return db.prepare('SELECT range_id FROM RangeStoreDoc_body_membership WHERE annotation_id = ? ORDER BY ordinal').all(annotationId).map((row) => row.range_id);
}

test('reanchoring one annotation replaces only its link and leaves shared ranges untouched', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  // timing-1 and confidence-1 share the exactly equal [0,5) structural range.
  const timing = await applyRange(ctx, 'apply-timing', { id: 'timing-1', family: 'timing', fields: { startMs: 0, durationMs: 420 } }, 0, 5);
  assert.equal(timing.ok, true, timing.failure?.message);
  const confidence = await applyRange(ctx, 'apply-confidence', { id: 'confidence-1', family: 'transcriptionConfidence', fields: { confidence: 0.98 } }, 0, 5);
  assert.equal(confidence.ok, true, confidence.failure?.message);
  const sharedRangeId = rangeIdOf(ctx.db, 'timing-1')[0];
  assert.deepEqual(rangeIdOf(ctx.db, 'confidence-1'), [sharedRangeId], 'equal structural endpoints intern to one range');

  // Reanchor timing-1 to [6,11): the shared [0,5) range must NOT move, and
  // confidence-1 must still reference it.
  const reanchor = await applyRange(ctx, 'reanchor-timing', { id: 'timing-1', family: 'timing', fields: { startMs: 0, durationMs: 420 } }, 6, 11);
  assert.equal(reanchor.ok, true, reanchor.failure?.message);
  assert.deepEqual(committedOffsets(ctx.db, 'timing-1'), [{ start: 6, end: 11 }]);
  assert.deepEqual(committedOffsets(ctx.db, 'confidence-1'), [{ start: 0, end: 5 }]);
  assert.deepEqual(rangeIdOf(ctx.db, 'confidence-1'), [sharedRangeId], 'the shared range row is unchanged by the reanchor');
  assert.notDeepEqual(rangeIdOf(ctx.db, 'timing-1'), [sharedRangeId], 'timing-1 now points at a different range');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM RangeStoreDoc_body_range WHERE id = ?").get(sharedRangeId).c, 1);
});

test('one-cardinality exclusive trim keeps left/right remnants on one annotation id for both commit orders', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const speakerA = await applyRange(ctx, 'speaker-a', { id: 'speaker-a', family: 'speaker', fields: {} }, 0, 11);
  assert.equal(speakerA.ok, true, speakerA.failure?.message);
  const speakerB = await applyRange(ctx, 'speaker-b', { id: 'speaker-b', family: 'speaker', fields: {} }, 3, 7);
  assert.equal(speakerB.ok, true, speakerB.failure?.message);
  const aRanges = committedOffsets(ctx.db, 'speaker-a');
  assert.deepEqual(aRanges, [{ start: 0, end: 3 }, { start: 7, end: 11 }]);
  assert.deepEqual(committedOffsets(ctx.db, 'speaker-b'), [{ start: 3, end: 7 }]);

  // The other order (B first, then A) is order-deterministic too: applying the
  // covering range afterwards trims the inner one into nothing (empty-remnant
  // cleanup) and leaves only the covering annotation.
  const other = await setup();
  t.after(async () => { await other.app.shutdown(); other.db.close(); });
  const bFirst = await applyRange(other, 'speaker-b', { id: 'speaker-b', family: 'speaker', fields: {} }, 3, 7);
  assert.equal(bFirst.ok, true, bFirst.failure?.message);
  const aCovering = await applyRange(other, 'speaker-a', { id: 'speaker-a', family: 'speaker', fields: {} }, 0, 11);
  assert.equal(aCovering.ok, true, aCovering.failure?.message);
  assert.deepEqual(committedOffsets(other.db, 'speaker-b'), [], 'fully covered range leaves no remnants');
  assert.deepEqual(committedOffsets(other.db, 'speaker-a'), [{ start: 0, end: 11 }]);
  assert.equal(other.db.prepare('SELECT COUNT(*) AS c FROM RangeStoreDoc_body_annotation WHERE family = ? AND document_id = ?').get('speaker', 'd1').c, 2);
});

test('projection rejects a forged operated event that violates one-cardinality exclusivity', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  assert.equal((await applyRange(ctx, 'speaker-a', { id: 'speaker-a', family: 'speaker', fields: {} }, 0, 5)).ok, true);
  const applyB = await applyRange(ctx, 'speaker-b', { id: 'speaker-b', family: 'speaker', fields: {} }, 3, 7);
  assert.equal(applyB.ok, true, applyB.failure?.message);

  // The committed B plan carries the real trimmed postimage. Forge it so the
  // postimage holds BOTH B [3,7) AND the untrimmed A [0,5) — an overlap the
  // planner can never produce.
  const committed = ctx.db.prepare("SELECT eventData FROM _Log WHERE eventType = 'RangeStoreDoc.body.operated' ORDER BY seq DESC LIMIT 1").get();
  assert.ok(committed, 'committed speaker-b event must exist');
  const data = JSON.parse(committed.eventData);
  // The honest B plan's postimage has A trimmed to [0,3) + [7,11) and B [3,7).
  // Forge a postimage that keeps A UNTRIMMED at [0,5) overlapping B [3,7) — a
  // shape the exclusive planner can never produce.
  const aEvent = ctx.db.prepare("SELECT eventData FROM _Log WHERE eventType = 'RangeStoreDoc.body.operated' AND JSON_EXTRACT(eventData, '$.operation.annotation.id') = 'speaker-a' ORDER BY seq LIMIT 1").get();
  const aSelected = JSON.parse(aEvent.eventData).facts.selectedRange;
  const forged = JSON.parse(JSON.stringify(data));
  forged.facts.ranges = [
    { annotationId: 'speaker-a', start: JSON.parse(JSON.stringify(aSelected.start)), end: JSON.parse(JSON.stringify(aSelected.end)) },
    { annotationId: 'speaker-b', start: JSON.parse(JSON.stringify(data.facts.selectedRange.start)), end: JSON.parse(JSON.stringify(data.facts.selectedRange.end)) },
  ];

  // Replay the honest create + speaker-a events into a fresh database, then the
  // forged B event must fail closed BEFORE replacing any membership rows.
  const rebuilt = new DatabaseSync(':memory:');
  executeFrameworkDDL(rebuilt);
  rebuilt.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  rebuilt.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(projectDecl(), rebuilt);
  rebuilt.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(docDecl(), rebuilt);
  const projection = workbench({ db: rebuilt, entities: [projectDecl(), docDecl()] }).entities.get('RangeStoreDoc').projection;
  const rows = ctx.db.prepare('SELECT * FROM _Log ORDER BY seq').all();
  const snapshotTables = () => {
    const state = {};
    for (const table of [
      'RangeStoreDoc',
      'RangeStoreDoc_body_state',
      'RangeStoreDoc_body_annotation',
      'RangeStoreDoc_body_annotation_speaker',
      'RangeStoreDoc_body_annotation_protected_target',
      'RangeStoreDoc_body_annotation_orphan_state',
      'RangeStoreDoc_body_membership',
      'RangeStoreDoc_body_range',
    ]) {
      state[table] = rebuilt.prepare(`SELECT * FROM ${table}`).all()
        .map((row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
        .sort();
    }
    return state;
  };
  for (const raw of rows) {
    const event = rowToEvent(raw, parseEventType);
    if (event.data?.operation?.annotation?.id === 'speaker-b') {
      const before = snapshotTables();
      const forgedEvent = { handle: event.handle, data: forged };
      assert.throws(() => projection.apply(forgedEvent, rebuilt), /range postimage disagrees with the semantic operation/);
      // The forged event performs ZERO writes across every projection table:
      // annotation rows, typed extension rows, protected edges, orphan state,
      // state, memberships, and ranges are byte-identical after the rejection.
      assert.deepEqual(snapshotTables(), before, 'forged event must not write any projection table');
      const omitted = JSON.parse(JSON.stringify(data));
      omitted.facts.ranges = omitted.facts.ranges.filter((entry) => entry.annotationId === 'speaker-b');
      assert.throws(
        () => projection.apply({ handle: event.handle, data: omitted }, rebuilt),
        /range postimage disagrees with the semantic operation/,
      );
      assert.deepEqual(snapshotTables(), before, 'a forged omission must not delete unrelated memberships');
      break;
    }
    projection.apply(event, rebuilt);
  }
  rebuilt.close();
});

test('projection rejects reversed ordinary-family endpoints before any write', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  assert.equal((await applyRange(ctx, 'timing-a', { id: 'timing-a', family: 'timing', fields: { startMs: 0, durationMs: 420 } }, 0, 5)).ok, true);
  const rows = ctx.db.prepare('SELECT * FROM _Log ORDER BY seq').all().map((row) => rowToEvent(row, parseEventType));
  const operated = rows.find((event) => event.data?.operation?.annotation?.id === 'timing-a');
  assert.ok(operated);
  const forged = JSON.parse(JSON.stringify(operated.data));
  const reversed = {
    annotationId: 'timing-a',
    start: forged.facts.selectedRange.end,
    end: forged.facts.selectedRange.start,
  };
  forged.facts.selectedRange = reversed;
  forged.facts.ranges = [reversed];

  const rebuilt = new DatabaseSync(':memory:');
  executeFrameworkDDL(rebuilt);
  rebuilt.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1')");
  executeDDL(projectDecl(), rebuilt);
  rebuilt.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(docDecl(), rebuilt);
  const projection = workbench({ db: rebuilt, entities: [projectDecl(), docDecl()] }).entities.get('RangeStoreDoc').projection;
  for (const event of rows) {
    if (event === operated) break;
    projection.apply(event, rebuilt);
  }
  assert.throws(() => projection.apply({ handle: operated.handle, data: forged }, rebuilt), /forward and non-empty|selected range disagrees/);
  assert.equal(rebuilt.prepare("SELECT COUNT(*) AS count FROM RangeStoreDoc_body_annotation WHERE id = 'timing-a'").get().count, 0);
  assert.equal(rebuilt.prepare('SELECT COUNT(*) AS count FROM RangeStoreDoc_body_membership').get().count, 0);
  rebuilt.close();
});

test('endpoint canonicalization distinguishes affinity and basis, not only visible offsets', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  assert.equal((await applyRange(ctx, 'timing-left', { id: 'timing-left', family: 'timing', fields: { startMs: 0, durationMs: 420 } }, 0, 5)).ok, true);
  const base = rangeIdOf(ctx.db, 'timing-left')[0];

  // Same visible offsets but a right-affinity start: a DIFFERENT structural
  // endpoint, so a distinct range row even though the projected offsets match.
  const binding = await bindingFor(ctx.db, ctx.Doc);
  const differentAffinity = await ctx.app.dispatch({
    actionId: 'timing-right', principal: { id: 'u1' }, scope: 'Project:p1',
    type: 'RangeStoreDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'timing-right' },
      edit: {
        kind: 'annotation.apply', annotation: { id: 'timing-right', family: 'timing', fields: { startMs: 0, durationMs: 420 } },
        from: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'right' },
        to: { positionToken: binding.documentPositionToken, offset: 5, affinity: 'left' },
      },
    },
  });
  assert.equal(differentAffinity.ok, true, differentAffinity.failure?.message);
  const rightId = rangeIdOf(ctx.db, 'timing-right')[0];
  assert.notEqual(rightId, base, 'different affinity must not intern with the same visible offsets');
  assert.deepEqual(committedOffsets(ctx.db, 'timing-left'), committedOffsets(ctx.db, 'timing-right'));
});

test('structurally equal endpoints in different documents never share a range row', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  assert.equal((await applyRange(ctx, 'timing-a', { id: 'timing-a', family: 'timing', fields: { startMs: 0, durationMs: 420 } }, 0, 5)).ok, true);
  // A second document with identical text and an identical [0,5) selection.
  const created = await ctx.app.dispatch({
    actionId: 'create-d2', type: 'RangeStoreDoc.create', scope: 'Project:p1',
    payload: { id: 'd2', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world' }] } },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const row = ctx.db.prepare("SELECT * FROM RangeStoreDoc WHERE id = 'd2'").get();
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Doc, Document: ctx.Doc, row,
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Doc.fields.body,
  });
  const applyD2 = await ctx.app.dispatch({
    actionId: 'timing-d2', type: 'RangeStoreDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd2',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'timing-d2' },
      edit: {
        kind: 'annotation.apply', annotation: { id: 'timing-d2', family: 'timing', fields: { startMs: 0, durationMs: 420 } },
        from: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(applyD2.ok, true, applyD2.failure?.message);
  const aRangeId = rangeIdOf(ctx.db, 'timing-a')[0];
  const d2RangeId = rangeIdOf(ctx.db, 'timing-d2')[0];
  assert.notEqual(d2RangeId, aRangeId, 'ranges are document-scoped: equal endpoints never share across documents');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM RangeStoreDoc_body_range').get().c, 2);

  // The database boundary rejects a membership that would join an annotation to
  // a range owned by a DIFFERENT document.
  const d1Range = ctx.db.prepare("SELECT id FROM RangeStoreDoc_body_range WHERE document_id = 'd1'").get().id;
  const d2Range = ctx.db.prepare("SELECT id FROM RangeStoreDoc_body_range WHERE document_id = 'd2'").get().id;
  ctx.db.prepare("INSERT INTO RangeStoreDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('d1-cross-owner', 'd1', 'p1', 'u1', 'timing')").run();
  assert.throws(() => ctx.db.prepare('INSERT INTO RangeStoreDoc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES (?, ?, ?, ?)').run('d1-cross-owner', d2Range, 'd1', 0), /FOREIGN KEY constraint/i);
  // The same-document link itself is legal.
  ctx.db.prepare('INSERT INTO RangeStoreDoc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES (?, ?, ?, ?)').run('d1-cross-owner', d1Range, 'd1', 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM RangeStoreDoc_body_membership WHERE annotation_id = ?').get('d1-cross-owner').c, 1);
});

test('equal visible offsets before and after a text edit stay distinct via their historical basis', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  assert.equal((await applyRange(ctx, 'timing-before', { id: 'timing-before', family: 'timing', fields: { startMs: 0, durationMs: 420 } }, 0, 5)).ok, true);
  const beforeRangeId = rangeIdOf(ctx.db, 'timing-before')[0];

  // An insert at the END of the document changes the family frontier without
  // moving the elements under [0,5): a later [0,5) selection resolves to the
  // same anchors but a DIFFERENT historical basis frontier, so it must not
  // intern with the pre-edit range even though the visible offsets match.
  const binding = await bindingFor(ctx.db, ctx.Doc);
  const insert = await ctx.app.dispatch({
    actionId: 'insert-tail', type: 'RangeStoreDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'insert-tail' },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 11, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(insert.ok, true, insert.failure?.message);

  const binding2 = await bindingFor(ctx.db, ctx.Doc);
  const after = await ctx.app.dispatch({
    actionId: 'timing-after', type: 'RangeStoreDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding2.streamToken, lease: binding2.leaseToken, mutationId: 'timing-after' },
      edit: {
        kind: 'annotation.apply', annotation: { id: 'timing-after', family: 'timing', fields: { startMs: 0, durationMs: 420 } },
        from: { positionToken: binding2.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: binding2.documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(after.ok, true, after.failure?.message);
  const afterRangeId = rangeIdOf(ctx.db, 'timing-after')[0];
  assert.notEqual(afterRangeId, beforeRangeId, 'a later basis frontier must not intern with the pre-edit range');
  assert.deepEqual(committedOffsets(ctx.db, 'timing-before'), committedOffsets(ctx.db, 'timing-after'));
  assert.equal(committedOffsets(ctx.db, 'timing-after')[0].start, 0);
});

test('eager snapshot loading is bounded: query count does not grow with annotation count', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  const ranges = [];
  for (let i = 0; i < 6; i += 1) {
    ranges.push({ annotationId: `timing-${i}`, family: 'timing', start: i * 2, end: i * 2 + 1, fields: { startMs: i * 100, durationMs: 50 } });
    ranges.push({ annotationId: `confidence-${i}`, family: 'transcriptionConfidence', start: i * 2, end: i * 2 + 1, fields: { confidence: 0.9 } });
  }
  const created = await ctx.app.dispatch({
    actionId: 'create-bulk-small', type: 'RangeStoreDoc.create', scope: 'Project:p1',
    payload: {
      id: 'bulk', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text: 'hello world' }], ranges },
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);

  const countPrepares = (db) => {
    const original = db.prepare.bind(db);
    let count = 0;
    db.prepare = (sql) => { count += 1; return original(sql); };
    return () => { db.prepare = original; return count; };
  };

  const row = ctx.db.prepare("SELECT * FROM RangeStoreDoc WHERE id = 'bulk'").get();
  const small = countPrepares(ctx.db);
  await projectAnnotatedTextSnapshot({ db: ctx.db, entity: ctx.Doc, row, principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Doc.fields.body, mintBasis: false });
  const smallCount = small();

  // A transcript-sized document with hundreds of annotations per family must
  // cost the SAME number of queries — one per declared family, never per
  // annotation or per range.
  const large = [];
  for (let i = 0; i < 250; i += 1) {
    large.push({ annotationId: `timing-big-${i}`, family: 'timing', start: i % 11, end: i % 11 + 1, fields: { startMs: i, durationMs: 50 } });
    large.push({ annotationId: `confidence-big-${i}`, family: 'transcriptionConfidence', start: i % 11, end: i % 11 + 1, fields: { confidence: 0.5 } });
  }
  const bigText = 'hello world'.repeat(20);
  const createdBig = await ctx.app.dispatch({
    actionId: 'create-bulk-big', type: 'RangeStoreDoc.create', scope: 'Project:p1',
    payload: {
      id: 'bulk-big', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text: bigText }], ranges: large },
    },
    principal: { id: 'u1' },
  });
  assert.equal(createdBig.ok, true, createdBig.failure?.message);
  const rowBig = ctx.db.prepare("SELECT * FROM RangeStoreDoc WHERE id = 'bulk-big'").get();
  const big = countPrepares(ctx.db);
  await projectAnnotatedTextSnapshot({ db: ctx.db, entity: ctx.Doc, row: rowBig, principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Doc.fields.body, mintBasis: false });
  const bigCount = big();

  assert.equal(bigCount, smallCount, `query count must be flat as annotations grow (${smallCount} vs ${bigCount})`);
});
