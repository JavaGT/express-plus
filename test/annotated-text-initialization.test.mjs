import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL, grant, measurement,
  read, ref, scope, write, registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { materializeText, restoreTextFamily } from '../src/annotated-text-continuous.mjs';
import { annotatedTextCreateAction } from '../src/annotated-text-public.mjs';
import { frozenJsonSnapshot } from '../src/annotated-text-r2.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate() {}, edit() {},
  partition({ blockText, utf16Offset, payload }) {
    return Object.freeze({ version: 1, leftPayload: Object.freeze({ ...payload, text: blockText.slice(0, utf16Offset) }), rightPayload: Object.freeze({ ...payload, text: blockText.slice(utf16Offset) }) });
  },
  combine({ left, right }) { return Object.freeze({ version: 1, payload: Object.freeze({ text: `${left?.payload.text ?? ''}${right?.payload.text ?? ''}` }) }); },
}));

function doc(fieldAccess = () => grant(read, write)) {
  return entity('InitDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }).can(fieldAccess),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor(fieldAccess) {
  const db = new DatabaseSync(':memory:');
  const Document = doc(fieldAccess);
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1'); INSERT INTO User VALUES ('u2')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Document] });
  app.start(); await app.ready;
  return { app, db, Document };
}

async function create(ctx, text = '') {
  const result = await ctx.app.dispatch({
    actionId: `create-${text || 'empty'}`,
    type: 'InitDoc.create',
    principal: { id: 'u1' },
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      ...(text ? { body: { version: 1, blocks: [{ text }] } } : {}),
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  return ctx.db.prepare('SELECT structure_version, family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1');
}

async function binding(ctx, principal = { id: 'u1' }) {
  const row = ctx.db.prepare('SELECT * FROM InitDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row, principal,
    fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
}

async function author(ctx, actionId, edit, { principal = { id: 'u1' }, current = null } = {}) {
  const active = current ?? await binding(ctx, principal);
  const token = active.documentPositionToken;
  const translated = {
    ...edit,
    ...(edit.at ? { at: { positionToken: token, offset: edit.at.offset, affinity: edit.at.affinity } } : {}),
    ...(edit.from ? { from: { positionToken: token, offset: edit.from.offset, affinity: edit.from.affinity } } : {}),
    ...(edit.to ? { to: { positionToken: token, offset: edit.to.offset, affinity: edit.to.affinity } } : {}),
  };
  return ctx.app.dispatch({
    actionId,
    principal,
    scope: 'Project:p1',
    type: 'InitDoc.body.operation',
    payload: {
      version: 9,
      id: 'd1',
      authoring: { version: 1, stream: active.streamToken, lease: active.leaseToken, mutationId: actionId },
      edit: translated,
    },
  });
}

function familyText(ctx) {
  const state = ctx.db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

test('frozen JSON snapshots are isolated and reject invalid JSON values', () => {
  const source = { nested: { value: 1 } };
  const snapshot = frozenJsonSnapshot(source);
  assert.notEqual(snapshot, source); assert.equal(Object.isFrozen(snapshot.nested), true);
  assert.throws(() => { snapshot.nested.value = 2; }, TypeError);
  assert.throws(() => frozenJsonSnapshot({ value: undefined }), /undefined/);
  assert.throws(() => frozenJsonSnapshot(NaN), /finite/);
});

test('annotated text create atomically initializes continuous family state and imports validated source data', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const state = await create(ctx, 'hello');
  assert.ok(state);
  assert.equal(typeof state.family_checkpoint, 'string');
  assert.equal(familyText(ctx), 'hello');
  // No block-era tables.
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name GLOB 'InitDoc_body_block*'").get().count, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_state WHERE document_id = ?').get('d1').count, 1);

  // Create via annotatedTextCreateAction imports the continuous source text
  // into one family. Measurements are DOCUMENT-SCOPED (one per family); a
  // duplicate family must be rejected by the create validation.
  // A duplicate family in the source is rejected (one measurement per
  // (document, family)); the create must fail closed rather than pick one.
  assert.throws(() => ctx.app.dispatch({
    actionId: 'import',
    principal: { id: 'u1' },
    ...annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
      id: 'imported',
      projectId: 'p1',
      ownerId: 'u1',
      source: {
        text: 'firstsecond',
        measurements: [
          { family: 'source', payload: { text: 'firstsecond' } },
          { family: 'source', payload: { text: 'firstsecond' } },
        ],
      },
    }),
  }), /duplicate measurement family/);

  const importedTwo = await ctx.app.dispatch({
    actionId: 'import-two',
    principal: { id: 'u1' },
    ...annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
      id: 'imported',
      projectId: 'p1',
      ownerId: 'u1',
      source: {
        text: 'firstsecond',
        measurements: [{ family: 'source', payload: { text: 'firstsecond' } }],
      },
    }),
  });
  assert.equal(importedTwo.ok, true, importedTwo.failure?.message);
  const importedText = materializeText(restoreTextFamily(JSON.parse(
    ctx.db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('imported').family_checkpoint,
  )));
  assert.equal(importedText, 'firstsecond');
  // One measurement row per family per document (unique on document_id, family).
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_measurement WHERE document_id = 'imported'").get().count, 1);
  assert.equal(ctx.db.prepare("SELECT family FROM InitDoc_body_measurement WHERE document_id = 'imported'").get().family, 'source');
});

