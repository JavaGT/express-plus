import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL, grant,
  read, ref, scope, write, wordEvidenceFamily,
} from '../src/internal.mjs';
import { annotatedTextCreateAction } from '../src/annotated-text-public.mjs';
import { annotatedTextDDL } from '../src/annotated-text-field.mjs';
import { assertWordEvidencePayload, readWordEvidence, wordEvidenceFieldHandle } from '../src/word-evidence.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const timingFamily = wordEvidenceFamily('timing', {
  formatVersion: 1,
  parse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('timing payload must be an object');
    const { mediaStartMs, mediaEndMs } = value;
    if (!Number.isFinite(mediaStartMs) || !Number.isFinite(mediaEndMs) || mediaEndMs < mediaStartMs) {
      throw new Error('timing payload requires finite mediaStartMs <= mediaEndMs');
    }
    return { mediaStartMs, mediaEndMs };
  },
});

const uncertaintyFamily = wordEvidenceFamily('uncertainty', {
  formatVersion: 1,
  parse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('uncertainty payload must be an object');
    const { confidence } = value;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('uncertainty payload requires confidence in [0,1]');
    return { confidence };
  },
});

function doc() {
  return entity('WoeDoc', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
      wordEvidence: [timingFamily, uncertaintyFamily],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function appFor(t) {
  const db = new DatabaseSync(':memory:');
  const Document = doc();
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE Project (id TEXT PRIMARY KEY); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES ('p1'); INSERT INTO User VALUES ('u1'); INSERT INTO User VALUES ('u2')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Document] });
  app.start();
  await app.ready;
  t.after(() => { app.close?.(); db.close(); });
  return { app, db, Document };
}

function wordEvidence(overrides = {}) {
  return {
    version: 1,
    ids: ['w1', 'w2'],
    startsUtf16: [0, 6],
    endsUtf16: [5, 11],
    originalTokens: ['hello', 'world'],
    families: {
      timing: { formatVersion: 1, values: [{ mediaStartMs: 0, mediaEndMs: 420 }, { mediaStartMs: 430, mediaEndMs: 900 }] },
      uncertainty: { formatVersion: 1, values: [{ confidence: 0.98 }, { confidence: 0.61 }] },
    },
    ...overrides,
  };
}

