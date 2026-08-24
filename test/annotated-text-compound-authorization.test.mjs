// W3 (#145) slice 4 — policy-owned authorization ordering with instrumented
// no-private-access assertions (scope#992 rev 2 Finding 9 / the authorization
// suite named in #145).
//
// A contribution policy under a composed compound action (and under a native
// annotated insert) exposes authorization REQUIREMENTS; durable history
// evaluates them through the central authorize/admitRow seam BEFORE any
// private fact, event reference, outcome, or result data is read. A
// since-revoked principal therefore gets an opaque 403 `forbidden` on:
//   - a normal (duplicated) dispatch retry,
//   - the first undo and the first redo of a committed compound origin,
//   - same-action-ID undo and redo retries,
//   - a native annotated-insert move retry.
// The instrumented database proves no `_PrivateActionFact` SELECT runs before
// any denial.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL,
  executeFrameworkDDL, grant, read, ref, scope, write,
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
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const ACTOR = 'a'.repeat(32);
const PRINCIPAL = { type: 'user', id: 'u1', attributes: {} };
const SESSION = 'session-1';

// Count every `_PrivateActionFact` SELECT issued through the shared db handle.
// The application, the history engine, and this suite all read through the same
// DatabaseSync object, so a revoked call that issues zero such SELECTs proves
// private material was never touched before denial.
function instrumentPrivateFactReads(db) {
  let reads = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql, ...rest) => {
    if (typeof sql === 'string' && /^\s*SELECT/i.test(sql) && sql.includes('_PrivateActionFact')) {
      reads += 1;
    }
    return originalPrepare(sql, ...rest);
  };
  return () => reads;
}

// ---- compound composed-action fixture (modeled on the W2 composite-move suite) ----

function docEntity() {
  return entity('AuthzMoveDoc', {
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

const authzSchema = defineSqliteSchema({
  name: 'annotated-text-compound-authorization',
  tables: [],
  externalTables: [{ name: 'Project', columns: ['id'] }],
});

function installCompoundSchema(db) {
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
  db.exec("INSERT INTO AuthzMoveDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO AuthzMoveDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'AuthzMoveDoc_body', 'doc-1'));
}

function currentDescriptor(db, { from, to, replacement, transitions = [] }) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'AuthzMoveDoc_body',
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

function buildCompoundApp(db, state) {
  const Document = docEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  return workbench({
    db,
    schema: authzSchema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      // The domain admission gate: `state.revoked` turns the compound action's
      // outer authorization off after the origin committed.
      authorize: () => !state.revoked,
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
          events: [{ type: 'correction.recorded', scope: 'Project:p1', data: { id: 'correction-1' } }],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'correction-1' } },
        };
      },
    }],
  });
}

async function commitCompoundOrigin(app) {
  const origin = await app.dispatch({
    actionId: 'authz-origin', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: PRINCIPAL, clientId: SESSION, history: { session: SESSION },
  });
  assert.equal(origin.ok, true, origin.failure?.message);
  return origin;
}

function assertOpaqueForbidden(outcome) {
  assert.equal(outcome.failure?.category, 'denied', `expected denied, got ${JSON.stringify(outcome.failure)}`);
  assert.equal(outcome.failure?.message, 'Forbidden.');
  assert.equal(Object.hasOwn(outcome, 'events'), false, 'denial must not leak event data');
  assert.equal(Object.hasOwn(outcome, 'deduped'), false, 'denial must not leak dedupe metadata');
  assert.equal(Object.hasOwn(outcome.failure ?? {}, 'events'), false, 'denial failure must not leak events');
}

async function assertOpaqueForbiddenRejection(promise) {
  let error = null;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'expected the move to be rejected');
  assert.equal(error?.status, 403, `expected opaque forbidden, got ${error?.message ?? error}`);
  assert.equal(Object.hasOwn(error, 'events'), false, 'denial must not leak event data');
  assert.equal(Object.hasOwn(error, 'deduped'), false, 'denial must not leak dedupe metadata');
}

// ---- scenario suite over the compound composed action ----

test('a revoked principal is denied on a normal dispatch retry before any private read', async () => {
  const db = new DatabaseSync(':memory:');
  installCompoundSchema(db);
  const state = { revoked: false };
  const count = instrumentPrivateFactReads(db);
  const app = buildCompoundApp(db, state);
  await app.start();
  await commitCompoundOrigin(app);

  const before = count();
  state.revoked = true;
  const retried = await app.dispatch({
    actionId: 'authz-origin', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: PRINCIPAL, clientId: SESSION, history: { session: SESSION },
  });
  assert.equal(retried.ok, false, 'a revoked dispatch retry must fail');
  assertOpaqueForbidden(retried);
  assert.equal(count(), before, '_PrivateActionFact was read before the dispatch denial');
  db.close();
});

test('a revoked principal is denied on the first undo before any private read', async () => {
  const db = new DatabaseSync(':memory:');
  installCompoundSchema(db);
  const state = { revoked: false };
  const count = instrumentPrivateFactReads(db);
  const app = buildCompoundApp(db, state);
  await app.start();
  await commitCompoundOrigin(app);

  const cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  const before = count();
  state.revoked = true;
  await assertOpaqueForbiddenRejection(app.history.undo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-undo-1', revision: cursor.revision,
  }));
  assert.equal(count(), before, '_PrivateActionFact was read before the first-undo denial');
  db.close();
});

