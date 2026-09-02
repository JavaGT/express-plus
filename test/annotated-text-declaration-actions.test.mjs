// Declaration-owned annotation actions through the Commit loop (issue #61/#63).
// A keyed action descriptor carries input validation, an optional narrower
// authorize, and a synchronous server-only change function. The compiler
// derives the typed handle, the durable operated event, the projection, and the
// public request builder. These tests prove: sync-only change/authorize, frozen
// current state, partial field contributions merged over the committed record,
// fail-closed malformed input/contribution/async/thrown change with zero
// partial writes, narrower additive authorization, handle identity checks, and
// durable dedupe/conflict semantics.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, annotationAction, annotationEntityRemoveAction, entity, everyone, executeDDL,
  executeFrameworkDDL, grant, number as numberField, read, ref, scope, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { annotatedTextAnnotationAction } from '../build/annotated-text-public.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const externalReferences = defineSqliteSchema({
  name: 'annotated-text-declaration-actions',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function timingAnnotation({ change, authorize = null, input = {} } = {}) {
  return annotation('timing', {
    fields: {
      startMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
      durationMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
    },
    actions: {
      correct: annotationAction({
        input: {
          startMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
          durationMs: numberField({ validate: (value) => Number.isSafeInteger(value) && value >= 0 }),
          ...input,
        },
        ...(authorize ? { authorize } : {}),
        change,
      }),
    },
  });
}

function confidenceAnnotation() {
  return annotation('transcriptionConfidence', {
    fields: { confidence: numberField({ validate: (value) => typeof value === 'number' && value >= 0 && value <= 1 }) },
    actions: {
      revise: annotationAction({
        input: { confidence: numberField({ validate: (value) => typeof value === 'number' && value >= 0 && value <= 1 }) },
        change({ input }) {
          return { fields: input };
        },
      }),
    },
  });
}

function docDecl(options = {}) {
  return entity('ActionDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [timingAnnotation(options), confidenceAnnotation()],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor(declaration, { ranges } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1'), ('u2')");
  executeDDL(declaration, db);
  const app = workbench({ db, schema: externalReferences, entities: [declaration] });
  app.start();
  await app.ready;
  const created = await app.dispatch({ actionId: 'create', type: 'ActionDoc.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world' }], ...(ranges ? { ranges } : {}) } } });
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, Document: declaration };
}

async function bindingFor(ctx, principal = { id: 'u1' }) {
  const row = ctx.db.prepare("SELECT * FROM ActionDoc WHERE id = 'd1'").get();
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
}

async function correct(ctx, handle, values, { actionId = 'correct', principal = { id: 'u1' } } = {}) {
  const binding = await bindingFor(ctx, principal);
  const request = annotatedTextAnnotationAction(ctx.Document, ctx.Document.body, handle, {
    id: 'd1', basis: binding.documentPositionToken, mutationId: `m-${actionId}`, from: 0, to: 5, values,
  });
  return ctx.app.dispatch({ actionId, scope: 'Project:p1', principal, ...request });
}

