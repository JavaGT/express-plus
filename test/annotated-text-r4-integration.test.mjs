import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, number, text, entity, everyone, executeDDL, executeFrameworkDDL, measurement, protectingAnnotation,
  grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { materializeBlock, restoreTextFamilyCheckpoint, textFamilyCheckpoint } from '../src/annotated-text-family.mjs';
import { native } from '../src/event-handle.mjs';
import { frozenJsonSnapshot } from '../src/annotated-text-r2.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INSERT_HELLO = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'hello']];
const INSERT_WORLD = ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['root'], 'world']];

registerAnnotatedTextContract('sourceInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceInit', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition(input) {
    const blockText = input.blockText;
    const offset = input.utf16Offset;
    const payload = input.payload;
    if (payload.fail === true) throw new Error('partition failure');
    const leftText = blockText.slice(0, offset);
    const rightText = blockText.slice(offset);
    return Object.freeze({
      version: 1,
      leftPayload: Object.freeze({ ...payload, text: leftText, offset }),
      rightPayload: Object.freeze({ ...payload, text: rightText, offset }),
    });
  },
  combine: function combine(input) {
    if (input.left !== null && input.right !== null) {
      return Object.freeze({
        version: 1,
        payload: Object.freeze({ text: input.left.payload.text + input.right.payload.text }),
      });
    }
    if (input.left !== null) return Object.freeze({ version: 1, payload: input.left.payload });
    if (input.right !== null) return Object.freeze({ version: 1, payload: input.right.payload });
    return Object.freeze({ version: 1, payload: null });
  },
}));

function r4Doc({ protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant() } = {}) {
  return entity('R4Doc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      block: { reviewed: boolean({ default: true }) },
      annotations: [
        annotation('theme', { fields: { color: text({ default: 'blue' }), weight: number({ default: 1 }) } }),
        annotation('flag', { fields: { flagged: boolean({ default: false }) } }),
        protectingAnnotation('confidential', { protects: 'theme', access: protectingAccess }),
        protectingAnnotation('standalone', { access: () => grant(read) }),
      ],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor(db = new DatabaseSync(':memory:'), principalId = null, options) {
  const R4Doc = r4Doc(options);
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(R4Doc, db);
  const app = workbench({ db, entities: [R4Doc] });
  if (principalId !== null) app.listen(0, { principalOf: () => typeof principalId === 'function' ? principalId() : ({ id: principalId }) });
  else app.start();
  await app.ready;
  return { app, db };
}

async function setupDoc(blockText, principalId = null, options) {
  const { app, db } = await appFor(new DatabaseSync(':memory:'), principalId, options);
  const created = await app.dispatch({
    actionId: 'create', type: 'R4Doc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  let family = restoreTextFamilyCheckpoint(
    JSON.parse(db.prepare('SELECT family_checkpoint FROM R4Doc_body_state WHERE document_id = ?').get('d1').family_checkpoint),
  );
  if (blockText) {
    const op = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], blockText]];
    const result = await app.dispatch({
      actionId: 'insert-text', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
      payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: op } },
    });
    assert.equal(result.ok, true);
    family = restoreTextFamilyCheckpoint(
      JSON.parse(db.prepare('SELECT family_checkpoint FROM R4Doc_body_state WHERE document_id = ?').get('d1').family_checkpoint),
    );
  }
  const state = db.prepare('SELECT structure_version, family_checkpoint FROM R4Doc_body_state WHERE document_id = ?').get('d1');
  return { app, db, blockId, family, state };
}

function v4Payload(docId, blockId, startUtf16Offset, endUtf16Offset, annId, family, fields, expected, protectedTargetIds) {
  return {
    version: 4,
    id: docId,
    expected: { structuralRevision: expected.structuralRevision, frontier: expected.frontier },
    operation: {
      kind: 'annotation.apply',
      selection: { blockId, startUtf16Offset, endUtf16Offset },
      annotation: { id: annId, family, fields, ...(protectedTargetIds ? { protectedTargetIds } : {}) },
    },
  };
}