test('a revoked principal is denied on the first redo before any private read', async () => {
  const db = new DatabaseSync(':memory:');
  installCompoundSchema(db);
  const state = { revoked: false };
  const count = instrumentPrivateFactReads(db);
  const app = buildCompoundApp(db, state);
  await app.start();
  await commitCompoundOrigin(app);

  // Undo while authorized to give redo a future frame.
  let cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  const undone = await app.history.undo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-undo-1', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);

  cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  const before = count();
  state.revoked = true;
  await assertOpaqueForbiddenRejection(app.history.redo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-redo-1', revision: cursor.revision,
  }));
  assert.equal(count(), before, '_PrivateActionFact was read before the first-redo denial');
  db.close();
});

test('a revoked principal is denied on a same-action-ID undo retry before any private read', async () => {
  const db = new DatabaseSync(':memory:');
  installCompoundSchema(db);
  const state = { revoked: false };
  const count = instrumentPrivateFactReads(db);
  const app = buildCompoundApp(db, state);
  await app.start();
  await commitCompoundOrigin(app);

  let cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  const undone = await app.history.undo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-undo-1', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);

  // Positive control: the same-action-ID retry while authorized dedupes.
  cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  const deduped = await app.history.undo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-undo-1', revision: cursor.revision,
  });
  assert.equal(deduped.deduped, true, 'an authorized same-ID retry dedupes');

  const before = count();
  state.revoked = true;
  await assertOpaqueForbiddenRejection(app.history.undo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-undo-1', revision: cursor.revision,
  }));
  assert.equal(count(), before, '_PrivateActionFact was read before the undo-retry denial');
  db.close();
});

test('a revoked principal is denied on a same-action-ID redo retry before any private read', async () => {
  const db = new DatabaseSync(':memory:');
  installCompoundSchema(db);
  const state = { revoked: false };
  const count = instrumentPrivateFactReads(db);
  const app = buildCompoundApp(db, state);
  await app.start();
  await commitCompoundOrigin(app);

  let cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  await app.history.undo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-undo-1', revision: cursor.revision,
  });
  cursor = await app.history.cursor({ scope: 'Project:p1', principal: PRINCIPAL, session: SESSION });
  const redone = await app.history.redo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-redo-1', revision: cursor.revision,
  });
  assert.equal(redone.ok, true, redone.failure?.message);

  const before = count();
  state.revoked = true;
  await assertOpaqueForbiddenRejection(app.history.redo({
    scope: 'Project:p1', principal: PRINCIPAL, session: SESSION,
    actionId: 'authz-redo-1', revision: cursor.revision,
  }));
  assert.equal(count(), before, '_PrivateActionFact was read before the redo-retry denial');
  db.close();
});

// ---- native annotated insert path through the compiled registry ----

function nativeDeclaration(fieldAccess) {
  const Project = entity('Project', { owner: ref('User'), grant: [scope(() => everyone()).can(() => grant(read, write))] });
  const Document = entity('AuthzNativeDoc', {
    project: ref('Project'),
    owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner' }).can(fieldAccess),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  return { Project, Document };
}

async function setupNative(state) {
  const db = new DatabaseSync(':memory:');
  const { Project, Document } = nativeDeclaration(() => state.revoked ? [] : grant(read, write));
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('alice'), ('bob')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project VALUES ('p1', 'alice')");
  executeDDL(Document, db);
  const app = workbench({
    db,
    schema: defineSqliteSchema({ name: 'annotated-text-compound-authorization-native', tables: [], externalTables: [{ name: 'Project', columns: ['id'] }] }),
    entities: [Project, Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
  });
  await app.start();
  await app.dispatch({
    actionId: 'create', type: 'AuthzNativeDoc.create', principal: { type: 'user', id: 'alice' },
    payload: { id: 'd1', project: 'p1', owner: 'alice', body: { version: 1, blocks: [{ text: 'hello' }] } },
  });
  return { app, db, Document };
}

async function nativeInsert(ctx, actionId, principal, session, offset, textValue) {
  const row = ctx.db.prepare('SELECT * FROM AuthzNativeDoc WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({
    db: ctx.db, entity: ctx.Document, Document: ctx.Document, row, principal,
    fieldName: 'body', descriptor: ctx.Document.fields.body,
  });
  return ctx.app.dispatch({
    actionId, principal, scope: 'Project:p1', history: { session },
    type: 'AuthzNativeDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: actionId },
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset, affinity: 'right' }, text: textValue },
    },
  });
}

test('a revoked field writer is denied on a native annotated move retry before any private read', async () => {
  const state = { revoked: false };
  const { app, db, Document } = await setupNative(state);
  const count = instrumentPrivateFactReads(db);

  const inserted = await nativeInsert({ app, db, Document }, 'alice-insert', { type: 'user', id: 'alice' }, 'tab-a', 5, ' A');
  assert.equal(inserted.ok, true, inserted.failure?.message);

  // Authorized move, then a same-action-ID move retry through the registry.
  let cursor = await app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a' });
  const undone = await app.history.undo({
    scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a',
    actionId: 'alice-undo', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, undone.failure?.message);
  cursor = await app.history.cursor({ scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a' });
  const deduped = await app.history.undo({
    scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a',
    actionId: 'alice-undo', revision: cursor.revision,
  });
  assert.equal(deduped.deduped, true, 'an authorized native same-ID retry dedupes');

  // Revoke the field grant; the retry must now be denied before any private read.
  const before = count();
  state.revoked = true;
  await assertOpaqueForbiddenRejection(app.history.undo({
    scope: 'Project:p1', principal: { type: 'user', id: 'alice' }, session: 'tab-a',
    actionId: 'alice-undo', revision: cursor.revision,
  }));
  assert.equal(count(), before, '_PrivateActionFact was read before the native move-retry denial');
  db.close();
});