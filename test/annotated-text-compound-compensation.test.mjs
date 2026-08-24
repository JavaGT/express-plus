// W3 (#145) slice 2 — APPLIED compound document compensation through the
// contribution-policy planner (scope#992 rev 2 Finding 3 applied branch).
//
// The W2 adapter always stored a whole-compound noop; W3 replaces it with the
// real applied path: the policy plans the inverse of the TARGET receipt's
// region against CURRENT state (locating the target's inserted scalars by
// opId), emits a fresh v16 operated compensation event through W1's reducer
// machinery, and stores an `applied` compensation envelope with linkage.
//
// Acceptance here:
//   - edit → later collaborator insertion → undo → redo keeps the collaborator
//     content and restores same-ID annotation memberships;
//   - created annotations are removed by undo and recreated by redo;
//   - removed annotations are recreated by undo and removed by redo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  resolveOffsetToEndpoint,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { readAnnotatedTextFamilyCheckpoint } from '../build/annotated-text-authoring-stream.mjs';
import { attachAnnotationRange, loadAnnotationImages } from '../build/annotated-text-storage.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
} from '../build/annotated-text-region-reducer.mjs';
import { annotatedTextOperation } from '../build/annotated-text-region-operation.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);
const ALICE = { type: 'user', id: 'u1', attributes: {} };
const BOB = { type: 'user', id: 'u2', attributes: {} };

const compSchema = defineSqliteSchema({
  name: 'annotated-text-compound-compensation',
  tables: [],
  externalTables: [
    { name: 'Project', columns: ['id'] },
  ],
});

function declaredEntity() {
  return entity('CompDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('note', { fields: {} }),
      ],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function installSchema(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1'), ('u2')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(declaredEntity(), db);
}

function membershipOf(family, start, end) {
  return {
    ordinal: 0,
    start: resolveOffsetToEndpoint(family, start, family.checkpoint.frontier, 'left'),
    end: resolveOffsetToEndpoint(family, end, family.checkpoint.frontier, 'right'),
  };
}

function seedDocument(db, { text, annotations = [] }) {
  const family = importTextToFamily('doc-1', ACTOR, text);
  db.exec("INSERT INTO CompDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO CompDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
  for (const image of annotations) {
    db.prepare('INSERT INTO CompDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
      .run(image.id, 'doc-1', 'p1', 'u1', image.family);
    for (const entry of image.memberships) {
      attachAnnotationRange(db, 'CompDoc_body', 'doc-1', image.id, entry.start, entry.end, entry.ordinal);
    }
  }
  return family;
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'CompDoc_body', 'doc-1'));
}

function liveText(db) {
  return materializeText(liveFamily(db));
}

function liveMemberships(db, id) {
  const images = loadAnnotationImages(db, {
    prefix: 'CompDoc_body',
    documentId: 'doc-1',
    declarations: [{ annotationName: 'note', fields: {} }],
  });
  const image = images.find((candidate) => candidate.id === id);
  if (!image) return null;
  const family = liveFamily(db);
  return image.memberships.map((entry) => [
    projectEndpointToOffset(family, entry.start),
    projectEndpointToOffset(family, entry.end),
  ]);
}

function currentDescriptor(db, { from, to, replacement, transitions = [] }) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'CompDoc_body',
    documentId: 'doc-1',
    declarations: [{ annotationName: 'note', fields: {} }],
  });
  const regionImages = baseImages.map((image) => ({
    id: image.id,
    family: image.family,
    fields: image.fields,
    protectedTargetIds: image.protectedTargetIds,
    memberships: image.memberships,
    prerequisites: image.prerequisites,
    empty: 'delete',
    cardinality: 'many',
  }));
  const namedIds = transitions.map((transition) => (
    transition.kind === 'create' ? transition.annotation.id : transition.annotationId
  ));
  const closure = computeAffectedClosure({ annotations: regionImages, family, from, to, namedIds });
  const coveredIds = [];
  for (const image of closure) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, to) - Math.max(start, from) > 0) { coveredIds.push(image.id); break; }
    }
  }
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from,
    to,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(from, to)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIds.sort(),
    replacement,
    transitions,
  };
}

function buildApp(db) {
  const Document = declaredEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  return workbench({
    db,
    schema: compSchema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      handler: ({ payload, history }) => {
        if (history?.input && history.input.version === 1) {
          return {
            events: [],
            applicationTransition: { before: history.input.expected, after: history.input.replacement },
          };
        }
        if (payload.variant === 'origin-replace') {
          const descriptor = currentDescriptor(db, {
            from: 0, to: 5, replacement: 'hallo',
            transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
          });
          return {
            events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: payload.actionRef } }],
            annotatedText: [region.region(descriptor)],
            applicationTransition: { before: null, after: { correctionId: payload.actionRef } },
          };
        }
        if (payload.variant === 'origin-swap') {
          const descriptor = currentDescriptor(db, {
            from: 0, to: 5, replacement: 'hallo',
            transitions: [
              { kind: 'remove', annotationId: 'note-1' },
              { kind: 'create', annotation: { id: 'note-2', family: 'note', fields: {}, protectedTargetIds: [] }, ranges: [{ start: 0, end: 5 }] },
            ],
          });
          return {
            events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: payload.actionRef } }],
            annotatedText: [region.region(descriptor)],
            applicationTransition: { before: null, after: { correctionId: payload.actionRef } },
          };
        }
        // Collaborator insert after the origin region.
        const descriptor = currentDescriptor(db, { from: 10, to: 10, replacement: 'X' });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: payload.actionRef } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: payload.actionRef } },
        };
      },
    }],
  });
}

