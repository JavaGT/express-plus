import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, executeDDL, executeFrameworkDDL, grant, measurement, ref, read, scope, write, everyone,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, protectingAnnotation,
} from '../src/internal.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { native } from '../src/event-handle.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const extension = {
  version: 1,
  validate() {},
  edit() {},
  partition({ blockText, utf16Offset, payload }) {
    return { version: 1, leftPayload: { ...payload, text: blockText.slice(0, utf16Offset) }, rightPayload: { ...payload, text: blockText.slice(utf16Offset) } };
  },
  combine({ left, right }) { return { version: 1, payload: { text: `${left?.payload?.text ?? ''}${right?.payload?.text ?? ''}` } }; },
};
registerAnnotatedTextContract('r8IntegrationSource', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('r8IntegrationSource', Object.freeze(extension));

function makeApp() {
  const Document = entity('R8IntegrationDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner', block: { reviewed: boolean({ default: true }) },
       annotations: [annotation('coding'), annotation('tag', { appliesTo: 'block-group', cardinality: 'one', fields: { value: boolean({ default: false }) } }), annotation('other', { appliesTo: 'block-group', cardinality: 'one', fields: { value: boolean({ default: false }) } }), protectingAnnotation('confidential', { protects: 'coding', access: () => grant() })],
      measurements: [measurement('source', { extension: 'r8IntegrationSource' })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  const Project = entity('Project', { owner: ref('User'), grant: [scope(() => everyone()).can(() => grant(read, write))] });
  return { Document, Project };
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  const { Document, Project } = makeApp();
  executeFrameworkDDL(db); db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)'); db.exec("INSERT INTO User VALUES ('u1')");
  executeDDL(Project, db); db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')"); executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document] });
  app.listen(0, { principalOf: () => ({ id: 'u1' }) }); await app.ready;
  const created = await app.dispatch({ actionId: 'create', type: 'R8IntegrationDocument.create', principal: { id: 'u1' }, payload: {
    id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', fields: { reviewed:  false }, measurements: [{ family: 'source', payload: { text: 'hello world' } }] }] },
  }});
  assert.equal(created.ok, true, created.failure?.message);
  const blockId = db.prepare('SELECT id FROM R8IntegrationDocument_body_block').get().id;
  return { app, db, Document: app.entities.get('R8IntegrationDocument'), blockId };
}

async function recipientSnapshot({ db, Document }, principal = { id: 'u1' }) {
  const row = db.prepare('SELECT * FROM R8IntegrationDocument WHERE id = ?').get('d1');
  return withAuthoringBinding({ db, entity: Document, Document, row, principal, fieldName: 'body', descriptor: Document.fields.body });
}

async function dispatch({ app, db, Document }, actionId, command, { binding, principal = { id: 'u1' } } = {}) {
  const current = binding ?? await recipientSnapshot({ db, Document }, principal);
  const edit = typeof command === 'function' ? command(current.snapshot) : command;
  const token = ({ blockId, offset, affinity }) => ({ positionToken: current.positionTokens.get(blockId), offset, affinity });
  const groups = (selection) => selection.kind === 'one'
    ? { kind: 'one', groupToken: current.groupTokens.get(selection.blockGroupId) }
    : { kind: selection.kind, groupTokens: selection.blockGroupIds.map((id) => current.groupTokens.get(id)) };
  const translated = { ...edit, ...(edit.at ? { at: token(edit.at) } : {}), ...(edit.from ? { from: token(edit.from) } : {}), ...(edit.to ? { to: token(edit.to) } : {}), ...(edit.selection ? { selection: groups(edit.selection) } : {}), authoring: { version: 1, stream: current.streamToken, lease: current.leaseToken, mutationId: actionId } };
  if (translated.kind === 'block.split' || translated.kind === 'block.continue' || translated.kind === 'block.split-and-assign') translated.temporaryBlock = `temporary-${actionId}`;
  const result = await app.dispatch({ actionId, principal, scope: 'Project:p1', type: `${Document.name}.body.operation`, payload: { version: 9, id: 'd1', authoring: translated.authoring, edit: Object.fromEntries(Object.entries(translated).filter(([key]) => !['authoring', 'id', 'mutationId'].includes(key))) } });
  if (!result.ok && result.events?.length) console.log('R8EVENT', actionId, Object.keys(result.events[0].data), result.events[0].data);
  return result;
}

function rows(db, sql) { return db.prepare(sql).all(); }

function durableAnnotatedTextState(db) {
  const prefix = 'R8IntegrationDocument_body';
  const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
  const tables = rows(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '${prefix}_*' ORDER BY name`)
    .map(({ name }) => name).filter((name) => !name.includes('_authoring_'));
  return tables.map((name) => {
    const columns = rows(db, `PRAGMA table_info(${quote(name)})`).map((column) => column.name);
    const order = columns.map(quote).join(', ');
    return [name, rows(db, `SELECT * FROM ${quote(name)} ORDER BY ${order}`)];
  });
}

test('v9 block.continue partitions block facts while retaining its durable group', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const { db, blockId } = ctx;
  const result = await dispatch(ctx, 'continue', { kind: 'block.continue', at: { blockId, offset: 5, affinity: 'right' } });
  assert.equal(result.ok, true, result.failure?.message);
  const blocks = rows(db, 'SELECT id, group_id FROM R8IntegrationDocument_body_block_group JOIN R8IntegrationDocument_body_block ON id = block_id ORDER BY position');
  assert.equal(blocks.length, 2); assert.equal(blocks[0].group_id, blocks[1].group_id);
  assert.deepEqual(rows(db, 'SELECT reviewed FROM R8IntegrationDocument_body_block ORDER BY position').map((r) => r.reviewed), [0, 0]);
  assert.deepEqual(rows(db, 'SELECT measurement.block_id, measurement.payload FROM R8IntegrationDocument_body_measurement AS measurement JOIN R8IntegrationDocument_body_block AS block ON block.id = measurement.block_id ORDER BY block.position').map((r) => [r.block_id, JSON.parse(r.payload).text]), [[blocks[0].id, 'hello'], [blocks[1].id, ' world']]);
  assert.equal(rows(db, 'SELECT group_id FROM R8IntegrationDocument_body_block_group').length, 2);
});

test('v9 block.split-and-assign commits split and one right-group annotation in one action', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const result = await dispatch(ctx, 'split-assign', { kind: 'block.split-and-assign', at: { blockId: ctx.blockId, offset: 5, affinity: 'right' }, annotation: { id: 'tag-right', family: 'tag', fields: { value: true } } });
  assert.equal(result.ok, true, result.failure?.message);
  const groups = rows(ctx.db, 'SELECT b.id, bg.group_id FROM R8IntegrationDocument_body_block b JOIN R8IntegrationDocument_body_block_group bg ON bg.block_id=b.id ORDER BY b.position');
  assert.notEqual(groups[0].group_id, groups[1].group_id); assert.equal(groups[1].group_id, groups[1].id);
  assert.deepEqual(rows(ctx.db, 'SELECT annotation_id, group_id FROM R8IntegrationDocument_body_group_membership').map((row) => ({ ...row })), [{ annotation_id: 'tag-right', group_id: groups[1].group_id }]);
});

test('v9 listed assignment canonicalizes order, replaces only selected groups, and clear is idempotent', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const split = await dispatch(ctx, 'split-assign', { kind: 'block.split-and-assign', at: { blockId: ctx.blockId, offset: 5, affinity: 'right' }, annotation: { id: 'old-a', family: 'tag', fields: { value: false } } });
  assert.equal(split.ok, true, split.failure?.message);
  const groups = rows(ctx.db, 'SELECT b.id, bg.group_id FROM R8IntegrationDocument_body_block b JOIN R8IntegrationDocument_body_block_group bg ON bg.block_id=b.id ORDER BY b.position');
  const oldB = await dispatch(ctx, 'old-b', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, annotation: { id: 'old-b', family: 'tag', fields: { value: false } } }));
  assert.equal(oldB.ok, true, oldB.failure?.message);
  const set = await dispatch(ctx, 'set-listed', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'listed', blockGroupIds: [snapshot.blockGroups[1].id, snapshot.blockGroups[0].id] }, annotation: { id: 'new', family: 'tag', fields: { value: true } } }));
  assert.equal(set.ok, true, set.failure?.message);
   const listedMemberships = rows(ctx.db, `SELECT membership.annotation_id, membership.group_id, membership.ordinal, MIN(block.position) AS group_position
     FROM R8IntegrationDocument_body_group_membership AS membership
     JOIN R8IntegrationDocument_body_block_group AS block_group ON block_group.group_id = membership.group_id
     JOIN R8IntegrationDocument_body_block AS block ON block.id = block_group.block_id
     GROUP BY membership.annotation_id, membership.group_id, membership.ordinal
     ORDER BY group_position`).map(({ annotation_id, group_id, ordinal }) => ({ annotation_id, group_id, ordinal }));
   assert.deepEqual(listedMemberships, [{ annotation_id: 'new', group_id: groups[0].group_id, ordinal: 0 }, { annotation_id: 'new', group_id: groups[1].group_id, ordinal: 1 }]);
   const cleared = await dispatch(ctx, 'clear-missing', (snapshot) => ({ kind: 'block-group.assignment.clear', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, family: 'tag' }));
  assert.equal(cleared.ok, true, cleared.failure?.message);
   assert.deepEqual(rows(ctx.db, 'SELECT annotation_id, group_id FROM R8IntegrationDocument_body_group_membership').map((row) => ({ ...row })), [{ annotation_id: 'new', group_id: groups[1].group_id }]);
});

test('v9 assignment removal is scoped to the operated family', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const other = await dispatch(ctx, 'other', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, annotation: { id: 'other-1', family: 'other', fields: { value: true } } }));
  assert.equal(other.ok, true, other.failure?.message);
  const tag = await dispatch(ctx, 'tag', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, annotation: { id: 'tag-1', family: 'tag', fields: { value: true } } }));
  assert.equal(tag.ok, true, tag.failure?.message);
  const cleared = await dispatch(ctx, 'clear-tag', (snapshot) => ({ kind: 'block-group.assignment.clear', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, family: 'tag' }));
  assert.equal(cleared.ok, true, cleared.failure?.message);
  assert.deepEqual(rows(ctx.db, 'SELECT annotation_id, group_id FROM R8IntegrationDocument_body_group_membership ORDER BY annotation_id').map((row) => ({ ...row })), [{ annotation_id: 'other-1', group_id: rows(ctx.db, 'SELECT group_id FROM R8IntegrationDocument_body_block_group LIMIT 1').at(0).group_id }]);
  assert.equal(rows(ctx.db, "SELECT id FROM R8IntegrationDocument_body_annotation WHERE family = 'tag'").length, 0);
  assert.deepEqual(cleared.events[0].data.facts.removedAnnotationIds, ['tag-1']);
});

test('v9 rejects invalid consecutive selections, stale/partial bases, boundaries, and invalid families without partial writes', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
   const split = await dispatch(ctx, 'split', { kind: 'block.split-and-assign', at: { blockId: ctx.blockId, offset: 5, affinity: 'right' }, annotation: { id: 'first', family: 'tag', fields: { value: true } } }); assert.equal(split.ok, true, split.failure?.message);
   const splitAgain = await dispatch(ctx, 'split-again', { kind: 'block.split-and-assign', at: { blockId: rows(ctx.db, 'SELECT id FROM R8IntegrationDocument_body_block ORDER BY position')[1].id, offset: 1, affinity: 'right' }, annotation: { id: 'middle', family: 'tag', fields: { value: true } } });
   assert.equal(splitAgain.ok, true, splitAgain.failure?.message);
   const groups = rows(ctx.db, 'SELECT b.id, bg.group_id FROM R8IntegrationDocument_body_block b JOIN R8IntegrationDocument_body_block_group bg ON bg.block_id=b.id ORDER BY b.position');
   const before = durableAnnotatedTextState(ctx.db);
   for (const [actionId, pick] of [['reordered', (ids) => [ids[1], ids[0]]], ['nonadjacent', (ids) => [ids[0], ids[2]]]]) {
     const result = await dispatch(ctx, actionId, (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'consecutive', blockGroupIds: pick(snapshot.blockGroups.map((group) => group.id)) }, annotation: { id: actionId, family: 'tag', fields: { value: true } } })); assert.equal(result.ok, false, result.failure?.message);
   }
   const boundary = await dispatch(ctx, 'boundary', { kind: 'block.continue', at: { blockId: groups[0].id, offset: 0, affinity: 'right' } }); assert.equal(boundary.ok, false, boundary.failure?.message);
   const invalidFamily = await dispatch(ctx, 'invalid-family', (snapshot) => ({ kind: 'block-group.assignment.clear', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, family: 'not-declared' })); assert.equal(invalidFamily.ok, false, invalidFamily.failure?.message);
   assert.deepEqual(durableAnnotatedTextState(ctx.db), before);
});

test('v9 block continuation classifies an unprojectable token position as invalid input', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const before = durableAnnotatedTextState(ctx.db);
  const result = await dispatch(ctx, 'invalid-position', { kind: 'block.continue', at: { blockId: ctx.blockId, offset: 12, affinity: 'right' } });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.match(result.failure.message, /offset is outside text bounds/);
  assert.equal(rows(ctx.db, "SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'invalid-position'")[0].count, 0);
  assert.deepEqual(durableAnnotatedTextState(ctx.db), before);
});

test('v9 projection rejects tampered split facts before any durable write', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const result = await dispatch(ctx, 'tamper-source', { kind: 'block.continue', at: { blockId: ctx.blockId, offset: 5, affinity: 'right' } }); assert.equal(result.ok, true);
  const snapshot = ctx.db.serialize(); ctx.db.deserialize(snapshot);
  const event = structuredClone(result.events[0].data); event.operation.groupId = 'unknown-group';
  assert.throws(() => ctx.Document.projection.apply({ handle: native('R8IntegrationDocument', 'body', 'operated'), data: event }, ctx.db), /source group fact mismatch/);
  assert.deepEqual(ctx.db.serialize(), snapshot);
});

test('v9 token is bound to the recipient and rejects a newly restricted physical group', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const captured = await recipientSnapshot(ctx);
  const groupId = captured.snapshot.blockGroups[0].id;
  const blockId = ctx.blockId;
  const point = JSON.stringify({ point: ['point', ['root'], 'left'], tokenFrontier: [] });
  ctx.db.prepare("INSERT INTO R8IntegrationDocument_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('coding-1', 'd1', 'p1', 'u1', 'coding')").run();
  ctx.db.prepare("INSERT INTO R8IntegrationDocument_body_annotation (id, document_id, project_id, owner_id, family) VALUES ('protect-1', 'd1', 'p1', 'u1', 'confidential')").run();
  ctx.db.prepare("INSERT INTO R8IntegrationDocument_body_annotation_confidential (annotation_id) VALUES ('protect-1')").run();
  ctx.db.prepare("INSERT INTO R8IntegrationDocument_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES ('protect-1', 'coding-1')").run();
  ctx.db.prepare('INSERT INTO R8IntegrationDocument_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, 0, ?, ?)').run('coding-1', blockId, point, point);
  ctx.db.prepare('INSERT INTO R8IntegrationDocument_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, 0, ?, ?)').run('protect-1', blockId, point, point);
  const before = durableAnnotatedTextState(ctx.db);
  const rejected = await dispatch(ctx, 'hidden-group', { kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: groupId }, annotation: { id: 'never', family: 'tag', fields: { value: true } } }, { binding: captured, principal: { id: 'u1' } });
  assert.equal(rejected.ok, false);
  assert.deepEqual(durableAnnotatedTextState(ctx.db), before);
});

test('v9 authoring stream/lease persists across structural mutations and old binding positions remain valid for surviving blocks', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const captured = await recipientSnapshot(ctx);
  const split = await dispatch(ctx, 'fresh-split', { kind: 'block.continue', at: { blockId: ctx.blockId, offset: 5, affinity: 'right' } });
  assert.equal(split.ok, true, split.failure?.message);
  const before = durableAnnotatedTextState(ctx.db);
  // The old binding's stream/lease is still valid; the original block survives as the left half
  const stillValid = await dispatch(ctx, 'stale-binding', { kind: 'text.insert', at: { blockId: ctx.blockId, offset: 1, affinity: 'right' }, text: 'X' }, { binding: captured, principal: { id: 'u1' } });
  assert.equal(stillValid.ok, true, stillValid.failure?.message);
  // The old binding has no position token for the new right block
  const blocks = rows(ctx.db, 'SELECT id FROM R8IntegrationDocument_body_block ORDER BY position');
  assert.equal(captured.positionTokens.has(blocks[1].id), false);
});

test('v9 assignment projection rejects tampered set and clear facts without writes', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const set = await dispatch(ctx, 'tamper-set', (snapshot) => ({ kind: 'block-group.assignment.set', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, annotation: { id: 'set-ann', family: 'tag', fields: { value: true } } }));
  assert.equal(set.ok, true);
  const clear = await dispatch(ctx, 'tamper-clear', (snapshot) => ({ kind: 'block-group.assignment.clear', selection: { kind: 'one', blockGroupId: snapshot.blockGroups[0].id }, family: 'tag' }));
  assert.equal(clear.ok, true);
  for (const tamper of [
    (event) => { event.facts.preimage[0].annotationId = 'forged'; },
    (event) => { event.operation.groupIds[0] = 'forged'; },
  ]) {
    const before = durableAnnotatedTextState(ctx.db); const event = structuredClone(clear.events[0].data); tamper(event);
    assert.throws(() => ctx.Document.projection.apply({ handle: native('R8IntegrationDocument', 'body', 'operated'), data: event }, ctx.db));
    assert.deepEqual(durableAnnotatedTextState(ctx.db), before);
  }
});

test('v9 split-and-assign projection rejects tampered annotation and group membership facts', async (t) => {
  const ctx = await setup(); t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  const result = await dispatch(ctx, 'tamper-split-assign', { kind: 'block.split-and-assign', at: { blockId: ctx.blockId, offset: 5, affinity: 'right' }, annotation: { id: 'split-ann', family: 'tag', fields: { value: true } } });
  assert.equal(result.ok, true);
  for (const tamper of [
    (event) => { event.facts.annotation.id = 'forged'; },
    (event) => { event.facts.groupMembership.groupId = 'forged'; },
  ]) {
    const before = durableAnnotatedTextState(ctx.db); const event = structuredClone(result.events[0].data); tamper(event);
    assert.throws(() => ctx.Document.projection.apply({ handle: native('R8IntegrationDocument', 'body', 'operated'), data: event }, ctx.db));
    assert.deepEqual(durableAnnotatedTextState(ctx.db), before);
  }
});
