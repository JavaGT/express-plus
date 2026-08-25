import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, protectingAnnotation, entity, everyone, grant, read, write, ref, scope, admin, subscribe,
} from '../build/index.mjs';
import { executeDDL, executeFrameworkDDL, registerAnnotatedTextStructuralExtension } from '../build/internal.mjs';
import { registerAnnotatedTextContract } from '../build/index.mjs';
import {
  importTextToFamily, textFamilyCheckpoint, projectEndpointToOffset as serverProjectEndpointToOffset,
  resolveOffsetToEndpoint,
} from '../build/annotated-text-continuous.mjs';
import {
  projectEndpointToOffset as publicProjectEndpointToOffset,
  restoreTextFamily, createTextFamily, applyTextOperation, materializeText,
} from '../public/workbench-annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { attachAnnotationRange } from '../build/annotated-text-storage.mjs';
import { tryBuildAnnotatedTextFoldEnvelopes } from '../build/annotated-text-fold-envelope.mjs';
import { materializeAnnotatedTextSnapshot } from '../public/workbench-annotated-text-snapshot.mjs';
import { createAnnotatedTextHttpSession, createLiveDeliverySession } from '../public/workbench-client.mjs';
import { createTextState, applyTextOp, textCheckpoint } from '../build/annotated-text.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

