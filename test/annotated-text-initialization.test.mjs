import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import workbench, {
  annotatedText, annotation, boolean, entity, everyone, executeDDL, executeFrameworkDDL, measurement,
  createServer, grant, read, ref, scope, write,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension,
} from '../src/internal.mjs';
import { applyTextOperationToBlock, mergeBlocks, restoreTextFamilyCheckpoint, textFamilyCheckpoint, materializeBlock, splitBlock } from '../src/annotated-text-family.mjs';
import { native } from '../src/event-handle.mjs';
import { frozenJsonSnapshot } from '../src/annotated-text-r2.mjs';
import { annotatedTextAction, annotatedTextCreateAction } from '../src/annotated-text-public.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';

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

registerAnnotatedTextContract('sourceRangeInit', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('sourceRangeInit', Object.freeze({
  version: 1,
  validate: function validate({ blockText, payload }) {
    if (!payload || !Array.isArray(payload.ranges)) throw new Error('ranges required');
    let previous = -1;
    for (const range of payload.ranges) {
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          range.start < 0 || range.start >= range.end || range.end > blockText.length || range.start < previous ||
          (range.start > 0 && blockText.charCodeAt(range.start) >= 0xdc00 && blockText.charCodeAt(range.start) <= 0xdfff) ||
          (range.end > 0 && blockText.charCodeAt(range.end) >= 0xdc00 && blockText.charCodeAt(range.end) <= 0xdfff)) throw new Error('invalid UTF-16 range');
      previous = range.start;
    }
  },
  edit: function edit(input) { return input; },
  partition: function partition(input) { return { version: 1, leftPayload: input.payload, rightPayload: input.payload }; },
  combine: function combine(input) { return { version: 1, payload: input.left?.payload ?? input.right?.payload ?? { ranges: [] } }; },
}));

function doc() {
  return entity('InitDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      block: { reviewed: boolean({ default: true }) },
      annotations: [annotation('note', { fields: {} })],
      measurements: [measurement('source', { extension: 'sourceInit' })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

test('R2 measurement adapter inputs receive an isolated deep-frozen JSON snapshot', () => {
  const source = { nested: { value: 1 } };
  const snapshot = frozenJsonSnapshot(source);
  assert.notEqual(snapshot, source);
  assert.notEqual(snapshot.nested, source.nested);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.nested), true);
  assert.throws(() => { snapshot.nested.value = 2; }, TypeError);
  assert.equal(source.nested.value, 1);
});

test('frozenJsonSnapshot rejects undefined top-level value', () => {
  assert.throws(() => frozenJsonSnapshot(undefined), /undefined/);
});

test('frozenJsonSnapshot rejects undefined property', () => {
  assert.throws(() => frozenJsonSnapshot({ x: undefined }), /undefined/);
});

test('frozenJsonSnapshot rejects NaN', () => {
  assert.throws(() => frozenJsonSnapshot(NaN), /finite/);
  assert.throws(() => frozenJsonSnapshot({ x: NaN }), /finite/);
});

test('frozenJsonSnapshot rejects Infinity', () => {
  assert.throws(() => frozenJsonSnapshot(Infinity), /finite/);
  assert.throws(() => frozenJsonSnapshot({ x: Infinity }), /finite/);
});

test('frozenJsonSnapshot rejects sparse array', () => {
  assert.throws(() => frozenJsonSnapshot([1, , 3]), /sparse/);
});

test('frozenJsonSnapshot leaves valid source mutable and unmodified while snapshot freezes', () => {
  const source = { nested: { value: 1 } };
  const snapshot = frozenJsonSnapshot(source);
  assert.notEqual(snapshot, source);
  assert.notEqual(snapshot.nested, source.nested);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.nested), true);
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.nested), false);
  source.nested.value = 2;
  assert.equal(source.nested.value, 2);
  assert.equal(snapshot.nested.value, 1);
});

async function appFor(db = new DatabaseSync(':memory:')) {
  const InitDoc = doc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(InitDoc, db);
  const app = workbench({ db, entities: [InitDoc] });
  app.start();
  await app.ready;
  return { app, db, InitDoc };
}

test('annotated text create atomically initializes one canonical empty family and block', async () => {
  const { app, db } = await appFor();
  const result = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(result.ok, true);
  const blockId = result.events[0].data.__workbench.annotatedText.body.initialBlockId;
  assert.equal(typeof blockId, 'string');
  assert.ok(blockId.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc WHERE id = ?').get('d1').count, 1);
  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  const block = db.prepare('SELECT * FROM InitDoc_body_block WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);
  assert.equal(block.id, blockId);
  assert.equal(block.position, '0000000000000');
  assert.equal(block.epoch, 1);
  assert.equal(block.structure_version, 1);
  assert.equal(block.reviewed, 1);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.id, 'd1');
  assert.deepEqual(family.blocks, [{ id: blockId, elementKeys: [] }]);
  assert.ok(!Object.hasOwn(db.prepare('SELECT * FROM InitDoc WHERE id = ?').get('d1'), '__workbench'));
});

test('annotated text create imports declared measurements with generated identities and rejects invalid imports atomically', async () => {
  const { app, db } = await appFor();
  const source = { version: 1, blocks: [
    { text: 'hello', measurements: [{ family: 'source', payload: { text: 'hello', offset: 0 } }] },
    { text: 'world' },
  ] };
  const created = await app.dispatch({ actionId: 'measurement-create', type: 'InitDoc.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'measured', project: 'p1', owner: 'u1', body: source } });
  assert.equal(created.ok, true, created.failure?.message);
  const rows = db.prepare('SELECT id, family, format_version, payload FROM InitDoc_body_measurement WHERE block_id IN (SELECT id FROM InitDoc_body_block WHERE document_id = ?)').all('measured');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].family, 'source');
  assert.equal(rows[0].format_version, 1);
  assert.deepEqual(JSON.parse(rows[0].payload), { text: 'hello', offset: 0 });
  assert.notEqual(rows[0].id, '');
  const rejected = await app.dispatch({ actionId: 'measurement-invalid', type: 'InitDoc.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'bad-measured', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'x', measurements: [{ family: 'source', payload: {} }, { family: 'source', payload: {} }] }] } } });
  assert.equal(rejected.ok, false);
  assert.equal(db.prepare('SELECT 1 FROM InitDoc WHERE id = ?').get('bad-measured'), undefined);
  await app.close?.();
});

test('typed source import rejects invalid UTF-16 measurement offsets, reversed ranges, and ordering before any write', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1')");
  const RangeDoc = entity('RangeInitDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('note')], measurements: [measurement('ranges', { extension: 'sourceRangeInit' })] }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(RangeDoc, db);
  const app = workbench({ db, entities: [RangeDoc] });
  await app.start();
  const valid = annotatedTextCreateAction(RangeDoc, RangeDoc.body, {
    id: 'valid', projectId: 'p1', ownerId: 'u1',
    source: { blocks: [{ text: 'A😀B', measurements: [{ family: 'ranges', payload: { ranges: [{ start: 1, end: 3 }] } }] }] },
  });
  assert.equal((await app.dispatch({ actionId: 'valid', principal: { id: 'u1' }, ...valid })).ok, true);
  const beforeEditPayload = db.prepare("SELECT payload FROM RangeInitDoc_body_measurement WHERE family = 'ranges'").get().payload;
  const row = db.prepare("SELECT * FROM RangeInitDoc WHERE id = 'valid'").get();
  const snapshot = await projectAnnotatedTextSnapshot({ db, entity: RangeDoc, row, principal: { id: 'u1' }, fieldName: 'body', descriptor: RangeDoc.fields.body });
  const blockId = snapshot.blocks[0].id;
  const edited = await app.dispatch({ actionId: 'human-edit', principal: { id: 'u1' }, ...annotatedTextAction(RangeDoc, RangeDoc.body, {
    kind: 'text.insert', id: 'valid', basis: snapshot.basis, mutationId: 'human-edit', at: { blockId, offset: 0 }, text: 'x',
  }) });
  assert.equal(edited.ok, true, edited.failure?.message);
  assert.equal(db.prepare("SELECT payload FROM RangeInitDoc_body_measurement WHERE family = 'ranges'").get().payload, beforeEditPayload, 'human text edits do not overwrite immutable source provenance');
  for (const [id, ranges] of [
    ['past-end', [{ start: 0, end: 5 }]],
    ['surrogate', [{ start: 2, end: 3 }]],
    ['reversed', [{ start: 3, end: 1 }]],
    ['unordered', [{ start: 3, end: 4 }, { start: 0, end: 1 }]],
  ]) {
    assert.throws(() => annotatedTextCreateAction(RangeDoc, RangeDoc.body, {
      id, projectId: 'p1', ownerId: 'u1', source: { blocks: [{ text: 'A😀B', measurements: [{ family: 'ranges', payload: { ranges } }] }] },
    }), /failed validation/);
    const raw = await app.dispatch({ actionId: id, type: 'RangeInitDoc.create', principal: { id: 'u1' }, payload: { id, project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'A😀B', measurements: [{ family: 'ranges', payload: { ranges } }] }] } } });
    assert.equal(raw.ok, false);
    assert.equal(db.prepare('SELECT 1 FROM RangeInitDoc WHERE id = ?').get(id), undefined);
  }
  await app.shutdown();
  db.close();
});