test('a keyed declaration action commits its semantic annotation contribution', async (t) => {
  let serverChangeCalls = 0;
  const ctx = await appFor(docDecl({ change({ input }) { serverChangeCalls += 1; return { fields: input }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;
  assert.deepEqual(handle.inputNames, ['startMs', 'durationMs']);
  assert.equal(handle.change, undefined);
  const result = await correct(ctx, handle, { startMs: 0, durationMs: 420 });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(serverChangeCalls, 1);
  assert.deepEqual({ ...ctx.db.prepare('SELECT startMs, durationMs FROM ActionDoc_body_annotation_timing').get() }, { startMs: 0, durationMs: 420 });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_membership').get().count, 1);
});
test('annotationAction rejects async and native change/authorize functions at declaration', () => {
  assert.throws(() => annotationAction({ change: async () => ({ fields: {} }) }), /direct synchronous function/);
  assert.throws(() => annotationAction({ change: () => ({ fields: {} }), authorize: async () => true }), /direct synchronous function/);
  assert.throws(() => annotationAction({ change: (async () => ({ fields: {} })).bind(null) }), /direct synchronous function/);
});

test('a thenable or thrown change fails closed with zero partial writes', async (t) => {
  let serverChangeCalls = 0;
  const ctx = await appFor(docDecl({ change({ input }) {
    serverChangeCalls += 1;
    if (input.durationMs === 1) return Promise.resolve({ fields: input });
    if (input.durationMs === 2) throw new Error('boom');
    return { fields: input };
  } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;

  const thenable = await correct(ctx, handle, { startMs: 0, durationMs: 1 });
  assert.equal(thenable.ok, false);
  assert.match(thenable.failure?.message ?? '', /change returned a promise/);
  assert.equal(serverChangeCalls, 1);

  const thrown = await correct(ctx, handle, { startMs: 0, durationMs: 2 });
  assert.equal(thrown.ok, false);
  assert.equal(serverChangeCalls, 2);

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_membership').get().count, 0);
});

test('unknown input fields, invalid values, and undeclared contributions fail closed', async (t) => {
  let calls = 0;
  const ctx = await appFor(docDecl({ change({ input }) { calls += 1; return { fields: input }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;

  // Unknown input key on the request.
  const binding = await bindingFor(ctx);
  assert.throws(() => annotatedTextAnnotationAction(ctx.Document, ctx.Document.body, handle, {
    id: 'd1', basis: binding.documentPositionToken, mutationId: 'x', from: 0, to: 5,
    values: { startMs: 0, durationMs: 420, bogus: 1 },
  }), /unknown or missing fields/);

  // Invalid value for a declared input.
  const invalid = await correct(ctx, handle, { startMs: -1, durationMs: 420 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.failure?.message ?? '', /failed validation|invalid/i);

  assert.equal(calls, 0, 'no change ran for the invalid request');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);
});

test('non-plain and symbol-keyed payloads fail closed before change runs', async (t) => {
  let calls = 0;
  const ctx = await appFor(docDecl({ change({ input }) { calls += 1; return { fields: input }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const binding = await bindingFor(ctx);
  const payload = {
    version: 1, id: 'd1', basis: binding.documentPositionToken, mutationId: 'malformed',
    from: 0, to: 5, values: { startMs: 0, durationMs: 420 },
  };
  const malformed = [
    Object.assign(Object.create({ inherited: true }), payload),
    { ...payload, [Symbol('hidden')]: true },
    { ...payload, values: Object.assign(Object.create({ inherited: true }), payload.values) },
    { ...payload, values: { ...payload.values, [Symbol('hidden')]: true } },
  ];
  for (const [index, candidate] of malformed.entries()) {
    const result = await ctx.app.dispatch({
      actionId: `malformed-${index}`, type: 'ActionDoc.body.timing.correct', scope: 'Project:p1',
      principal: { id: 'u1' }, payload: candidate,
    });
    assert.equal(result.ok, false);
    assert.match(result.failure?.message ?? '', /closed selection payload/);
  }
  assert.equal(calls, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);
});

test('timing and confidence reject unsafe or non-finite numeric input', async (t) => {
  const ctx = await appFor(docDecl({ change({ input }) { return { fields: input }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const timingHandle = ctx.Document.body.annotations.timing.actions.correct;
  for (const [index, value] of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity].entries()) {
    const result = await correct(ctx, timingHandle, { startMs: value, durationMs: 420 }, { actionId: `timing-invalid-${index}` });
    assert.equal(result.ok, false, `timing accepted ${String(value)}`);
  }
  const binding = await bindingFor(ctx);
  for (const [index, confidence] of [-0.1, 1.1, NaN, Infinity, -Infinity].entries()) {
    const result = await ctx.app.dispatch({
      actionId: `confidence-invalid-${index}`, type: 'ActionDoc.body.transcriptionConfidence.revise',
      scope: 'Project:p1', principal: { id: 'u1' },
      payload: { version: 1, id: 'd1', basis: binding.documentPositionToken, mutationId: `confidence-${index}`, from: 0, to: 5, values: { confidence } },
    });
    assert.equal(result.ok, false, `confidence accepted ${String(confidence)}`);
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);
});

test('a change returning an undeclared field contribution fails closed', async (t) => {
  let calls = 0;
  const ctx = await appFor(docDecl({ change() { calls += 1; return { fields: { bogus: 1 } }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const result = await correct(ctx, ctx.Document.body.annotations.timing.actions.correct, { startMs: 0, durationMs: 420 });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /undeclared field/);
  assert.equal(calls, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);
});

test('a change cannot control annotation identity, range, lifecycle, or protection edges', async (t) => {
  let calls = 0;
  const ctx = await appFor(docDecl({ change() { calls += 1; return { annotationId: 'hijack', fields: { startMs: 0, durationMs: 420 } }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const result = await correct(ctx, ctx.Document.body.annotations.timing.actions.correct, { startMs: 0, durationMs: 420 });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /invalid contribution/);
  assert.equal(calls, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);
});

test('a partial correction merges over the frozen current record without clobbering other fields', async (t) => {
  let receivedCurrent = null;
  const ctx = await appFor(docDecl({
    change({ input, current }) {
      receivedCurrent = current;
      return { fields: { durationMs: input.durationMs } };
    },
  }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;

  // First correct: no covering annotation yet, so a partial contribution is
  // incomplete and fails closed — a NEW annotation must be fully supplied.
  const first = await correct(ctx, handle, { startMs: 0, durationMs: 420 });
  assert.equal(first.ok, false);
  assert.match(first.failure?.message ?? '', /does not cover every declared field/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);

  // Seed a timing annotation at [0,5) through ordinary source ranges.
  const seeded = await ctx.app.dispatch({
    actionId: 'seed', type: 'ActionDoc.create', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      id: 'd2', project: 'p1', owner: 'u1',
      body: { version: 1, blocks: [{ text: 'hello world' }], ranges: [{ annotationId: 'timing-1', family: 'timing', start: 0, end: 5, fields: { startMs: 0, durationMs: 420 } }] },
    },
  });
  assert.equal(seeded.ok, true, seeded.failure?.message);

  // The correction targets the single covering annotation by default; the
  // change function received its frozen current fields and returned only the
  // changed field. startMs must survive untouched.
  const row = ctx.db.prepare("SELECT * FROM ActionDoc WHERE id = 'd2'").get();
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
  const corrected = await ctx.app.dispatch({
    actionId: 'correct-d2', type: 'ActionDoc.body.timing.correct', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd2', basis: binding.documentPositionToken, mutationId: 'm', from: 0, to: 5, values: { startMs: 0, durationMs: 500 } },
  });
  assert.equal(corrected.ok, true, corrected.failure?.message);
  assert.ok(receivedCurrent, 'the change function must receive the covering annotation current state');
  assert.equal(receivedCurrent.id, 'timing-1');
  assert.deepEqual({ ...receivedCurrent.fields }, { startMs: 0, durationMs: 420 });
  assert.deepEqual(receivedCurrent.ranges, [{ start: 0, end: 5 }]);
  assert.ok(Object.isFrozen(receivedCurrent) && Object.isFrozen(receivedCurrent.fields));
  assert.deepEqual({ ...ctx.db.prepare('SELECT startMs, durationMs FROM ActionDoc_body_annotation_timing').get() }, { startMs: 0, durationMs: 500 });
});

test('independent timing and confidence corrections never overwrite each other', async (t) => {
  const ctx = await appFor(docDecl({ change({ input }) { return { fields: input }; } }), {
    ranges: [
      { annotationId: 'timing-1', family: 'timing', start: 0, end: 5, fields: { startMs: 0, durationMs: 420 } },
      { annotationId: 'confidence-1', family: 'transcriptionConfidence', start: 0, end: 5, fields: { confidence: 0.98 } },
    ],
  });
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });

  assert.equal(
    ctx.db.prepare("SELECT range_id FROM ActionDoc_body_membership WHERE annotation_id = 'timing-1'").get().range_id,
    ctx.db.prepare("SELECT range_id FROM ActionDoc_body_membership WHERE annotation_id = 'confidence-1'").get().range_id,
    'exact common geometry shares one immutable range',
  );

  // The two clients correct concurrently (serialized by the single-writer DB):
  // timing keeps durationMs, confidence keeps confidence; neither erases the
  // other record's fields.
  const timingResult = await correct(ctx, ctx.Document.body.annotations.timing.actions.correct, { startMs: 0, durationMs: 999 });
  assert.equal(timingResult.ok, true, timingResult.failure?.message);
  const row = ctx.db.prepare("SELECT * FROM ActionDoc WHERE id = 'd1'").get();
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
  const confidenceResult = await ctx.app.dispatch({
    actionId: 'revise', type: 'ActionDoc.body.transcriptionConfidence.revise', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', basis: binding.documentPositionToken, mutationId: 'm', from: 0, to: 5, values: { confidence: 0.5 } },
  });
  assert.equal(confidenceResult.ok, true, confidenceResult.failure?.message);

  const timingRow = ctx.db.prepare("SELECT startMs, durationMs FROM ActionDoc_body_annotation_timing WHERE annotation_id = 'timing-1'").get();
  const confidenceRow = ctx.db.prepare('SELECT confidence FROM ActionDoc_body_annotation_transcriptionConfidence WHERE annotation_id = ?').get('confidence-1');
  assert.deepEqual({ ...timingRow }, { startMs: 0, durationMs: 999 });
  assert.deepEqual({ ...confidenceRow }, { confidence: 0.5 });
});

test('narrower declaration authorization is additive and fails closed', async (t) => {
  let calls = 0;
  const ctx = await appFor(docDecl({
    authorize: ({ principal }) => principal.id === 'u1',
    change({ input }) { calls += 1; return { fields: input }; },
  }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;

  // u2 holds the same document write grant but fails the narrower authorize.
  const denied = await correct(ctx, handle, { startMs: 0, durationMs: 420 }, { actionId: 'deny', principal: { id: 'u2' } });
  assert.equal(denied.ok, false);
  assert.match(denied.failure?.message ?? '', /not authorized|denied/i);
  assert.equal(calls, 0, 'change must not run when the narrower authorize denies');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM ActionDoc_body_annotation').get().count, 0);

  const allowed = await correct(ctx, handle, { startMs: 0, durationMs: 420 }, { actionId: 'allow' });
  assert.equal(allowed.ok, true, allowed.failure?.message);
  assert.equal(calls, 1);
});

test('copied, foreign, and cross-declaration handles are rejected by identity', async (t) => {
  const ctx = await appFor(docDecl({ change({ input }) { return { fields: input }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;

  const cloned = { ...handle };
  assert.throws(() => annotatedTextAnnotationAction(ctx.Document, ctx.Document.body, cloned, {
    id: 'd1', basis: 'x', mutationId: 'm', from: 0, to: 5, values: { startMs: 0, durationMs: 420 },
  }), /same compiled declaration/);

  // A handle from an unrelated declaration.
  const other = annotation('timing', {
    fields: { startMs: numberField({ validate: () => true }), durationMs: numberField({ validate: () => true }) },
    actions: { correct: annotationAction({ input: {}, change: () => ({ fields: { startMs: 0, durationMs: 0 } }) }) },
  });
  const otherDoc = entity('OtherDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [other] }).can(() => grant(read, write)),
  });
  executeDDL(otherDoc, ctx.db);
  const foreignHandle = otherDoc.body.annotations.timing.actions.correct;
  assert.throws(() => annotatedTextAnnotationAction(ctx.Document, ctx.Document.body, foreignHandle, {
    id: 'd1', basis: 'x', mutationId: 'm', from: 0, to: 5, values: { startMs: 0, durationMs: 420 },
  }), /same compiled declaration/);
});

test('durable dedupe: concurrent identical actions commit once; changed input conflicts', async (t) => {
  let calls = 0;
  const ctx = await appFor(docDecl({ change({ input }) { calls += 1; return { fields: input }; } }));
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const handle = ctx.Document.body.annotations.timing.actions.correct;

  const binding = await bindingFor(ctx);
  const request = annotatedTextAnnotationAction(ctx.Document, ctx.Document.body, handle, {
    id: 'd1', basis: binding.documentPositionToken, mutationId: 'm', from: 0, to: 5, values: { startMs: 0, durationMs: 420 },
  });
  const dispatch = () => ctx.app.dispatch({ actionId: 'same', scope: 'Project:p1', principal: { id: 'u1' }, ...request });
  const [first, replayed] = await Promise.all([dispatch(), dispatch()]);
  assert.equal(first.ok, true, first.failure?.message);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.resultData?.confirmedThrough, first.resultData?.confirmedThrough);
  assert.equal(calls, 1, 'concurrent dedupe must not re-run the change function');

  // Same action id but a changed input is a durable conflict, not a re-commit.
  const changed = await ctx.app.dispatch({
    actionId: 'same', scope: 'Project:p1', principal: { id: 'u1' },
    ...annotatedTextAnnotationAction(ctx.Document, ctx.Document.body, handle, {
      id: 'd1', basis: binding.documentPositionToken, mutationId: 'm', from: 0, to: 5, values: { startMs: 0, durationMs: 999 },
    }),
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.failure?.category, 'conflict');
  assert.equal(calls, 1);
  assert.deepEqual({ ...ctx.db.prepare('SELECT startMs, durationMs FROM ActionDoc_body_annotation_timing').get() }, { startMs: 0, durationMs: 420 });
});

// -- annotationEntityRemoveAction: the declaration surface --

test('annotationEntityRemoveAction validates its declaration surface', () => {
  const base = { relation: 'comment', project: 'project', author: 'author', stale: 'updatedAt', capability: write };
  // Unknown keys are rejected; declared keys are required.
  assert.throws(() => annotationEntityRemoveAction({ ...base, bogus: true }), /unknown key/);
  for (const key of ['relation', 'project', 'author', 'stale', 'capability']) {
    const { [key]: _dropped, ...rest } = base;
    assert.throws(() => annotationEntityRemoveAction(rest), new RegExp(`requires '${key}'`));
  }
  // Field names must be strings.
  for (const key of ['relation', 'project', 'author', 'stale']) {
    assert.throws(() => annotationEntityRemoveAction({ ...base, [key]: 7 }), /must be field names/, key);
  }
  // The invariant must be a direct synchronous function when declared.
  assert.throws(() => annotationEntityRemoveAction({ ...base, invariant: 'nope' }), /invariant must be a function/);
  assert.throws(() => annotationEntityRemoveAction({ ...base, invariant: async () => {} }), /direct synchronous function/);
  // The handle is frozen, data + invariant only, with the declared field names.
  const handle = annotationEntityRemoveAction({ ...base, invariant: () => {} });
  assert.ok(Object.isFrozen(handle));
  assert.deepEqual(Object.keys(handle).sort(), ['author', 'capability', 'invariant', 'kind', 'project', 'relation', 'stale']);
  assert.equal(handle.kind, 'annotationEntityRemoveAction');
  assert.equal(handle.stale, 'updatedAt');
  // Omitting the invariant stays legal.
  const plain = annotationEntityRemoveAction(base);
  assert.equal(plain.invariant, undefined);
});