test('R4 annotation.apply on full block produces no splits, creates annotation with whole-block membership', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-full', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'ann-1', 'theme', { color: 'red' }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.version, 4);
  const receipt = db.prepare("SELECT eventRefs FROM _ActionReceipt WHERE scope = 'R4Doc:d1' AND actionId = 'apply-full'").get();
  const receiptRefs = JSON.parse(receipt.eventRefs);
  assert.equal(receiptRefs.length, 1);
  assert.equal(receiptRefs[0].scope, 'R4Doc:d1');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'apply-full'").get().count, 1);
  assert.equal(result.events[0].data.selectedBlockId, blockId);
  assert.deepEqual(result.events[0].data.splitBlockIds, []);
  assert.equal(result.events[0].data.annotation.id, 'ann-1');
  assert.equal(result.events[0].data.annotation.family, 'theme');
  assert.deepEqual(result.events[0].data.annotation.fields, { color: 'red', weight: 1 });
  assert.equal(result.events[0].data.after.structuralRevision, state.structure_version);
  const annRow = db.prepare("SELECT id, family FROM R4Doc_body_annotation WHERE id = 'ann-1'").get();
  assert.equal(annRow.family, 'theme');
  const famRow = db.prepare("SELECT * FROM R4Doc_body_annotation_theme WHERE annotation_id = 'ann-1'").get();
  assert.equal(famRow.color, 'red');
  assert.equal(famRow.weight, 1);
  const memberships = db.prepare("SELECT * FROM R4Doc_body_membership WHERE annotation_id = 'ann-1' ORDER BY ordinal").all();
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].block_id, blockId);
  await app.close?.();
});

test('R4 annotation.apply persists sorted protecting targets through its sole event and projection path', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const expected = { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier };
  const coded = await app.dispatch({
    actionId: 'apply-theme', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'theme-1', 'theme', {}, expected),
  });
  assert.equal(coded.ok, true, coded.failure?.message);
  const afterCoded = db.serialize();
  const protectedResult = await app.dispatch({
    actionId: 'apply-protection', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'protect-1', 'confidential', {}, expected, ['theme-1']),
  });
  assert.equal(protectedResult.ok, true, protectedResult.failure?.message);
  assert.deepEqual(protectedResult.events[0].data.annotation.protectedTargetIds, ['theme-1']);
  const targets = db.prepare("SELECT annotation_id, target_annotation_id FROM R4Doc_body_annotation_protected_target").all();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].annotation_id, 'protect-1');
  assert.equal(targets[0].target_annotation_id, 'theme-1');
  db.deserialize(afterCoded);
  const replay = JSON.parse(JSON.stringify(protectedResult.events[0].data));
  delete replay.__workbench;
  app.entities.get('R4Doc').projection.apply({ handle: native('R4Doc', 'body', 'operated'), data: replay }, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation_protected_target WHERE annotation_id = 'protect-1' AND target_annotation_id = 'theme-1'").get().count, 1);
  await app.close?.();
});

test('HTTP snapshot projects protected annotated text for each recipient before serialization', async (t) => {
  let principal = { id: 'u1' };
  let ownerMayRead = true;
  const { app, db, blockId, state } = await setupDoc('hello world', () => principal, {
    protectingAccess: async ({ is }) => (ownerMayRead && await is.owner()) ? grant(read) : grant(),
  });
  t.after(async () => { await app.shutdown(); db.close(); });
  const expected = { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier };
  assert.equal((await app.dispatch({
    actionId: 'http-theme', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'http-theme', 'theme', {}, expected),
  })).ok, true);
  assert.equal((await app.dispatch({
    actionId: 'http-protection', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'http-protect', 'confidential', {}, expected, ['http-theme']),
  })).ok, true);
  db.prepare("INSERT INTO R4Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('http-measurement', ?, 'source', 1, '{\"text\":\"hello world\"}')").run(blockId);
  const ownerResponse = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(ownerResponse.status, 200);
  const owner = await ownerResponse.json();
  assert.equal(owner.snapshot.body.blocks[0].kind, 'visible');
  assert.equal(owner.snapshot.body.blocks[0].text, 'hello world');

  principal = { id: 'u2' };
  const response = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const recipient = await response.json();
  assert.deepEqual(recipient.snapshot.body, {
    kind: 'workbench.annotatedText.recipient', version: 1,
    blocks: [{ kind: 'restricted', id: blockId, placeholder: '[Restricted]' }],
    annotations: [], memberships: [], measurements: [], capabilityHints: [],
  });
  const serialized = JSON.stringify(recipient.snapshot.body);
  assert.equal(serialized.includes('hello world'), false);
  assert.equal(serialized.includes('http-measurement'), false);
  assert.equal(serialized.includes('http-theme'), false);
  assert.equal(serialized.includes('http-protect'), false);
  assert.equal(serialized.includes('protectedTargetIds'), false);

  principal = { id: 'u1' };
  ownerMayRead = false;
  const revoked = await fetch(`http://127.0.0.1:${app.httpServer.address().port}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(revoked.status, 200, 'a fresh snapshot re-evaluates changed recipient authorization');
  assert.deepEqual((await revoked.json()).snapshot.body.blocks, [{ kind: 'restricted', id: blockId, placeholder: '[Restricted]' }]);
});

test('HTTP snapshot fails closed on malformed state and throwing protector access', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, blockId, state } = await setupDoc('secret', () => principal, {
    protectingAccess: () => { throw new Error('access failure'); },
  });
  t.after(async () => { await app.shutdown(); db.close(); });
  const expected = { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier };
  assert.equal((await app.dispatch({
    actionId: 'failed-theme', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal,
    payload: v4Payload('d1', blockId, 0, 6, 'failed-theme', 'theme', {}, expected),
  })).ok, true);
  assert.equal((await app.dispatch({
    actionId: 'failed-protection', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal,
    payload: v4Payload('d1', blockId, 0, 6, 'failed-protection', 'confidential', {}, expected, ['failed-theme']),
  })).ok, true);
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const throwing = await fetch(`${origin}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(throwing.status, 403);
  assert.equal((await throwing.text()).includes('secret'), false);

  db.prepare("DELETE FROM R4Doc_body_state WHERE document_id = 'd1'").run();
  const malformed = await fetch(`${origin}/snapshot/R4Doc/d1`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(malformed.status, 403);
  assert.equal((await malformed.text()).includes('secret'), false);
});

