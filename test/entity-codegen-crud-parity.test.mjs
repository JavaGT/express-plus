// CRUD codegen parity — the designed kill switch (#182).
//
// For the same mutation, the codegen-derived action (src/entity/codegen-crud.ts)
// must commit byte-identical events — type, data, scope, and per-scope seq
// assignment — to the hand-written action for that mutation, with grants
// evaluated identically, through the same durable pipeline. The hand-written
// action below is what an app writes by hand today (SPEC §7: validate → admit
// → emit); the codegen derivation is independent of it, so agreement is a test
// result, not an implementation detail.
//
// Also pinned here:
//  - SPEC §5.4 field access on generated writes: a field with no `.can`
//    strong-inherits the row grant (its edit floor is the row's write
//    capability); a declared `.can` runs as the field's own floor — a denied
//    field edit is a hard write reject (403) with zero events, on both the
//    hand-written and the derived path.
//  - The M1 coverage gate (docs/conflict-merge-policy.md): merge/stub kinds
//    (map, list, computed, …) stay hand-written — a CRUD payload touching them
//    is rejected, never half-applied.
//  - SPEC §7.3 inverses: the derived inverse events ride the one pipeline and
//    restore the preimage exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import workbench, {
  entity, text, number, boolean, json, map, list, computed, ref,
  grant, read, write, subscribe, scope, everyone, deny,
} from '../build/index.mjs';
import { generateFrameworkDDL } from '../build/internal.mjs';
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { validateMutation, ValidationError } from '../build/field-strategy.mjs';
import { materializeCreateDefaults } from '../build/entity/crud.mjs';
import { mayRow, mayFieldOp } from '../build/row-grant.mjs';
import { admitRowTransition } from '../build/field-admission.mjs';
import { rawRow } from '../build/entity/query.mjs';
import { scopeOf } from '../build/scope-handle.mjs';
import { canonicalStringify } from '../build/canonical-json.mjs';
import { codegenCrud, crudCodegenCoverage, codegenInverse } from '../build/entity/codegen-crud.mjs';

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob' };

// The hand-written CRUD action — the baseline the codegen must match byte for
// byte. Written the way an app writes it by hand (validate → admit → emit);
// it deliberately shares nothing with the codegen module.
function handwrittenCrudHandlers(bound) {
  const { name, fields } = bound;
  const ownerField = Object.entries(fields)
    .find(([, d]) => d.type === 'ref' && d.role && d.readonly)?.[0] ?? null;
  // A non-`inTransaction` handler receives no context db — the current row is
  // read through the bound record's query seam (the same seam the compiled
  // CRUD handlers use for exactly this reason).
  const materialized = (id) => {
    try {
      const row = bound.findById(id);
      return row && typeof row === 'object' ? row : null;
    } catch {
      return null;
    }
  };
  return {
    [`${name}.create`]: ({ payload, principal }) => {
      const { id: requestedId, ...rest } = payload;
      const validated = validateMutation(bound, rest);
      const id = requestedId ?? randomUUID();
      // Declared defaults materialize on create (the write path's one helper).
      const data = materializeCreateDefaults(bound, { ...validated, id });
      if (ownerField) data[ownerField] = principal?.id;
      return [{ type: `${name}.created`, scope: scopeOf(name, id).key, data }];
    },
    [`${name}.update`]: async ({ payload, principal }) => {
      const { id, ...rest } = payload;
      if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
      if (Object.keys(rest).length === 0) {
        throw new ValidationError(`${name}.update requires at least one field to change`);
      }
      const validated = validateMutation(bound, rest);
      const data = { ...validated, id };
      const before = materialized(id);
      if (before) {
        // SPEC §5.4: declared field floors run against the materialized row.
        for (const fieldName of Object.keys(validated)) {
          if (fields[fieldName]?.access && !(await mayFieldOp(bound, fieldName, write, before, principal))) {
            throw Object.assign(new Error('forbidden'), { status: 403 });
          }
        }
        if (!(await admitRowTransition({ entity: bound, verb: 'update', before, after: { ...before, ...data }, principal }))) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
      }
      return [{ type: `${name}.updated`, scope: scopeOf(name, id).key, data }];
    },
    [`${name}.remove`]: async ({ payload, principal }) => {
      const row = materialized(payload.id);
      if (!row || !(await mayRow(bound, 'remove', row, principal))) {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      return [{ type: `${name}.removed`, scope: scopeOf(name, payload.id).key, data: { id: payload.id } }];
    },
  };
}

// Two identical durable pipelines over identical dbs: one runs the hand-written
// action, one runs the codegen-derived action. Both share the same pipeline
// variant, projection consumer, and event vocabulary — the handler is the only
// difference, which is exactly what parity must prove. Each side gets its own
// app binding so its projection consumer writes its own db.
function parityHarness(Entity, { handwritten, derived } = {}) {
  const dbHand = new DatabaseSync(':memory:');
  const dbDerived = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) { dbHand.exec(sql); dbDerived.exec(sql); }
  for (const sql of Entity.generateDDL()) { dbHand.exec(sql); dbDerived.exec(sql); }
  const appHand = workbench({ db: dbHand, entities: [Entity] });
  const appDerived = workbench({ db: dbDerived, entities: [Entity] });
  const boundHand = appHand.entity(Entity);
  const boundDerived = appDerived.entity(Entity);
  const serverHand = createServer({
    handlers: handwritten ?? handwrittenCrudHandlers(boundHand),
    authorize: () => true, // generated-CRUD admission is the handler's (kernel.ts does the same)
    db: dbHand,
    pipeline: durableMutationVariant({ projectionConsumers: [boundHand.projection] }),
  });
  const serverDerived = createServer({
    handlers: derived ?? codegenCrud(boundDerived).handlers,
    authorize: () => true,
    db: dbDerived,
    pipeline: durableMutationVariant({ projectionConsumers: [boundDerived.projection] }),
  });
  return { dbHand, dbDerived, boundHand, boundDerived, serverHand, serverDerived };
}