test('annotated text create imports a validated multi-block CRDT family atomically', async () => {
  const { app, db, InitDoc } = await appFor();
  const result = await app.dispatch({
    actionId: 'import', principal: { id: 'u1' },
    ...annotatedTextCreateAction(InitDoc, InitDoc.body, { id: 'imported', projectId: 'p1', ownerId: 'u1', source: { blocks: [
      { text: 'hello', fields: { reviewed: false }, measurements: [{ family: 'source', payload: { provider: 'local', originalToken: 'hello' } }] },
      { text: ' 🌍' },
    ] } }),
  });
  assert.equal(result.ok, true, result.failure?.message);
  const blocks = db.prepare("SELECT * FROM InitDoc_body_block WHERE document_id = 'imported' ORDER BY position").all();
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.reviewed), [0, 1]);
  const family = restoreTextFamilyCheckpoint(JSON.parse(db.prepare("SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = 'imported'").get().family_checkpoint));
  assert.deepEqual(family.blocks.map((block) => materializeBlock(family, block.id)), ['hello', ' 🌍']);
  const importedMeasurement = db.prepare("SELECT * FROM InitDoc_body_measurement WHERE family = 'source'").get();
  assert.ok(importedMeasurement);
  const retry = await app.dispatch({ actionId: 'import', principal: { id: 'u1' }, ...annotatedTextCreateAction(InitDoc, InitDoc.body, { id: 'imported', projectId: 'p1', ownerId: 'u1', source: { blocks: [{ text: 'different', measurements: [{ family: 'source', payload: { provider: 'changed' } }] }] } }) });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'import'").get().count, 1);
  assert.deepEqual(db.prepare("SELECT * FROM InitDoc_body_measurement WHERE family = 'source'").get(), importedMeasurement);
  await app.close?.();
});

test('source-imported blocks and measurements survive application and SQLite restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-source-import-'));
  const filename = join(directory, 'restart.sqlite');
  try {
    let db = new DatabaseSync(filename);
    let setup = await appFor(db);
    const created = await setup.app.dispatch({ actionId: 'restart-import', type: 'InitDoc.create', principal: { id: 'u1' }, payload: {
      id: 'restart', project: 'p1', owner: 'u1', body: { version: 1, blocks: [
        { text: 'first', measurements: [{ family: 'source', payload: { provider: 'local', originalToken: 'first' } }] },
        { text: 'second' },
      ] },
    } });
    assert.equal(created.ok, true, created.failure?.message);
    await setup.app.shutdown();
    db.close();

    db = new DatabaseSync(filename);
    const InitDoc = doc();
    setup = { app: workbench({ db, entities: [InitDoc] }), db };
    await setup.app.start();
    const row = db.prepare("SELECT * FROM InitDoc WHERE id = 'restart'").get();
    const snapshot = await projectAnnotatedTextSnapshot({ db, entity: InitDoc, row, principal: { id: 'u1' }, fieldName: 'body', descriptor: InitDoc.fields.body });
    assert.deepEqual(snapshot.blocks.filter((block) => block.kind === 'visible').map((block) => block.text), ['first', 'second']);
    assert.equal(snapshot.measurements.length, 1);
    await setup.app.shutdown();
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('annotated text import rejects malformed Unicode and empty multi-block topology', async () => {
  const { app } = await appFor();
  for (const [actionId, blocks, pattern] of [
    ['bad-unicode', [{ text: '\uD800' }], /unpaired high surrogate/],
    ['bad-single-empty', [{ text: '' }], /empty text block/],
    ['bad-empty', [{ text: 'one' }, { text: '' }], /empty text block/],
  ]) {
    const result = await app.dispatch({ actionId, type: 'InitDoc.create', principal: { id: 'u1' }, payload: { id: actionId, project: 'p1', owner: 'u1', body: { version: 1, blocks } } });
    assert.equal(result.ok, false);
    assert.match(result.failure?.message ?? '', pattern);
  }
  await app.close?.();
});

test('annotated text import persists more than 36 blocks in declared order', async () => {
  const { app, db } = await appFor();
  const blocks = Array.from({ length: 38 }, (_, index) => ({ text: String.fromCharCode(65 + index) }));
  const result = await app.dispatch({ actionId: 'many-blocks', type: 'InitDoc.create', principal: { id: 'u1' }, payload: { id: 'many', project: 'p1', owner: 'u1', body: { version: 1, blocks } } });
  assert.equal(result.ok, true, result.failure?.message);
  const rows = db.prepare("SELECT position FROM InitDoc_body_block WHERE document_id = 'many' ORDER BY position").all();
  assert.deepEqual(rows.map((row) => row.position), blocks.map((_, index) => index.toString(36).padStart(13, '0')));
  await app.close?.();
});

test('annotated text field and framework metadata are rejected from generic payloads', async () => {
  const { app, db } = await appFor();
  for (const [actionId, payload] of [
    ['body-value', { id: 'd1', project: 'p1', owner: 'u1', body: null }],
    ['reserved', { id: 'd2', project: 'p1', owner: 'u1', __workbench: {} }],
  ]) {
    const result = await app.dispatch({ actionId, type: 'InitDoc.create', payload, principal: { id: 'u1' } });
    assert.equal(result.ok, false);
  }
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create', payload: { id: 'd3', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(created.ok, true);
  const update = await app.dispatch({
    actionId: 'update', type: 'InitDoc.update', payload: { id: 'd3', body: {} }, principal: { id: 'u1' },
  });
  assert.equal(update.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_state').get().count, 1);
});

test('create retry retains its event-carried initial block identity without duplicate projection rows', async () => {
  const { app, db } = await appFor();
  const request = {
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  };
  const first = await app.dispatch(request);
  const retry = await app.dispatch(request);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(
    retry.events[0].data.__workbench.annotatedText.body.initialBlockId,
    first.events[0].data.__workbench.annotatedText.body.initialBlockId,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_state').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block').get().count, 1);
});

test('annotated-text operation commits one canonical family fact and rejects a stale structural revision', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const result = await app.dispatch({
    actionId: 'operation', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'InitDoc.body.operated');
  assert.equal(result.events[0].data.version, 1);
  assert.equal(result.events[0].data.id, 'd1');
  assert.equal(result.events[0].data.operation.kind, 'text.apply');
  assert.deepEqual(result.events[0].data.before, { structuralRevision: 1, frontier: [] });
  assert.deepEqual(result.events[0].data.after, { structuralRevision: 1, frontier: [[A, 1]] });
  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.checkpoint.elements[`${A}:1:0`].scalar, 'h');
  assert.deepEqual(result.events[0].data.family, JSON.parse(state.family_checkpoint));
  assert.equal(state.structure_version, 1);
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_block WHERE id = ?').get(blockId).structure_version, 1);
  const second = await app.dispatch({
    actionId: 'operation-two', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [[A, 1]] },
      operation: { kind: 'text.apply', blockId, operation: ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['root'], '!']] },
    },
  });
  assert.equal(second.ok, true);
  assert.deepEqual(second.events[0].data.before, { structuralRevision: 1, frontier: [[A, 1]] });
  assert.deepEqual(second.events[0].data.after, { structuralRevision: 1, frontier: [[A, 2]] });
  const retry = await app.dispatch({
    actionId: 'operation', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt WHERE actionId = ?').get('operation').count, 1);
  const stale = await app.dispatch({
    actionId: 'stale', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 2, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('stale').count, 0);
  await app.close?.();
});

test('annotated-text operation rejects malformed and causally unready commands without a composite event', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  for (const [actionId, payload] of [
    ['malformed', { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO }, extra: true }],
    ['unready', { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: ['workbench.text', 1, [A, 2], 2, [[A, 1]], ['insert', ['root'], 'x']] } }],
  ]) {
    const result = await app.dispatch({ actionId, type: 'InitDoc.body.operation', scope: 'Project:p1', payload, principal: { id: 'u1' } });
    assert.equal(result.ok, false);
    assert.equal(result.failure.category, 'invalid-input');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get(actionId).count, 0);
  }
  await app.close?.();
});