test('R4 annotation.apply rejects target IDs on ordinary, standalone, and wrong-family protectors', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const expected = { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier };
  const ordinary = await app.dispatch({
    actionId: 'bad-targets', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'flag-1', 'flag', {}, expected, ['nope']),
  });
  assert.equal(ordinary.ok, false);
  const standalone = await app.dispatch({
    actionId: 'bad-standalone-protection', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'standalone-1', 'standalone', {}, expected, ['nope']),
  });
  assert.equal(standalone.ok, false);
  const wrongFamily = await app.dispatch({
    actionId: 'bad-protection', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'protect-2', 'confidential', {}, expected, ['nope']),
  });
  assert.equal(wrongFamily.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R4Doc_body_annotation_protected_target').get().count, 0);
  await app.close?.();
});

test('R4 annotation.apply on prefix (start=0, end<length) produces one split, annotation on left block', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-prefix', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 5, 'ann-2', 'flag', { flagged: true }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events[0].data.splitBlockIds.length, 1);
  assert.equal(result.events[0].data.selectedBlockId, blockId);
  const newBlockId = result.events[0].data.splitBlockIds[0];
  assert.equal(result.events[0].data.after.structuralRevision, state.structure_version + 1);
  assert.equal(materializeBlock(restoreTextFamilyCheckpoint(result.events[0].data.family), blockId), 'hello');
  assert.equal(materializeBlock(restoreTextFamilyCheckpoint(result.events[0].data.family), newBlockId), ' world');
  const annRow = db.prepare("SELECT id, family FROM R4Doc_body_annotation WHERE id = 'ann-2'").get();
  assert.equal(annRow.family, 'flag');
  const famRow = db.prepare("SELECT * FROM R4Doc_body_annotation_flag WHERE annotation_id = 'ann-2'").get();
  assert.equal(famRow.flagged, 1);
  const memberships = db.prepare("SELECT * FROM R4Doc_body_membership WHERE annotation_id = 'ann-2'").all();
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].block_id, blockId);
  await app.close?.();
});

test('R4 annotation.apply on suffix (start>0, end=length) produces one split, annotation on right block', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-suffix', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 6, 11, 'ann-3', 'theme', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(result.events[0].data.splitBlockIds.length, 1);
  assert.notEqual(result.events[0].data.selectedBlockId, blockId);
  const selectedBlockId = result.events[0].data.selectedBlockId;
  assert.equal(materializeBlock(restoreTextFamilyCheckpoint(result.events[0].data.family), selectedBlockId), 'world');
  await app.close?.();
});

test('R4 annotation.apply on interior (start>0, end<length) produces two splits, annotation on middle block', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-interior', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 6, 9, 'ann-4', 'theme', { color: 'green', weight: 2 }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].data.splitBlockIds.length, 2);
  const selectedBlockId = result.events[0].data.selectedBlockId;
  assert.equal(materializeBlock(restoreTextFamilyCheckpoint(result.events[0].data.family), selectedBlockId), 'wor');
  const famRow = db.prepare("SELECT * FROM R4Doc_body_annotation_theme WHERE annotation_id = 'ann-4'").get();
  assert.equal(famRow.color, 'green');
  assert.equal(famRow.weight, 2);
  await app.close?.();
});

