// Hostile-review fixes (#145 round 1) — MAJOR 1 + MAJOR 2 proving tests:
//
// MAJOR 1: native insert classification is strict again. A malformed persisted
// v9 receipt payload (missing fields, wrong types, bad offsets) is a BARRIER
// and must never reconstruct as history-eligible on cursor reconstruction.
//
// MAJOR 2: the contribution-policy seam functions are EXERCISED by the history
// engine, not dead code. A policy-level rejection in selectAndParseTargetFact
// (redo-of-undo chain) or validateTranslation (first undo) surfaces as opaque
// forbidden with ZERO durable writes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createServer, durableMutationVariant, executeFrameworkDDL } from '../build/internal.mjs';
import { durableHistory } from '../build/index.mjs';
import {
  createHistoryContributionPolicyRegistry,
  compileNativeInsertContributionPolicy,
} from '../build/history-contribution-policy.mjs';

const principal = Object.freeze({ type: 'user', id: 'u1', attributes: {} });
const scope = 'Document:1';

// ---- MAJOR 1: strict classification ---------------------------------------

const strictRegistry = () => createHistoryContributionPolicyRegistry({
  policies: [
    compileNativeInsertContributionPolicy({ entity: 'Doc', fieldName: 'body' }, 'Doc.body.operation'),
    compileNativeInsertContributionPolicy({ entity: 'Doc', fieldName: 'body' }, 'Doc.body.compensate'),
  ],
  privateHistoryScopes: new Set(['Doc']),
});

function validV9Insert(id = 'd1') {
  return {
    version: 9,
    id,
    authoring: { version: 1, stream: 's', lease: 'l', mutationId: 'm' },
    edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 5, affinity: 'right' }, text: ' A' },
  };
}

test('MAJOR 1: only a shape-complete v9 text.insert payload classifies as eligible', () => {
  const registry = strictRegistry();
  assert.equal(registry.classify({ type: 'Doc.body.operation', payload: validV9Insert() }), 'eligible', 'a valid insert is eligible');

  const malformed = [
    ['missing edit', { version: 9, id: 'd1', authoring: { version: 1, stream: 's', lease: 'l', mutationId: 'm' } }],
    ['missing id', { version: 9, authoring: { version: 1, stream: 's', lease: 'l', mutationId: 'm' }, edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 5, affinity: 'right' }, text: ' A' } }],
    ['wrong edit type', { ...validV9Insert(), edit: { kind: 42 } }],
    ['non-object edit', { ...validV9Insert(), edit: 'nope' }],
    ['missing authoring', { version: 9, id: 'd1', edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 5, affinity: 'right' }, text: ' A' } }],
    ['bad offset type', { ...validV9Insert(), edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 'nope', affinity: 'right' }, text: ' A' } }],
    ['negative offset', { ...validV9Insert(), edit: { kind: 'text.insert', at: { positionToken: 'p', offset: -1, affinity: 'right' }, text: ' A' } }],
    ['bad affinity', { ...validV9Insert(), edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 5, affinity: 'middle' }, text: ' A' } }],
    ['empty text', { ...validV9Insert(), edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 5, affinity: 'right' }, text: '' } }],
    ['text wrong type', { ...validV9Insert(), edit: { kind: 'text.insert', at: { positionToken: 'p', offset: 5, affinity: 'right' }, text: 42 } }],
    ['position token missing', { ...validV9Insert(), edit: { kind: 'text.insert', at: { offset: 5, affinity: 'right' }, text: ' A' } }],
  ];
  for (const [label, payload] of malformed) {
    assert.equal(registry.classify({ type: 'Doc.body.operation', payload }), 'barrier', `${label} must classify as barrier, never eligible`);
  }
  // A valid but NON-insert native action is the barrier law, never eligible.
  const deletePayload = { ...validV9Insert(), edit: { kind: 'text.delete', from: { positionToken: 'p', offset: 0, affinity: 'right' }, to: { positionToken: 'p', offset: 1, affinity: 'right' } } };
  assert.equal(registry.classify({ type: 'Doc.body.operation', payload: deletePayload }), 'barrier');
});