test('annotated-text operation is rejected from generic batches before aggregate reduction', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const result = await app.batch([{
    type: 'InitDoc.body.operation',
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  }], { principal: { id: 'u1' } });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 0);
  await app.close?.();
});

test('annotated-text projection rejects a canonical family fact that does not match its text operation', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const current = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  const substituted = textFamilyCheckpoint(applyTextOperationToBlock(current, blockId,
    ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'bye']],
  ));
  const handle = native('InitDoc', 'body', 'operated');
  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 1,
      id: 'd1',
      before: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
      after: { structuralRevision: 1, frontier: [[A, 1]] },
      family: substituted,
    },
  }, db), /does not match its text operation/);
  const persisted = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  assert.deepEqual(persisted, current);
  await app.close?.();
});

test('annotated-text operation derives its project scope for receipt ownership', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const result = await app.dispatch({
    actionId: 'wrong-scope', type: 'InitDoc.body.operation', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get('Project:p1', 'wrong-scope').count, 1);
  await app.close?.();
});

test('annotated-text operation derives scope before returning a colliding receipt', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const unrelated = await app.dispatch({
    actionId: 'collides', type: 'InitDoc.create', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: { id: 'd2', project: 'p1', owner: 'u1' },
  });
  assert.equal(unrelated.ok, true);
  const result = await app.dispatch({
    actionId: 'collides', type: 'InitDoc.body.operation', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: {
      version: 1,
      id: 'd1',
      expected: { structuralRevision: 1, frontier: [] },
      operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log WHERE actionId = ?').get('collides').count, 1);
  await app.close?.();
});

test('in-memory batches reject explicitly single-dispatch actions before handler invocation', () => {
  const handler = () => {
    throw new Error('must not run');
  };
  Object.defineProperty(handler, 'batchForbidden', { value: true });
  const server = createServer({
    handlers: { 'aggregate.operation': handler },
    authorize: () => true,
  });
  const result = server.dispatchBatch({
    actionId: 'batch', principal: { id: 'u1' }, actions: [{ type: 'aggregate.operation', payload: {} }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(server.log.length, 0);
});

// ---- R2 block.split tests ----

test('R2 block.split emits one changed v2 event and projection produces two blocks', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(created.ok, true);
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const op2 = await app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
  assert.equal(op2.ok, true);

  const blockText = db.prepare(`SELECT * FROM InitDoc_body_block WHERE document_id = 'd1'`).all();
  assert.equal(blockText.length, 1);

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 2]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  assert.equal(split.ok, true);
  assert.equal(split.events.length, 1);
  assert.equal(split.events[0].data.version, 2);
  assert.equal(split.events[0].data.operation.kind, 'block.split');
  assert.equal(split.events[0].data.operation.leftBlockId, blockId);
  assert.ok(split.events[0].data.operation.rightBlockId);
  assert.notEqual(split.events[0].data.operation.rightBlockId, blockId);
  assert.equal(split.events[0].data.operation.utf16Offset, 5);
  assert.equal(split.events[0].data.before.structuralRevision, 1);
  assert.equal(split.events[0].data.after.structuralRevision, 2);
  assert.deepEqual(split.events[0].data.before.frontier, [[A, 2]]);
  assert.deepEqual(split.events[0].data.after.frontier, [[A, 2]]);

  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 2);
  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.blocks.length, 2);
  assert.equal(family.blocks[0].id, blockId);
  assert.equal(family.blocks[1].id, split.events[0].data.operation.rightBlockId);

  const blocks = db.prepare("SELECT * FROM InitDoc_body_block WHERE document_id = 'd1' ORDER BY position").all();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, blockId);
  assert.equal(blocks[0].structure_version, 2);
  assert.equal(blocks[1].id, split.events[0].data.operation.rightBlockId);
  assert.equal(blocks[1].structure_version, 2);
  assert.equal(blocks[0].epoch, 1);
  assert.equal(blocks[1].epoch, 1);
  assert.equal(blocks[0].reviewed, 1);
  assert.equal(blocks[1].reviewed, 1);
  assert.equal(materializeBlock(family, blockId), 'world');
  assert.equal(materializeBlock(family, split.events[0].data.operation.rightBlockId), 'hello');

  await app.close?.();
});

test('R2 block.split at offset 0 or text.length returns zero events', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const atStart = await app.dispatch({
    actionId: 'at-start', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 0 } },
  });
  assert.equal(atStart.ok, true);
  assert.equal(atStart.events.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'at-start'").get().count, 0);

  const atEnd = await app.dispatch({
    actionId: 'at-end', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  assert.equal(atEnd.ok, true);
  assert.equal(atEnd.events.length, 0);

  const blocks = db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = 'd1'").get().count;
  assert.equal(blocks, 1);

  await app.close?.();
});

test('R2 block.split zero-event retry is idempotent via existing receipt', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const first = await app.dispatch({
    actionId: 'zero-retry', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 0 } },
  });
  assert.equal(first.ok, true);
  assert.equal(first.events.length, 0);

  const retry = await app.dispatch({
    actionId: 'zero-retry', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 0 } },
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 1);

  await app.close?.();
});