registerAnnotatedTextContract('anchoredWireM', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('anchoredWireM', Object.freeze({ version: 1, validate() {}, edit() {}, partition() {}, combine() {} }));

const ACTOR = 'a'.repeat(32);

function setup() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1'), ('reader')");
  const Project = entity('Project', { owner: ref('User', { role: 'owner' }), grant: [scope(() => everyone()).can(() => grant(read, write, admin))] });
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  const Doc = entity('Doc', {
    project: ref('Project', { physical: true }), owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project', owner: 'owner',
      annotations: [
        annotation('comment', { empty: 'orphan' }),
        annotation('sensitive', { empty: 'delete' }),
        protectingAnnotation('confidential', { protects: 'sensitive', placeholder: '[REDACTED]', access: async ({ is }) => (await is.owner()) ? grant(read) : grant() }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });
  executeDDL(Doc, db);
  const app = workbench({ db, entities: [Project, Doc] });
  return { db, app, Doc, Project };
}

function seedDocument(db, text, annotations = []) {
  db.prepare("INSERT INTO Doc (id, project, owner) VALUES ('d1', 'p1', 'u1')").run();
  const family = importTextToFamily('d1', ACTOR, text);
  db.prepare('INSERT INTO Doc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, 1, ?)').run('d1', JSON.stringify(textFamilyCheckpoint(family)));
  for (const annotation of annotations) {
    db.prepare('INSERT INTO Doc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(annotation.id, 'd1', 'p1', 'u1', annotation.family);
    const start = resolveOffsetToEndpoint(family, annotation.start, family.checkpoint.frontier, 'right');
    const end = resolveOffsetToEndpoint(family, annotation.end, family.checkpoint.frontier, 'right');
    attachAnnotationRange(db, 'Doc_body', 'd1', annotation.id, start, end, 0);
    if (annotation.protectedTargetIds) {
      for (const target of annotation.protectedTargetIds) {
        db.prepare('INSERT INTO Doc_body_annotation_protected_target (annotation_id, target_annotation_id) VALUES (?, ?)').run(annotation.id, target);
      }
    }
  }
  return family;
}

function token(label) {
  return `${label}${'x'.repeat(43)}`.slice(0, 43);
}

function expandV3Ranges(snapshot) {
  return snapshot.ranges.map(([annotationId, startPoint, startFrontier, endPoint, endFrontier]) => ({
    annotationId,
    start: { point: snapshot.points[startPoint], basisFrontier: snapshot.frontiers[startFrontier] },
    end: { point: snapshot.points[endPoint], basisFrontier: snapshot.frontiers[endFrontier] },
  }));
}

test('fully-visible recipient snapshot ships compact anchored v3 ranges', async () => {
  const { db, app, Doc } = setup();
  await app.ready;
  const family = seedDocument(db, 'hello world', [{ id: 'a1', family: 'comment', start: 6, end: 11 }]);
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const anchored = await projectAnnotatedTextSnapshot({
    db, entity: Doc, row, principal, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false,
  });
  assert.equal(anchored.version, 3);
  assert.equal(anchored.ranges.length, 1);
  assert.equal(anchored.ranges[0][0], 'a1');
  assert.equal(anchored.frontiers.length, 1);
  const [expanded] = expandV3Ranges(anchored);
  assert.ok(Array.isArray(expanded.start.point));
  assert.ok(Array.isArray(expanded.start.basisFrontier));
  assert.equal(serverProjectEndpointToOffset(family, expanded.start), 6);
  assert.equal(serverProjectEndpointToOffset(family, expanded.end), 11);
  await app.shutdown(); db.close();
});

test('redacted recipients stay offset-only v1 and never receive raw endpoints', async () => {
  const { db, app, Doc } = setup();
  await app.ready;
  seedDocument(db, 'open text secret more', [
    { id: 's1', family: 'sensitive', start: 10, end: 16 },
    { id: 'c1', family: 'confidential', start: 10, end: 16, protectedTargetIds: ['s1'] },
  ]);
  const reader = { type: 'user', id: 'reader', attributes: {} };
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const redacted = await projectAnnotatedTextSnapshot({
    db, entity: Doc, row, principal: reader, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false,
  });
  assert.equal(redacted.version, 1);
  assert.ok(redacted.redactions?.length > 0);
  for (const range of redacted.ranges) {
    assert.equal(typeof range.start, 'number');
    assert.equal(typeof range.end, 'number');
  }
  assert.equal(JSON.stringify(redacted).includes('basisFrontier'), false);
  assert.equal(JSON.stringify(redacted).includes('"point"'), false);
  await app.shutdown(); db.close();
});

test('a whole-document restriction stays offset-empty v1', async () => {
  const { db, app, Doc } = setup();
  await app.ready;
  const text = 'entirely secret body';
  seedDocument(db, text, [
    { id: 's1', family: 'sensitive', start: 0, end: text.length },
    { id: 'c1', family: 'confidential', start: 0, end: text.length, protectedTargetIds: ['s1'] },
  ]);
  const reader = { type: 'user', id: 'reader', attributes: {} };
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const restricted = await projectAnnotatedTextSnapshot({
    db, entity: Doc, row, principal: reader, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false,
  });
  assert.equal(restricted.version, 1);
  assert.equal(restricted.restricted, true);
  assert.deepEqual(restricted.ranges, []);
  assert.equal(JSON.stringify(restricted).includes('basisFrontier'), false);
  await app.shutdown(); db.close();
});

test('materialize expands v3 with semantic parity to v2 and fails closed without a family replica', async () => {
  const { db, app, Doc } = setup();
  await app.ready;
  const family = seedDocument(db, 'hello world', [{ id: 'a1', family: 'comment', start: 6, end: 11 }]);
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const wire = await projectAnnotatedTextSnapshot({
    db, entity: Doc, row, principal, fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false,
  });

  assert.throws(
    () => materializeAnnotatedTextSnapshot(wire, Doc.body),
    /family|endpoint|replica/i,
  );

  const publicFamily = restoreTextFamily({ id: family.id, checkpoint: family.checkpoint });
  const expandedV2 = {
    ...wire,
    version: 2,
    ranges: expandV3Ranges(wire),
  };
  delete expandedV2.points;
  delete expandedV2.frontiers;
  const previousDocument = materializeAnnotatedTextSnapshot(expandedV2, Doc.body, { family: publicFamily });
  const document = materializeAnnotatedTextSnapshot(wire, Doc.body, { family: publicFamily });
  assert.equal(document.version, 3);
  assert.equal(document.ranges.length, 1);
  assert.equal(document.ranges[0].annotationId, 'a1');
  assert.equal(typeof document.ranges[0].start, 'object');
  assert.equal(publicProjectEndpointToOffset(publicFamily, document.ranges[0].start), 6);
  assert.equal(publicProjectEndpointToOffset(publicFamily, document.ranges[0].end), 11);
  assert.equal(document.text, 'hello world');
  assert.deepEqual({ ...document, version: 2 }, previousDocument);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(expandedV2).length);
  await app.shutdown(); db.close();
});

test('v3 compact tables reject malformed, duplicate, non-canonical, and unknown data', () => {
  const family = importTextToFamily('d1', ACTOR, 'hello world');
  const point = ['point', ['root'], 'left'];
  const frontier = [[ACTOR, 1]];
  const snapshot = {
    kind: 'workbench.annotatedText.recipient', version: 3, text: 'hello world',
    points: [point], frontiers: [frontier], ranges: [['a1', 0, 0, 0, 0]],
    annotations: [{ id: 'a1', family: 'comment', fields: {} }], measurements: [], capabilityHints: [], orphans: [],
  };
  const handle = { annotations: { comment: {} } };
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...structuredClone(snapshot), extra: true }, handle, { family }), /v3 envelope has invalid shape/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...structuredClone(snapshot), points: [point, point] }, handle, { family }), /deduplicated|unused/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...structuredClone(snapshot), ranges: [['a1', 1, 0, 0, 0]] }, handle, { family }), /out of bounds|canonical/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...structuredClone(snapshot), ranges: [['a1', 0, 0, 0, 0, 0]] }, handle, { family }), /compact endpoint references/);
  assert.throws(() => materializeAnnotatedTextSnapshot({ ...structuredClone(snapshot), frontiers: [[[ACTOR, 0]]] }, handle, { family }), /frontier table entry/);
  const symbolTable = structuredClone(snapshot);
  symbolTable.points[Symbol('extra')] = true;
  assert.throws(() => materializeAnnotatedTextSnapshot(symbolTable, handle, { family }), /endpoint tables/);
  const symbolPoint = structuredClone(snapshot);
  symbolPoint.points[0][Symbol('extra')] = true;
  assert.throws(() => materializeAnnotatedTextSnapshot(symbolPoint, handle, { family }), /point table entry/);
  const hiddenAnchor = structuredClone(snapshot);
  Object.defineProperty(hiddenAnchor.points[0][1], 'extra', { value: true });
  assert.throws(() => materializeAnnotatedTextSnapshot(hiddenAnchor, handle, { family }), /point table entry/);
  const symbolFrontierEntry = structuredClone(snapshot);
  symbolFrontierEntry.frontiers[0][0][Symbol('extra')] = true;
  assert.throws(() => materializeAnnotatedTextSnapshot(symbolFrontierEntry, handle, { family }), /frontier table entry/);
  const hiddenFrontier = structuredClone(snapshot);
  Object.defineProperty(hiddenFrontier.frontiers[0], 'extra', { value: true });
  assert.throws(() => materializeAnnotatedTextSnapshot(hiddenFrontier, handle, { family }), /frontier table entry/);
  const hiddenTopLevel = structuredClone(snapshot);
  Object.defineProperty(hiddenTopLevel, 'extra', { value: true });
  assert.throws(() => materializeAnnotatedTextSnapshot(hiddenTopLevel, handle, { family }), /invalid shape/);
});

