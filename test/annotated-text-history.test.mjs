import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import workbench, { annotatedText, annotation, boolean, durableHistory, entity, executeDDL, executeFrameworkDDL, grant, measurement, ref, read, scope, write, everyone, registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
import { annotatedTextAction, annotatedTextRetireAction } from '../src/annotated-text-public.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';

const extension = Object.freeze({ version: 1, validate() {}, edit() {}, partition({ blockText, utf16Offset, payload }) { return { version: 1, leftPayload: { ...payload, text: blockText.slice(0, utf16Offset) }, rightPayload: { ...payload, text: blockText.slice(utf16Offset) } }; }, combine({ left, right }) { return { version: 1, payload: { text: `${left?.payload?.text ?? ''}${right?.payload?.text ?? ''}` } }; } });
registerAnnotatedTextContract('historySource', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('historySource', extension);

function make(fieldAccess = () => grant(read, write)) {
  const Document = entity('HistoryDocument', { project: ref('Project'), owner: ref('User'), body: annotatedText({ project: 'project', owner: 'owner', block: { reviewed: boolean({ default: true }) }, annotations: [annotation('tag', { appliesTo: 'block-group', cardinality: 'one', fields: { value: boolean({ default: false }) } }), annotation('empty', { appliesTo: 'block-group', cardinality: 'one' })], measurements: [measurement('source', { extension: 'historySource' })] }).can(fieldAccess), grant: [scope(() => everyone()).can(() => grant(read, write))] });
  const Project = entity('Project', { owner: ref('User'), grant: [scope(() => everyone()).can(() => grant(read, write))] });
  return { Document, Project };
}
async function setup(fieldAccess) {
  const db = new DatabaseSync(':memory:'); const { Document, Project } = make(fieldAccess);
  executeFrameworkDDL(db); db.exec('CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES (\'u1\')'); executeDDL(Project, db); db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')"); executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document], history: durableHistory({ authorize: () => true, actions: {} }) }); await app.start();
  const created = await app.dispatch({ actionId: 'create', type: 'HistoryDocument.create', principal: { type: 'user', id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', fields: { reviewed: false }, measurements: [{ family: 'source', payload: { text: 'hello world' } }] }] } } });
  assert.equal(created.ok, true, created.failure?.message); return { app, db, Document: app.entities.get('HistoryDocument'), blockId: db.prepare('SELECT id FROM HistoryDocument_body_block').get().id };
}
const state = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'HistoryDocument_body_*' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]).filter(([name]) => !name.endsWith('_basis'));
const durableMeta = (db) => ['_Log', '_ActionReceipt', '_HistoryCursor'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all()]);
async function edit(ctx, actionId, edit, principal = { type: 'user', id: 'u1' }) { const row = ctx.db.prepare('SELECT * FROM HistoryDocument WHERE id = ?').get('d1'); const snapshot = await projectAnnotatedTextSnapshot({ db: ctx.db, entity: ctx.Document, row, principal, fieldName: 'body', descriptor: ctx.Document.fields.body }); const command = typeof edit === 'function' ? edit(snapshot) : edit; return ctx.app.dispatch({ actionId, principal, scope: 'Project:p1', history: { session: 'tab-a' }, ...annotatedTextAction(ctx.Document, ctx.Document.body, { ...command, id: 'd1', basis: snapshot.basis, mutationId: actionId }) }); }
async function move(ctx, operation, actionId) { const cursor = await ctx.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a' }); return ctx.app.history[operation]({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a', actionId, revision: cursor.revision }); }

test('v8 continuation has one opaque cursor entry and exact undo/redo projection', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); }); const before = state(c.db);
  const result = await edit(c, 'continue', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } }); assert.equal(result.ok, true, result.failure?.message); const after = state(c.db);
  assert.deepEqual((await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a' })).undo, 1);
   assert.equal(result.events.length, 1); assert.equal(result.events[0].type, 'HistoryDocument.body.operated');
   const publicText = JSON.stringify([c.db.prepare("SELECT eventData FROM _Log WHERE actionId = 'continue'").all(), c.db.prepare("SELECT actionData FROM _ActionReceipt WHERE actionId = 'continue'").all()]); assert.equal(/tables|family_checkpoint|private/i.test(publicText), false);
  const undone = await move(c, 'undo', 'undo'); assert.equal(undone.ok, true); assert.deepEqual(state(c.db), before); assert.equal(undone.events.length, 1);
  const redone = await move(c, 'redo', 'redo'); assert.equal(redone.ok, true); assert.deepEqual(state(c.db), after); assert.equal(redone.events.length, 1);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE actionId IN ('undo','redo') AND eventType = 'HistoryDocument.body.operated'").get().n, 2);
});

