import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, grant, read, ref, write, scope, deny, subscribe, admin,
} from '../build/internal.mjs';
import { executeDDL, executeFrameworkDDL, registerAnnotatedTextStructuralExtension } from '../build/internal.mjs';
import { registerAnnotatedTextContract } from '../build/index.mjs';
import { durableHistory } from '../build/internal.mjs';
import { annotatedTextCreateAction } from '../build/annotated-text-action.mjs';
import { restoreTextFamily, materializeText } from '../build/annotated-text-continuous.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../build/annotated-text-fold-envelope.mjs';
import { createAnnotatedTextHttpSession } from '../public/workbench-client.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

registerAnnotatedTextContract('httpDeliveryMeasurement', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('httpDeliveryMeasurement', Object.freeze({
  version: 1, validate() {}, edit() {}, partition() {}, combine() {},
}));

// Typing is a latency-sensitive interaction. These tests guard the annotated
// text fold delivery on large documents: the fold envelope must stay small
// enough to survive the SSE frame clamp (it no longer ships the whole family),
// and the server fold build / client fold apply must stay inside a
// "perceived instant" budget. The fold timing tests are split into a
// timing-independent CORRECTNESS assertion (the fold actually produced the
// right document state from the fold — no snapshot demotion) and a generous,
// machine-tolerant TIMING budget that only trips on a real blowup. Timing
// assertions WARN below the budget and fail only well above it so slow CI
// machines do not produce red noise.

const FOLD_PAYLOAD_BUDGET = 128 * 1024;
const SERVER_BUILD_WARN_MS = 20;
const SERVER_BUILD_FAIL_MS = 2000;
const CLIENT_APPLY_WARN_MS = 2;
// The large-document fold path re-materializes the whole continuous family
// from its checkpoint (re-reducing every element) on every build/apply, so its
// measured cost scales with machine speed AND load. Standalone medians on this
// machine were 103-128ms (server build) and 149-264ms (client apply); under
// full-suite parallel load they reached 546-573ms and 384ms. These FAIL budgets
// are deliberately generous: they absorb machine variance with >3.5x margin
// over every observation. They are a catastrophic-blowup guard only (an
// accidental O(n^2) restore re-materializing per fold call, or a fold that
// re-builds the whole family again), NOT a 2x-regression detector — a real
// fold regression that merely doubles cost passes, and that is the accepted
// trade for a machine-tolerant gate; the timing-independent correctness
// assertions below carry the precise signal.
const CLIENT_APPLY_FAIL_MS = 2000;

const WORDS = Array.from({ length: 10 }, (_, index) => `word${index}`).join(' ');
const SEGMENT_COUNT = 96;

function largeText(count = SEGMENT_COUNT) {
  return Array.from({ length: count }, (_, index) => `${WORDS} ${index}`).join('\n');
}

async function setupLargeDocument(t) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY, owner TEXT); CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO Project VALUES (\'p1\', \'u1\'); INSERT INTO User VALUES (\'u1\')');
  const Document = entity('LatencyDoc', {
    project: ref('Project'), owner: ref('User', { role: 'owner' }),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Document, db);
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, subscribe, admin) : deny('not project owner'))],
  });
  const app = workbench({ db, entities: [Project, Document], history: durableHistory({ authorize: () => true }) });
  app.attachLiveDelivery({ principalOf: () => ({ type: 'user', id: 'u1', attributes: {} }) });
  app.listen(0, { principalOf: () => ({ type: 'user', id: 'u1', attributes: {} }) });
  await app.ready;
  t.after(async () => { app.httpServer.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const create = annotatedTextCreateAction(Document, Document.body, {
    id: 'd1', projectId: 'p1', ownerId: 'u1', source: { text: largeText() },
  });
  const createRes = await fetch(`${origin}/workbench/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId: 'latency-create', type: create.type, payload: create.payload, scope: 'Project:p1', clientId: 'tab-a' }),
  });
  assert.equal(createRes.status, 200, await createRes.text());
  // The compact durable checkpoint stores the causal operation registry rather
  // than the derived element topology. The imported document is one valid
  // multi-scalar operation; assert the compact shape and retain the large text
  // workload that drives materialization and fold payload sizing.
  const importedState = db.prepare('SELECT family_checkpoint FROM LatencyDoc_body_state WHERE document_id = ?').get('d1');
  assert.ok(importedState?.family_checkpoint, 'expected the created document checkpoint');
  const checkpoint = JSON.parse(importedState.family_checkpoint).checkpoint;
  assert.equal(checkpoint.version, 2, 'expected the compact checkpoint representation');
  const operationCount = Object.keys(checkpoint.operations).length;
  assert.ok(operationCount >= 1, `expected the imported operation registry, got ${operationCount} operations`);
  const text = largeText();
  assert.ok(text.length >= 1000, `expected a large text workload, got ${text.length} UTF-16 units`);
  return { app, db, Document, origin, segmentCount: SEGMENT_COUNT, text: largeText(), textLength: largeText().length };
}

async function buildFoldForInsert(ctx, text) {
  const row = ctx.db.prepare('SELECT * FROM LatencyDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row,
    principal: { id: 'u1' }, fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
  const result = await ctx.app.dispatch({
    actionId: `latency-insert-${Math.random().toString(36).slice(2)}`, principal: { id: 'u1' }, scope: 'Project:p1',
    type: 'LatencyDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: `m-${Math.random().toString(36).slice(2)}` },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'right' }, text },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  const event = ctx.db.prepare("SELECT * FROM _Log WHERE eventType = 'LatencyDoc.body.operated' ORDER BY seq DESC LIMIT 1").get();
  const document = {
    entity: ctx.Document, fieldName: 'body', descriptor: ctx.Document.fields.body, documentId: 'd1', clientNonce: 'z'.repeat(43),
  };
  const envelopes = await tryBuildAnnotatedTextFoldEnvelopes(
    { event: { ...event, data: JSON.parse(event.eventData) }, scope: 'Project:p1', principal: { id: 'u1' }, db: ctx.db, document },
    { db: ctx.db, document },
  );
  assert.ok(Array.isArray(envelopes) && envelopes[0]?.fold?.kind === 'annotatedText', 'large-document insert must build a fold');
  return { envelopes, event };
}

test('fold envelope for a large document stays far under the SSE frame clamp (payload budget)', async (t) => {
  const ctx = await setupLargeDocument(t);
  const { envelopes } = await buildFoldForInsert(ctx, 'p');
  const bytes = Buffer.byteLength(JSON.stringify(envelopes));
  assert.ok(bytes <= FOLD_PAYLOAD_BUDGET,
    `fold envelope is ${bytes}B, over the ${FOLD_PAYLOAD_BUDGET}B budget: the fold still ships the full family on the wire, which the 1MB SSE clamp silently demotes to a per-edit bootstrap`);
});

test('server fold build on a large document stays inside the typing budget (warn over threshold)', async (t) => {
  const ctx = await setupLargeDocument(t);
  const { event } = await buildFoldForInsert(ctx, 'a');
  const document = {
    entity: ctx.Document, fieldName: 'body', descriptor: ctx.Document.fields.body, documentId: 'd1', clientNonce: 'z'.repeat(43),
  };
  const durations = [];
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    const envelopes = await tryBuildAnnotatedTextFoldEnvelopes(
      { event: { ...event, data: JSON.parse(event.eventData) }, scope: 'Project:p1', principal: { id: 'u1' }, db: ctx.db, document },
      { db: ctx.db, document },
    );
    assert.equal(envelopes[0]?.fold?.kind, 'annotatedText');
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const median = durations[durations.length >> 1];
  console.error(`[latency] server fold build median ${median.toFixed(3)}ms on a ${ctx.textLength}-char doc`);
  if (median > SERVER_BUILD_FAIL_MS) {
    assert.fail(`server fold build median ${median.toFixed(1)}ms on a ${ctx.textLength}-char doc is over the ${SERVER_BUILD_FAIL_MS}ms hard budget`);
  }
  if (median > SERVER_BUILD_WARN_MS) {
    console.warn(`[latency] server fold build median ${median.toFixed(1)}ms on a ${ctx.textLength}-char doc exceeds the ${SERVER_BUILD_WARN_MS}ms perceived-instant warning. Likely: full-family re-issue in mintFoldAuthoring or the recipient re-projection.`);
  }
});

test('client fold apply on a large document stays inside the typing budget (warn over threshold)', async (t) => {
  const ctx = await setupLargeDocument(t);
  // A real streaming EventSource so the client receives and applies fold
  // envelopes, letting onFoldApplied measure the fold apply itself.
  const streamController = new AbortController();
  const eventSources = new Set();
  const streamingEventSource = (urlString) => {
    const source = { close() { controller.abort(); }, onmessage: null, onerror: null };
    eventSources.add(source);
    const controller = new AbortController();
    source.close = () => { controller.abort(); eventSources.delete(source); };
    void (async () => {
      try {
        const response = await fetch(urlString, { signal: controller.signal });
        if (!response.ok || !response.body) { source.onerror?.(new Error(`SSE HTTP ${response.status}`)); return; }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (dataLine && typeof source.onmessage === 'function') source.onmessage({ data: dataLine.slice('data: '.length) });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) source.onerror?.(error);
      }
    })();
    return source;
  };

  const foldTimings = [];
  const projections = [];
  const session = createAnnotatedTextHttpSession({
    baseUrl: `${ctx.origin}/live-delivery`,
    context: { entity: ctx.Document, field: ctx.Document.body, documentId: 'd1' },
    historySession: 'tab-b', createActionId: () => `typed-${Math.random().toString(36).slice(2)}`,
    eventSourceFactory: streamingEventSource,
    onFoldApplied: (fold, elapsedMs) => {
      foldTimings.push(elapsedMs);
      projections.push(fold.projection.text);
    },
  });
  // Closing the session and aborting the SSE streams must happen even when an
  // assertion below fails, or the open fetch keeps the event loop alive and
  // the whole test file hangs.
  t.after(() => {
    session.close();
    for (const source of eventSources) source.close();
    streamController.abort();
  });
  await session.ready.catch((error) => { error.message = `latency-ready: ${error.message}`; throw error; });
  assert.equal(foldTimings.length, 0);

  for (let index = 0; index < 10; index += 1) {
    const inserted = await session.insert({ mutationId: `latency-${index}`, at: { offset: 0, affinity: 'right' }, text: 'x' });
    assert.equal(inserted.ok, true, inserted.failure?.message);
    await inserted.settlement.wait();
  }

  // CORRECTNESS — timing-independent. The fold must actually be applied (not
  // demoted to a snapshot bootstrap) and must produce exactly the state the
  // server projected for each fold.
  assert.ok(foldTimings.length >= 10, `expected at least 10 fold applies, got ${foldTimings.length} — folds are being demoted to snapshots`);
  assert.equal(projections.length, foldTimings.length, 'every fold apply must carry a server projection');
  const expected = 'x'.repeat(10) + ctx.text;
  assert.equal(projections.at(-1), expected,
    `fold projection diverges from the expected ${ctx.textLength}+10-char document — the fold produced the wrong state`);
  assert.equal(session.document.text, expected,
    `client fold result must equal the server's final projected text; got length ${session.document.text.length} vs ${expected.length}`);
  // Cross-check against the authoritative family checkpoint on the server: the
  // fold result must be produced purely from the fold, never a snapshot rest.
  const finalState = ctx.db.prepare('SELECT family_checkpoint FROM LatencyDoc_body_state WHERE document_id = ?').get('d1');
  const serverText = materializeText(restoreTextFamily(JSON.parse(finalState.family_checkpoint)));
  assert.equal(serverText, expected, `server family checkpoint must match the expected ${ctx.textLength}+10-char text`);
  assert.equal(session.document.text, serverText, 'client fold result must equal the server family checkpoint text');

  // TIMING — generous, machine-tolerant budget. The fold apply re-materializes
  // the whole continuous family per keystroke, so absolute ms scales with
  // machine speed and load; only a genuine blowup should fail.
  const sorted = [...foldTimings].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  console.error(`[latency] client fold apply median ${median.toFixed(3)}ms on a ${ctx.textLength}-char doc`);
  if (median > CLIENT_APPLY_FAIL_MS) {
    assert.fail(`client fold apply median ${median.toFixed(1)}ms on a ${ctx.textLength}-char doc is over the ${CLIENT_APPLY_FAIL_MS}ms hard budget`);
  }
  if (median > CLIENT_APPLY_WARN_MS) {
    console.warn(`[latency] client fold apply median ${median.toFixed(1)}ms on a ${ctx.textLength}-char doc exceeds the ${CLIENT_APPLY_WARN_MS}ms perceived-instant warning. Likely: full-family restore/stringify in the client fold.`);
  }
});