test('MAJOR 1: a malformed persisted receipt never reconstructs as an eligible history frame', async () => {
  // Scenario A: a valid insert reconstructs as one eligible frame.
  {
    const db = new DatabaseSync(':memory:');
    executeFrameworkDDL(db);
    const server = createServer({
      db,
      history: durableHistory({ authorize: () => true, actions: { 'Doc.body.operation': { inverse: () => ({ type: 'Doc.body.operation', scope, payload: {} }), redo: () => ({ type: 'Doc.body.operation', scope, payload: {} }) } } }),
      contributionPolicies: strictRegistry(),
      authorize: () => true,
      handlers: { 'Doc.body.operation': ({ payload }) => [{ type: 'Doc.body.operated', scope, data: payload }] },
    });
    await server.dispatch({
      actionId: 'good-insert', type: 'Doc.body.operation', scope, principal,
      payload: validV9Insert(), history: { session: 'tab-a' },
    });
    db.prepare('DELETE FROM _HistoryCursor').run();
    const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
    assert.equal(cursor.undo, 1, 'the valid insert reconstructs as one eligible frame');
    db.close();
  }
  // Scenario B: a malformed persisted receipt is a BARRIER — it never
  // reconstructs as an eligible frame (fail-closed: the reconstructed cursor
  // has NO frame for the malformed action, exactly the retired strict
  // classifier behavior, not the shallow presence check).
  {
    const db = new DatabaseSync(':memory:');
    executeFrameworkDDL(db);
    const server = createServer({
      db,
      history: durableHistory({ authorize: () => true, actions: { 'Doc.body.operation': { inverse: () => ({ type: 'Doc.body.operation', scope, payload: {} }), redo: () => ({ type: 'Doc.body.operation', scope, payload: {} }) } } }),
      contributionPolicies: strictRegistry(),
      authorize: () => true,
      handlers: { 'Doc.body.operation': ({ payload }) => [{ type: 'Doc.body.operated', scope, data: payload }] },
    });
    await server.dispatch({
      actionId: 'bad-insert', type: 'Doc.body.operation', scope, principal,
      payload: { version: 9, id: 'd1', authoring: { version: 1 }, edit: { kind: 'text.insert', text: 42 } },
      history: { session: 'tab-a' },
    });
    db.prepare('DELETE FROM _HistoryCursor').run();
    const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
    assert.equal(cursor.undo, 0, 'the malformed receipt never reconstructs as an eligible frame');
    db.close();
  }
});

// ---- MAJOR 2: the policy seam is exercised ---------------------------------

function makeSeamServer(db, policy) {
  const registry = createHistoryContributionPolicyRegistry({ policies: [policy], privateHistoryScopes: new Set() });
  return createServer({
    db,
    history: durableHistory({
      authorize: () => true,
      actions: { 'document.set': {
        inverse: ({ action, fact }) => ({ type: 'document.set', scope: action.scope, payload: { value: fact.before, before: fact.after } }),
        redo: ({ action, fact }) => ({ type: 'document.set', scope: action.scope, payload: { value: fact.after, before: fact.before } }),
      } },
    }),
    contributionPolicies: registry,
    authorize: () => true,
    handlers: { 'document.set': ({ payload, scope: owningScope }) => owningScope === undefined || payload.before === undefined
      ? [{ type: 'document.changed', scope, data: { value: payload.value } }]
      : ({ events: [{ type: 'document.changed', scope, data: { value: payload.value } }], privateFact: { before: payload.before ?? null, after: payload.value } }),
    },
    pipeline: durableMutationVariant(),
  });
}

function basePolicy(overrides = {}) {
  return {
    actionType: 'document.set',
    handle: { entity: 'Doc', fieldName: 'body' },
    classify: () => 'eligible',
    parseOriginFact: (fact) => fact,
    parseTargetFact: (fact) => fact,
    selectAndParseTargetFact: (ctx) => ctx.originFact,
    validateTranslation: () => undefined,
    authorizationRequirements: () => 'outer-field',
    ...overrides,
  };
}

async function commitSet(server, actionId) {
  const result = await server.dispatch({
    actionId, type: 'document.set', scope, principal,
    payload: { value: { n: actionId }, before: null }, history: { session: 'tab-a' },
  });
  assert.equal(result.ok, true, result.failure?.message);
}

function durableCounts(db) {
  return {
    receipts: db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt').get().c,
    facts: db.prepare('SELECT COUNT(*) AS c FROM _PrivateActionFact').get().c,
    log: db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c,
  };
}

test('MAJOR 2: a selectAndParseTargetFact rejection on redo-of-undo is opaque forbidden with zero writes', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const policy = basePolicy({
    selectAndParseTargetFact: (ctx) => {
      if (ctx.origin.actionId === ctx.target.actionId) return ctx.originFact;
      throw Object.assign(new Error('forbidden'), { status: 403 });
    },
  });
  const server = makeSeamServer(db, policy);
  await commitSet(server, 'p1');
  const cursor1 = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const undone = await server.history.undo({ scope, principal, session: 'tab-a', actionId: 'p1-undo', revision: cursor1.revision });
  assert.equal(undone.ok, true, undone.failure?.message);

  // The redo moves a CHAIN (origin != target) — the policy-owned
  // selectAndParseTargetFact runs and rejects; nothing may be written.
  const before = durableCounts(db);
  const cursor2 = await server.history.cursor({ scope, principal, session: 'tab-a' });
  await assert.rejects(server.history.redo({ scope, principal, session: 'tab-a', actionId: 'p1-redo', revision: cursor2.revision }), { status: 403 });
  assert.deepEqual(durableCounts(db), before, 'the policy rejection wrote nothing');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _ActionReceipt WHERE actionId = 'p1-redo'").get().c, 0, 'no receipt for the rejected redo');
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), cursor2, 'the cursor did not move');
  db.close();
});