function setupDoc({ withNote, withNote2 } = { withNote: true, withNote2: false }) {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  const annotations = [];
  if (withNote) annotations.push({ id: 'note-1', family: 'note', fields: {}, memberships: [membershipOf(family, 0, 5)] });
  if (withNote2) annotations.push({ id: 'note-2', family: 'note', fields: {}, memberships: [membershipOf(family, 0, 5)] });
  seedDocument(db, { text: 'hello world', annotations });
  return db;
}

async function dispatch(app, principal, session, actionId, variant) {
  const result = await app.dispatch({
    actionId, type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1', variant, actionRef: actionId }, principal, clientId: session, history: { session },
  });
  assert.equal(result.ok, true, `${actionId} failed: ${result.failure?.message}`);
  return result;
}

async function move(app, operation, principal, session, actionId) {
  const cursor = await app.history.cursor({ scope: 'Project:p1', principal, session });
  const result = await app.history[operation]({
    scope: 'Project:p1', principal, session, actionId, revision: cursor.revision,
  });
  assert.equal(result.ok, true, `${operation} failed: ${result.failure?.message}`);
  return result;
}

test('undo keeps a later collaborator insertion and restores same-ID memberships; redo reapplies', async () => {
  const db = setupDoc({ withNote: true });
  const app = buildApp(db);
  await app.start();

  await dispatch(app, ALICE, 'tab-a', 'origin', 'origin-replace');
  assert.equal(liveText(db), 'hallo world');
  assert.deepEqual(liveMemberships(db, 'note-1'), [[0, 5]], 'origin re-ranges note-1 over the replacement');

  // Unrelated later collaborator insertion through the same compound action.
  await dispatch(app, BOB, 'tab-b', 'bob-insert', 'collab-insert');
  assert.equal(liveText(db), 'hallo worlXd', 'bob inserts X at offset 10');

  // Undo alice's origin: only her contribution moves; bob's X survives.
  await move(app, 'undo', ALICE, 'tab-a', 'alice-undo');
  assert.equal(liveText(db), 'hello worlXd', 'undo restores the original text and keeps the collaborator insert');
  assert.deepEqual(liveMemberships(db, 'note-1'), [[0, 5]], 'same-ID note-1 memberships restored over the original text');

  const undoReceipt = db.prepare("SELECT fact, historyOutcome FROM _ActionReceipt r JOIN _PrivateActionFact p ON p.actionId = r.actionId WHERE r.actionId = 'alice-undo'").get();
  const undoFact = JSON.parse(undoReceipt.fact);
  assert.equal(undoFact.kind, 'workbench.compound-compensation');
  assert.equal(undoFact.linkage.outcome, 'applied');
  assert.equal(undoFact.linkage.direction, 'undo');
  assert.equal(undoFact.linkage.rootActionId, 'origin');
  assert.equal(undoFact.linkage.targetActionId, 'origin');
  assert.equal(undoFact.contributions.length, 1, 'the undo stored its own fresh compensation contribution');

  // Redo compensates the completed undo receipt (fresh contribution + linkage).
  const redone = await move(app, 'redo', ALICE, 'tab-a', 'alice-redo');
  assert.equal(liveText(db), 'hallo worlXd', 'redo reapplies the replacement and keeps the collaborator insert');
  assert.deepEqual(liveMemberships(db, 'note-1'), [[0, 5]], 'note-1 stays same-ID over the reapplied replacement');

  const redoFact = JSON.parse(db.prepare("SELECT fact FROM _PrivateActionFact WHERE actionId = 'alice-redo'").get().fact);
  assert.equal(redone.ok, true);
  assert.equal(redoFact.kind, 'workbench.compound-compensation');
  assert.equal(redoFact.linkage.outcome, 'applied');
  assert.equal(redoFact.linkage.direction, 'redo');
  assert.equal(redoFact.linkage.rootActionId, 'origin');
  assert.equal(redoFact.linkage.targetActionId, 'alice-undo', 'redo targets the completed undo receipt');
  db.close();
});

test('undo removes created annotations and recreates removed ones; redo reverses', async () => {
  const db = setupDoc({ withNote: true });
  const app = buildApp(db);
  await app.start();

  await dispatch(app, ALICE, 'tab-a', 'origin', 'origin-swap');
  assert.equal(liveText(db), 'hallo world');
  assert.equal(liveMemberships(db, 'note-1'), null, 'origin removed note-1');
  assert.deepEqual(liveMemberships(db, 'note-2'), [[0, 5]], 'origin created note-2');

  await move(app, 'undo', ALICE, 'tab-a', 'alice-undo');
  assert.equal(liveText(db), 'hello world');
  assert.deepEqual(liveMemberships(db, 'note-1'), [[0, 5]], 'undo recreates the removed annotation with same memberships');
  assert.equal(liveMemberships(db, 'note-2'), null, 'undo removes the origin-created annotation');

  await move(app, 'redo', ALICE, 'tab-a', 'alice-redo');
  assert.equal(liveText(db), 'hallo world');
  assert.equal(liveMemberships(db, 'note-1'), null, 'redo removes note-1 again');
  assert.deepEqual(liveMemberships(db, 'note-2'), [[0, 5]], 'redo recreates note-2 again');
  db.close();
});