test('R2 block.split rejects invalid payload and stale structural revision', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const invalid = await app.dispatch({
    actionId: 'invalid', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId: 'nonexistent', utf16Offset: 3 } },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.failure.category, 'invalid-input');

  const stale = await app.dispatch({
    actionId: 'stale', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 3 } },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.failure.category, 'invalid-input');

  const wrongScope = await app.dispatch({
    actionId: 'wrong-scope', type: 'InitDoc.body.operation', scope: 'InitDoc:other', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 3 } },
  });
  assert.equal(wrongScope.ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated'").get().count, 2);

  await app.close?.();
});

test('R2 block.split with membership expansion produces canonical rows', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const op2 = await app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
  assert.equal(op2.ok, true);

  const annId = 'ann1';
  const noteFamily = 'note';
  db.prepare(`INSERT INTO InitDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, 'd1', 'p1', 'u1', ?)`).run(annId, noteFamily);
  db.prepare(`INSERT INTO InitDoc_body_annotation_note (annotation_id) VALUES (?)`).run(annId);
  db.prepare(`INSERT INTO InitDoc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, 0, ?, ?)`)
    .run(annId, blockId, JSON.stringify({ point: ['point', ['root'], 'left'], basisFrontier: [] }), JSON.stringify({ point: ['point', ['element', [[A, 2], 1]], 'right'], basisFrontier: [[A, 2]] }));

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 2]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  const memberships = db.prepare(`SELECT * FROM InitDoc_body_membership WHERE annotation_id = ?`).all(annId);
  assert.equal(memberships.length, 2);
  const leftMembership = memberships.find(m => m.block_id === blockId);
  const rightMembership = memberships.find(m => m.block_id === rightBlockId);
  assert.ok(leftMembership);
  assert.ok(rightMembership);
  assert.equal(leftMembership.ordinal, 0);
  assert.equal(rightMembership.ordinal, 1);

  await app.close?.();
});

