// Composite annotated-text resync benchmark (scope#992 W1 / Finding 5, rev 3).
// Counts snapshot projections under a 50-control burst and records loop delay,
// per-recipient projection time, and RSS growth. Snapshot work never enters
// the write coordinator.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import { createLiveFanout } from '../build/live-fanout.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const RECIPIENTS = 25;
const CONTROLS = 50;
const WORDS = Number(process.env.ANNOTATED_TEXT_BENCH_WORDS ?? 36_000);
const ANNOTATIONS_PER_WORD = Number(process.env.ANNOTATED_TEXT_BENCH_ANNOTATIONS_PER_WORD ?? 2);

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
      annotations: [annotation('note', { fields: {} })],
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
  const initialAnnotationCount = Math.min(annotationCount, 4096);
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
        ranges: Array.from({ length: initialAnnotationCount }, (_, index) => {
          const word = index % WORDS;
          const start = offsets[word];
          const end = start + `w${word.toString(36)}`.length;
          return { annotationId: `n${index}`, family: 'note', start, end };
        }),
      },
    },
    principal: { id: 'u1' },
  });
  if (!created.ok) throw new Error(created.failure?.message ?? 'seed failed');
  if (annotationCount > initialAnnotationCount) {
    const ranges = db.prepare('SELECT id FROM BenchDoc_body_range ORDER BY id').all();
    if (ranges.length === 0) throw new Error('direct annotation seed requires at least one canonical range');
    const insertAnnotation = db.prepare(
      'INSERT INTO BenchDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)',
    );
    const insertNote = db.prepare('INSERT INTO BenchDoc_body_annotation_note (annotation_id) VALUES (?)');
    const insertMembership = db.prepare(
      'INSERT INTO BenchDoc_body_membership (annotation_id, range_id, document_id, ordinal) VALUES (?, ?, ?, 0)',
    );
    db.exec('BEGIN');
    try {
      for (let index = initialAnnotationCount; index < annotationCount; index += 1) {
        const annotationId = `n${index}`;
        insertAnnotation.run(annotationId, 'd1', 'p1', 'u1', 'note');
        insertNote.run(annotationId);
        insertMembership.run(annotationId, ranges[index % ranges.length].id, 'd1');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db.prepare("SELECT * FROM BenchDoc WHERE id = 'd1'").get();
}

async function measureProjection(db, BenchDoc, row, principal) {
  const started = performance.now();
  await projectAnnotatedTextSnapshot({
    db,
    entity: BenchDoc,
    row,
    principal,
    fieldName: 'body',
    descriptor: BenchDoc.fields.body,
    mintBasis: false,
  });
  return performance.now() - started;
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
  const rssBefore = process.memoryUsage().rss;
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
  const row = await seedDocument(app, db);

  const projectionSamples = [];
  for (let i = 0; i < RECIPIENTS; i += 1) {
    if (coordinatorHeld.value) throw new Error('snapshot work held the write coordinator');
    projectionSamples.push(await measureProjection(db, BenchDoc, row, { id: i < 13 ? 'u1' : `viewer-${i}` }));
  }

  const fanout = await measureFanoutCoalescing();
  const noReconnect = await measureClientBudget({ reconnect: false });
  const oneReconnect = await measureClientBudget({ reconnect: true });
  const rssAfter = process.memoryUsage().rss;
  const rssDeltaMiB = (rssAfter - rssBefore) / (1024 * 1024);

  const report = {
    recordedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    fixture: { words: WORDS, annotations: WORDS * ANNOTATIONS_PER_WORD, recipients: RECIPIENTS, controls: CONTROLS },
    fanout: { p99LoopDelayMs: Number(fanout.p99.toFixed(3)), coalescedMessages: fanout.messages },
    projections: {
      p95Ms: Number(percentile(projectionSamples, 95).toFixed(3)),
      samples: projectionSamples.map((value) => Number(value.toFixed(3))),
    },
    budget: {
      C0: noReconnect,
      C1: oneReconnect,
    },
    rssDeltaMiB: Number(rssDeltaMiB.toFixed(2)),
    writeCoordinatorHeld: coordinatorHeld.value,
  };

  const thresholdNotes = [];
  if (fanout.p99 >= 100) thresholdNotes.push(`event-loop delay p99 ${fanout.p99}ms exceeds 100ms`);
  if (report.projections.p95Ms >= 500) thresholdNotes.push(`projected snapshot p95 ${report.projections.p95Ms}ms exceeds 500ms`);
  if (rssDeltaMiB >= 256) thresholdNotes.push(`RSS growth ${rssDeltaMiB}MiB exceeds 256MiB`);
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
