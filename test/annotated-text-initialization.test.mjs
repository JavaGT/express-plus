import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL, grant, measurement,
  read, ref, scope, write, registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { annotatedTextAction, annotatedTextCreateAction } from '../src/annotated-text-public.mjs';
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
    body: annotatedText({ project: 'project', owner: 'owner', block: { reviewed: boolean({ default: true }) }, annotations: [annotation('note', { fields: {} })], measurements: [measurement('source', { extension: 'sourceInit' })] }).can(fieldAccess),
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
  const result = await ctx.app.dispatch({ actionId: `create-${text || 'empty'}`, type: 'InitDoc.create', principal: { id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1', ...(text ? { body: { version: 1, blocks: [{ text }] } } : {}) } });
  assert.equal(result.ok, true, result.failure?.message);
  return ctx.db.prepare('SELECT id FROM InitDoc_body_block WHERE document_id = ?').get('d1').id;
}

async function binding(ctx, principal = { id: 'u1' }) {
  const row = ctx.db.prepare('SELECT * FROM InitDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({ db: ctx.db, entity: ctx.Document, Document: ctx.Document, row, principal, fieldName: 'body', descriptor: ctx.Document.fields.body });
}

async function author(ctx, actionId, edit, { principal = { id: 'u1' }, current = null } = {}) {
  const active = current ?? await binding(ctx, principal);
  const position = ({ blockId, offset, affinity }) => ({ positionToken: active.positionTokens.get(blockId), offset, affinity });
  const translated = { ...edit, ...(edit.at ? { at: position(edit.at) } : {}), ...(edit.from ? { from: position(edit.from) } : {}), ...(edit.to ? { to: position(edit.to) } : {}) };
  if (edit.kind === 'block.merge') {
    translated.leftPositionToken = active.positionTokens.get(edit.leftBlockId);
    translated.rightPositionToken = active.positionTokens.get(edit.rightBlockId);
    delete translated.leftBlockId; delete translated.rightBlockId;
  }
  if (edit.kind === 'annotation.detach') { translated.positionToken = active.positionTokens.get(edit.blockId); delete translated.blockId; }
  if (['block.split', 'block.continue', 'block.split-and-assign'].includes(edit.kind)) translated.temporaryBlock = `temporary-${actionId}`;
  const request = annotatedTextAction(ctx.Document, ctx.Document.body, { id: 'd1', authoring: { version: 1, stream: active.streamToken, lease: active.leaseToken, mutationId: actionId }, ...translated });
  return ctx.app.dispatch({ actionId, principal, scope: 'Project:p1', ...request });
}

test('frozen JSON snapshots are isolated and reject invalid JSON values', () => {
  const source = { nested: { value: 1 } };
  const snapshot = frozenJsonSnapshot(source);
  assert.notEqual(snapshot, source); assert.equal(Object.isFrozen(snapshot.nested), true);
  assert.throws(() => { snapshot.nested.value = 2; }, TypeError);
  assert.throws(() => frozenJsonSnapshot({ value: undefined }), /undefined/);
  assert.throws(() => frozenJsonSnapshot(NaN), /finite/);
});

test('annotated text create atomically initializes canonical blocks and imports validated source data', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const blockId = await create(ctx, 'hello');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count, 1);
  assert.equal(ctx.db.prepare('SELECT reviewed FROM InitDoc_body_block WHERE id = ?').get(blockId).reviewed, 1);
  const imported = await ctx.app.dispatch({ actionId: 'import', principal: { id: 'u1' }, ...annotatedTextCreateAction(ctx.Document, ctx.Document.body, { id: 'imported', projectId: 'p1', ownerId: 'u1', source: { blocks: [{ text: 'first', measurements: [{ family: 'source', payload: { text: 'first' } }] }, { text: 'second' }] } }) });
  assert.equal(imported.ok, true, imported.failure?.message);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_measurement').get().count, 1);
});

test('v9 authoring actions converge concurrent inserts from independent leases', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const blockId = await create(ctx, '');
  const left = await binding(ctx, { id: 'u1' });
  const right = await binding(ctx, { id: 'u2' });
  const leftResult = await author(ctx, 'left', { kind: 'text.insert', at: { blockId, offset: 0, affinity: 'right' }, text: 'A' }, { current: left });
  assert.equal(leftResult.ok, true, leftResult.failure?.message);
  assert.equal((await author(ctx, 'right', { kind: 'text.insert', at: { blockId, offset: 0, affinity: 'right' }, text: 'B' }, { principal: { id: 'u2' }, current: right })).ok, true);
  const family = restoreTextFamilyCheckpoint(JSON.parse(ctx.db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint));
  assert.equal(materializeBlock(family, blockId).length, 2);
  assert.match(materializeBlock(family, blockId), /^[AB]{2}$/);
});

