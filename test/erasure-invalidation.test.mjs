// Phase B erasure-invalidation tests (#134, delete-undo design §5/§9/§11).
//
// Covers the design §9 erasure-invalidation matrix: v2 typed-subject
// directives invalidate dependent v3 delete facts and prune cursor frames;
// v1 directives cannot certify invalidation; erase-after-cursor-read fails
// closed at move time via prerequisite liveness; unrelated facts stay
// undoable; the dependency index stays exactly aligned with
// `_PrivateActionFact`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { generateFrameworkDDL } from '../build/ddl.mjs';
import {
  applyTextOperation,
  importTextToFamily,
} from '../build/annotated-text-continuous.mjs';
import { canonicalTextOp } from '../build/annotated-text.mjs';
import {
  captureDeleteContribution,
  planDeleteUndo,
  serializeDeleteFact,
} from '../build/annotated-text-delete-history.mjs';
import {
  applyErasureDirective,
  erasureDirective,
  erasureDirectivePreparation,
} from '../build/erasure-directive.mjs';
import { prepareErasureDirective } from '../build/erasure-directive.mjs';
import {
  factDependencies,
  invalidateDependencies,
  recordFactDependencies,
  sweepFactDependencies,
} from '../build/private-action-fact-dependency.mjs';
import { frameworkTableNamesWithoutAuthCompile } from '../build/framework-table-names.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function insertOp(family, actor, lamport, anchor, textValue) {
  const deps = family.checkpoint.frontier.filter(([a]) => a < actor);
  if (lamport > 1) deps.push([actor, lamport - 1]);
  for (const [a, c] of family.checkpoint.frontier) if (a > actor) deps.push([a, c]);
  return applyTextOperation(family, canonicalTextOp(['workbench.text', 1, [actor, lamport], lamport, deps, ['insert', anchor, textValue]]));
}

/** A real captured v3 delete fact: "hello" inserted by A:1, fully deleted. */
function deleteFact({ documentId = 'd1', prerequisites = [] } = {}) {
  let family = importTextToFamily(documentId, A, '');
  family = insertOp(family, A, 1, ['root'], 'hello');
  const mkEndpoint = (ordinal, affinity) => ({
    point: ['point', ['element', [[A, 1], ordinal]], affinity ?? 'left'],
    basisFrontier: [],
  });
  return captureDeleteContribution({
    documentId,
    family,
    fromUtf16: 0,
    toUtf16: 5,
    annotations: prerequisites.length === 0 ? [] : [{
      id: 'ann-1',
      family: 'comments',
      fields: {},
      protectedTargetIds: [],
      memberships: [{ ordinal: 0, start: mkEndpoint(0), end: mkEndpoint(4, 'right') }],
      prerequisites,
    }],
    declarations: [{ annotationName: 'comments', fields: {} }],
  });
}

const DECLARATIONS = [{ annotationName: 'comments', fields: {} }];

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  return db;
}

function storeDeleteFact(db, fact, { scope = 'Project:p1', actionId = 'del-1', committedAt = '2026-08-24T00:00:00.000Z' } = {}) {
  db.prepare('INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects) VALUES (?, ?, ?, ?, ?)')
    .run(scope, actionId, committedAt, serializeDeleteFact(fact), '[]');
  recordFactDependencies(db, { scope, actionId, canonicalFact: fact });
}

/**
 * Seed a real erasure-target action (a profile erasure) into `scope`, then
 * build the manifest through the production preparation path with a v2
 * typed subject — exactly how Scope-side erasure actions will author them.
 */
