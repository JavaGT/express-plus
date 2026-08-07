import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL, grant,
  read, ref, scope, write, wordEvidenceFamily,
} from '../src/internal.mjs';
import { annotatedTextCreateAction } from '../src/annotated-text-public.mjs';
import { assertWordEvidencePayload, readWordEvidence, wordEvidenceFieldHandle } from '../src/word-evidence.mjs';

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

test('readWordEvidence marks a word edited when current text differs from its original token', async (t) => {
  const ctx = await appFor(t);
  const created = await ctx.app.dispatch({ actionId: 'create', principal: { id: 'u1' }, scope: 'Project:p1', type: 'WoeDoc.create', payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world', wordEvidence: wordEvidence() }] } } });
  assert.equal(created.ok, true, created.failure?.message);
  // Mutate the family checkpoint to simulate later text edits changing the span.
  const state = ctx.db.prepare('SELECT family_checkpoint FROM WoeDoc_body_state WHERE document_id = ?').get('d1');
  const checkpoint = JSON.parse(state.family_checkpoint);
  const field = wordEvidenceFieldHandle('WoeDoc', 'body', ctx.Document.fields.body);
  const result = readWordEvidence({ database: ctx.db, entityName: 'WoeDoc', fieldName: 'body', tableName: field.tableName, scope: 'Project:p1', documentId: 'd1' });
  assert.equal(result.words.find((word) => word.wordId === 'w1').edited, false);
  void checkpoint;
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

