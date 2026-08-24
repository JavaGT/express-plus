// Composite annotated-text resync benchmark (scope#992 W1 / Finding 5, rev 3).
// Counts snapshot projections under a 50-control burst and records loop delay,
// per-recipient projection time, and RSS growth. Snapshot work never enters
// the write coordinator.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, number as numberField, protectingAnnotation, read, ref, scope, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { restoreTextFamilySerialized, resolveOffsetToEndpoint } from '../build/annotated-text-continuous.mjs';
import { canonicalEndpointJSON } from '../build/annotated-text-storage.mjs';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const RECIPIENTS = Number(process.env.ANNOTATED_TEXT_BENCH_RECIPIENTS ?? 25);
const VISIBLE_RECIPIENTS = Number(process.env.ANNOTATED_TEXT_BENCH_VISIBLE_RECIPIENTS ?? 13);
const CONTROLS = 50;
const WORDS = Number(process.env.ANNOTATED_TEXT_BENCH_WORDS ?? 36_000);
const ANNOTATIONS_PER_WORD = Number(process.env.ANNOTATED_TEXT_BENCH_ANNOTATIONS_PER_WORD ?? 2);
const PROTECTED_WORDS = 100;
const PROFILE_PHASES = process.env.ANNOTATED_TEXT_BENCH_PROFILE === '1';
const SCENARIO = process.env.ANNOTATED_TEXT_BENCH_SCENARIO ?? 'initial';
if (!['initial', 'fallback'].includes(SCENARIO)) throw new Error('ANNOTATED_TEXT_BENCH_SCENARIO must be initial or fallback');

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function makeConn(id) {
  const messages = [];
  return {
    id,
    closed: false,
    principal: { type: 'user', id },
    send(message) { messages.push(message); },
    drain() { const out = [...messages]; messages.length = 0; return out; },
  };
}

function nextTurn() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await wait(0);
}