test('word evidence families validate their payloads and canonicalize per-word values', () => {
  const canonical = assertWordEvidencePayload(wordEvidence(), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' });
  assert.equal(canonical.version, 1);
  assert.deepEqual(canonical.originalTokens, ['hello', 'world']);
  assert.deepEqual(canonical.families.timing.values, [{ mediaStartMs: 0, mediaEndMs: 420 }, { mediaStartMs: 430, mediaEndMs: 900 }]);
  assert.deepEqual(canonical.families.uncertainty.values, [{ confidence: 0.98 }, { confidence: 0.61 }]);
  assert.throws(() => assertWordEvidencePayload(wordEvidence({ ids: ['w1', 'w1'] }), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' }), /unique/);
  assert.throws(() => assertWordEvidencePayload(wordEvidence({ startsUtf16: [0, 99] }), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' }), /span/);
  assert.throws(() => assertWordEvidencePayload(wordEvidence({ families: { timing: { formatVersion: 1, values: [{ mediaStartMs: 0, mediaEndMs: 420 }] } } }), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' }), /aligned/);
  assert.throws(() => assertWordEvidencePayload(wordEvidence({ families: { mystery: { formatVersion: 1, values: [{}] } } }), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' }), /not declared/);
  assert.throws(() => assertWordEvidencePayload(wordEvidence({ families: { timing: { formatVersion: 2, values: [{ mediaStartMs: 0, mediaEndMs: 420 }] } } }), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' }), /formatVersion/);
  assert.throws(() => assertWordEvidencePayload(wordEvidence({ families: { timing: { formatVersion: 1, values: [{ mediaStartMs: 0, mediaEndMs: 420 }, { mediaStartMs: 900, mediaEndMs: 400 }] } } }), { families: [timingFamily, uncertaintyFamily], blockText: 'hello world' }), /failed validation/);
});

test('create action validates the word-evidence envelope against declared families', async (t) => {
  const ctx = await appFor(t);
  const good = annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
    id: 'd1', projectId: 'p1', ownerId: 'u1',
    source: { blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }] },
  });
  assert.equal(good.payload.body.blocks[0].wordEvidence.version, 1);
  assert.deepEqual(good.payload.body.blocks[0].wordEvidence.originalTokens, ['hello', 'world']);
  assert.throws(
    () => annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
      id: 'd2', projectId: 'p1', ownerId: 'u1',
      source: { blocks: [{ text: 'hello world', wordEvidence: wordEvidence({ families: { timing: { formatVersion: 1, values: [{ mediaStartMs: 0, mediaEndMs: 420 }] } } }) }] },
    }),
    /aligned/,
  );
  assert.throws(
    () => annotatedTextCreateAction(ctx.Document, ctx.Document.body, {
      id: 'd3', projectId: 'p1', ownerId: 'u1',
      source: { blocks: [{ text: 'hello world', wordEvidence: wordEvidence({ families: { mystery: { formatVersion: 1, values: [{ mediaStartMs: 0, mediaEndMs: 420 }] } } }) }] },
    }),
    /not declared/,
  );
});

test('the engaged consumer materializes one row per (word, family) on create', async (t) => {
  const ctx = await appFor(t);
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  const rows = ctx.db.prepare('SELECT * FROM WoeDoc_body_word_evidence WHERE document_id = ? ORDER BY word_id, family').all('d1');
  assert.equal(rows.length, 4);
  const w1Timing = rows.find((row) => row.word_id === 'w1' && row.family === 'timing');
  assert.equal(w1Timing.original_token, 'hello');
  assert.deepEqual(JSON.parse(w1Timing.payload), { mediaStartMs: 0, mediaEndMs: 420 });
  assert.equal(w1Timing.format_version, 1);
  assert.equal(rows.filter((row) => row.word_id === 'w1').length, 2);
});

test('readWordEvidence resolves anchors and pivots per-word evidence', async (t) => {
  const ctx = await appFor(t);
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  const field = wordEvidenceFieldHandle('WoeDoc', 'body', ctx.Document.fields.body);
  const result = readWordEvidence({ database: ctx.db, entityName: 'WoeDoc', fieldName: 'body', tableName: field.tableName, scope: 'Project:p1', documentId: 'd1' });
  assert.equal(result.structureVersion, 1);
  assert.equal(result.words.length, 2);
  const w1 = result.words.find((word) => word.wordId === 'w1');
  assert.equal(w1.start, 0);
  assert.equal(w1.end, 5);
  assert.equal(w1.text, 'hello');
  assert.equal(w1.edited, false);
  assert.deepEqual(w1.evidence.timing, { mediaStartMs: 0, mediaEndMs: 420 });
  assert.deepEqual(w1.evidence.uncertainty, { confidence: 0.98 });
  const filtered = readWordEvidence({ database: ctx.db, entityName: 'WoeDoc', fieldName: 'body', tableName: field.tableName, scope: 'Project:p1', documentId: 'd1', families: ['uncertainty'] });
  assert.deepEqual(filtered.words.find((word) => word.wordId === 'w1').evidence, { uncertainty: { confidence: 0.98 } });
});

test('readWordEvidence re-projects a committed text edit through the authoring path', async (t) => {
  const ctx = await appFor(t);
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  const field = wordEvidenceFieldHandle('WoeDoc', 'body', ctx.Document.fields.body);
  const before = readWordEvidence({ database: ctx.db, entityName: 'WoeDoc', fieldName: 'body', tableName: field.tableName, scope: 'Project:p1', documentId: 'd1' });
  assert.equal(before.words.find((word) => word.wordId === 'w1').edited, false);
  assert.equal(before.words.find((word) => word.wordId === 'w1').text, 'hello');
  // Commit a real text.delete through the authoring operation path. The whole
  // document imports as one multi-scalar RGA element, so deleting part of the
  // first word's span makes the word's mid-element end anchor unprojectable
  // after the element is edited and the framework fails closed: the word is
  // marked edited and falls back to its original token + stored offsets rather
  // than inventing a slice.
  const row = ctx.db.prepare("SELECT * FROM WoeDoc WHERE id = 'd1'").get();
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row, principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
  const edited = await ctx.app.dispatch({
    actionId: 'edit-w1', type: 'WoeDoc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'm-edit-w1' },
      edit: {
        kind: 'text.delete',
        from: { positionToken: binding.documentPositionToken, offset: 2, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: 4, affinity: 'right' },
      },
    },
  });
  assert.equal(edited.ok, true, edited.failure?.message);
  const after = readWordEvidence({ database: ctx.db, entityName: 'WoeDoc', fieldName: 'body', tableName: field.tableName, scope: 'Project:p1', documentId: 'd1' });
  const w1 = after.words.find((word) => word.wordId === 'w1');
  assert.equal(w1.edited, true);
  // The committed edit is projected against the same immutable anchors: the
  // word now slices to different text than its original token. The evidence
  // rows are untouched — the READ re-projects, the consumer does not re-run.
  assert.equal(w1.text, 'heo');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS count FROM WoeDoc_body_word_evidence WHERE document_id = ?').get('d1').count, 4);
});

test('the word-evidence DDL is document-scoped: no block-era source columns', async (t) => {
  const ctx = await appFor(t);
  // The compiled schema (like annotated-text-field.test.mjs inspects it) and
  // the applied schema must both be blockless: word evidence is per-document,
  // anchored by absolute start/end offsets plus RGA endpoints, never a
  // block-local identity.
  const ddl = annotatedTextDDL('WoeDoc', 'body', ctx.Document.fields.body, ctx.Document.fields);
  const wordEvidenceDDL = ddl.find((sql) => sql.includes('WoeDoc_body_word_evidence'));
  assert.ok(wordEvidenceDDL, 'word-evidence table DDL is emitted');
  assert.ok(!wordEvidenceDDL.includes('source_block_id'), 'no source_block_id column');
  assert.ok(!wordEvidenceDDL.includes('source_ordinal'), 'no source_ordinal column');
  assert.ok(wordEvidenceDDL.includes('PRIMARY KEY (scope, document_id, word_id, family)'));
  const columns = ctx.db.prepare('PRAGMA table_info(WoeDoc_body_word_evidence)').all().map((column) => column.name);
  assert.ok(!columns.includes('source_block_id'));
  assert.ok(!columns.includes('source_ordinal'));
  assert.ok(columns.includes('source_start_utf16'));
  assert.ok(columns.includes('source_end_utf16'));
  assert.ok(columns.includes('start_anchor'));
  assert.ok(columns.includes('end_anchor'));
});

test('word evidence resolves ABSOLUTE document offsets across multiple source blocks', async (t) => {
  const ctx = await appFor(t);
  // Two source blocks join into ONE continuous document text:
  // 'hello world' + 'goodbye there' = 'hello worldgoodbye there'.
  // Each block's wordEvidence offsets are block-local at admission, so the
  // second block's words must resolve to the continuous text's absolute
  // positions (base 11), not a block-local position.
  const block1 = {
    version: 1,
    ids: ['w3', 'w4'],
    startsUtf16: [0, 8],
    endsUtf16: [7, 13],
    originalTokens: ['goodbye', 'there'],
    families: {
      timing: { formatVersion: 1, values: [{ mediaStartMs: 1000, mediaEndMs: 1700 }, { mediaStartMs: 1800, mediaEndMs: 2100 }] },
      uncertainty: { formatVersion: 1, values: [{ confidence: 0.9 }, { confidence: 0.4 }] },
    },
  };
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }, { text: 'goodbye there', wordEvidence: block1 }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  // Stored offsets are document-absolute, not block-local.
  const w3Row = ctx.db.prepare('SELECT * FROM WoeDoc_body_word_evidence WHERE word_id = ? AND family = ?').get('w3', 'timing');
  assert.equal(w3Row.source_start_utf16, 11);
  assert.equal(w3Row.source_end_utf16, 18);
  assert.equal(w3Row.original_token, 'goodbye');
  const field = wordEvidenceFieldHandle('WoeDoc', 'body', ctx.Document.fields.body);
  const result = readWordEvidence({ database: ctx.db, entityName: 'WoeDoc', fieldName: 'body', tableName: field.tableName, scope: 'Project:p1', documentId: 'd1' });
  assert.equal(result.words.length, 4);
  const w1 = result.words.find((word) => word.wordId === 'w1');
  const w3 = result.words.find((word) => word.wordId === 'w3');
  const w4 = result.words.find((word) => word.wordId === 'w4');
  assert.deepEqual([w1.start, w1.end], [0, 5], 'first-block word keeps its absolute position');
  assert.deepEqual([w3.start, w3.end], [11, 18], 'second-block word resolves past the joined prefix, not block-local');
  assert.deepEqual([w4.start, w4.end], [19, 24], 'second-block word end also lands in absolute document space');
  assert.equal(w3.text, 'goodbye');
  assert.equal(w4.text, 'there');
  assert.equal(w3.edited, false);
});

test('the primary key is one row per (word, family) per document; duplicate ids coalesce', async (t) => {
  const ctx = await appFor(t);
  // Word evidence is inherently per-word: the PK (scope, document_id, word_id,
  // family) permits exactly one row per word+family for the whole document. A
  // word id declared again in a later source block coalesces onto that single
  // row (ON CONFLICT upsert) instead of fanning out into block-scoped rows.
  const block1 = {
    version: 1,
    ids: ['w1', 'w3'],
    startsUtf16: [0, 0],
    endsUtf16: [7, 3],
    originalTokens: ['goodbye', 'bye'],
    families: {
      timing: { formatVersion: 1, values: [{ mediaStartMs: 1000, mediaEndMs: 1700 }, { mediaStartMs: 2000, mediaEndMs: 2500 }] },
      uncertainty: { formatVersion: 1, values: [{ confidence: 0.9 }, { confidence: 0.8 }] },
    },
  };
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }, { text: 'goodbye there', wordEvidence: block1 }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  const schema = ctx.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'WoeDoc_body_word_evidence'").get();
  assert.ok(schema.sql.includes('PRIMARY KEY (scope, document_id, word_id, family)'));
  const rows = ctx.db.prepare('SELECT * FROM WoeDoc_body_word_evidence WHERE document_id = ? ORDER BY word_id, family').all('d1');
  // Three distinct word ids (w1, w2, w3) x two families = six rows, but w1 was
  // declared in BOTH blocks — it must coalesce, not double.
  assert.equal(rows.length, 6);
  assert.deepEqual(new Set(rows.map((row) => row.word_id)), new Set(['w1', 'w2', 'w3']));
  assert.equal(rows.filter((row) => row.family === 'timing').length, 3, 'one row per distinct word per family');
  const w1Timing = rows.find((row) => row.word_id === 'w1' && row.family === 'timing');
  assert.equal(w1Timing.original_token, 'goodbye', 'the later block coalesces onto the same row');
  assert.equal(w1Timing.source_start_utf16, 11, 'the coalesced row holds the second block\'s absolute offsets');
});

test('undeclared family on a create block is rejected at admission (fail closed)', async (t) => {
  const ctx = await appFor(t);
  const attempt = ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence({ families: { timing: { formatVersion: 1, values: [{ mediaStartMs: 0, mediaEndMs: 420 }] }, unknown: { formatVersion: 1, values: [{ x: 1 }] } } }) }] } } });
  assert.equal((await attempt).ok, false);
});

test('redelivery is idempotent: the whole-event consumer does not duplicate rows', async (t) => {
  const ctx = await appFor(t);
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  const before = ctx.db.prepare('SELECT COUNT(*) AS count FROM WoeDoc_body_word_evidence WHERE document_id = ?').get('d1').count;
  // Re-running the reconcile sweep replays the same committed event; the
  // consumer cursor + ON CONFLICT upsert must keep the row set stable.
  await ctx.app.writeQueue.run(() => ctx.app.reconcileOperationalConsumers());
  const after = ctx.db.prepare('SELECT COUNT(*) AS count FROM WoeDoc_body_word_evidence WHERE document_id = ?').get('d1').count;
  assert.equal(after, before);
  assert.equal(after, 4);
});