test('R4 annotation.apply with existing membership propagates through splits', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const first = await app.dispatch({
    actionId: 'first-ann', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'existing-ann', 'theme', { color: 'red' }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(first.ok, true);
  const afterState = db.prepare('SELECT structure_version, family_checkpoint FROM R4Doc_body_state WHERE document_id = ?').get('d1');
  const afterFamily = JSON.parse(afterState.family_checkpoint);
  const second = await app.dispatch({
    actionId: 'second-ann', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 5, 'second-ann', 'flag', { flagged: true }, { structuralRevision: afterState.structure_version, frontier: afterFamily.checkpoint.frontier }),
  });
  assert.equal(second.ok, true);
  const existingMemberships = db.prepare("SELECT * FROM R4Doc_body_membership WHERE annotation_id = 'existing-ann' ORDER BY ordinal").all();
  assert.equal(existingMemberships.length, 2);
  const newMemberships = db.prepare("SELECT * FROM R4Doc_body_membership WHERE annotation_id = 'second-ann' ORDER BY ordinal").all();
  assert.equal(newMemberships.length, 1);
  await app.close?.();
});

test('R4 annotation.apply propagates an existing membership through both interior splits', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const first = await app.dispatch({
    actionId: 'first-interior-membership', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'existing-interior-ann', 'theme', { color: 'red' }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(first.ok, true);
  const afterState = db.prepare('SELECT * FROM R4Doc_body_state WHERE document_id = ?').get('d1');
  const afterFamily = JSON.parse(afterState.family_checkpoint);
  const second = await app.dispatch({
    actionId: 'second-interior-membership', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 6, 9, 'new-interior-ann', 'flag', { flagged: true }, { structuralRevision: afterState.structure_version, frontier: afterFamily.checkpoint.frontier }),
  });
  assert.equal(second.ok, true, second.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_membership WHERE annotation_id = 'existing-interior-ann'").get().count, 3);
  await app.close?.();
});

test('R4 annotation.apply persists default field values when omitted', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-defaults', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'ann-def', 'theme', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true);
  const famRow = db.prepare("SELECT * FROM R4Doc_body_annotation_theme WHERE annotation_id = 'ann-def'").get();
  assert.equal(famRow.color, 'blue');
  assert.equal(famRow.weight, 1);
  await app.close?.();
});

test('R4 annotation.apply rejects stale structural revision', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'stale', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'ann-stale', 'theme', {}, { structuralRevision: 999, frontier: [] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  await app.close?.();
});

test('R4 annotation.apply rejects invalid selection offsets', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  for (const [actionId, start, end] of [['reversed', 5, 3], ['negative', -1, 5], ['beyond', 0, 999], ['equal', 3, 3]]) {
    const result = await app.dispatch({
      actionId, type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
      payload: v4Payload('d1', blockId, start, end, 'ann-bad', 'theme', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
    });
    assert.equal(result.ok, false, `expected failure for ${actionId}`);
    assert.equal(result.failure.category, 'invalid-input');
  }
  await app.close?.();
});

test('R4 annotation.apply rejects unknown annotation family', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'no-family', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'ann-nofam', 'nonexistent', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  await app.close?.();
});

test('R4 annotation.apply rejects duplicate annotation id', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const first = await app.dispatch({
    actionId: 'first', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'dup-ann', 'theme', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(first.ok, true);
  const afterState = db.prepare('SELECT structure_version, family_checkpoint FROM R4Doc_body_state WHERE document_id = ?').get('d1');
  const afterFamily = JSON.parse(afterState.family_checkpoint);
  const second = await app.dispatch({
    actionId: 'second', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'dup-ann', 'theme', {}, { structuralRevision: afterState.structure_version, frontier: afterFamily.frontier }),
  });
  assert.equal(second.ok, false);
  assert.equal(second.failure.category, 'invalid-input');
  await app.close?.();
});