test('R2 block.split with measurement partition produces measurement facts', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const measId = 'meas1';
  const measPayload = JSON.stringify({ source: 'test', text: 'hello', offset: 0 });
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, 'source', 1, ?)`).run(measId, blockId, measPayload);

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  const measurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(blockId);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].id, measId);
  const leftPayload = JSON.parse(measurements[0].payload);
  assert.equal(leftPayload.text, 'he');

  const rightMeasurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(rightBlockId);
  assert.equal(rightMeasurements.length, 1);
  assert.notEqual(rightMeasurements[0].id, measId);
  const rightPayload = JSON.parse(rightMeasurements[0].payload);
  assert.equal(rightPayload.text, 'llo');

  await app.close?.();
});

test('R2 block.split with failing measurement adapter rolls back', async () => {
  registerAnnotatedTextContract('failingMeas', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('failingMeas', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition() {
      throw new Error('intentional partition failure');
    },
    combine: function combine() {},
  }));

  function failingDoc() {
    return entity('FailingDoc', {
      project: ref('Project'),
      owner: ref('User'),
      body: annotatedText({
        project: 'project',
        owner: 'owner',
        block: {},
        annotations: [annotation('note', { fields: {} })],
        measurements: [measurement('failing', { extension: 'failingMeas' })],
      }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const FailingDoc = failingDoc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(FailingDoc, db);
  const app = workbench({ db, entities: [FailingDoc] });
  app.start();
  await app.ready;

  const created = await app.dispatch({
    actionId: 'create', type: 'FailingDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'FailingDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  db.prepare(`INSERT INTO FailingDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'failing', 1, '{}')`).run(blockId);

  const split = await app.dispatch({
    actionId: 'split', type: 'FailingDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, false);
  assert.equal(split.failure.category, 'invalid-input');

  const state = db.prepare('SELECT structure_version FROM FailingDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);

  await app.close?.();
});

test('R2 block.split with non-deterministic measurement partition rolls back', async () => {
  let callCount = 0;
  registerAnnotatedTextContract('nonDetMeas', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('nonDetMeas', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition(input) {
      callCount++;
      const offset = input.utf16Offset;
      const blockText = input.blockText;
      if (callCount === 1) {
        return Object.freeze({ version: 1, leftPayload: { text: blockText.slice(0, offset) }, rightPayload: { text: blockText.slice(offset) } });
      }
      return Object.freeze({ version: 1, leftPayload: { text: blockText.slice(0, offset).toUpperCase() }, rightPayload: { text: blockText.slice(offset).toUpperCase() } });
    },
    combine: function combine() {},
  }));

  function nonDetDoc() {
    return entity('NonDetDoc', {
      project: ref('Project'),
      owner: ref('User'),
      body: annotatedText({
        project: 'project',
        owner: 'owner',
        block: {},
        annotations: [annotation('note', { fields: {} })],
        measurements: [measurement('nonDet', { extension: 'nonDetMeas' })],
      }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const NonDetDoc = nonDetDoc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(NonDetDoc, db);
  const app = workbench({ db, entities: [NonDetDoc] });
  app.start();
  await app.ready;

  const created = await app.dispatch({
    actionId: 'create', type: 'NonDetDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'NonDetDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  db.prepare(`INSERT INTO NonDetDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'nonDet', 1, '{}')`).run(blockId);

  const split = await app.dispatch({
    actionId: 'split', type: 'NonDetDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, false);

  const state = db.prepare('SELECT structure_version FROM NonDetDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);

  await app.close?.();
});

test('R2 v2 event with substituted memberships is rejected with no partial rows', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const op1 = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(op1.ok, true);

  const op2 = await app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
  assert.equal(op2.ok, true);

  const current = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  const newBlockId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const splitResult = splitBlock(current, blockId, newBlockId, 5);
  assert.equal(splitResult.type, 'split');

  const handle = native('InitDoc', 'body', 'operated');
  const badMemberships = [{ annotationId: 'fake', blockId, ordinal: 0, start: { point: ['point', ['root'], 'left'], basisFrontier: [] }, end: { point: ['point', ['element', [[A, 2], 1]], 'right'], basisFrontier: [[A, 2]] } }];

  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 2,
      id: 'd1',
      before: { structuralRevision: 1, frontier: [[A, 2]] },
      operation: { kind: 'block.split', leftBlockId: blockId, rightBlockId: newBlockId, utf16Offset: 5 },
      after: { structuralRevision: 2, frontier: [[A, 2]] },
      family: textFamilyCheckpoint(splitResult.family),
      blocks: [{ id: blockId, epoch: 1, fields: { reviewed: true } }, { id: newBlockId, epoch: 1, fields: { reviewed: true } }],
      memberships: badMemberships,
      measurements: [],
    },
  }, db), /do not match split membership projection/);

  const persisted = db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(persisted.structure_version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = 'd1'").get().count, 1);

  await app.close?.();
});

test('R2 projection rejects a fabricated right block epoch', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });

  const current = restoreTextFamilyCheckpoint(JSON.parse(
    db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint,
  ));
  const rightBlockId = 'cccccccccccccccccccccccccccccccc';
  const split = splitBlock(current, blockId, rightBlockId, 2);
  const handle = native('InitDoc', 'body', 'operated');
  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 2, id: 'd1',
      before: { structuralRevision: 1, frontier: [[A, 1]] },
      operation: { kind: 'block.split', leftBlockId: blockId, rightBlockId, utf16Offset: 2 },
      after: { structuralRevision: 2, frontier: [[A, 1]] },
      family: textFamilyCheckpoint(split.family),
      blocks: [{ id: blockId, epoch: 1, fields: { reviewed: true } }, { id: rightBlockId, epoch: 2, fields: { reviewed: true } }],
      memberships: [], measurements: [],
    },
  }, db), /epochs do not match source/);
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1').structure_version, 1);
  await app.close?.();
});

test('R1 text.apply still works after R2 code is present', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  const result = await app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].data.version, 1);

  const state = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 1);

  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(materializeBlock(family, blockId), 'hello');

  await app.close?.();
});

// ── R3 block.merge tests ──────────────────────────────────────────────────────

function r3AppFor(db = new DatabaseSync(':memory:')) {
  const InitDoc = doc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(InitDoc, db);
  const app = workbench({ db, entities: [InitDoc] });
  app.start();
  return { app, db, InitDoc };
}

function setupR3Doc(app) {
  return app.dispatch({
    actionId: 'create', type: 'InitDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
}

function setupR3Split(app, blockId) {
  return app.dispatch({
    actionId: 'op1', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });
}

function setupR3Split2(app, blockId) {
  return app.dispatch({
    actionId: 'op2', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'text.apply', blockId, operation: INSERT_WORLD } },
  });
}

async function setupR3Mergable(app, db) {
  const created = await setupR3Doc(app);
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  await setupR3Split(app, blockId);
  await setupR3Split2(app, blockId);
  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 2]] }, operation: { kind: 'block.split', blockId, utf16Offset: 5 } },
  });
  const rightBlockId = split.events[0].data.operation.rightBlockId;
  return { blockId, rightBlockId, created, split };
}

test('R3 successful block.merge produces one v3 event, left identity survives, right removed, text restored, revision 3, frontier unchanged', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const merge = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, true);
  assert.equal(merge.events.length, 1);
  assert.equal(merge.events[0].type, 'InitDoc.body.operated');
  assert.equal(merge.events[0].data.version, 3);
  assert.equal(merge.events[0].data.operation.kind, 'block.merge');
  assert.equal(merge.events[0].data.operation.leftBlockId, blockId);
  assert.equal(merge.events[0].data.operation.rightBlockId, rightBlockId);

  const state = db.prepare('SELECT structure_version, family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 3);

  const family = restoreTextFamilyCheckpoint(JSON.parse(state.family_checkpoint));
  assert.equal(family.blocks.length, 1);
  assert.equal(family.blocks[0].id, blockId);
  assert.equal(materializeBlock(family, blockId), 'worldhello');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count, 1);
  const leftBlock = db.prepare('SELECT * FROM InitDoc_body_block WHERE id = ?').get(blockId);
  assert.ok(leftBlock);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE id = ?').get(rightBlockId).count, 0);

  assert.deepEqual(merge.events[0].data.before, { structuralRevision: 2, frontier: [[A, 2]] });
  assert.deepEqual(merge.events[0].data.after, { structuralRevision: 3, frontier: [[A, 2]] });

  await app.close?.();
});

test('R3 merge receipt retry dedupes without duplicate rows', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const payload = { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } };
  const first = await app.dispatch({ actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' }, payload });
  assert.equal(first.ok, true);
  const retry = await app.dispatch({ actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' }, payload });
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE eventType = 'InitDoc.body.operated' AND actionId = 'merge'").get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block').get().count, 1);
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1').structure_version, 3);

  await app.close?.();
});

test('R3 merge rejects stale structural revision', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const result = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1').structure_version, 2);

  await app.close?.();
});

test('R3 merge rejects non-adjacent blocks', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);
  const otherBlockId = 'dddddddddddddddddddddddddddddddd';

  const result = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: otherBlockId, rightBlockId } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1').structure_version, 2);

  await app.close?.();
});

test('R3 merge rejects mismatched block memberships', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const annId = 'ann1';
  db.prepare(`INSERT INTO InitDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, 'd1', 'p1', 'u1', 'note')`).run(annId);
  db.prepare(`INSERT INTO InitDoc_body_membership (annotation_id, block_id, ordinal, start_point, end_point) VALUES (?, ?, 0, ?, ?)`)
    .run(annId, blockId, JSON.stringify({ point: ['point', ['root'], 'left'], basisFrontier: [] }), JSON.stringify({ point: ['point', ['element', [[A, 2], 1]], 'right'], basisFrontier: [[A, 2]] }));

  const result = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1').structure_version, 2);

  await app.close?.();
});

test('R3 merge with both-present measurements retains correct ID and rehomes safely', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const created = await setupR3Doc(app);
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  await setupR3Split(app, blockId);

  const measId = 'meas1';
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, 'source', 1, ?)`).run(measId, blockId, JSON.stringify({ source: 'test', text: 'hello', offset: 0 }));

  const split = await app.dispatch({
    actionId: 'split', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  const merge = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 1]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, true);

  const measurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(blockId);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].id, measId);
  const payload = JSON.parse(measurements[0].payload);
  assert.equal(payload.text, 'hello');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM InitDoc_body_measurement WHERE block_id = ?`).get(rightBlockId).count, 0);

  await app.close?.();
});

test('R3 merge with left-only measurement retains correct ID and rehomes safely', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const measId = 'meas1';
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, 'source', 1, ?)`).run(measId, blockId, JSON.stringify({ source: 'test', text: 'helloworld', offset: 0 }));

  const merge = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, true);

  const measurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(blockId);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].id, measId);
  assert.equal(JSON.parse(measurements[0].payload).text, 'helloworld');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM InitDoc_body_measurement WHERE id = ?`).get(rightBlockId).count, 0);

  await app.close?.();
});

test('R3 merge with right-only measurement retains correct ID and rehomes safely', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const measId = 'meas1';
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES (?, ?, 'source', 1, ?)`).run(measId, rightBlockId, JSON.stringify({ source: 'test', text: 'helloworld', offset: 0 }));

  const merge = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, true);

  const measurements = db.prepare(`SELECT * FROM InitDoc_body_measurement WHERE block_id = ?`).all(blockId);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].id, measId);
  assert.equal(JSON.parse(measurements[0].payload).text, 'helloworld');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM InitDoc_body_measurement WHERE id = ?`).get(rightBlockId).count, 0);

  await app.close?.();
});

test('R3 merge combine invoked exactly twice with frozen non-identical input/payload snapshots', async () => {
  const combineCalls = [];
  registerAnnotatedTextContract('combineCheck', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('combineCheck', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition(input) {
      return Object.freeze({ version: 1, leftPayload: { text: input.blockText.slice(0, input.utf16Offset), offset: input.utf16Offset }, rightPayload: { text: input.blockText.slice(input.utf16Offset), offset: input.utf16Offset } });
    },
    combine: function combine(input) {
      combineCalls.push({ input, frozen: Object.isFrozen(input) && Object.isFrozen(input.left?.payload) && Object.isFrozen(input.right?.payload) });
      if (input.left !== null && input.right !== null) {
        return Object.freeze({ version: 1, payload: Object.freeze({ text: input.left.payload.text + input.right.payload.text }) });
      }
      if (input.left !== null) return Object.freeze({ version: 1, payload: input.left.payload });
      if (input.right !== null) return Object.freeze({ version: 1, payload: input.right.payload });
      return Object.freeze({ version: 1, payload: null });
    },
  }));

  function ccDoc() {
    return entity('CcDoc', {
      project: ref('Project'), owner: ref('User'),
      body: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('note', { fields: {} })], measurements: [measurement('cc', { extension: 'combineCheck' })] }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const CcDoc = ccDoc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(CcDoc, db);
  const app = workbench({ db, entities: [CcDoc] });
  app.start();
  await app.ready;

  const created = await app.dispatch({
    actionId: 'create', type: 'CcDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  await app.dispatch({
    actionId: 'op1', type: 'CcDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });

  db.prepare(`INSERT INTO CcDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'cc', 1, '{}')`).run(blockId);

  const split = await app.dispatch({
    actionId: 'split', type: 'CcDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  combineCalls.length = 0;
  const merge = await app.dispatch({
    actionId: 'merge', type: 'CcDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 1]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, true);
  assert.equal(combineCalls.length, 2);
  assert.equal(combineCalls[0].frozen, true);
  assert.equal(combineCalls[1].frozen, true);
  assert.notEqual(combineCalls[0].input, combineCalls[1].input);
  assert.notEqual(combineCalls[0].input.left, combineCalls[1].input.left);
  assert.notEqual(combineCalls[0].input.right, combineCalls[1].input.right);
  assert.notEqual(combineCalls[0].input.left.payload, combineCalls[1].input.left.payload);
  assert.notEqual(combineCalls[0].input.right.payload, combineCalls[1].input.right.payload);
  assert.deepEqual(combineCalls[0].input, combineCalls[1].input);

  await app.close?.();
});

test('R3 merge nondeterministic combine rolls back', async () => {
  let callCount = 0;
  registerAnnotatedTextContract('nonDetMergMeas', Object.freeze({ kind: 'measurement' }));
  registerAnnotatedTextStructuralExtension('nonDetMergMeas', Object.freeze({
    version: 1,
    validate: function validate() {},
    edit: function edit() {},
    partition: function partition(input) {
      return Object.freeze({ version: 1, leftPayload: { text: input.blockText.slice(0, input.utf16Offset) }, rightPayload: { text: input.blockText.slice(input.utf16Offset) } });
    },
    combine: function combine(input) {
      callCount++;
      if (callCount === 1) return Object.freeze({ version: 1, payload: { text: 'hello' } });
      return Object.freeze({ version: 1, payload: { text: 'WORLD' } });
    },
  }));

  function ndDoc() {
    return entity('NdDoc', {
      project: ref('Project'), owner: ref('User'),
      body: annotatedText({ project: 'project', owner: 'owner', block: {}, annotations: [annotation('note', { fields: {} })], measurements: [measurement('nd', { extension: 'nonDetMergMeas' })] }),
      grant: [scope(() => everyone()).can(() => grant(read, write))],
    });
  }

  const db = new DatabaseSync(':memory:');
  const NdDoc = ndDoc();
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY)');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO Project (id) VALUES ('p1')");
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(NdDoc, db);
  const app = workbench({ db, entities: [NdDoc] });
  app.start();
  await app.ready;

  const created = await app.dispatch({
    actionId: 'create', type: 'NdDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;

  await app.dispatch({
    actionId: 'op1', type: 'NdDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation: INSERT_HELLO } },
  });

  db.prepare(`INSERT INTO NdDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'nd', 1, '{}')`).run(blockId);

  const split = await app.dispatch({
    actionId: 'split', type: 'NdDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 2, id: 'd1', expected: { structuralRevision: 1, frontier: [[A, 1]] }, operation: { kind: 'block.split', blockId, utf16Offset: 2 } },
  });
  assert.equal(split.ok, true);
  const rightBlockId = split.events[0].data.operation.rightBlockId;

  callCount = 0;
  const merge = await app.dispatch({
    actionId: 'merge', type: 'NdDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 1]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, false);
  assert.equal(merge.failure.category, 'invalid-input');
  assert.equal(db.prepare('SELECT structure_version FROM NdDoc_body_state WHERE document_id = ?').get('d1').structure_version, 2);

  await app.close?.();
});

test('R3 projection valid event applies even if combine is changed to throw after event admission', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const merge = await app.dispatch({
    actionId: 'merge', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 3, id: 'd1', expected: { structuralRevision: 2, frontier: [[A, 2]] }, operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId } },
  });
  assert.equal(merge.ok, true);

  const state = db.prepare('SELECT structure_version FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(state.structure_version, 3);
  const family = restoreTextFamilyCheckpoint(JSON.parse(db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint));
  assert.equal(materializeBlock(family, blockId), 'worldhello');

  await app.close?.();
});

test('R3 tampered event rejects with unchanged state and rows', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const originalState = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1')));
  const originalBlockCount = db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count;

  const handle = native('InitDoc', 'body', 'operated');
  const currentFamily = restoreTextFamilyCheckpoint(JSON.parse(originalState.family_checkpoint));
  const reduced = mergeBlocks(currentFamily, blockId, rightBlockId);
  const tamperedFamily = { ...reduced, checkpoint: { ...reduced.checkpoint, frontier: [['bogus', 1]] } };

  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 3,
      id: 'd1',
      before: { structuralRevision: 2, frontier: [[A, 2]] },
      operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId },
      after: { structuralRevision: 3, frontier: [[A, 2]] },
      family: textFamilyCheckpoint(tamperedFamily),
      block: { id: blockId, epoch: 1, cells: { reviewed: true } },
      memberships: [],
      measurements: [],
    },
  }, db));

  const afterState = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(afterState.structure_version, originalState.structure_version);
  assert.equal(afterState.family_checkpoint, originalState.family_checkpoint);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count, originalBlockCount);

  await app.close?.();
});

test('R3 projection rejects tampered stored right block cells with unchanged state', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);

  const originalState = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1')));
  const originalBlockCount = db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count;

  db.prepare(`UPDATE InitDoc_body_block SET reviewed = 0 WHERE id = ?`).run(rightBlockId);

  const handle = native('InitDoc', 'body', 'operated');
  const currentFamily = restoreTextFamilyCheckpoint(JSON.parse(originalState.family_checkpoint));
  const reduced = mergeBlocks(currentFamily, blockId, rightBlockId);

  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle,
    data: {
      version: 3,
      id: 'd1',
      before: { structuralRevision: 2, frontier: [[A, 2]] },
      operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId },
      after: { structuralRevision: 3, frontier: [[A, 2]] },
      family: textFamilyCheckpoint(reduced),
      block: { id: blockId, epoch: 1, cells: { reviewed: true } },
      memberships: [],
      measurements: [],
    },
  }, db), /right block cells must equal left block cells/);

  const afterState = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(afterState.structure_version, originalState.structure_version);
  assert.equal(afterState.family_checkpoint, originalState.family_checkpoint);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM InitDoc_body_block WHERE document_id = ?').get('d1').count, originalBlockCount);

  await app.close?.();
});

test('R3 projection rejects an event that omits a present measurement family', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('m1', ?, 'source', 1, ?)`)
    .run(blockId, JSON.stringify({ source: 'test', text: 'world', offset: 0 }));

  const originalState = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1')));
  const originalMeasurements = db.prepare('SELECT * FROM InitDoc_body_measurement ORDER BY id').all();
  const currentFamily = restoreTextFamilyCheckpoint(JSON.parse(originalState.family_checkpoint));
  const reduced = mergeBlocks(currentFamily, blockId, rightBlockId);

  assert.throws(() => app.entities.get('InitDoc').projection.apply({
    handle: native('InitDoc', 'body', 'operated'),
    data: {
      version: 3,
      id: 'd1',
      before: { structuralRevision: 2, frontier: [[A, 2]] },
      operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId },
      after: { structuralRevision: 3, frontier: [[A, 2]] },
      family: textFamilyCheckpoint(reduced),
      block: { id: blockId, epoch: 1, cells: { reviewed: true } },
      memberships: [],
      measurements: [],
    },
  }, db), /measurement family count does not match source rows/);

  const afterState = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
  assert.equal(afterState.structure_version, originalState.structure_version);
  assert.equal(afterState.family_checkpoint, originalState.family_checkpoint);
  assert.deepEqual(db.prepare('SELECT * FROM InitDoc_body_measurement ORDER BY id').all(), originalMeasurements);

  await app.close?.();
});