test('v9 authoring inserts at either explicit boundary of a fully tombstoned non-first block', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const firstBlockId = await create(ctx, 'first');
  const continued = await author(ctx, 'continue', { kind: 'block.continue', at: { blockId: firstBlockId, offset: 3, affinity: 'right' } });
  assert.equal(continued.ok, true, continued.failure?.message);
  const secondBlockId = continued.events[0].data.operation.rightBlockId;
  const deleted = await author(ctx, 'delete-second', { kind: 'text.delete', from: { blockId: secondBlockId, offset: 0, affinity: 'left' }, to: { blockId: secondBlockId, offset: 2, affinity: 'right' } });
  assert.equal(deleted.ok, true, deleted.failure?.message);

  const empty = await binding(ctx);
  const left = await author(ctx, 'insert-left', { kind: 'text.insert', at: { blockId: secondBlockId, offset: 0, affinity: 'left' }, text: 'L' }, { current: empty });
  const right = await author(ctx, 'insert-right', { kind: 'text.insert', at: { blockId: secondBlockId, offset: 0, affinity: 'right' }, text: 'R' }, { current: empty });
  assert.equal(left.ok, true, left.failure?.message);
  assert.equal(right.ok, true, right.failure?.message);
  const family = restoreTextFamilyCheckpoint(JSON.parse(ctx.db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint));
  assert.equal(materializeBlock(family, secondBlockId).length, 2);
});

test('v9 authoring resolves a token issued before concurrent text for split, apply, detach, and merge', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const blockId = await create(ctx, 'abcd');
  const structural = await binding(ctx);
  const concurrent = await binding(ctx, { id: 'u2' });
  assert.equal((await author(ctx, 'concurrent', { kind: 'text.insert', at: { blockId, offset: 2, affinity: 'right' }, text: 'X' }, { principal: { id: 'u2' }, current: concurrent })).ok, true);
  const split = await author(ctx, 'split', { kind: 'block.split', at: { blockId, offset: 2, affinity: 'right' } }, { current: structural });
  assert.equal(split.ok, true, split.failure?.message);
  const rightBlockId = split.events[0].data.operation.rightBlockId;
  assert.equal((await author(ctx, 'apply', { kind: 'annotation.apply', annotation: { id: 'note-1', family: 'note', fields: {} }, from: { blockId, offset: 0, affinity: 'left' }, to: { blockId, offset: 2, affinity: 'right' } })).ok, true);
  assert.equal((await author(ctx, 'detach', { kind: 'annotation.detach', annotationId: 'note-1', blockId })).ok, true);
  assert.equal((await author(ctx, 'merge', { kind: 'block.merge', leftBlockId: blockId, rightBlockId })).ok, true);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count, 1);
});

test('v9 authoring rejects stale and foreign position tokens without mutation', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const blockId = await create(ctx, 'abcd');
  const foreign = await binding(ctx, { id: 'u2' });
  const split = await author(ctx, 'split', { kind: 'block.split', at: { blockId, offset: 2, affinity: 'right' } });
  assert.equal(split.ok, true, split.failure?.message);
  const rightBlockId = split.events[0].data.operation.rightBlockId;
  const stale = await binding(ctx);
  assert.equal((await author(ctx, 'merge', { kind: 'block.merge', leftBlockId: blockId, rightBlockId })).ok, true);
  const staleResult = await author(ctx, 'stale', { kind: 'text.insert', at: { blockId: rightBlockId, offset: 0, affinity: 'right' }, text: 'x' }, { current: stale });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.failure.category, 'invalid-input');
  const foreignResult = await author(ctx, 'foreign', { kind: 'text.insert', at: { blockId: rightBlockId, offset: 0, affinity: 'right' }, text: 'x' }, { current: { ...stale, streamToken: foreign.streamToken, leaseToken: foreign.leaseToken } });
  assert.equal(foreignResult.ok, false);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId IN ('stale', 'foreign')").get().count, 0);
});

test('v9 authoring rejects UTF-16 surrogate-interior offsets', async (t) => {
  const ctx = await appFor(); t.after(() => ctx.app.close?.());
  const blockId = await create(ctx, 'a😀b');
  const result = await author(ctx, 'bad-offset', { kind: 'text.insert', at: { blockId, offset: 2, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /surrogate pair/);
});

test('v9 authoring enforces annotated-text field write policy', async (t) => {
  const ctx = await appFor(() => grant(read)); t.after(() => ctx.app.close?.());
  const blockId = await create(ctx, '');
  const result = await author(ctx, 'locked-edit', { kind: 'text.insert', at: { blockId, offset: 0, affinity: 'right' }, text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.failure?.category, 'denied');
});
