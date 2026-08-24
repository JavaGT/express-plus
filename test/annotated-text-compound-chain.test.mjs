// W3 (#145) slice 3 — undo/redo chain integrity (rev 2 Finding 3 ledger
// outcomes; rev 3 §1 CAS contract).
//
//   - Redo compensates the COMPLETED UNDO receipt via a fresh contribution +
//     linkage chain (target = the undo receipt, never the root origin).
//   - An application CAS/transition failure THROWS and rolls the whole move
//     back: no receipt, no private fact, no document event, no cursor movement,
//     no partial durable chain. The compound head stays exactly as it was, and
//     the next legitimate move succeeds from that same head.
//   - Failure injection at multiple move stages proves the same all-or-nothing
//     atomicity (a throw anywhere inside the coordinated move transaction
//     leaves zero durable delta).
//   - Restart/cursor reconstruction: after an applied undo→redo chain the
//     cursor is rebuilt identically from the durable receipts alone (the
//     reconstructed frame chain is one coherent unit per compound action).

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

const chainSchema = defineSqliteSchema({
  name: 'annotated-text-compound-chain',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function declaredEntity() {
  return entity('ChainDoc', {
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
  executeDDL(declaredEntity(), db);
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  db.exec("INSERT INTO ChainDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO ChainDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
  const note = { id: 'note-1', family: 'note', fields: {} };
  db.prepare('INSERT INTO ChainDoc_body_annotation (id, document_id, project_id, owner_id, family) VALUES (?, ?, ?, ?, ?)')
    .run(note.id, 'doc-1', 'p1', 'u1', note.family);
  attachAnnotationRange(db, 'ChainDoc_body', 'doc-1', 'note-1',
    resolveOffsetToEndpoint(family, 0, family.checkpoint.frontier, 'left'),
    resolveOffsetToEndpoint(family, 5, family.checkpoint.frontier, 'right'),
    0,
  );
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'ChainDoc_body', 'doc-1'));
}

function currentDescriptor(db) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'ChainDoc_body',
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
  const closure = computeAffectedClosure({ annotations: regionImages, family, from: 0, to: 5, namedIds: [] });
  const coveredIds = [];
  for (const image of closure) {
    for (const entry of image.memberships) {
      const start = projectEndpointToOffset(family, entry.start);
      const end = projectEndpointToOffset(family, entry.end);
      if (Math.min(end, 5) - Math.max(start, 0) > 0) { coveredIds.push(image.id); break; }
    }
  }
  return {
    version: 10,
    kind: 'region.edit',
    id: 'doc-1',
    basis: textFamilyBasis(family),
    from: 0,
    to: 5,
    coveredTextDigest: sha256Utf8(materializeText(family).slice(0, 5)),
    affectedClosureDigest: digestAffectedClosure(closure),
    expectedCoveredAnnotationIds: coveredIds.sort(),
    replacement: 'hallo',
    transitions: [{ kind: 'range.set', annotationId: 'note-1', ranges: [{ start: 0, end: 5 }] }],
  };
}

function buildApp(db, state) {
  const Document = declaredEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  return workbench({
    db,
    schema: chainSchema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      handler: ({ payload, history }) => {
        if (history?.input && history.input.version === 1) {
          if (state.failureMode === 'throw') {
            throw new Error('injected move failure at the handler stage');
          }
          if (state.failureMode === 'divergent') {
            // Shape-valid but semantically divergent application fact: after
            // does not equal the translated replacement.
            return {
              events: [],
              applicationTransition: { before: history.input.expected, after: { divergent: true } },
            };
          }
          return {
            events: [],
            applicationTransition: { before: history.input.expected, after: history.input.replacement },
          };
        }
        const descriptor = currentDescriptor(db);
        return {
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: payload.actionRef } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: payload.actionRef } },
        };
      },
    }],
  });
}