test('v9 authoring actions from independent leases converge after each re-bootstraps', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  await create(ctx, '');
  // Position tokens bind to the family frontier at issue time. Independent
  // leases each re-bootstrap before mutating so absolute offsets stay honest.
  const left = await binding(ctx, { id: 'u1' });
  const leftResult = await author(ctx, 'left', { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'A' }, { current: left });
  assert.equal(leftResult.ok, true, leftResult.failure?.message);
  const right = await binding(ctx, { id: 'u2' });
  assert.equal((await author(ctx, 'right', { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'B' }, { principal: { id: 'u2' }, current: right })).ok, true);
  const text = familyText(ctx);
  assert.equal(text.length, 2);
  assert.match(text, /^[AB]{2}$/);
});

test('v9 authoring inserts at either affinity of an emptied document range', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  await create(ctx, 'ab');
  const deleted = await author(ctx, 'delete-all', {
    kind: 'text.delete',
    from: { offset: 0, affinity: 'left' },
    to: { offset: 2, affinity: 'right' },
  });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal(familyText(ctx), '');

  // Each insert changes the frontier; re-bootstrap between affinities.
  const forLeft = await binding(ctx);
  const left = await author(ctx, 'insert-left', { kind: 'text.insert', at: { offset: 0, affinity: 'left' }, text: 'L' }, { current: forLeft });
  assert.equal(left.ok, true, left.failure?.message);
  const forRight = await binding(ctx);
  const right = await author(ctx, 'insert-right', { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'R' }, { current: forRight });
  assert.equal(right.ok, true, right.failure?.message);
  assert.equal(familyText(ctx).length, 2);
});

test('v9 authoring rejects a pre-mutation token after concurrent text, then apply/remove on a fresh basis', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  await create(ctx, 'abcd');
  const stale = await binding(ctx);
  const concurrent = await binding(ctx, { id: 'u2' });
  assert.equal((await author(ctx, 'concurrent', { kind: 'text.insert', at: { offset: 2, affinity: 'right' }, text: 'X' }, { principal: { id: 'u2' }, current: concurrent })).ok, true);
  // Stale basis is fail-closed: absolute offsets are only honest against the
  // frontier they were issued for.
  const staleApply = await author(ctx, 'stale-apply', {
    kind: 'annotation.apply',
    annotation: { id: 'note-stale', family: 'note', fields: {} },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 2, affinity: 'right' },
  }, { current: stale });
  assert.equal(staleApply.ok, false);
  assert.match(staleApply.failure?.message ?? '', /stale|re-bootstrap/i);

  const fresh = await binding(ctx);
  assert.equal((await author(ctx, 'apply', {
    kind: 'annotation.apply',
    annotation: { id: 'note-1', family: 'note', fields: {} },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 2, affinity: 'right' },
  }, { current: fresh })).ok, true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_annotation WHERE id = 'note-1'").get().count, 1);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_membership WHERE annotation_id = 'note-1'").get().count, 1);
  assert.equal((await author(ctx, 'remove', { kind: 'annotation.remove', annotationId: 'note-1' })).ok, true);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_annotation WHERE id = 'note-1'").get().count, 0);
  assert.equal(familyText(ctx), 'abXcd');
});

test('v9 authoring rejects foreign position tokens without mutation', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  await create(ctx, 'abcd');
  const foreign = await binding(ctx, { id: 'u2' });
  const own = await binding(ctx);
  const before = familyText(ctx);
  // Foreign stream/lease with own position token is rejected.
  const foreignResult = await author(ctx, 'foreign', {
    kind: 'text.insert',
    at: { offset: 0, affinity: 'right' },
    text: 'x',
  }, { current: { ...own, streamToken: foreign.streamToken, leaseToken: foreign.leaseToken } });
  assert.equal(foreignResult.ok, false);
  // Completely foreign position token is rejected.
  const staleResult = await ctx.app.dispatch({
    actionId: 'stale-token',
    principal: { id: 'u1' },
    scope: 'Project:p1',
    type: 'InitDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: own.streamToken, lease: own.leaseToken, mutationId: 'stale-token' },
      edit: { kind: 'text.insert', at: { positionToken: foreign.documentPositionToken, offset: 0, affinity: 'right' }, text: 'x' },
    },
  });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.failure.category, 'invalid-input');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId IN ('foreign', 'stale-token')").get().count, 0);
  assert.equal(familyText(ctx), before);
});

test('v9 authoring rejects UTF-16 surrogate-interior offsets', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  await create(ctx, 'a😀b');
  const result = await author(ctx, 'bad-offset', { kind: 'text.insert', at: { offset: 2, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /surrogate pair/);
});

test('v9 authoring enforces annotated-text field write policy', async (t) => {
  const ctx = await appFor(() => grant(read)); t.after(() => ctx.app.close?.());
  await create(ctx, '');
  const result = await author(ctx, 'locked-edit', { kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.category, 'denied');
});