function seedAndPrepare({ db, subjectId, entity, owningScope = 'Project:p1', extraCensusRules = [] } = {}) {
  const committedAt = '2026-08-24T00:00:00.000Z';
  const eventData = JSON.stringify({ id: subjectId });
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(owningScope, 1, 'profile.erased', eventData, 'purge-me', committedAt);
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(owningScope, 'purge-me', committedAt, JSON.stringify([{ scope: owningScope, seq: 1 }]), 1,
      'profile.erase', eventData, 'user:u1', 's1', 'action');
  return prepareErasureDirective(db, erasureDirectivePreparation({
    owningScope,
    subject: subjectId,
    ...(entity === undefined ? {} : { erasureSubject: { entity, id: subjectId } }),
    census: { version: 1, rules: [
      { kind: 'action', type: 'profile.erase', disposition: 'target', identityPointers: ['/id'] },
      { kind: 'event', type: 'profile.erased', disposition: 'target', identityPointers: ['/id'] },
      ...extraCensusRules,
    ] },
  }));
}

function cursorRows(db, scope) {
  return db.prepare('SELECT * FROM _HistoryCursor WHERE scope = ?').all(scope);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

test('factDependencies derives sorted identities from validated v3 facts and nothing else', () => {
  const fact = deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }, { entity: 'Code', id: 'c1' }] });
  assert.deepEqual([...factDependencies(fact)], [
    { entity: 'Code', entityId: 'c1' },
    { entity: 'Comment', entityId: 'c9' },
    { entity: 'document', entityId: 'd1' },
  ]);
  assert.deepEqual([...factDependencies({ version: 2, kind: 'annotated-text.barrier', documentId: 'd1' })], []);
  assert.deepEqual([...factDependencies({ before: {}, after: {} })], []);
  assert.deepEqual([...factDependencies(null)], []);
});

test('factDependencies rejects forged or malformed v3 facts (fail closed)', () => {
  const fact = JSON.parse(serializeDeleteFact(deleteFact()));
  assert.throws(() => factDependencies({ ...fact, extra: 1 }), /exactly/);
  assert.throws(() => factDependencies({ ...structuredClone(fact), version: 2 }), TypeError);
});

test('recordFactDependencies persists identities-only rows joined to the fact', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }] }));
  const rows = db.prepare('SELECT scope, actionId, entity, entityId FROM _PrivateActionFactDependency ORDER BY entity').all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { scope: 'Project:p1', actionId: 'del-1', entity: 'Comment', entityId: 'c9' },
    { scope: 'Project:p1', actionId: 'del-1', entity: 'document', entityId: 'd1' },
  ]);
});

test('recordFactDependencies requires the fact row (no orphan index rows)', () => {
  const db = fixture();
  assert.throws(
    () => recordFactDependencies(db, { scope: 's', actionId: 'a', canonicalFact: deleteFact() }),
    /require the stored private fact/,
  );
});

test('FK cascade: deleting the fact removes its dependency rows', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact());
  db.prepare('PRAGMA foreign_keys = ON').run();
  db.prepare("DELETE FROM _PrivateActionFact WHERE actionId = 'del-1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 0);
});

// ---------------------------------------------------------------------------
// Directive-time invalidation + cursor pruning
// ---------------------------------------------------------------------------

test('v2 typed-subject directive deletes dependent facts and prunes matching cursor frames', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }] }), { actionId: 'del-1' });
  db.prepare('INSERT INTO _HistoryCursor (principalKey, sessionId, scope, past, future) VALUES (?, ?, ?, ?, ?)')
    .run('user:u1', 's1', 'Project:p1',
      JSON.stringify([
        { rootActionId: 'keep-root', headActionId: 'keep-root' },
        { rootActionId: 'del-1', headActionId: 'del-1' },
        { rootActionId: 'del-1', headActionId: 'del-1-head' },
        { rootActionId: 'later', headActionId: 'later' },
      ]),
      JSON.stringify([{ rootActionId: 'del-1', headActionId: 'del-1' }]));
  const directive = seedAndPrepare({ db, subjectId: 'c9', entity: 'Comment' });
  assert.deepEqual(directive.erased, { entity: 'Comment', id: 'c9' });
  applyErasureDirective(db, directive, { scope: 'Project:p1', actionId: 'purge-action', actionContext: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFact').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 0);
  const [cursor] = cursorRows(db, 'Project:p1');
  // Only frames referencing the invalidated action are pruned; neighbors survive.
  assert.deepEqual(JSON.parse(cursor.past), [
    { rootActionId: 'keep-root', headActionId: 'keep-root' },
    { rootActionId: 'later', headActionId: 'later' },
  ]);
  assert.deepEqual(JSON.parse(cursor.future), []);
});