// The committed-event projection the parity compare runs over: type, scope,
// per-scope seq assignment, and data — byte-compared via canonical JSON.
function committedShape(result) {
  const events = (result.events ?? []).map((event) => ({
    type: event.type,
    scope: event.scope,
    seq: event.seq,
    data: event.data,
  }));
  return {
    ok: result.ok === true,
    category: result.failure?.category ?? null,
    events,
    canonical: canonicalStringify(events),
  };
}

async function dispatchParity({ serverHand, serverDerived }, step) {
  const [hand, derived] = await Promise.all([
    serverHand.dispatch({ ...step.request, principal: step.principal }),
    serverDerived.dispatch({ ...step.request, principal: step.principal }),
  ]);
  return { hand: committedShape(hand), derived: committedShape(derived) };
}

test('parity: derived create/update/remove commits byte-identical events with the hand-written action', async () => {
  const Ticket = entity('ParityTicket', {
    title: text({ required: true }),
    points: number({ default: 3 }),
    done: boolean({ default: false }),
    tags: json({ optional: true }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });

  const harness = parityHarness(Ticket, {});

  // The whole mutation sequence runs in lockstep on both sides; every step
  // (including the denied ones, which keep the seq cursors aligned) must agree.
  const steps = [
    { request: { actionId: 's1', type: 'ParityTicket.create', payload: { id: 't1', title: 'spec it', points: 5 } }, principal: alice },
    { request: { actionId: 's2', type: 'ParityTicket.update', payload: { id: 't1', points: 8 } }, principal: alice },
    { request: { actionId: 's3', type: 'ParityTicket.update', payload: { id: 't1', title: 'bob was here' } }, principal: bob }, // denied
    { request: { actionId: 's4', type: 'ParityTicket.update', payload: { id: 't1', done: true, tags: { size: 2 } } }, principal: alice },
    { request: { actionId: 's5', type: 'ParityTicket.remove', payload: { id: 't1' } }, principal: bob },                        // denied
    { request: { actionId: 's6', type: 'ParityTicket.remove', payload: { id: 't1' } }, principal: alice },
  ];

  const seen = [];
  for (const step of steps) {
    const { hand, derived } = await dispatchParity(harness, step);
    assert.equal(hand.ok, derived.ok, `same outcome for ${step.request.type} (${step.principal.id})`);
    assert.equal(hand.canonical, derived.canonical, `byte-identical committed events for ${step.request.type}`);
    seen.push({ hand, derived });
  }

  const [created, , deniedUpdate, , deniedRemove, removed] = seen;
  assert.equal(created.hand.events.length, 1);
  assert.equal(created.hand.events[0].type, 'ParityTicket.created');
  assert.equal(created.hand.events[0].seq, 1);
  assert.equal(created.hand.events[0].data.owner, 'alice', 'owner role stamped from the principal');
  assert.equal(deniedUpdate.hand.ok, false, 'denied edit is a hard reject');
  assert.equal(deniedUpdate.hand.category, 'denied');
  assert.deepEqual(deniedUpdate.hand.events, [], 'a denied edit emits zero events');
  assert.equal(deniedRemove.hand.category, 'denied');
  assert.equal(removed.hand.events[0].type, 'ParityTicket.removed');
  assert.deepEqual(removed.hand.events[0].data, { id: 't1' });

  // Seq assignment stays aligned across the interleaved denials: the allowed
  // events carry 1..4 in commit order on BOTH sides (denials consume no seq).
  const seqs = seen.flatMap(({ hand }) => hand.events.map((event) => event.seq));
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test('fail-closed field access (SPEC §5.4): .can strong-inherits the row grant; a denied field edit is a hard reject on both paths', async () => {
  const Doc = entity('AccessDoc', {
    body: text(), // no .can — strong-inherits the row grant (edit floor = row write)
    secret: text().can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : deny('only the owner edits secret')),
    owner: ref('User', { role: 'owner', readonly: true }),
    // Everyone holds the row write capability; the FIELD floor is what denies.
    grant: () => [scope(() => everyone()).can(() => grant(read, write, subscribe))],
  });

  const harness = parityHarness(Doc, {});
  const setup = { actionId: 'd0', type: 'AccessDoc.create', payload: { id: 'doc1', body: 'v1', secret: 's1' } };
  const boot = await dispatchParity(harness, { request: setup, principal: alice });
  assert.equal(boot.hand.canonical, boot.derived.canonical);

  const steps = [
    // Strong-inherit: bob holds the row write, `body` declares no floor → allowed.
    { request: { actionId: 'd1', type: 'AccessDoc.update', payload: { id: 'doc1', body: 'bob edits body' } }, principal: bob },
    // Declared floor: bob's edit of `secret` is a hard reject on BOTH paths.
    { request: { actionId: 'd2', type: 'AccessDoc.update', payload: { id: 'doc1', secret: 'bob steals' } }, principal: bob },
    // The owner's own edit of `secret` passes its floor.
    { request: { actionId: 'd3', type: 'AccessDoc.update', payload: { id: 'doc1', secret: 'alice ok' } }, principal: alice },
  ];

  const seen = [];
  for (const step of steps) {
    const { hand, derived } = await dispatchParity(harness, step);
    assert.equal(hand.ok, derived.ok, `same grant outcome for ${step.principal.id} on ${Object.keys(step.request.payload).filter((k) => k !== 'id').join('/')}`);
    assert.equal(hand.canonical, derived.canonical);
    seen.push({ hand, derived });
  }

  const [bodyEdit, deniedSecret, ownerSecret] = seen;
  assert.equal(bodyEdit.hand.ok, true, 'strong-inherit: the row grant admits the edit of an undeclared field');
  assert.equal(deniedSecret.hand.ok, false);
  assert.equal(deniedSecret.hand.category, 'denied');
  assert.deepEqual(deniedSecret.hand.events, [], 'denied field edit: zero events');
  assert.equal(ownerSecret.hand.ok, true);
  assert.deepEqual(ownerSecret.hand.events[0].data, { secret: 'alice ok', id: 'doc1' });

  // The denied edit left the row untouched on both sides.
  assert.equal(harness.dbHand.prepare('SELECT secret FROM AccessDoc WHERE id = ?').get('doc1').secret, 'alice ok');
  assert.equal(harness.dbDerived.prepare('SELECT secret FROM AccessDoc WHERE id = ?').get('doc1').secret, 'alice ok');
});

test('M1 coverage: merge/stub kinds stay hand-written — a CRUD payload touching them is rejected, not half-applied', async () => {
  const Mixer = entity('CoverageMixer', {
    title: text({ required: true }),
    collaborators: map(ref('User'), { default: {} }),
    steps: list(text()),
    total: computed({ compute: () => 42 }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });

  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of Mixer.generateDDL()) db.exec(sql);
  const app = workbench({ db, entities: [Mixer] });
  const bound = app.entity(Mixer);
  const surface = codegenCrud(bound);

  // The coverage report: whole-value replace kinds covered; merge/stub and
  // framework-owned kinds named as what stays hand-written.
  const coverage = crudCodegenCoverage(bound);
  assert.deepEqual(coverage.createFields, ['title']);
  assert.deepEqual(coverage.updateFields, ['title']);
  assert.deepEqual([...coverage.handWrittenFields].sort(), ['collaborators', 'steps']);
  assert.deepEqual([...coverage.frameworkFields].sort(), ['owner', 'total']);
  assert.deepEqual(surface.coverage.handWrittenFields, coverage.handWrittenFields);

  const server = createServer({
    handlers: surface.handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({ projectionConsumers: [bound.projection] }),
  });

  // A CRUD payload that touches a merge/stub kind is rejected before any event.
  const badCreate = await server.dispatch({
    actionId: 'm1', type: 'CoverageMixer.create', payload: { title: 'x', collaborators: { u1: { role: 'viewer' } } }, principal: alice,
  });
  assert.equal(badCreate.ok, false);
  assert.equal(badCreate.failure?.category, 'invalid-input');
  assert.match(badCreate.failure?.message ?? '', /collaborators.*not assignment-shaped|map field/);
  assert.deepEqual(badCreate.events ?? [], [], 'no events on a rejected payload');

  const badUpdate = await server.dispatch({
    actionId: 'm2', type: 'CoverageMixer.update', payload: { id: 'x1', steps: ['a'] }, principal: alice,
  });
  assert.equal(badUpdate.ok, false);
  assert.match(badUpdate.failure?.message ?? '', /steps.*not assignment-shaped|list field/);
  assert.deepEqual(badUpdate.events ?? [], []);

  // The covered half still works: the title-only CRUD commits normally.
  const good = await server.dispatch({
    actionId: 'm3', type: 'CoverageMixer.create', payload: { id: 'mx1', title: 'covered' }, principal: alice,
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.events.map((event) => event.type), ['CoverageMixer.created']);
});

test('inverses (SPEC §7.3): derived inverse events ride the one pipeline and restore the preimage', async () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const Ticket = entity('UndoTicket', {
    title: text({ required: true }),
    points: number({ default: 3 }),
    done: boolean({ default: false }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
  for (const sql of Ticket.generateDDL()) db.exec(sql);
  const app = workbench({ db, entities: [Ticket] });
  await app.ready;
  await app.start();
  const bound = app.entity(Ticket);
  const preimageOf = (id) => bound.deserializeRow({ ...rawRow(db, Ticket.name, id) });

  // update inverse: restore exactly the fields the forward event changed.
  const created = await app.dispatch({ actionId: 'i1', type: 'UndoTicket.create', payload: { id: 'u1', title: 'orig', points: 5 }, principal: alice });
  assert.equal(created.ok, true);
  const before = preimageOf('u1');
  await app.dispatch({ actionId: 'i2', type: 'UndoTicket.update', payload: { id: 'u1', title: 'changed', points: 9 }, principal: alice });
  const inverse = codegenInverse(bound, 'update', {
    forwardData: { title: 'changed', points: 9, id: 'u1' },
    preimageRow: before,
  });
  assert.deepEqual(inverse, { type: 'UndoTicket.update', payload: { id: 'u1', title: 'orig', points: 5 } });
  const undone = await app.dispatch({ actionId: 'i3', type: inverse.type, payload: inverse.payload, principal: alice });
  assert.equal(undone.ok, true);
  assert.deepEqual(preimageOf('u1'), before, 'the row is back at the preimage');

  // remove inverse: re-create the removed row from its preimage (captured
  // BEFORE the remove — after it the row is gone).
  const second = await app.dispatch({ actionId: 'i4', type: 'UndoTicket.create', payload: { id: 'u2', title: 'second', points: 1 }, principal: alice });
  assert.equal(second.ok, true);
  const removedPreimage = preimageOf('u2');
  await app.dispatch({ actionId: 'i5', type: 'UndoTicket.remove', payload: { id: 'u2' }, principal: alice });
  const recreate = codegenInverse(bound, 'remove', {
    forwardData: { id: 'u2' },
    preimageRow: removedPreimage,
  });
  assert.equal(recreate.type, 'UndoTicket.create');
  const restored = await app.dispatch({ actionId: 'i6', type: recreate.type, payload: recreate.payload, principal: alice });
  assert.equal(restored.ok, true);
  const row = preimageOf('u2');
  assert.equal(row.title, 'second');
  assert.equal(row.points, 1);
  assert.equal(row.owner, 'alice');

  // create inverse: the remove that undoes a create.
  const removeInverse = codegenInverse(bound, 'create', { forwardData: { id: 'u1' }, preimageRow: null });
  assert.deepEqual(removeInverse, { type: 'UndoTicket.remove', payload: { id: 'u1' } });
  const gone = await app.dispatch({ actionId: 'i7', type: removeInverse.type, payload: removeInverse.payload, principal: alice });
  assert.equal(gone.ok, true);
  assert.equal(rawRow(db, Ticket.name, 'u1'), undefined);

  // A restore that would have to CLEAR a non-nullable field is not expressible
  // as a CRUD payload — the derived inverse refuses (stays hand-written) rather
  // than half-restoring.
  const impossible = codegenInverse(bound, 'update', {
    forwardData: { points: 9, id: 'u1' },
    preimageRow: { id: 'u1', points: null },
  });
  assert.equal(impossible, null);
});

test('derived reducers fold the same log event to the same state as the compiled verbs', async () => {
  const Ticket = entity('FoldTicket', {
    title: text({ required: true }),
    points: number({ default: 3 }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of Ticket.generateDDL()) db.exec(sql);
  const app = workbench({ db, entities: [Ticket] });
  const bound = app.entity(Ticket);

  const derived = codegenCrud(bound);
  const logEvents = [
    { type: 'FoldTicket.created', scope: 'FoldTicket:f1', data: { title: 'x', points: 5, id: 'f1', owner: 'alice' } },
    { type: 'FoldTicket.updated', scope: 'FoldTicket:f1', data: { points: 9, id: 'f1' } },
    { type: 'FoldTicket.removed', scope: 'FoldTicket:f1', data: { id: 'f1' } },
  ];
  for (const logEvent of logEvents) {
    const derivedState = derived.events[logEvent.type.endsWith('.created') ? 'created' : logEvent.type.endsWith('.updated') ? 'updated' : 'removed']
      .reduce({}, logEvent);
    const compiledState = bound.verbs[logEvent.type.endsWith('.created') ? 'created' : logEvent.type.endsWith('.updated') ? 'updated' : 'removed']
      .reduce({}, logEvent);
    assert.deepEqual(derivedState, compiledState, `derived fold == compiled fold for ${logEvent.type}`);
  }
});

test('lifecycle refusals: conditional history, live tier, and onRemove cascades stay hand-written (fail closed)', async () => {
  const ownerGrant = () => [
    scope(({ is }) => is.owner()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
  ];
  const Conditional = entity('CondTicket', {
    title: text(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
    history: { update: 'conditional' },
  });
  const conditionalCoverage = crudCodegenCoverage(Conditional);
  assert.equal(conditionalCoverage.coversLifecycle, false);
  const conditionalHandlers = codegenCrud(Conditional).handlers;
  await assert.rejects(
    () => conditionalHandlers['CondTicket.update']({ payload: { id: 'x', title: 'y' }, principal: alice }),
    /not codegen-covered/,
  );

  const Live = entity('LiveThing', {
    x: number(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
    tier: 'live',
  });
  assert.equal(crudCodegenCoverage(Live).coversLifecycle, false);

  const Cascade = entity('CascadeParent', {
    title: text(),
    child: ref('Other', { onRemove: 'cascade' }),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: ownerGrant,
  });
  const cascadeCoverage = crudCodegenCoverage(Cascade);
  assert.equal(cascadeCoverage.coversRemove, false);
  // Derivation stays total; the refusal fires at the mutation seam.
  await assert.rejects(
    () => codegenCrud(Cascade).handlers['CascadeParent.remove']({ payload: { id: 'x' }, principal: alice }),
    /onRemove cascade owns the removal/,
  );
});