async function commitOrigin(app) {
  const origin = await app.dispatch({
    actionId: 'chain-origin', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1', actionRef: 'chain-origin' }, principal: ALICE, clientId: 'tab-a', history: { session: 'tab-a' },
  });
  assert.equal(origin.ok, true, origin.failure?.message);
}

async function cursorOf(app) {
  return app.history.cursor({ scope: 'Project:p1', principal: ALICE, session: 'tab-a' });
}

// Try a move and capture either its outcome or its rejection; never throw.
async function settle(promise) {
  try {
    return { outcome: await promise };
  } catch (error) {
    return { error };
  }
}

function durableSnapshot(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}

test('tampered v16 target event blocks a compound move with zero durable delta', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const state = { failureMode: 'none' };
  const app = buildApp(db, state);
  await app.start();
  await commitOrigin(app);

  const target = db.prepare("SELECT eventData FROM _Log WHERE actionId = 'chain-origin' AND eventType = 'ChainDoc.body.operated'").get();
  assert.equal(typeof target?.eventData, 'string');
  const tampered = target.eventData.replace(/^\{/, '{"version":16,');
  assert.notEqual(tampered, target.eventData);
  db.prepare("UPDATE _Log SET eventData = ? WHERE actionId = 'chain-origin' AND eventType = 'ChainDoc.body.operated'").run(tampered);

  const cursor = await cursorOf(app);
  const before = durableSnapshot(db);
  const documentBefore = materializeText(liveFamily(db));
  const moved = await settle(app.history.undo({
    scope: 'Project:p1', principal: ALICE, session: 'tab-a',
    actionId: 'tampered-undo', revision: cursor.revision,
  }));
  assert.equal(Boolean(moved.error) || moved.outcome?.ok === false, true, 'tampered v16 must fail the history move');
  const message = moved.error?.message ?? moved.outcome?.failure?.message ?? '';
  assert.match(String(message), /canonical|internal|invalid/i, 'strict decoder failure must propagate as a failed move');
  assert.deepEqual(durableSnapshot(db), before, 'tampered target left zero durable delta in every table');
  assert.equal(materializeText(liveFamily(db)), documentBefore, 'document state did not move');
  assert.deepEqual(await cursorOf(app), cursor, 'history cursor did not advance');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _ActionReceipt WHERE actionId = 'tampered-undo'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _PrivateActionFact WHERE actionId = 'tampered-undo'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _Log WHERE actionId = 'tampered-undo'").get().c, 0);
  db.close();
});

test('a semantically divergent application fact throws and rolls the whole move back', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const state = { failureMode: 'none' };
  const app = buildApp(db, state);
  await app.start();
  await commitOrigin(app);
  assert.equal(materializeText(liveFamily(db)), 'hallo world');
  const before = {
    receipts: db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt').get().c,
    facts: db.prepare('SELECT COUNT(*) AS c FROM _PrivateActionFact').get().c,
    log: db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c,
  };

  // A shape-valid but semantically divergent correction fact fails the package
  // CAS validator (rev 3 §1) and must leave no partial durable chain.
  const cursor = await cursorOf(app);
  state.failureMode = 'divergent';
  const settled = await settle(app.history.undo({
    scope: 'Project:p1', principal: ALICE, session: 'tab-a',
    actionId: 'broken-undo', revision: cursor.revision,
  }));
  // The CAS failure must fail the move closed (opaque sanitized outcome or a
  // thrown mismatch) — never an ok outcome.
  const failed = settled.error ? true : settled.outcome?.ok === false;
  assert.equal(failed, true, 'the divergent application fact must fail the move');
  const failedOutcome = settled.outcome;
  if (failedOutcome) {
    assert.equal(failedOutcome.ok, false);
    assert.match(String(failedOutcome.failure?.message ?? ''), /Internal|mismatch|transition/i);
  }
  const after = {
    receipts: db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt').get().c,
    facts: db.prepare('SELECT COUNT(*) AS c FROM _PrivateActionFact').get().c,
    log: db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c,
  };
  assert.deepEqual(after, before, 'the CAS failure left zero durable writes');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _ActionReceipt WHERE actionId = 'broken-undo'").get().c, 0, 'no receipt for the failed move');
  assert.equal(materializeText(liveFamily(db)), 'hallo world', 'the document did not move');
  assert.deepEqual(await cursorOf(app), { undo: 1, redo: 0, revision: cursor.revision }, 'the cursor did not move');

  // The compound chain was not poisoned: the same head is still safely
  // compensable and the next legitimate undo applies.
  state.failureMode = 'none';
  const goodCursor = await cursorOf(app);
  const undone = await app.history.undo({
    scope: 'Project:p1', principal: ALICE, session: 'tab-a',
    actionId: 'good-undo', revision: goodCursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);
  assert.equal(materializeText(liveFamily(db)), 'hello world', 'the follow-up undo applied from the same head');
  db.close();
});

