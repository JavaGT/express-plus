// W2 deletion-mutation focused tests (scope#992 Finding 8). Each test PASSES
// on the real build and FAILS with the named signature when the corresponding
// deletion mutation is applied to a temporary copy. Run individually by the
// deletion harness via --test-name-pattern.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, durableHistory, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, read, ref, scope, write, deny,
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

function declaredEntity(fieldAccess = null) {
  const annotatedField = fieldAccess
    ? annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
    }).can(() => fieldAccess())
    : annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [annotation('note', { fields: {} })],
    }).can(() => grant(read, write));
  return entity('DelDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedField,
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

const delSchema = defineSqliteSchema({
  name: 'annotated-text-composite-deletion',
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
  executeDDL(declaredEntity(), db);
  const family = importTextToFamily('doc-1', ACTOR, 'hello world');
  db.exec("INSERT INTO DelDoc (id, project, owner) VALUES ('doc-1', 'p1', 'u1')");
  db.prepare('INSERT INTO DelDoc_body_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)')
    .run('doc-1', 1, serializeCompactTextFamilyCheckpoint(family));
}

function liveFamily(db) {
  return restoreTextFamilySerialized(readAnnotatedTextFamilyCheckpoint(db, 'DelDoc_body', 'doc-1'));
}

function currentDescriptor(db, { from, to, replacement, transitions = [] }) {
  const family = liveFamily(db);
  const baseImages = loadAnnotationImages(db, {
    prefix: 'DelDoc_body',
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

test('undeclared operation remains undeclared when the compiled handles are cleared', async () => {
  // remove-operation-declaration: clearing the compiled operation handles makes
  // the pipeline reject the annotatedText return with
  // 'undeclared annotated operation was admitted'. On the real build the
  // declared operation is admitted and this dispatch succeeds; the mutation
  // must make it fail with the signature.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = declaredEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: delSchema,
    entities: [Document],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => {
        const descriptor = currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] });
        return {
          events: [],
          annotatedText: [region.region(descriptor)],
          applicationTransition: { before: null, after: { correctionId: 'c-1' } },
        };
      },
    }],
  });
  await app.start();
  const result = await app.dispatch({
    actionId: 'declared-op', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1', attributes: {} },
  });
  assert.equal(result.ok, true, 'undeclared annotated operation was admitted');
  const stored = JSON.parse(db.prepare('SELECT fact FROM _PrivateActionFact').get().fact);
  assert.equal(stored.kind, 'workbench.compound-origin');
  db.close();
});

test('revoked field writer is denied the composite operation', async () => {
  // bypass-field-readmission: forcing field admission true lets a principal
  // whose field `.can` denies write commit the composed operation. On the real
  // build the field admission rejects before any write; the mutation must make
  // the dispatch succeed and this assertion fail.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = declaredEntity(() => deny('no write for you'));
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: delSchema,
    entities: [Document],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => ({
        events: [],
        annotatedText: [region.region(currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] }))],
        applicationTransition: { before: null, after: { correctionId: 'c-1' } },
      }),
    }],
  });
  await app.start();
  const result = await app.dispatch({
    actionId: 'revoked-field', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1' },
  });
  assert.equal(result.ok, false, 'revoked field writer committed composite operation');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact').get().count, 0);
  db.close();
});

test('semantically divergent application fact is rejected', async () => {
  // trust-returned-application-transition: bypassing the canonical-equality
  // check accepts an application transition whose before equals after. On the
  // real build the origin gate rejects it; the mutation must make it accepted.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = declaredEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: delSchema,
    entities: [Document],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => ({
        events: [],
        annotatedText: [region.region(currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] }))],
        applicationTransition: { before: { correctionId: 'c-1' }, after: { correctionId: 'c-1' } },
      }),
    }],
  });
  await app.start();
  const result = await app.dispatch({
    actionId: 'divergent-fact', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1' },
  });
  assert.equal(result.ok, false, 'semantically divergent application fact was accepted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _PrivateActionFact').get().count, 0);
  db.close();
});

test('a valid compound envelope reaches _PrivateActionFact', async () => {
  // remove-compound-private-fact-canonicalizer: removing the compound branch
  // from canonicalPrivateFact makes a valid envelope fail the top-level
  // before/after gate. On the real build the envelope is stored; the mutation
  // must make this assertion fail.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = declaredEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: delSchema,
    entities: [Document],
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      operations: [region],
      handler: () => ({
        events: [],
        annotatedText: [region.region(currentDescriptor(db, { from: 0, to: 5, replacement: 'hallo', transitions: [] }))],
        applicationTransition: { before: null, after: { correctionId: 'c-1' } },
      }),
    }],
  });
  await app.start();
  const result = await app.dispatch({
    actionId: 'valid-envelope', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal: { type: 'user', id: 'u1' },
  });
  assert.equal(result.ok, true, 'valid compound envelope did not reach _PrivateActionFact');
  const stored = db.prepare('SELECT fact FROM _PrivateActionFact').get();
  assert.ok(stored, 'valid compound envelope did not reach _PrivateActionFact');
  assert.equal(JSON.parse(stored.fact).kind, 'workbench.compound-origin');
  db.close();
});

test('a composed action is a history barrier when its contribution policy is removed', async () => {
  // remove-contribution-policy: dropping the compiled compound policy from the
  // registry makes the move refuse to interpret the compound origin generically,
  // failing with 'compound action remained history eligible without its policy'.
  // On the real build the composed origin is moved by the policy path and this
  // test passes; the mutation must make the move fail with the signature.
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const Document = declaredEntity();
  const region = annotatedTextOperation(Document, { fieldName: 'body' });
  const app = workbench({
    db,
    schema: delSchema,
    entities: [Document],
    history: durableHistory({ authorize: () => true, actions: {} }),
    actions: [{
      type: 'correction.apply',
      authorize: () => true,
      history: { cursor: 'eligible' },
      operations: [region],
      handler: ({ history }) => {
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
          applicationTransition: { before: null, after: { correctionId: 'c-1' } },
        };
      },
    }],
  });
  await app.start();
  const principal = { type: 'user', id: 'u1', attributes: {} };
  const origin = await app.dispatch({
    actionId: 'policy-origin', type: 'correction.apply', scope: 'Project:p1',
    payload: { id: 'doc-1' }, principal, clientId: 'tab-a', history: { session: 'tab-a' },
  });
  assert.equal(origin.ok, true, origin.failure?.message);
  const cursor = await app.history.cursor({ scope: 'Project:p1', principal, session: 'tab-a' });
  const undone = await app.history.undo({
    scope: 'Project:p1', principal, session: 'tab-a',
    actionId: 'policy-undo', revision: cursor.revision,
  });
  assert.equal(undone.ok, true, 'compound action remained history eligible without its policy');
  db.close();
});