test('R3 projection rejects per-side source omission when both sides have rows', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);
  const sourcePayload = { source: 'test', text: 'hello', offset: 0 };
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('left-source', ?, 'source', 1, ?)`)
    .run(blockId, JSON.stringify(sourcePayload));
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('right-source', ?, 'source', 1, ?)`)
    .run(rightBlockId, JSON.stringify(sourcePayload));

  const originalState = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1')));
  const originalBlocks = db.prepare('SELECT * FROM InitDoc_body_block ORDER BY id').all();
  const originalMeasurements = db.prepare('SELECT * FROM InitDoc_body_measurement ORDER BY id').all();
  const reduced = mergeBlocks(restoreTextFamilyCheckpoint(JSON.parse(originalState.family_checkpoint)), blockId, rightBlockId);
  const base = () => ({
    version: 3, id: 'd1',
    before: { structuralRevision: 2, frontier: [[A, 2]] },
    operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId },
    after: { structuralRevision: 3, frontier: [[A, 2]] },
    family: textFamilyCheckpoint(reduced),
    block: { id: blockId, epoch: 1, cells: { reviewed: true } },
    memberships: [],
    measurements: [{
      family: 'source', formatVersion: 1,
      leftSource: { id: 'left-source', blockId, payload: sourcePayload },
      rightSource: { id: 'right-source', blockId: rightBlockId, payload: sourcePayload },
      result: { id: 'left-source', blockId, payload: { text: 'worldhello' } },
      removedId: 'right-source',
    }],
  });
  const invalidEvents = [
    (data) => { data.measurements[0].leftSource = null; },
    (data) => { data.measurements[0].rightSource = null; },
  ];

  for (const mutate of invalidEvents) {
    const data = base();
    mutate(data);
    assert.throws(() => app.entities.get('InitDoc').projection.apply({
      handle: native('InitDoc', 'body', 'operated'), data,
    }, db));
    const afterState = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
    assert.equal(afterState.structure_version, originalState.structure_version);
    assert.equal(afterState.family_checkpoint, originalState.family_checkpoint);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_block ORDER BY id').all()), JSON.stringify(originalBlocks));
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_measurement ORDER BY id').all()), JSON.stringify(originalMeasurements));
  }

  await app.close?.();
});