test('failure injection at every move stage leaves zero partial durable chains', async () => {
  for (const failureMode of ['throw', 'divergent']) {
    const db = new DatabaseSync(':memory:');
    installSchema(db);
    const state = { failureMode: 'none' };
    const app = buildApp(db, state);
    await app.start();
    await commitOrigin(app);
    const before = {
      receipts: db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt').get().c,
      facts: db.prepare('SELECT COUNT(*) AS c FROM _PrivateActionFact').get().c,
      log: db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c,
    };
    const cursor = await cursorOf(app);
    state.failureMode = failureMode;
    await settle(app.history.undo({
      scope: 'Project:p1', principal: ALICE, session: 'tab-a',
      actionId: `inj-${failureMode}`, revision: cursor.revision,
    }));
    const after = {
      receipts: db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt').get().c,
      facts: db.prepare('SELECT COUNT(*) AS c FROM _PrivateActionFact').get().c,
      log: db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c,
    };
    assert.deepEqual(after, before, `injected ${failureMode} must leave zero durable delta`);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt WHERE actionId = ?').get(`inj-${failureMode}`).c, 0);
    assert.deepEqual(await cursorOf(app), { undo: 1, redo: 0, revision: cursor.revision }, `cursor unchanged after ${failureMode}`);
    db.close();
  }
});

test('an applied undo→redo chain survives cursor reconstruction from durable receipts', async () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const state = { failureMode: 'none' };
  const app = buildApp(db, state);
  await app.start();
  await commitOrigin(app);

  let cursor = await cursorOf(app);
  const undone = await app.history.undo({
    scope: 'Project:p1', principal: ALICE, session: 'tab-a',
    actionId: 'chain-undo', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);
  cursor = await cursorOf(app);
  const redone = await app.history.redo({
    scope: 'Project:p1', principal: ALICE, session: 'tab-a',
    actionId: 'chain-redo', revision: cursor.revision,
  });
  assert.equal(redone.ok, true, redone.failure?.message);
  assert.equal(materializeText(liveFamily(db)), 'hallo world');

  // The redo compensated the completed undo receipt (linkage chain).
  const redoReceipt = db.prepare("SELECT historyRootActionId, historyTargetActionId, historyOutcome FROM _ActionReceipt WHERE actionId = 'chain-redo'").get();
  assert.equal(redoReceipt.historyRootActionId, 'chain-origin');
  assert.equal(redoReceipt.historyTargetActionId, 'chain-undo', 'redo targets the completed undo receipt');
  assert.equal(redoReceipt.historyOutcome, 'applied');

  // Simulate a restart: drop the cursor row so the next cursor read must
  // reconstruct the frame chain purely from the durable receipts.
  db.prepare("DELETE FROM _HistoryCursor WHERE scope = 'Project:p1' AND sessionId = 'tab-a'").run();
  const rebuilt = await cursorOf(app);
  assert.deepEqual(rebuilt, { undo: 1, redo: 0, revision: '{"past":[{"rootActionId":"chain-origin","headActionId":"chain-redo"}],"future":[]}' }, 'cursor reconstruction restores the applied chain as one frame');
  db.close();
});