test('v2 directive invalidates across scopes and prunes every affected scope', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact({ documentId: 'd1', prerequisites: [{ entity: 'SpeakerProfile', id: 'sp1' }] }), { scope: 'Project:p1', actionId: 'del-p1' });
  storeDeleteFact(db, deleteFact({ documentId: 'd2', prerequisites: [{ entity: 'SpeakerProfile', id: 'sp1' }] }), { scope: 'Project:p2', actionId: 'del-p2' });
  // p2 also holds a fact with NO dependency on sp1 — it must survive.
  storeDeleteFact(db, deleteFact({ documentId: 'd3' }), { scope: 'Project:p2', actionId: 'del-p3' });
  db.prepare('INSERT INTO _HistoryCursor (principalKey, sessionId, scope, past, future) VALUES (?, ?, ?, ?, ?)')
    .run('user:u1', 's1', 'Project:p2',
      JSON.stringify([
        { rootActionId: 'del-p2', headActionId: 'del-p2' },
        { rootActionId: 'del-p3', headActionId: 'del-p3' },
      ]),
      JSON.stringify([]));
  const directive = seedAndPrepare({ db, subjectId: 'sp1', entity: 'SpeakerProfile' });
  applyErasureDirective(db, directive, { scope: 'Project:p1', actionId: 'purge-action', actionContext: null });
  // p1's fact and p2's DEPENDENT fact die; the unrelated p3 fact survives
  // (its only remaining index row is its own document identity).
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _PrivateActionFact WHERE actionId IN ('del-p1','del-p2')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _PrivateActionFact WHERE actionId = 'del-p3'").get().n, 1);
  const remaining = db.prepare('SELECT entity, entityId FROM _PrivateActionFactDependency').all().map((row) => ({ ...row }));
  assert.deepEqual(remaining, [{ entity: 'document', entityId: 'd3' }]);
  const [p2cursor] = cursorRows(db, 'Project:p2');
  assert.deepEqual(JSON.parse(p2cursor.past), [{ rootActionId: 'del-p3', headActionId: 'del-p3' }]);
});

test('v1 directive without typed subject cannot invalidate (no certification, no expansion)', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }] }), { actionId: 'del-1' });
  const directive = seedAndPrepare({ db, subjectId: 'c9' });
  assert.equal(directive.erased, undefined);
  applyErasureDirective(db, directive, { scope: 'Project:p1', actionId: 'purge-action', actionContext: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFact').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 2);
});

test('invalidation is not census expansion: unrelated receipts and log rows stay; only facts die', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }] }), { actionId: 'del-1' });
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('Project:p1', 'del-1', '2026-08-24T00:00:00.000Z', '[]', 2, 'doc.operation', '{"version":9}', 'user:u1', 's1', 'action');
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Project:p1', 2, 'doc.changed', '{}', 'del-1', '2026-08-24T00:00:00.000Z');
  const directive = seedAndPrepare({ db, subjectId: 'c9', entity: 'Comment', extraCensusRules: [
    { kind: 'action', type: 'doc.operation', disposition: 'target', identityPointers: ['/id'] },
    { kind: 'event', type: 'doc.changed', disposition: 'target', identityPointers: ['/id'] },
  ] });
  applyErasureDirective(db, directive, { scope: 'Project:p1', actionId: 'purge-action', actionContext: null });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _ActionReceipt WHERE actionId = 'del-1'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE actionId = 'del-1'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFact').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 0);
});