test('R3 projection rejects invalid right-only measurement lineage and result payloads', async () => {
  const { app, db } = r3AppFor();
  await app.ready;
  const { blockId, rightBlockId } = await setupR3Mergable(app, db);
  const sourcePayload = { source: 'test', text: 'hello', offset: 0 };
  db.prepare(`INSERT INTO InitDoc_body_measurement (id, block_id, family, format_version, payload) VALUES ('right-source', ?, 'source', 1, ?)`)
    .run(rightBlockId, JSON.stringify(sourcePayload));

  const originalState = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1')));
  const originalBlocks = db.prepare('SELECT * FROM InitDoc_body_block ORDER BY id').all();
  const originalMeasurements = db.prepare('SELECT * FROM InitDoc_body_measurement ORDER BY id').all();
  const reduced = mergeBlocks(restoreTextFamilyCheckpoint(JSON.parse(originalState.family_checkpoint)), blockId, rightBlockId);
  const base = () => ({
    version: 3, id: 'd1',
    before: { structuralRevision: 2, frontier: [[A, 2]] },
    operation: { kind: 'block.merge', leftBlockId: blockId, rightBlockId },
    after: { structuralRevision: 3, frontier: [[A, 2]] },
    family: textFamilyCheckpoint(reduced),
    block: { id: blockId, epoch: 1, cells: { reviewed: true } },
    memberships: [],
    measurements: [{
      family: 'source', formatVersion: 1,
      leftSource: null,
      rightSource: { id: 'right-source', blockId: rightBlockId, payload: sourcePayload },
      result: { id: 'right-source', blockId, payload: { text: 'worldhello' } },
      removedId: null,
    }],
  });
  const invalidEvents = [
    (data) => { data.measurements[0].result.id = 'substituted'; },
    (data) => { data.measurements[0].rightSource.id = 'left-source'; },
    (data) => { data.measurements[0].removedId = 'right-source'; },
    (data) => { data.measurements[0].result.blockId = rightBlockId; },
    (data) => { data.measurements[0].result.blockId = 'some-arbitrary-id'; },
    (data) => { data.measurements[0].result.payload = undefined; },
    (data) => { data.measurements[0].result.payload = { value: NaN }; },
    (data) => { data.measurements[0].result.payload = { value: Infinity }; },
  ];

  for (const mutate of invalidEvents) {
    const data = base();
    mutate(data);
    assert.throws(() => app.entities.get('InitDoc').projection.apply({
      handle: native('InitDoc', 'body', 'operated'), data,
    }, db));
    const afterState = db.prepare('SELECT * FROM InitDoc_body_state WHERE document_id = ?').get('d1');
    assert.equal(afterState.structure_version, originalState.structure_version);
    assert.equal(afterState.family_checkpoint, originalState.family_checkpoint);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_block ORDER BY id').all()), JSON.stringify(originalBlocks));
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM InitDoc_body_measurement ORDER BY id').all()), JSON.stringify(originalMeasurements));
  }

  await app.close?.();
});

test('public offset authoring converges same-basis inserts and deletes in either arrival order', async () => {
  async function apply(order, importedText, edits) {
    const { app, db } = await appFor();
    const created = await app.dispatch({ actionId: `create-${order[0]}-${importedText}`, type: 'InitDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', ...(importedText === '' ? {} : { body: { version: 1, blocks: [{ text: importedText }] } }) }, principal: { id: 'u1' } });
    const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
    const basis = db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint;
    for (const name of Object.keys(edits)) db.prepare('INSERT INTO InitDoc_body_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, 1, ?, ?)').run(`basis-${name}`, 'd1', `${name}-user`, basis, JSON.stringify([blockId]));
    for (const name of order) {
      const edit = edits[name];
      const command = edit.kind === 'text.insert'
        ? { ...edit, at: { ...edit.at, blockId }, id: 'd1', basis: `basis-${name}`, mutationId: name }
        : { ...edit, from: { ...edit.from, blockId }, to: { ...edit.to, blockId }, id: 'd1', basis: `basis-${name}`, mutationId: name };
      const authored = annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, command);
      const result = await app.dispatch({ actionId: `${importedText}-${name}`, principal: { id: `${name}-user` }, ...authored, scope: 'Project:p1' });
      assert.equal(result.ok, true, result.failure?.message);
    }
    const family = restoreTextFamilyCheckpoint(JSON.parse(db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint));
    const value = materializeBlock(family, blockId);
    await app.close?.();
    return value;
  }
  const inserts = {
    left: { kind: 'text.insert', at: { offset: 0 }, text: 'A' },
    right: { kind: 'text.insert', at: { offset: 0 }, text: 'B' },
  };
  const deletes = {
    left: { kind: 'text.delete', from: { offset: 0 }, to: { offset: 1 } },
    right: { kind: 'text.delete', from: { offset: 2 }, to: { offset: 3 } },
  };
  assert.deepEqual(await apply(['left', 'right'], '', inserts), await apply(['right', 'left'], '', inserts));
  assert.deepEqual(await apply(['left', 'right'], 'ABC', deletes), await apply(['right', 'left'], 'ABC', deletes));
});