test('R4 annotation.apply rejects extra and missing fields', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const extraResult = await app.dispatch({
    actionId: 'extra', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 11, 'ann-extra', 'theme', { color: 'red', extraField: 'oops' }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(extraResult.ok, false);
  assert.equal(extraResult.failure.category, 'invalid-input');
  await app.close?.();
});

test('R4 annotation.apply receipt deduplication works', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const payload = v4Payload('d1', blockId, 0, 11, 'ann-dedup', 'theme', { color: 'red' }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier });
  const first = await app.dispatch({
    actionId: 'dedup-op', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload,
  });
  assert.equal(first.ok, true);
  const retry = await app.dispatch({
    actionId: 'dedup-op', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R4Doc_body_annotation WHERE id = 'ann-dedup'").get().count, 1);
  await app.close?.();
});

test('R4 annotation.apply with measurements partitions deterministically', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  db.prepare("INSERT INTO R4Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'source', 1, '{\"text\":\"hello world\"}')").run(blockId);
  const result = await app.dispatch({
    actionId: 'ann-meas', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 5, 'ann-meas', 'theme', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true);
  const measRows = db.prepare('SELECT id, block_id, family, payload FROM R4Doc_body_measurement ORDER BY id').all();
  assert.equal(measRows.length, 2);
  const leftMeas = measRows.find(r => r.block_id === blockId);
  const rightMeas = measRows.find(r => r.block_id !== blockId);
  assert.ok(leftMeas);
  assert.ok(rightMeas);
  assert.equal(JSON.parse(leftMeas.payload).text, 'hello');
  assert.equal(JSON.parse(rightMeas.payload).text, ' world');
  await app.close?.();
});

test('R4 annotation.apply projection tamper leaves state unchanged', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  const pristineDatabase = db.serialize();
  const result = await app.dispatch({
    actionId: 'apply-tamper', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 5, 'ann-tamper', 'theme', { color: 'red' }, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, true);

  const baseData = () => {
    const data = JSON.parse(JSON.stringify(result.events[0].data));
    delete data.__workbench;
    return data;
  };

  const invalidEvents = [
    (data) => { data.annotation.id = 'different-id'; },
    (data) => { data.annotation.family = 'flag'; },
    (data) => { data.annotation.fields = { color: 'green' }; },
    (data) => { data.operation.annotation.fields = { color: 'green' }; },
    (data) => { data.selectedBlockId = 'fake-block'; },
    (data) => { data.splitBlockIds = []; },
    (data) => { data.splitOps = []; },
    (data) => { data.operation.selection.endUtf16Offset = data.operation.selection.startUtf16Offset; },
    (data) => { data.operation.selection.endUtf16Offset = 99; },
    (data) => { data.operation.extra = true; },
    (data) => { data.operation.selection.extra = true; },
    (data) => { data.operation.annotation.extra = true; },
    (data) => { data.annotation.extra = true; },
    (data) => { data.splitOps[0].utf16Offset += 1; },
    (data) => { data.splitOps[0].extra = true; },
    (data) => {
      data.splitBlockIds.push('extra-block');
      data.splitOps.push({ blockId: data.selectedBlockId, newBlockId: 'extra-block', utf16Offset: 1 });
    },
    (data) => { data.after.structuralRevision = data.before.structuralRevision; },
    (data) => { data.blocks[0].epoch = 999; },
    (data) => { data.memberships = []; },
    (data) => { data.measurements = [{ id: 'fake', blockId: 'fake', family: 'source', formatVersion: 1, payload: {} }]; },
    (data) => { data.measurements = [{ id: 'fake', blockId: blockId, family: 'source', formatVersion: 1, payload: { bad: undefined } }]; },
  ];

  for (const mutate of invalidEvents) {
    db.deserialize(pristineDatabase);
    const data = baseData();
    mutate(data);
    assert.throws(() => app.entities.get('R4Doc').projection.apply({
      handle: native('R4Doc', 'body', 'operated'), data,
    }, db));
    assert.equal(Buffer.compare(Buffer.from(db.serialize()), Buffer.from(pristineDatabase)), 0);
  }

  await app.close?.();
});

test('R4 annotation.apply with failing measurement adapter rolls back', async () => {
  const { app, db, blockId, state } = await setupDoc('hello world');
  db.prepare("INSERT INTO R4Doc_body_measurement (id, block_id, family, format_version, payload) VALUES ('failing-m1', ?, 'source', 1, '{\"text\":\"hello world\",\"fail\":true}')").run(blockId);
  const originalState = JSON.stringify(db.prepare('SELECT * FROM R4Doc_body_state WHERE document_id = ?').get('d1'));
  const originalBlocks = JSON.stringify(db.prepare('SELECT * FROM R4Doc_body_block ORDER BY id').all());
  const result = await app.dispatch({
    actionId: 'apply-fail', type: 'R4Doc.body.operation', scope: 'R4Doc:d1', principal: { id: 'u1' },
    payload: v4Payload('d1', blockId, 0, 5, 'ann-fail', 'theme', {}, { structuralRevision: state.structure_version, frontier: JSON.parse(state.family_checkpoint).checkpoint.frontier }),
  });
  assert.equal(result.ok, false);
  const afterState = JSON.stringify(db.prepare('SELECT * FROM R4Doc_body_state WHERE document_id = ?').get('d1'));
  assert.equal(afterState, originalState);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM R4Doc_body_block ORDER BY id').all()), originalBlocks);
  await app.close?.();
});