test('v8 assignment and split-and-assign undo/redo are atomic and preserve unrelated membership', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  const split = await edit(c, 'split', { kind: 'block.split-and-assign', at: { blockId: c.blockId, offset: 5 }, annotation: { id: 'old', family: 'tag', fields: { value: true } } }); assert.equal(split.ok, true, split.failure?.message);
  const pre = state(c.db); const set = await edit(c, 'set', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'listed', blockGroupIds: snapshot.blockGroups.map((group) => group.id) }, annotation: { id: 'new', family: 'tag', fields: { value: false } } })); assert.equal(set.ok, true, set.failure?.message);
   const post = state(c.db); assert.equal((await move(c, 'undo', 'undo-set')).ok, true); assert.deepEqual(state(c.db), pre); assert.equal((await move(c, 'redo', 'redo-set')).ok, true); assert.deepEqual(state(c.db), post);
   assert.equal((await move(c, 'undo', 'undo-set-again')).ok, true); assert.equal((await move(c, 'undo', 'undo-split')).ok, true); // selected assignment undo followed by split undo restores topology
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM HistoryDocument_body_block').get().n, 1); assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM HistoryDocument_body_group_membership').get().n, 0);
});

test('v6/v7 do not clear an existing v8 future and empty moves remain no-op receipts', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); }); await edit(c, 'continue', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } }); assert.equal((await move(c, 'undo', 'undo')).ok, true);
  const empty = await move(c, 'undo', 'empty'); assert.equal(empty.empty, true); assert.equal(empty.events.length, 0); assert.equal((await move(c, 'redo', 'redo')).ok, true);
  const cursor = await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a' }); assert.deepEqual({ undo: cursor.undo, redo: cursor.redo }, { undo: 1, redo: 0 });
});

test('non-human principals cannot create an annotated history cursor entry', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  const result = await edit(c, 'api-edit', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } }, { type: 'apiKey', id: 'key-1' });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal((await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'apiKey', id: 'key-1' }, session: 'tab-a' })).undo, 0);
  assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM _HistoryCursor WHERE principalKey = 'apiKey:key-1'").get().n, 0);
});

test('revoked field access is checked before loading a private history fact', async (t) => {
  let allowed = true;
  const c = await setup(() => allowed ? grant(read, write) : grant(read)); t.after(() => { c.app.shutdown(); c.db.close(); });
  assert.equal((await edit(c, 'private-edit', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } })).ok, true);
  // A malformed fact makes ordering observable: authorization must deny first.
  c.db.prepare("UPDATE _PrivateActionFact SET fact = 'not-json' WHERE actionId = 'private-edit'").run();
  allowed = false;
  const before = { state: state(c.db), meta: durableMeta(c.db) };
  await assert.rejects(move(c, 'undo', 'revoked-undo'), (error) => error.status === 403);
  assert.deepEqual(state(c.db), before.state); assert.deepEqual(durableMeta(c.db), before.meta);
});

test('malformed persisted annotated image rejects undo atomically', async () => {
  const mutations = [
    (image) => { image.before.tables[0].rows[0] = { document_id: 'd1' }; },
    (image) => { const table = image.before.tables.find((entry) => entry.name.endsWith('_block')); const extra = { ...table.rows[0], id: 'zzzz' }; table.rows.push(extra); table.rows.reverse(); },
    (image) => { image.before.tables[0].rows[0].document_id = 'other-document'; },
    (image) => {
      const annotations = image.before.tables.find((entry) => entry.name.endsWith('_annotation'));
      const annotation = { id: 'empty-annotation', document_id: 'd1', project_id: 'p1', owner_id: 'u1', family: 'empty' };
      annotations.rows.push(annotation);
      image.before.tables.find((entry) => entry.name.endsWith('_annotation_empty')).rows.push({ annotation_id: annotation.id });
    },
    (image) => {
      image.before.tables.find((entry) => entry.name.endsWith('_annotation')).rows.push({
        id: 'undeclared-annotation', document_id: 'd1', project_id: 'p1', owner_id: 'u1', family: 'undeclared',
      });
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const c = await setup();
    try {
      assert.equal((await edit(c, `bad-image-${index}`, { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } })).ok, true);
      const fact = c.db.prepare('SELECT fact FROM _PrivateActionFact WHERE actionId = ?').get(`bad-image-${index}`);
      const parsed = JSON.parse(fact.fact); mutate(parsed);
      c.db.prepare('UPDATE _PrivateActionFact SET fact = ? WHERE actionId = ?').run(JSON.stringify(parsed), `bad-image-${index}`);
      const before = { state: state(c.db), meta: durableMeta(c.db) };
      let denied;
      try { denied = await move(c, 'undo', `bad-image-undo-${index}`); } catch (error) { assert.equal(error.status, 403); }
      if (denied) assert.equal(denied.ok, false);
      assert.deepEqual(state(c.db), before.state); assert.deepEqual(durableMeta(c.db), before.meta);
    } finally { c.app.shutdown(); c.db.close(); }
  }
});

