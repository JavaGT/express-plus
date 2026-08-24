// W2 demonstrable compound inverse/redo outcome through the REAL durable-
// history engine (scope#992 rev 2 Finding 3 / rev 3 §1). The composed action is
// cursor-eligible with a registered inverse/redo; a move re-dispatches the outer
// action with handler-only compound input in the coordinated transaction. The
// W2-owned adapter stores the explicit whole-compound no-op compensation
// envelope (zero document events, lineage preserved, cursor advanced) — never a
// snapshot restore. The applied document-compensation algebra (policy planning +
// operated contribution) is W3 #145's contribution-policy flip; W2 proves the
// no-op move commits atomically as one receipt + one compensation envelope.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL,
  executeFrameworkDDL, grant, read, ref, scope, text, write,
} from '../build/internal.mjs';
import { defineSqliteSchema } from '../build/server.mjs';
import {
  importTextToFamily,
  materializeText,
  projectEndpointToOffset,
  restoreTextFamilySerialized,
  serializeCompactTextFamilyCheckpoint,
  textFamilyBasis,
} from '../build/annotated-text-continuous.mjs';
import { readAnnotatedTextFamilyCheckpoint } from '../build/annotated-text-authoring-stream.mjs';
import { loadAnnotationImages } from '../build/annotated-text-storage.mjs';
import {
  computeAffectedClosure,
  digestAffectedClosure,
} from '../build/annotated-text-region-reducer.mjs';
import { annotatedTextOperation } from '../build/annotated-text-region-operation.mjs';
import { sha256Utf8 } from '../build/annotated-text-region-limits.mjs';

const ACTOR = 'a'.repeat(32);

function docEntity() {
  return entity('MoveDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
    }).can(() => grant(read, write)),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

const moveSchema = defineSqliteSchema({
  name: 'annotated-text-composite-move',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function installSchema(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(docEntity(), db);
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  db.exec("INSERT INTO MoveDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO MoveDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'MoveDoc_body', 'doc-1'));
}

function currentDescriptor(db, { from, to, replacement, transitions = [] }) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'MoveDoc_body',
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
  const closure = computeAffectedClosure({ annotations: regionImages, family, from, to, namedIds: [] });
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

test('a composed undo move commits one no-op compensation envelope atomically', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = docEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: moveSchema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      // In history mode the handler returns ONLY the application transition
      // (rev 3: handler performs its domain CAS and returns the inverse fact);
      // the W2 adapter stores the whole-compound no-op with lineage.
      handler: ({ payload, history }) => {
        void payload;
        if (history?.input && history.input.version === 1) {
          // rev 3: the handler returns its inverse as { before: expected,
          // after: replacement } — no document contribution in W2's no-op path.
          return {
            events: [],
            applicationTransition: { before: history.input.expected, after: history.input.replacement },
          };
        }
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();

  const principal = { type: 'user', id: 'u1', attributes: {} };
  const session = 'session-1';
  const origin = await app.dispatch({
    actionId: 'composed-origin', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal,
    clientId: session, history: { session },
  });
  assert.equal(origin.ok, true, origin.failure?.message);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2);
  assert.equal(materializeText(liveFamily(db)), 'hallo world');

  const cursor = await app.history.cursor({ scope: 'Project:p1', principal, session });
  assert.equal(cursor.undo, 1, 'the composed origin occupies one cursor frame');

  // The W2 adapter's history input is the application transition the MOVE's
  // translator registered (undo of origin: expected = correction, replacement =
  // null). The handler receives it and returns it unchanged.
  const undone = await app.history.undo({
    scope: 'Project:p1', principal, session,
    actionId: 'composed-undo-1', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);
  // One zero-event receipt for the move; the document and ledger did not move.
  const moveReceipt = db.prepare("SELECT * FROM _ActionReceipt WHERE actionId = 'composed-undo-1'").get();
  assert.ok(moveReceipt, 'the move wrote its own receipt');
  assert.equal(JSON.parse(moveReceipt.eventRefs).length, 0, 'no document events on the no-op move');
  assert.equal(moveReceipt.historyOutcome, 'noop');
  // Document text unchanged: no snapshot restore, no partial document move.
  assert.equal(materializeText(liveFamily(db)), 'hallo world', 'the document contribution stayed put on the no-op move');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 2, 'no new _Log rows on the move');
  // One compensation envelope with lineage, one receipt, one cursor advance.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM _PrivateActionFact WHERE scope = 'Project:p1' AND actionId = 'composed-undo-1'").get().count, 1);
  const compensation = JSON.parse(db.prepare('SELECT fact FROM _PrivateActionFact WHERE actionId = ?').get('composed-undo-1').fact);
  assert.equal(compensation.kind, 'workbench.compound-compensation');
  assert.equal(compensation.linkage.outcome, 'noop');
  assert.equal(compensation.linkage.direction, 'undo');
  assert.equal(compensation.linkage.rootActionId, 'composed-origin');
  assert.deepEqual(compensation.application, { before: { correctionId: 'correction-1' }, after: null });
  const cursorAfter = await app.history.cursor({ scope: 'Project:p1', principal, session });
  assert.equal(cursorAfter.undo, 0, 'the undo move drained the cursor frame');
  assert.equal(cursorAfter.redo, 1, 'the undo move pushed a redo frame');
  db.close();
});

test('a composed redo of a no-op move stays a whole-compound no-op', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = docEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: moveSchema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      handler: ({ payload, history }) => {
        void payload;
        if (history?.input && history.input.version === 1) {
          return {
            events: [],
            applicationTransition: { before: history.input.expected, after: history.input.replacement },
          };
        }
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
  await app.start();
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const session = 'session-1';
  const origin = await app.dispatch({
    actionId: 'composed-origin-r', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal, clientId: session, history: { session },
  });
  assert.equal(origin.ok, true, origin.failure?.message);
  let cursor = await app.history.cursor({ scope: 'Project:p1', principal, session });
  const undone = await app.history.undo({
    scope: 'Project:p1', principal, session,
    actionId: 'composed-undo-r', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);
  cursor = await app.history.cursor({ scope: 'Project:p1', principal, session });
  const redone = await app.history.redo({
    scope: 'Project:p1', principal, session,
    actionId: 'composed-redo-r', revision: cursor.revision,
  });
  assert.equal(redone.ok, true, redone.failure?.message);
  const redoReceipt = db.prepare("SELECT actionId, historyOutcome, eventRefs FROM _ActionReceipt WHERE actionId = 'composed-redo-r'").get();
  assert.equal(redoReceipt.historyOutcome, 'noop');
  assert.equal(JSON.parse(redoReceipt.eventRefs).length, 0);
  assert.equal(materializeText(liveFamily(db)), 'hallo world', 'redo of a no-op leaves the document untouched');
  cursor = await app.history.cursor({ scope: 'Project:p1', principal, session });
  assert.equal(cursor.undo, 1, 'redo returned the frame to past');
  assert.equal(cursor.redo, 0);
  db.close();
});