test('public structural grammar resolves a basis position across concurrent text and supports split, merge, apply, and detach', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({ actionId: 'structural-create', type: 'InitDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'abcd' }] } }, principal: { id: 'u1' } });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const before = db.prepare("SELECT structure_version, family_checkpoint FROM InitDoc_body_state WHERE document_id = 'd1'").get();
  db.prepare('INSERT INTO InitDoc_body_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, ?, ?, ?)')
    .run('structural-basis', 'd1', 'u1', before.structure_version, before.family_checkpoint, JSON.stringify([blockId]));
  db.prepare('INSERT INTO InitDoc_body_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, ?, ?, ?)')
    .run('concurrent-basis', 'd1', 'u2', before.structure_version, before.family_checkpoint, JSON.stringify([blockId]));
  assert.equal((await app.dispatch({ actionId: 'concurrent-text', principal: { id: 'u2' }, ...annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, { kind: 'text.insert', id: 'd1', basis: 'concurrent-basis', mutationId: 'concurrent', at: { blockId, offset: 2 }, text: 'X' }), scope: 'Project:p1' })).ok, true);
  const split = await app.dispatch({ actionId: 'basis-split', principal: { id: 'u1' }, ...annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, { kind: 'block.split', id: 'd1', basis: 'structural-basis', mutationId: 'split', at: { blockId, offset: 2 } }), scope: 'Project:p1' });
  assert.equal(split.ok, true, split.failure?.message);
  const rightBlockId = split.events[0].data.operation.rightBlockId;
  let family = restoreTextFamilyCheckpoint(JSON.parse(db.prepare("SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = 'd1'").get().family_checkpoint));
  assert.equal(family.blocks.map((block) => materializeBlock(family, block.id)).join(''), 'abXcd');

  const mintBasis = (token) => {
    const state = db.prepare("SELECT structure_version, family_checkpoint FROM InitDoc_body_state WHERE document_id = 'd1'").get();
    db.prepare('INSERT INTO InitDoc_body_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(document_id, principal_id) DO UPDATE SET token=excluded.token, structural_revision=excluded.structural_revision, family_checkpoint=excluded.family_checkpoint, visible_blocks=excluded.visible_blocks')
      .run(token, 'd1', 'u1', state.structure_version, state.family_checkpoint, JSON.stringify([blockId, rightBlockId]));
  };
  mintBasis('apply-basis');
  assert.equal((await app.dispatch({ actionId: 'basis-apply', principal: { id: 'u1' }, ...annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, { kind: 'annotation.apply', id: 'd1', basis: 'apply-basis', mutationId: 'apply', annotation: { id: 'note-1', family: 'note', fields: {} }, from: { blockId, offset: 0 }, to: { blockId, offset: 2 } }), scope: 'Project:p1' })).ok, true);
  mintBasis('detach-basis');
  assert.equal((await app.dispatch({ actionId: 'basis-detach', principal: { id: 'u1' }, ...annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, { kind: 'annotation.detach', id: 'd1', basis: 'detach-basis', mutationId: 'detach', annotationId: 'note-1', blockId }), scope: 'Project:p1' })).ok, true);
  mintBasis('merge-basis');
  assert.equal((await app.dispatch({ actionId: 'basis-merge', principal: { id: 'u1' }, ...annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, { kind: 'block.merge', id: 'd1', basis: 'merge-basis', mutationId: 'merge', leftBlockId: blockId, rightBlockId }), scope: 'Project:p1' })).ok, true);
  family = restoreTextFamilyCheckpoint(JSON.parse(db.prepare("SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = 'd1'").get().family_checkpoint));
  assert.equal(family.blocks.length, 1);
  assert.equal(materializeBlock(family, blockId), 'abXcd');
  await app.close?.();
});

test('public offset authoring rejects invalid UTF-16 boundaries from its basis', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({ actionId: 'unicode-create', type: 'InitDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'a😀b' }] } }, principal: { id: 'u1' } });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const basis = db.prepare('SELECT family_checkpoint FROM InitDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint;
  db.prepare('INSERT INTO InitDoc_body_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, 1, ?, ?)').run('unicode-basis', 'd1', 'u1', basis, JSON.stringify([blockId]));
  const authored = annotatedTextAction(app.entities.get('InitDoc'), app.entities.get('InitDoc').body, { kind: 'text.insert', id: 'd1', basis: 'unicode-basis', mutationId: 'bad-offset', at: { blockId, offset: 2 }, text: 'x' });
  const result = await app.dispatch({ actionId: 'unicode-edit', principal: { id: 'u1' }, ...authored, scope: 'Project:p1' });
  assert.equal(result.ok, false);
  assert.match(result.failure?.message ?? '', /splits a surrogate pair/);
  await app.close?.();
});

test('public offset authoring enforces annotated-text field write policy', async () => {
  const db = new DatabaseSync(':memory:');
  const LockedDoc = entity('LockedDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')], measurements: [measurement('source', { extension: 'sourceInit' })] }).can(() => grant(read)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db); db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY);'); db.exec("INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1');"); executeDDL(LockedDoc, db);
  const app = workbench({ db, entities: [LockedDoc] }); app.start(); await app.ready;
  const created = await app.dispatch({ actionId: 'locked-create', type: 'LockedDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' } });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const basis = db.prepare('SELECT family_checkpoint FROM LockedDoc_body_state WHERE document_id = ?').get('d1').family_checkpoint;
  db.prepare('INSERT INTO LockedDoc_body_basis (token, document_id, principal_id, structural_revision, family_checkpoint, visible_blocks) VALUES (?, ?, ?, 1, ?, ?)').run('locked-basis', 'd1', 'u1', basis, JSON.stringify([blockId]));
  const authored = annotatedTextAction(LockedDoc, LockedDoc.body, { kind: 'text.insert', id: 'd1', basis: 'locked-basis', mutationId: 'locked-edit', at: { blockId, offset: 0 }, text: 'x' });
  const denied = await app.dispatch({ actionId: 'locked-edit', principal: { id: 'u1' }, ...authored, scope: 'Project:p1' });
  assert.equal(denied.ok, false);
  assert.equal(denied.failure?.category, 'denied');
  await app.close?.();
});

test('R1 rejects a future basis frontier and receipt replay stays idempotent', async () => {
  const { app, db } = await appFor();
  const created = await app.dispatch({ actionId: 'basis-create', type: 'InitDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' } });
  const blockId = created.events[0].data.__workbench.annotatedText.body.initialBlockId;
  const operation = ['workbench.text', 1, [A, 1], 1, [], ['insert', ['root'], 'A']];
  const request = { actionId: 'basis-insert', type: 'InitDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' }, payload: { version: 1, id: 'd1', expected: { structuralRevision: 1, frontier: [] }, operation: { kind: 'text.apply', blockId, operation } } };
  assert.equal((await app.dispatch(request)).ok, true);
  const replay = await app.dispatch(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.deduped, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _Log WHERE actionId = 'basis-insert'").get().count, 1);
  const future = await app.dispatch({ ...request, actionId: 'basis-future', payload: { ...request.payload, expected: { structuralRevision: 1, frontier: [['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1]] }, operation: { ...request.payload.operation, operation: ['workbench.text', 1, ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 2], 2, [['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1]], ['insert', ['root'], 'B']] } } });
  assert.equal(future.ok, false);
  assert.match(future.failure?.message ?? '', /not dominated/);
  await app.close?.();
});