test('default v3 materialization leaves its input reusable and deeply freezes shallow-frozen descendants', () => {
  const family = importTextToFamily('d1', ACTOR, 'hello world');
  const anchor = ['root'];
  const point = Object.freeze(['point', anchor, 'left']);
  const snapshot = {
    kind: 'workbench.annotatedText.recipient', version: 3, text: 'hello world',
    points: [point], frontiers: [[]], ranges: [['a1', 0, 0, 0, 0]],
    annotations: [{ id: 'a1', family: 'comment', fields: {} }], measurements: [], capabilityHints: [], orphans: [],
  };
  const before = structuredClone(snapshot.ranges);
  const document = materializeAnnotatedTextSnapshot(snapshot, { annotations: { comment: {} } }, { family });
  assert.deepEqual(snapshot.ranges, before);
  assert.ok(Object.isFrozen(anchor));
  assert.ok(Object.isFrozen(document.ranges[0].start));
  assert.equal(document.ranges[0].start, document.ranges[0].end);
});

test('an old v2 client rejects a v3 live replacement and recovers without installing it', async () => {
  let deliver;
  let bootstraps = 0;
  const session = createLiveDeliverySession({
    validateSnapshot(snapshot) {
      if (snapshot.version !== 1 && snapshot.version !== 2) throw new Error('unsupported recipient snapshot version');
      return snapshot;
    },
    bootstrap: async () => ({ kind: 'snapshot', snapshot: { version: 2 }, cursor: ++bootstraps }),
    subscribe: async ({ deliver: next }) => { deliver = next; return { close() {} }; },
    fold: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  await deliver([{ type: 'state', seq: 2, state: { version: 3 } }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bootstraps, 2);
  assert.deepEqual(session.snapshot, { version: 2 });
  session.close();
});

test('fail-closed: v1 never accepts endpoint objects and v2 never accepts numeric offsets', () => {
  const handle = { annotations: { comment: {} } };
  assert.throws(
    () => materializeAnnotatedTextSnapshot({
      kind: 'workbench.annotatedText.recipient', version: 1,
      text: 'hello world',
      ranges: [{
        annotationId: 'a1',
        start: { point: ['point', ['root'], 'left'], basisFrontier: [] },
        end: { point: ['point', ['root'], 'right'], basisFrontier: [] },
      }],
      annotations: [{ id: 'a1', family: 'comment', fields: {} }],
      measurements: [],
    }, handle),
    /offset|endpoint|envelope/i,
  );
  const family = importTextToFamily('d1', ACTOR, 'hello world');
  assert.throws(
    () => materializeAnnotatedTextSnapshot({
      kind: 'workbench.annotatedText.recipient', version: 2,
      text: 'hello world',
      ranges: [{ annotationId: 'a1', start: 6, end: 11 }],
      annotations: [{ id: 'a1', family: 'comment', fields: {} }],
      measurements: [],
    }, handle, { family }),
    /endpoint|envelope/i,
  );
});

test('fully-visible text edits fold as v5', async () => {
  const { db, app, Doc } = setup();
  await app.start();
  await app.ready;
  const created = await app.dispatch({
    actionId: 'create', type: 'Doc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello' }] } },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  const row = db.prepare('SELECT * FROM Doc WHERE id = ?').get('d1');
  const auth = await withAuthoringBinding({
    db, entity: Doc, Document: Doc, row, principal: { id: 'u1' }, fieldName: 'body', descriptor: Doc.fields.body,
  });
  const inserted = await app.dispatch({
    actionId: 'typed', type: 'Doc.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: auth.streamToken, lease: auth.leaseToken, mutationId: 'typed' },
      edit: { kind: 'text.insert', at: { positionToken: auth.documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(inserted.ok, true, inserted.failure?.message);
  const event = db.prepare(`SELECT * FROM _Log WHERE eventType = 'Doc.body.operated' ORDER BY seq`).all().at(-1);
  const document = {
    entity: Doc, fieldName: 'body', descriptor: Doc.fields.body,
    documentId: 'd1', clientNonce: 'x'.repeat(43),
  };
  const envelopes = await tryBuildAnnotatedTextFoldEnvelopes(
    { event: { ...event, data: JSON.parse(event.eventData) }, scope: 'Project:p1', principal: { id: 'u1' }, document },
    { db, document },
  );
  assert.equal(envelopes[0].type, 'event');
  assert.equal(envelopes[0].fold.version, 5);
  await app.shutdown(); db.close();
});

test('a v5 fold applies; a v4 fold recovers by snapshot', async () => {
  const actor = 'b'.repeat(32);
  const { textOperationForOffsetEdit, createTextFamily: createServerFamily, applyTextOperation: applyServerOp } = await import('../build/annotated-text-continuous.mjs');
  let serverFamily = createServerFamily('d1', textCheckpoint(applyTextOp(createTextState(), ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], 'Hello']])));
  const insert = textOperationForOffsetEdit(serverFamily, { kind: 'text.insert', at: { offset: 5, affinity: 'right' }, text: '!' }, 'c'.repeat(32), 2);
  const nextServer = applyServerOp(serverFamily, insert);
  const family = createTextFamily('d1', serverFamily.checkpoint);
  const next = applyTextOperation(family, insert);
  const compact = { id: 'd1', checkpoint: family.checkpoint };
  void nextServer;

  const snapshotRequests = [];
  const sources = [];
  let number = 0;
  const LiveDoc = entity('LiveDocument', {
    project: ref('Project'), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')] }),
  });
  const session = createAnnotatedTextHttpSession({
    baseUrl: 'https://example.test/live-delivery',
    context: { entity: LiveDoc, field: LiveDoc.body, documentId: 'd1' },
    historySession: 'tab-a', createActionId: () => 'action-1',
    fetchImpl: async (url, options) => {
      if (options?.method === 'POST') {
        if (url.includes('/authoring/ack')) return { ok: true, status: 200, json: async () => ({ ok: true, acknowledgedThrough: number }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const cursor = ++number;
      snapshotRequests.push({ cursor });
      return {
        ok: true, status: 200,
        json: async () => ({
          kind: 'snapshot',
          snapshot: {
            body: {
              kind: 'workbench.annotatedText.recipient', version: 1,
              text: number === 1 ? 'Hello' : 'recovered', ranges: [], annotations: [], orphans: [], measurements: [],
            },
          },
          cursor,
          authoring: {
            version: 1, stream: token('stream'), lease: token('lease'), snapshot: token(`snapshot${cursor}`),
            acknowledgementFence: cursor, positionFrames: [{ positionToken: token(`position${cursor}`) }],
            family: compact,
          },
        }),
      };
    },
    eventSourceFactory: () => {
      const source = { close() {}, onmessage: null, onerror: null };
      sources.push(source);
      return source;
    },
  });
  await session.ready;
  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 2, seqSpan: [2, 2],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 2, actionId: 'v5-fold' },
    fold: {
      kind: 'annotatedText', version: 5, field: 'body', baseCursor: 1, fence: 2,
      text: { reducer: 'workbench.text', operations: [insert] },
      projection: { text: materializeText(next) },
      dispositions: [],
      familyElementCount: Object.keys(next.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 2,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot2'),
        positionFrames: [{ positionToken: token('position2') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.document.text, 'Hello!', 'a v5 fold must apply');
  assert.equal(snapshotRequests.length, 1);

  sources[0].onmessage({ data: JSON.stringify([{
    type: 'event', entity: 'Project', id: 'p1', seq: 3, seqSpan: [3, 3],
    event: { type: 'LiveDocument.body.operated', scope: 'Project:p1', seq: 3, actionId: 'v4-fold' },
    fold: {
      kind: 'annotatedText', version: 4, field: 'body', baseCursor: 2, fence: 3,
      text: { reducer: 'workbench.text', operations: [insert] },
      projection: { text: 'Hello!!' },
      dispositions: [],
      familyElementCount: Object.keys(next.checkpoint.elements).length,
      authoring: {
        acknowledgementFence: 3,
        stream: token('stream'), lease: token('lease'), snapshot: token('snapshot3'),
        positionFrames: [{ positionToken: token('position3') }],
      },
    },
  }]) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(snapshotRequests.length >= 2, 'a v4 fold must recover via snapshot');
  assert.equal(session.document.text, 'recovered');
  session.close();
});

test('public projectEndpointToOffset matches the server primitive on a trusted family', () => {
  const actor = 'd'.repeat(32);
  const insert = ['workbench.text', 1, [actor, 1], 1, [], ['insert', ['root'], 'hello world']];
  const checkpoint = textCheckpoint(applyTextOp(createTextState(), insert));
  const serverFamily = importTextToFamily('d1', actor, 'hello world');
  const publicFamily = createTextFamily('d1', checkpoint);
  const start = resolveOffsetToEndpoint(serverFamily, 6, serverFamily.checkpoint.frontier, 'right');
  const end = resolveOffsetToEndpoint(serverFamily, 11, serverFamily.checkpoint.frontier, 'right');
  assert.equal(publicProjectEndpointToOffset(publicFamily, start), 6);
  assert.equal(publicProjectEndpointToOffset(publicFamily, end), 11);
  assert.equal(publicProjectEndpointToOffset(publicFamily, start), serverProjectEndpointToOffset(serverFamily, start));
  const restored = restoreTextFamily({ id: publicFamily.id, checkpoint: publicFamily.checkpoint });
  assert.equal(publicProjectEndpointToOffset(restored, start), 6);
});