function declaredEntity() {
  return entity('BenchDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('timing', { fields: { startMs: numberField(), durationMs: numberField() } }),
        annotation('transcriptionUncertainty', { fields: { uncertainty: numberField() } }),
        protectingAnnotation('confidential', {
          protects: 'transcriptionUncertainty',
          placeholder: '[REDACTED]',
          access: async ({ is }) => (await is.owner()) ? grant(read) : grant(),
        }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function install(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(declaredEntity(), db);
}

function wordText(count) {
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(`w${i.toString(36)}`);
  return words.join(' ');
}

async function seedDocument(app, db) {
  const text = wordText(WORDS);
  const annotationCount = WORDS * ANNOTATIONS_PER_WORD;
  const words = text.split(' ');
  const offsets = [];
  let offset = 0;
  for (const word of words) {
    offsets.push(offset);
    offset += word.length + 1;
  }
  const created = await app.dispatch({
    actionId: 'create',
    type: 'BenchDoc.create',
    scope: 'Project:p1',
    payload: {
      id: 'd1',
      project: 'p1',
      owner: 'u1',
      body: {
        version: 1,
        blocks: [{ text }],
        ranges: [],
      },
    },
    principal: { id: 'u1' },
  });
  if (!created.ok) throw new Error(created.failure?.message ?? 'seed failed');
  const checkpoint = db.prepare("SELECT family_checkpoint FROM BenchDoc_body_state WHERE document_id = 'd1'").get().family_checkpoint;
  const family = restoreTextFamilySerialized(checkpoint);
  const insertAnnotation = db.prepare(
    'INSERT INTO BenchDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)',
  );
  const insertTiming = db.prepare(
    'INSERT INTO BenchDoc_body_annotation_timing (annotation_id, startMs, durationMs) VALUES (?, ?, ?)',
  );
  const insertUncertainty = db.prepare(
    'INSERT INTO BenchDoc_body_annotation_transcriptionUncertainty (annotation_id, uncertainty) VALUES (?, ?)',
  );
  const insertConfidential = db.prepare('INSERT INTO BenchDoc_body_annotation_confidential (annotation_id) VALUES (?)');
  const insertRange = db.prepare(
    'INSERT INTO BenchDoc_body_range (document_id, start_point, end_point) VALUES (?, ?, ?) RETURNING id',
  );
  const insertMembership = db.prepare(
    'INSERT INTO BenchDoc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES (?, ?, ?, 0)',
  );
  const insertProtectedTarget = db.prepare(
    'INSERT INTO BenchDoc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)',
  );
  const rangeIds = [];
  db.exec('BEGIN');
  try {
    for (let index = 0; index < WORDS; index += 1) {
      const suffix = String(index).padStart(5, '0');
      const timingId = `timing-${suffix}`;
      const uncertaintyId = `uncertainty-${suffix}`;
      const start = offsets[index];
      const end = start + words[index].length;
      const startPoint = resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left');
      const endPoint = resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right');
      const rangeId = insertRange.get('d1', canonicalEndpointJSON(startPoint), canonicalEndpointJSON(endPoint)).id;
      rangeIds.push(rangeId);
      insertAnnotation.run(timingId, 'd1', 'p1', 'u1', 'timing');
      insertTiming.run(timingId, index * 100, 80);
      insertMembership.run(timingId, rangeId, 'd1');
      insertAnnotation.run(uncertaintyId, 'd1', 'p1', 'u1', 'transcriptionUncertainty');
      insertUncertainty.run(uncertaintyId, index % 10 / 10);
      insertMembership.run(uncertaintyId, rangeId, 'd1');
    }
    insertAnnotation.run('confidential-prefix', 'd1', 'p1', 'u1', 'confidential');
    insertConfidential.run('confidential-prefix');
    for (let index = 0; index < Math.min(PROTECTED_WORDS, WORDS); index += 1) {
      insertProtectedTarget.run('confidential-prefix', `uncertainty-${String(index).padStart(5, '0')}`);
    }
    const protectedEnd = offsets[Math.min(PROTECTED_WORDS, WORDS)] ?? text.length;
    const protectorRangeId = insertRange.get(
      'd1',
      canonicalEndpointJSON(resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'left')),
      canonicalEndpointJSON(resolveOffsetToEndpoint(family, protectedEnd, family.checkpoint.frontier, 'right')),
    ).id;
    insertMembership.run('confidential-prefix', protectorRangeId, 'd1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    row: db.prepare("SELECT * FROM BenchDoc WHERE id = 'd1'").get(),
    text,
    protectedText: text.slice(0, offsets[Math.min(PROTECTED_WORDS, WORDS)] ?? text.length),
    annotationCount,
    uniqueRanges: rangeIds.length + 1,
  };
}

async function measureProjection(db, BenchDoc, fixture, principal, visible) {
  const phases = [];
  const started = performance.now();
  const input = {
    db,
    entity: BenchDoc,
    row: fixture.row,
    principal,
    fieldName: 'body',
    descriptor: BenchDoc.fields.body,
    mintBasis: false,
    ...(PROFILE_PHASES ? { profile: (phase, durationMs, details) => phases.push({ phase, durationMs, details }) } : {}),
  };
  const snapshot = await projectAnnotatedTextSnapshot(input);
  const duration = performance.now() - started;
  const serializationStarted = PROFILE_PHASES ? performance.now() : 0;
  const serialized = PROFILE_PHASES ? JSON.stringify(snapshot) : '';
  if (PROFILE_PHASES) phases.push({ phase: 'serialization', durationMs: performance.now() - serializationStarted, details: { bytes: Buffer.byteLength(serialized) } });
  const endToEndDuration = performance.now() - started;
  if (visible) {
    if (snapshot.text !== fixture.text || snapshot.annotations.length !== fixture.annotationCount) {
      throw new Error('visible recipient did not receive the complete timing/uncertainty state');
    }
  } else {
    if (!Array.isArray(snapshot.redactions) || snapshot.redactions.length !== 1 || snapshot.text.includes(fixture.protectedText)
      || snapshot.annotations.some((entry) => entry.id === 'uncertainty-00000')
      || snapshot.annotations.some((entry) => entry.family === 'confidential')) {
      throw new Error('redacted recipient received protected text or canonical annotation facts');
    }
  }
  return { duration, endToEndDuration, phases, serializedBytes: PROFILE_PHASES ? Buffer.byteLength(serialized) : null };
}

async function measureFanoutCoalescing() {
  const fanout = createLiveFanout({ mayVerb: async () => true });
  const entityRecord = {
    name: 'Doc',
    fields: { body: { kind: 'annotatedText' } },
    grant: () => [scope().can(() => true)],
    findById: () => ({ id: 'd1' }),
  };
  const conns = Array.from({ length: RECIPIENTS }, (_, index) => makeConn(`r${index}`));
  for (const conn of conns) fanout.addSubscription('Doc', 'd1', conn);
  const delays = [];
  const turnStart = performance.now();
  const mark = performance.now();
  await Promise.all(Array.from({ length: CONTROLS }, (_, index) => fanout.emit(entityRecord, 'd1', { id: 'd1' }, {
    type: 'Doc.body.operated',
    seq: index + 1,
    data: { version: 15, id: 'd1' },
  })));
  delays.push(performance.now() - mark);
  await nextTurn();
  const sent = conns.map((conn) => conn.drain());
  fanout.close();
  const unexpected = sent.filter((messages) => messages.length !== 1 || messages[0]?.seq !== CONTROLS);
  return {
    p99: percentile(delays, 99),
    turnMs: performance.now() - turnStart,
    messages: sent.length,
    coalesced: unexpected.length === 0,
    observedPerRecipient: sent.map((messages) => messages.length),
  };
}

async function measureClientBudget({ reconnect }) {
  const projections = [];
  const sessions = [];
  for (let i = 0; i < RECIPIENTS; i += 1) {
    let bootstraps = 0;
    let deliver;
    let closed;
    let connections = 0;
    let snapshotCursor = 0;
    const session = createLiveDeliverySession({
      bootstrap: async ({ mode }) => {
        if (mode === 'snapshot') {
          bootstraps += 1;
          projections.push(1);
          snapshotCursor = reconnect ? CONTROLS * 2 : CONTROLS;
        }
        return { kind: 'snapshot', snapshot: { id: 'd1', n: bootstraps }, cursor: snapshotCursor };
      },
      subscribe: async ({ deliver: next, closed: closeCb }) => {
        connections += 1;
        deliver = next;
        closed = closeCb;
        return { close() {} };
      },
      validateSnapshot: (snapshot) => snapshot,
      fold: (snapshot) => snapshot,
      sendAction: async () => ({ ok: true }),
    });
    await session.ready;
    const afterReady = bootstraps;
    sessions.push({ session, deliver: () => deliver, closed: () => closed, connections: () => connections, bootstraps: () => bootstraps, afterReady });
  }
  for (const session of sessions) {
    await session.deliver()(Array.from({ length: CONTROLS }, (_, index) => ({
      type: 'resync', entity: 'BenchDoc', id: 'd1', seq: index + 1, reason: 'annotated-text-snapshot-required',
    })));
  }
  await flush();
  if (reconnect) {
    await Promise.all(sessions.map(({ session }) => session.reconnect()));
    if (sessions.some(({ connections }) => connections() < 2)) throw new Error('C=1 did not mint a second connection generation');
    for (const session of sessions) {
      await session.deliver()(Array.from({ length: CONTROLS }, (_, index) => ({
        type: 'resync', entity: 'BenchDoc', id: 'd1', seq: CONTROLS + index + 1, reason: 'annotated-text-snapshot-required',
      })));
    }
    await flush();
  }
  const burst = sessions.reduce((sum, { bootstraps, afterReady }) => sum + Math.max(0, bootstraps() - afterReady), 0);
  const bound = 4 * RECIPIENTS * (1 + (reconnect ? 1 : 0));
  for (const { session } of sessions) session.close();
  return {
    totalIncludingStart: projections.length,
    burst,
    bound,
    histogram: Object.fromEntries(
      Object.entries(sessions.reduce((acc, { bootstraps, afterReady }) => {
        const count = Math.max(0, bootstraps() - afterReady);
        acc[count] = (acc[count] ?? 0) + 1;
        return acc;
      }, {})),
    ),
    minimumConnections: Math.min(...sessions.map(({ connections }) => connections())),
  };
}

const coordinatorHeld = { value: false };
const originalHash = createHash;
void originalHash;

async function main() {
  const benchmarkBytes = readFileSync(new URL(import.meta.url));
  const processList = execFileSync('ps', ['-Ao', 'pid,pcpu,rss,command'], { encoding: 'utf8' });
  const rssAtStart = process.memoryUsage().rss;
  const db = new DatabaseSync(':memory:');
  install(db);
  const BenchDoc = declaredEntity();
  const app = workbench({ db, schema: defineSqliteSchema({
    name: 'annotated-text-composite-resync',
    tables: [],
    externalTables: [{ name: 'Project', columns: ['id'] }],
  }), entities: [BenchDoc] });
  app.start();
  await app.ready;
  const fixture = await seedDocument(app, db);
  // The acceptance delta measures projection/recovery over the fully seeded
  // fixture baseline; fixture construction is reported separately.
  const rssBefore = process.memoryUsage().rss;
  const forcedFallbackFanout = SCENARIO === 'fallback' ? await measureFanoutCoalescing() : null;

  const projectionSamples = [];
  const visibleSamples = [];
  const redactedSamples = [];
  const projectionPhaseSamples = [];
  const serializedSizes = [];
  const endToEndSamples = [];
  let peakRss = rssBefore;
  for (let i = 0; i < RECIPIENTS; i += 1) {
    if (coordinatorHeld.value) throw new Error('snapshot work held the write coordinator');
    const visible = i < VISIBLE_RECIPIENTS;
    const sample = await measureProjection(db, BenchDoc, fixture, { id: visible ? 'u1' : `viewer-${i}` }, visible);
    projectionSamples.push(sample.duration);
    (visible ? visibleSamples : redactedSamples).push(sample.duration);
    projectionPhaseSamples.push(sample.phases);
    serializedSizes.push(sample.serializedBytes);
    endToEndSamples.push(sample.endToEndDuration);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  const fanout = forcedFallbackFanout ?? await measureFanoutCoalescing();
  const noReconnect = await measureClientBudget({ reconnect: false });
  const oneReconnect = await measureClientBudget({ reconnect: true });
  const rssAfter = process.memoryUsage().rss;
  const rssDeltaMiB = (rssAfter - rssBefore) / (1024 * 1024);
  const peakRssDeltaMiB = (peakRss - rssBefore) / (1024 * 1024);

  const report = {
    recordedAt: new Date().toISOString(),
    scenario: SCENARIO,
    profiling: PROFILE_PHASES,
    provenance: {
      commit: process.env.ANNOTATED_TEXT_BENCH_COMMIT ?? null,
      benchmarkSha256: createHash('sha256').update(benchmarkBytes).digest('hex'),
      command: `ANNOTATED_TEXT_BENCH_SCENARIO=${SCENARIO} ANNOTATED_TEXT_BENCH_COMMIT=${process.env.ANNOTATED_TEXT_BENCH_COMMIT ?? ''} pnpm benchmark:annotated-text-composite-resync`,
      environment: {
        ANNOTATED_TEXT_BENCH_WORDS: String(WORDS),
        ANNOTATED_TEXT_BENCH_ANNOTATIONS_PER_WORD: String(ANNOTATIONS_PER_WORD),
        ANNOTATED_TEXT_BENCH_RECIPIENTS: String(RECIPIENTS),
        ANNOTATED_TEXT_BENCH_VISIBLE_RECIPIENTS: String(VISIBLE_RECIPIENTS),
      },
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryMiB: Number((totalmem() / (1024 * 1024)).toFixed(2)),
      processList,
    },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    fixture: {
      words: WORDS,
      annotations: fixture.annotationCount,
      uniqueRanges: fixture.uniqueRanges,
      protectingAnnotations: 1,
      visibleRecipients: visibleSamples.length,
      redactedRecipients: redactedSamples.length,
      recipients: RECIPIENTS,
      controls: CONTROLS,
    },
    fanout: { p99LoopDelayMs: Number(fanout.p99.toFixed(3)), coalescedMessages: fanout.messages },
    projections: {
      p95Ms: Number(percentile(projectionSamples, 95).toFixed(3)),
      visibleP95Ms: Number(percentile(visibleSamples, 95).toFixed(3)),
      redactedP95Ms: Number(percentile(redactedSamples, 95).toFixed(3)),
      samples: projectionSamples.map((value) => Number(value.toFixed(3))),
      phaseSamples: projectionPhaseSamples,
      serializedSizes,
      endToEndSamples: endToEndSamples.map((value) => Number(value.toFixed(3))),
    },
    budget: {
      C0: noReconnect,
      C1: oneReconnect,
    },
    rssDeltaMiB: Number(rssDeltaMiB.toFixed(2)),
    peakRssDeltaMiB: Number(peakRssDeltaMiB.toFixed(2)),
    fixtureSetupRssMiB: Number(((rssBefore - rssAtStart) / (1024 * 1024)).toFixed(2)),
    writeCoordinatorHeld: coordinatorHeld.value,
  };

  const thresholdNotes = [];
  if (fanout.p99 >= 100) thresholdNotes.push(`event-loop delay p99 ${fanout.p99}ms exceeds 100ms`);
  if (report.projections.p95Ms >= 500) thresholdNotes.push(`projected snapshot p95 ${report.projections.p95Ms}ms exceeds 500ms`);
  if (peakRssDeltaMiB >= 256) thresholdNotes.push(`peak RSS growth ${peakRssDeltaMiB}MiB exceeds 256MiB`);
  if (noReconnect.burst > noReconnect.bound || oneReconnect.burst > oneReconnect.bound) {
    thresholdNotes.push('snapshot recovery exceeded cycle budget');
  }
  report.thresholdNotes = thresholdNotes;

  const markdown = [
    '',
    '## Annotated-text composite resync',
    '',
    `- Recorded at: \`${report.recordedAt}\``,
    `- Node: \`${report.node}\``,
    `- Platform: \`${report.platform}\``,
    `- Fixture: ${report.fixture.words} words, ${report.fixture.annotations} annotations, ${report.fixture.recipients} recipients, ${report.fixture.controls} controls`,
    `- C=0 burst projections: ${report.budget.C0.burst} (bound ${report.budget.C0.bound}; including start ${report.budget.C0.totalIncludingStart})`,
    `- C=1 burst projections: ${report.budget.C1.burst} (bound ${report.budget.C1.bound}; including start ${report.budget.C1.totalIncludingStart})`,
    `- Event-loop delay p99: ${report.fanout.p99LoopDelayMs} ms`,
    `- Snapshot projection p95: ${report.projections.p95Ms} ms / recipient`,
    `- RSS Δ: ${report.rssDeltaMiB} MiB`,
    `- Peak RSS Δ: ${report.peakRssDeltaMiB} MiB`,
    `- Write coordinator held: ${report.writeCoordinatorHeld}`,
    `- Attempt histogram C=0: \`${JSON.stringify(report.budget.C0.histogram)}\``,
    `- Attempt histogram C=1: \`${JSON.stringify(report.budget.C1.histogram)}\``,
    `- Minimum transport generations C=1: ${report.budget.C1.minimumConnections}`,
    '',
  ].join('\n');

  if (process.env.ANNOTATED_TEXT_BENCH_RECORD === '1') {
    writeFileSync(new URL('../docs/performance-results.md', import.meta.url), markdown, { flag: 'a' });
  }
  console.log(JSON.stringify(report, null, 2));
  await app.shutdown().catch(() => {});
  db.close();
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