test('MAJOR 2: a validateTranslation rejection on the first undo is opaque forbidden with zero writes', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const policy = basePolicy({
    validateTranslation: () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
  });
  const server = makeSeamServer(db, policy);
  await commitSet(server, 'p2');
  const before = durableCounts(db);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  await assert.rejects(server.history.undo({ scope, principal, session: 'tab-a', actionId: 'p2-undo', revision: cursor.revision }), { status: 403 });
  assert.deepEqual(durableCounts(db), before, 'the policy rejection wrote nothing');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _ActionReceipt WHERE actionId = 'p2-undo'").get().c, 0);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), cursor, 'the cursor did not move');
  db.close();
});

test('round 3: undoToPoint rejects forged linkage through selectAndParseTargetFact with zero writes', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  // The fixture policy treats a receipt that CLAIMS a chain link on a source
  // being compensated as its own root as forged (its stored historyTargetActionId
  // names a different head) — a policy-level linkage rejection.
  const policy = basePolicy({
    selectAndParseTargetFact: (ctx) => {
      if (ctx.target.historyTargetActionId != null && ctx.target.historyTargetActionId !== ctx.origin.actionId) {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      return ctx.originFact;
    },
  });
  const server = makeSeamServer(db, policy);
  await commitSet(server, 'p3');
  // Forge the receipt's chain-link columns so the source no longer resolves.
  db.prepare("UPDATE _ActionReceipt SET historyRootActionId = 'forged', historyTargetActionId = 'forged' WHERE actionId = 'p3'").run();
  const before = durableCounts(db);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  await assert.rejects(
    server.history.undoToPoint({ scope, principal, session: 'tab-a', actionId: 'p3-utp', revision: cursor.revision, seq: 0 }),
    { status: 403 },
  );
  assert.deepEqual(durableCounts(db), before, 'the undoToPoint policy rejection wrote nothing');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM _ActionReceipt WHERE actionId = 'p3-utp'").get().c, 0, 'no receipt for the rejected undoToPoint');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _ActionReceipt WHERE operation = \'undoToPoint\'').get().c, 0);
  assert.deepEqual(await server.history.cursor({ scope, principal, session: 'tab-a' }), cursor, 'the cursor did not move');
  db.close();
});

test('round 3: undoToPoint translators receive only the application view of a compound envelope', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  let capturedFact = null;
  const registryPolicy = basePolicy({ actionType: 'doc.compound', handle: { entity: 'Doc', fieldName: 'body' } });
  const registry = createHistoryContributionPolicyRegistry({ policies: [registryPolicy], privateHistoryScopes: new Set() });
  const server = createServer({
    db,
    history: durableHistory({
      authorize: () => true,
      actions: { 'doc.compound': {
        inverse: ({ fact }) => { capturedFact = fact; return { type: 'doc.changed', scope, payload: {} }; },
        redo: ({ fact: _fact }) => ({ type: 'doc.changed', scope, payload: {} }),
      } },
    }),
    contributionPolicies: registry,
    authorize: () => true,
    handlers: {
      'doc.compound': () => ({
        events: [{ type: 'doc.compound.recorded', scope, data: {} }],
        privateFact: { version: 1, kind: 'workbench.compound-origin', application: { before: null, after: { correctionId: 'c-1' } }, contributions: [] },
      }),
      'doc.changed': () => [{ type: 'doc.applied', scope, data: {} }],
    },
    pipeline: durableMutationVariant(),
  });

  const dispatched = await server.dispatch({
    actionId: 'p4', type: 'doc.compound', scope, principal,
    payload: { id: 'd1' }, history: { session: 'tab-a' },
  });
  assert.equal(dispatched.ok, true, dispatched.failure?.message);
  const cursor = await server.history.cursor({ scope, principal, session: 'tab-a' });
  const undone = await server.history.undoToPoint({ scope, principal, session: 'tab-a', actionId: 'p4-utp', revision: cursor.revision, seq: 0 });
  assert.equal(undone.ok, true, undone.failure?.message);

  // The translator received the APPLICATION VIEW ONLY — no envelope material.
  assert.ok(capturedFact, 'the undoToPoint translator ran');
  const keys = Object.keys(capturedFact).sort();
  assert.deepEqual(keys, ['after', 'before'], 'only { before, after } crosses into translator input');
  assert.deepEqual(capturedFact, { before: null, after: { correctionId: 'c-1' } });
  assert.equal('kind' in capturedFact, false);
  assert.equal('version' in capturedFact, false);
  assert.equal('contributions' in capturedFact, false);
  assert.equal('linkage' in capturedFact, false);
  db.close();
});