test('stale revision after an intervening v8 action rejects the intended undo without movement', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  assert.equal((await edit(c, 'first', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } })).ok, true);
  const old = await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a' });
  const second = await edit(c, 'second', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'listed', blockGroupIds: snapshot.blockGroups.map((group) => group.id) }, annotation: { id: 'second-tag', family: 'tag', fields: { value: true } } }));
  assert.equal(second.ok, true, second.failure?.message);
  const before = { state: state(c.db), meta: durableMeta(c.db) };
  await assert.rejects(c.app.history.undo({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a', actionId: 'stale-undo', revision: old.revision }), /stale|changed/i);
  assert.deepEqual(state(c.db), before.state); assert.deepEqual(durableMeta(c.db), before.meta);
});

test('retired annotated documents reject history moves without restoration or cursor movement', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  assert.equal((await edit(c, 'retire-edit', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } })).ok, true);
  const cursor = await c.app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a' });
  const retired = await c.app.dispatch({ actionId: 'retire', principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', ...annotatedTextRetireAction(c.Document, 'd1') });
  assert.equal(retired.ok, true, retired.failure?.message);
  const before = { state: state(c.db), meta: durableMeta(c.db) };
  await assert.rejects(c.app.history.undo({ scope: 'Project:p1', principal: { type: 'user', id: 'u1' }, session: 'tab-a', actionId: 'retired-undo', revision: cursor.revision }));
  assert.deepEqual(state(c.db), before.state); assert.deepEqual(durableMeta(c.db), before.meta);
});

test('restoring history clears a minted basis and the old token cannot issue v8 afterward', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  const row = c.db.prepare('SELECT * FROM HistoryDocument WHERE id = ?').get('d1');
  const snapshot = await projectAnnotatedTextSnapshot({ db: c.db, entity: c.Document, row, principal: { type: 'user', id: 'u1' }, fieldName: 'body', descriptor: c.Document.fields.body });
  const command = { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } };
  assert.equal((await c.app.dispatch({ actionId: 'basis-edit', principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', history: { session: 'tab-a' }, ...annotatedTextAction(c.Document, c.Document.body, { ...command, id: 'd1', basis: snapshot.basis, mutationId: 'basis-edit' }) })).ok, true);
  assert.equal((await move(c, 'undo', 'basis-undo')).ok, true);
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM HistoryDocument_body_basis WHERE document_id = ?').get('d1').n, 0);
  const stale = await c.app.dispatch({ actionId: 'basis-reuse', principal: { type: 'user', id: 'u1' }, scope: 'Project:p1', history: { session: 'tab-a' }, ...annotatedTextAction(c.Document, c.Document.body, { ...command, id: 'd1', basis: snapshot.basis, mutationId: 'basis-reuse' }) });
  assert.equal(stale.ok, false); assert.match(stale.failure?.message ?? '', /basis|snapshot|token/i);
  assert.equal(stale.failure?.details?.code, 'basis-unavailable');
});

test('annotated history actions and events are not public reads or image-bearing receipts', async (t) => {
  const c = await setup(); t.after(() => { c.app.shutdown(); c.db.close(); });
  const result = await edit(c, 'opaque', { kind: 'block.continue', at: { blockId: c.blockId, offset: 5 } });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(c.app.history.actions, undefined); assert.equal(c.app.history.events, undefined);
  const durable = JSON.stringify(c.db.prepare("SELECT eventData FROM _Log WHERE actionId = 'opaque'").all()) + JSON.stringify(c.db.prepare("SELECT actionData FROM _ActionReceipt WHERE actionId = 'opaque'").all());
  assert.equal(/family_checkpoint|privateFact|tables|HistoryDocument_body_/i.test(durable), false);
});