test('direct invalidation returns exactly the invalidated scope/action pairs', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact({ documentId: 'd1', prerequisites: [{ entity: 'Comment', id: 'c9' }] }), { scope: 'Project:p1', actionId: 'del-a' });
  storeDeleteFact(db, deleteFact({ documentId: 'd2', prerequisites: [{ entity: 'Comment', id: 'cx' }] }), { scope: 'Project:p2', actionId: 'del-b' });
  const invalidated = invalidateDependencies(db, { entity: 'Comment', entityId: 'c9' });
  assert.deepEqual(invalidated.map((row) => ({ ...row })), [{ scope: 'Project:p1', actionId: 'del-a' }]);
  // Document-subject invalidation hits each document independently.
  assert.deepEqual(invalidateDependencies(db, { entity: 'document', entityId: 'd2' }).map((row) => ({ ...row })), [{ scope: 'Project:p2', actionId: 'del-b' }]);
});

// ---------------------------------------------------------------------------
// Erase-after-cursor-read fails closed (move-time layer, design §5)
// ---------------------------------------------------------------------------

test('planDeleteUndo no-ops when an erased prerequisite cannot be proven live', () => {
  const fact = deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }] });
  let family = importTextToFamily('d1', A, '');
  family = insertOp(family, A, 1, ['root'], 'hello');
  const blocked = planDeleteUndo({
    fact,
    family,
    declarations: DECLARATIONS,
    prerequisiteLiveness: () => false,
  });
  assert.equal(blocked.outcome, 'noop');
  assert.equal(blocked.code, 'prerequisite-missing');
  const allowed = planDeleteUndo({
    fact,
    family,
    declarations: DECLARATIONS,
    prerequisiteLiveness: () => true,
  });
  assert.equal(allowed.outcome, 'applied');
});

// ---------------------------------------------------------------------------
// Index alignment
// ---------------------------------------------------------------------------

test('sweepFactDependencies removes rows whose fact died without a cascade', () => {
  const db = fixture();
  storeDeleteFact(db, deleteFact(), { actionId: 'del-1' });
  // Simulate a non-cascading deletion path: FK enforcement off, fact deleted,
  // index row left behind.
  db.prepare('PRAGMA foreign_keys = OFF').run();
  db.prepare("DELETE FROM _PrivateActionFact WHERE actionId = 'del-1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 1);
  sweepFactDependencies(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 0);
});

test('dependency table is reserved framework namespace denied to application preparation', () => {
  assert.ok(frameworkTableNamesWithoutAuthCompile.map((n) => n.toLowerCase()).includes('_privateactionfactdependency'));
});

// ---------------------------------------------------------------------------
// v2 typed-subject validation
// ---------------------------------------------------------------------------

test('typed subject validation: malformed subjects fail closed', () => {
  const base = {
    kind: 'workbench.erasure', version: 1, owningScope: 'Project:p1', subject: 'x',
    actions: [], census: { version: 1, rules: [] },
  };
  assert.throws(() => erasureDirective({ ...base, erased: { entity: 'bad name', id: 'x' } }), /entity must be an identifier/);
  assert.throws(() => erasureDirective({ ...base, erased: { entity: 'Comment' } }), /id must be a non-empty string/);
  assert.throws(() => erasureDirective({ ...base, erased: { entity: 'Comment', id: 'x', extra: 1 } }), /not allowed/);
  assert.throws(() => erasureDirective({ ...base, erased: { entity: 'Comment', id: '' } }), /id must be a non-empty string/);
  assert.throws(() => erasureDirectivePreparation({
    owningScope: 'Project:p1', subject: 'x', erasureSubject: { nope: 1 }, census: { version: 1, rules: [] },
  }), /not allowed/);
});

// ---------------------------------------------------------------------------
// End-to-end through the pipeline: population hook + erasure-action dispatch
// ---------------------------------------------------------------------------

test('pipeline stores dependency rows for a v3 privateFact and an erasure action invalidates them', async () => {
  const { default: workbench } = await import('../build/index.mjs');
  const { defineSqliteSchema } = await import('../build/server.mjs');
  const fixtureSchema = defineSqliteSchema({ name: 'erasure-invalidation-fixtures', tables: [], externalTables: [] });
  const db = fixture();
  // A real erasure target: the retiring profile-erasure action's own receipt/log.
  const committedAt = '2026-08-24T00:00:00.000Z';
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Project:p1', 1, 'profile.erased', '{"id":"c9"}', 'purge-me', committedAt);
  db.prepare(`INSERT INTO _ActionReceipt
    (scope, actionId, committedAt, eventRefs, historyOrder, actionType, actionData, principalKey, sessionId, operation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('Project:p1', 'purge-me', committedAt, JSON.stringify([{ scope: 'Project:p1', seq: 1 }]), 1,
      'profile.erase', '{"id":"c9"}', 'user:u1', 's1', 'action');
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)').run('Project:p1', 1);
  // A history-session cursor frame referencing the soon-to-be-invalidated fact.
  db.prepare('INSERT INTO _HistoryCursor (principalKey, sessionId, scope, past, future) VALUES (?, ?, ?, ?, ?)')
    .run('user:u1', 's1', 'Project:p1',
      JSON.stringify([
        { rootActionId: 'doc-del-1', headActionId: 'doc-del-1' },
        { rootActionId: 'unrelated', headActionId: 'unrelated' },
      ]),
      JSON.stringify([]));
  const instance = workbench({
    db,
    schema: fixtureSchema,
    actions: [
      {
        type: 'document.deleteText',
        authorize: () => true,
        history: { cursor: 'excluded' },
        handler() {
          return {
            events: [{ type: 'document.textDeleted', scope: 'Project:p1', data: { id: 'd1' } }],
            privateFact: deleteFact({ prerequisites: [{ entity: 'Comment', id: 'c9' }] }),
          };
        },
      },
      {
        type: 'profile.purge',
        authorize: () => true,
        erasure: true,
        history: { cursor: 'excluded' },
        handler(context) {
          void context;
          return {
            events: [{ type: 'lifecycle.purged', scope: 'Project:p1', data: { done: true } }],
            directive: erasureDirectivePreparation({
              owningScope: 'Project:p1', subject: 'c9', erasureSubject: { entity: 'Comment', id: 'c9' },
              census: { version: 1, rules: [
                { kind: 'action', type: 'profile.erase', disposition: 'target', identityPointers: ['/id'] },
                { kind: 'event', type: 'profile.erased', disposition: 'target', identityPointers: ['/id'] },
                // Closed-world census: unrelated history stays untouched.
                { kind: 'action', type: 'document.deleteText', disposition: 'retain', identityPointers: [] },
                { kind: 'event', type: 'document.textDeleted', disposition: 'retain', identityPointers: [] },
              ] },
            }),
          };
        },
      },
    ],
  });
  await instance.start();
  const store = await instance.dispatch({
    actionId: 'doc-del-1', type: 'document.deleteText', payload: {}, principal: { type: 'user', id: 'u1' }, scope: 'Project:p1',
  });
  assert.equal(store.ok, true, store.failure?.message);
  // Population hook fired through declarePostCommitEffectsInTxn.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _PrivateActionFact WHERE actionId = 'doc-del-1'").get().n, 1);
  const dependencies = db.prepare("SELECT entity, entityId FROM _PrivateActionFactDependency WHERE actionId = 'doc-del-1'").all().map((row) => ({ ...row }));
  assert.deepEqual(dependencies, [
    { entity: 'Comment', entityId: 'c9' },
    { entity: 'document', entityId: 'd1' },
  ]);
  const purge = await instance.dispatch({
    actionId: 'purge-run', type: 'profile.purge', payload: {}, principal: { type: 'user', id: 'u1' }, scope: 'Project:p1',
  });
  assert.equal(purge.ok, true, purge.failure?.message);
  // Dependent fact + index rows are gone…
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFact').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _PrivateActionFactDependency').get().n, 0);
  // …invalidation is not census expansion: the deleted text's receipt and log stay…
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _ActionReceipt WHERE actionId = 'doc-del-1'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _Log WHERE eventType = 'document.textDeleted'").get().n, 1);
  // …and the session cursor lost only the invalidated frame.
  const [cursor] = cursorRows(db, 'Project:p1');
  assert.deepEqual(JSON.parse(cursor.past), [{ rootActionId: 'unrelated', headActionId: 'unrelated' }]);
});
