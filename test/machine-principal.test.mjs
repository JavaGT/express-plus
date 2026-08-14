// S5/A5 machine principal + revocation contract tests (workbench#75).
// Covers: machinePrincipal construction/guards, allowlist enforcement
// (admitSystemMutation + clock dispatch + job-queue handler/context), the
// no-human-impersonation guard, and the live-delivery revocation contract
// (bootstrap order, delivery-time wake, scope-match, exactly-once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { schedule, date, scope, everyone, grant, read } from '../build/index.mjs';
import { entity, generateDDL, executeFrameworkDDL } from '../build/internal.mjs';
import { admitSystemMutation, startClockTriggers, schedulerSource, machinePrincipal, isMachinePrincipal, machineAllows, machineOperations } from '../build/schedule.mjs';
import { createLiveDeliveryCore } from '../build/live-delivery-core.mjs';
import { createJobQueue } from '../build/job-queue.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- machinePrincipal construction + guards ----

test('machinePrincipal mints a frozen system principal with an explicit allowlist', () => {
  const p = machinePrincipal({ id: 'worker:1', operations: ['update', 'execute'] });
  assert.equal(p.type, 'system', 'a machine principal is a system principal — never user');
  assert.equal(p.id, 'worker:1', 'stable identity on the principal id');
  assert.equal(p.attributes.source, 'worker:1', 'source mirrors the identity for the schedule/receipt seam');
  assert.equal(p.attributes.machine, true, 'machine discriminator present');
  assert.deepEqual(p.attributes.operations, ['update', 'execute']);
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.attributes));
  assert.ok(Object.isFrozen(p.attributes.operations));
  assert.ok(isMachinePrincipal(p));
});

test('machinePrincipal rejects an empty/missing id (fail closed)', () => {
  assert.throws(() => machinePrincipal({ id: '', operations: ['update'] }), /id must be a non-empty string/);
  assert.throws(() => machinePrincipal({ id: undefined, operations: ['update'] }), /id must be a non-empty string/);
});

test('machinePrincipal rejects a non-array / empty operations list (fail closed)', () => {
  assert.throws(() => machinePrincipal({ id: 'w', operations: 'update' }), /must be an explicit array/);
  assert.throws(() => machinePrincipal({ id: 'w', operations: [] }), /allowlist of zero/);
});

test('machinePrincipal rejects an operation outside the closed vocabulary (fail closed)', () => {
  assert.throws(
    () => machinePrincipal({ id: 'w', operations: ['delete-all-data'] }),
    /unknown operation 'delete-all-data'/,
  );
  assert.throws(() => machinePrincipal({ id: 'w', operations: [42] }), /must be a non-empty operation name/);
});

// ---- no human impersonation ----

test('a machine principal can never pass a user-identity check', () => {
  const p = machinePrincipal({ id: 'scheduler:blog', operations: ['update'] });
  // A human identity check keys on type === 'user' — a machine principal is
  // structurally 'system' and cannot be minted as 'user' (the constructor has
  // no type option).
  assert.notEqual(p.type, 'user');
  assert.equal(p.type === 'user', false, 'a user-identity gate rejects a machine principal');
  // Its attributes are derived ONLY from { id, operations } — there is no slot
  // for a token/role/capability a human identity check could read.
  assert.deepEqual(Object.keys(p.attributes).sort(), ['machine', 'operations', 'source']);
  assert.ok(Object.isFrozen(p.attributes));
});

// ---- allowlist checks ----

test('machineAllows admits exactly the granted operations, denies everything else (fail closed)', () => {
  const p = machinePrincipal({ id: 'w', operations: ['update'] });
  assert.equal(machineAllows(p, 'update'), true, 'granted operation admitted');
  assert.equal(machineAllows(p, 'execute'), false, 'ungranted operation denied');
  assert.equal(machineAllows(p, 'remove'), false, 'ungranted operation denied');
  assert.equal(machineAllows(p, { operation: 'update' }), true, 'category-token form admitted');
  assert.equal(machineAllows(p, 'not-an-operation'), false, 'unknown name denied, never throws');
  assert.equal(machineAllows(p, null), false, 'null operation denied');
});

test('machineAllows denies a non-machine principal (an unattributed principal has no grant)', () => {
  assert.equal(machineAllows({ type: 'system', id: null, attributes: { source: 'x' }, status: 'active' }, 'update'), false);
  assert.equal(machineAllows({ type: 'user', id: 'u1', attributes: {}, status: 'active' }, 'update'), false);
  assert.equal(machineAllows(null, 'update'), false);
  assert.equal(machineAllows(undefined, 'update'), false);
});

test('machineOperations returns the allowlist or null (fail closed)', () => {
  const p = machinePrincipal({ id: 'w', operations: ['read'] });
  assert.deepEqual(machineOperations(p), ['read']);
  assert.equal(machineOperations({ type: 'user', id: 'u', attributes: {}, status: 'active' }), null);
  assert.equal(machineOperations(null), null);
});

test('isMachinePrincipal rejects a raw system principal (no machine discriminator)', () => {
  assert.equal(isMachinePrincipal({ type: 'system', id: null, attributes: { source: 'x' }, status: 'active' }), false);
  assert.equal(isMachinePrincipal({ type: 'user', id: 'u', attributes: {}, status: 'active' }), false);
  assert.equal(isMachinePrincipal(null), false);
});

// ---- allowlist enforcement: admitSystemMutation (schedule admission) ----

function admitSetup(verb = 'update') {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const Blog = entity('MachineAdmit', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    schedule: {
      [verb]: schedule.at(publishedAt, { with: { published: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO MachineAdmit (id, publishedAt) VALUES (?, ?)').run('row1', now - 1000);
  const source = schedulerSource(Blog.name, verb, Blog.schedule[verb].triggerId);
  return { db, Blog, now, source };
}

test('admitSystemMutation admits a machine principal whose allowlist contains the dispatched operation', () => {
  const { db, Blog, now, source } = admitSetup();
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true },
    principal: machinePrincipal({ id: source, operations: ['update'] }),
    db, now,
  });
  assert.equal(granted, true, 'granted operation + exact source + declared payload → admitted');
  db.close();
});

test('admitSystemMutation DENIES a dispatched operation outside the allowlist (fail closed)', () => {
  const { db, Blog, now, source } = admitSetup();
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true },
    // The principal is only granted 'create' — 'update' is not in the allowlist.
    principal: machinePrincipal({ id: source, operations: ['create'] }),
    db, now,
  });
  assert.equal(granted, false, 'operation not in the allowlist → deny, even with the exact schedule source');
  db.close();
});

test('admitSystemMutation DENIES a raw/legacy id-less system principal (no allowlist → implicit grant removed)', () => {
  const { db, Blog, now, source } = admitSetup();
  const granted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1',
    payload: { published: true },
    principal: { type: 'system', attributes: { source } },
    db, now,
  });
  assert.equal(granted, false, '"internal" is never an implicit grant — an unattributed system principal is denied');
  db.close();
});

test('admitSystemMutation DENIES a user principal and a wrong-source machine principal (fail closed)', () => {
  const { db, Blog, now } = admitSetup();
  assert.equal(admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1', payload: { published: true },
    principal: { type: 'user', id: 'u1', attributes: {}, status: 'active' }, db, now,
  }), false, 'user principal denied');
  assert.equal(admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'row1', payload: { published: true },
    principal: machinePrincipal({ id: 'OtherEntity.update.elsewhere', operations: ['update'] }), db, now,
  }), false, 'machine principal bound to another schedule source denied');
  db.close();
});

// ---- allowlist enforcement: clock dispatch mints attributable machine principals ----

test('clock dispatch mints a machine principal whose allowlist covers the trigger verb', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const Blog = entity('ClockMachine', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    schedule: {
      update: schedule.at(publishedAt, { with: { published: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO ClockMachine (id, publishedAt) VALUES (?, ?)').run('c1', Date.now() - 1000);

  const calls = [];
  const handle = startClockTriggers({
    db, entities: [Blog],
    dispatch: (args) => calls.push(args),
    now: () => Date.now(),
  });
  handle.stop();
  assert.equal(calls.length, 1, 'due row dispatched');
  assert.equal(calls[0].principal.type, 'system');
  assert.equal(calls[0].principal.attributes.machine, true, 'dispatch principal is a machine principal');
  assert.equal(machineAllows(calls[0].principal, 'update'), true, 'the trigger verb is in the allowlist');
  assert.equal(calls[0].principal.attributes.source, schedulerSource('ClockMachine', 'update', 'publishedAt'));
  db.close();
});

// ---- revocation contract: live delivery ----

function liveDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE IF NOT EXISTS Note (id TEXT PRIMARY KEY, title TEXT)');
  return db;
}

function insertNote(db, id, title) {
  db.prepare('INSERT OR REPLACE INTO Note (id, title) VALUES (?, ?)').run(id, title);
}

function appendEvent(db, scope, seq, type, data = {}) {
  db.prepare(
    'INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(scope, seq, type, JSON.stringify(data), `action-${seq}`, new Date().toISOString());
  db.prepare(
    'INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq',
  ).run(scope, seq);
}

function makeEntity(name) {
  return {
    name,
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    grant: () => [scope(() => true).can(async () => true)],
  };
}

const alwaysAllow = async () => true;
const simpleProjector = ({ event, scope }) => [{ type: event.eventType ?? event.type, seq: event.seq, scope }];

test('revocation fires registered listeners exactly once per publish', async () => {
  const db = liveDb();
  insertNote(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntity('Note')]]),
    mayVerb: alwaysAllow,
    projectRecipient: simpleProjector,
  });
  const fired = [];
  const unsubscribe = core.onRevocation((principal, resourceScope) => fired.push([principal.id, resourceScope]));
  const u1 = { type: 'user', id: 'u1' };
  core.revoke(u1, { category: 'entity', key: 'Note:n1' });
  assert.equal(fired.length, 1, 'one revoke call fires the listener exactly once');
  assert.deepEqual(fired[0], ['u1', { category: 'entity', key: 'Note:n1' }]);
  unsubscribe();
  core.revoke(u1, { category: 'entity', key: 'Note:n1' });
  assert.equal(fired.length, 1, 'an unsubscribed listener hears nothing');
  core.close();
  db.close();
});

test('scope-match: a revocation wakes ONLY the affected subscriptions', async () => {
  const db = liveDb();
  insertNote(db, 'n1', 'hello');
  insertNote(db, 'n2', 'world');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });
  appendEvent(db, 'Note:n2', 1, 'Note.created', { title: 'world' });

  // Count reauthorizations per subscription row: subscribe does checkMayRow +
  // catchUp checkMayRow (2 per sub). A revocation wake adds one more ONLY for
  // the matching scope.
  const auths = { n1: 0, n2: 0 };
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntity('Note')]]),
    mayVerb: async (entity, verb, row) => { auths[String(row?.id)] += 1; return true; },
    projectRecipient: simpleProjector,
  });
  await core.subscribe({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null, deliver: async () => {} });
  await core.subscribe({ principal: { type: 'user', id: 'u2' }, scope: 'Note:n2', after: 0, signal: null, deliver: async () => {} });
  const before = { ...auths };
  assert.equal(before.n1, 2);
  assert.equal(before.n2, 2);

  core.revoke({ type: 'user', id: 'u1' }, { category: 'entity', key: 'Note:n1' });
  await sleep(50);

  assert.equal(auths.n1, 3, 'the affected Note:n1 subscription was re-authorized immediately');
  assert.equal(auths.n2, 2, 'the unaffected Note:n2 subscription was left alone');
  core.close();
  db.close();
});

test('scope-match: a principal-scope revocation wakes every subscription of that principal', async () => {
  const db = liveDb();
  insertNote(db, 'n1', 'hello');
  insertNote(db, 'n2', 'world');
  appendEvent(db, 'Note:n1', 1, 'Note.created');
  appendEvent(db, 'Note:n2', 1, 'Note.created');

  const auths = { u1: 0, u2: 0 };
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntity('Note')]]),
    mayVerb: async (entity, verb, row, principal) => { auths[principal.id] += 1; return true; },
    projectRecipient: simpleProjector,
  });
  await core.subscribe({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null, deliver: async () => {} });
  await core.subscribe({ principal: { type: 'user', id: 'u1' }, scope: 'Note:n2', after: 0, signal: null, deliver: async () => {} });
  await core.subscribe({ principal: { type: 'user', id: 'u2' }, scope: 'Note:n1', after: 0, signal: null, deliver: async () => {} });
  assert.equal(auths.u1, 4, 'two u1 subs each auth twice at subscribe');
  assert.equal(auths.u2, 2, 'u2 sub auths twice at subscribe');

  core.revoke({ type: 'user', id: 'u1' }, { category: 'principal', key: 'user:u1' });
  await sleep(50);

  assert.equal(auths.u1, 6, 'both of u1 subscriptions re-authorized by the principal-scope revocation');
  assert.equal(auths.u2, 2, 'u2 untouched by u1 principal revocation');
  core.close();
  db.close();
});

test('revocation-during-bootstrap: a subscriber registered after revocation receives the revoked state on first delivery', async () => {
  const db = liveDb();
  insertNote(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created');

  // The adapter reflects the revocation: u1's access to Note:n1 is gone.
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntity('Note')]]),
    mayVerb: async (entity, verb, row, principal) => principal.id !== 'u1',
    projectRecipient: simpleProjector,
  });
  const result = await core.bootstrap({
    principal: { type: 'user', id: 'u1' },
    scope: 'Note:n1',
    snapshot: async ({ principal: recipient, scope }) => core.snapshot({ principal: recipient, scope }),
  });
  assert.deepEqual(result, { kind: 'revoked' }, 'no live-feed window for a revoked reader — first delivery is the revoked state');
  core.close();
  db.close();
});

test('revocation-during-delivery: revoke ends a live feed through the one removal path (transport revoke once)', async () => {
  const db = liveDb();
  insertNote(db, 'n1', 'hello');
  appendEvent(db, 'Note:n1', 1, 'Note.created', { title: 'hello' });

  let auths = 0;
  let transportRevokes = 0;
  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', makeEntity('Note')]]),
    // Authorize the subscribe + first catchUp, then deny the reauthorization a
    // revocation wake triggers.
    mayVerb: async () => { auths += 1; return auths <= 2; },
    projectRecipient: simpleProjector,
  });
  const delivered = [];
  await core.subscribe({
    principal: { type: 'user', id: 'u1' }, scope: 'Note:n1', after: 0, signal: null,
    deliver: async (batch) => { delivered.push(...batch); },
    revoke: () => { transportRevokes += 1; },
  });
  assert.equal(delivered.length, 1, 'event 1 delivered');
  assert.equal(auths, 2);

  const fired = [];
  core.onRevocation((principal, resourceScope) => fired.push([principal.id, resourceScope]));
  // Access revoked: the adapter now denies, and the revocation is published.
  core.revoke({ type: 'user', id: 'u1' }, { category: 'entity', key: 'Note:n1' });
  await sleep(50);

  assert.equal(fired.length, 1, 'the revocation fired the listener exactly once');
  assert.equal(transportRevokes, 1, 'the revoked live feed ended through the one removal path');
  assert.equal(delivered.length, 1, 'no further events delivered after revocation');

  // A later wake is a no-op — the subscription is gone.
  appendEvent(db, 'Note:n1', 2, 'Note.updated', { title: 'revoked' });
  core.wake('Note:n1');
  await sleep(50);
  assert.equal(delivered.length, 1, 'a revoked reader keeps nothing');
  assert.equal(fired.length, 1, 'the woken-then-denied subscription did not re-publish (exactly once)');
  core.close();
  db.close();
});

// ---- allowlist-via-context: job-queue dispatch ----

const JOB_SECRET = 'machine-job-secret';

test('job-queue: dispatch validates the executing principal against the handler context and denies on mismatch (fn never runs)', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: JOB_SECRET, maxAttempts: 1 });
  queue.enqueue({ kind: 'transcribe', payload: { url: 'a' } });

  let ran = false;
  const worker = queue.work('transcribe', async () => { ran = true; return { ok: true }; }, {
    principal: machinePrincipal({ id: 'worker:1', operations: ['update'] }),
    operations: ['execute'], // handler needs 'execute' — not granted to the principal
    pollIntervalMs: Infinity,
  });
  const res = await worker.once();
  assert.equal(res.denied, 'execute', 'the ungranted operation is reported');
  assert.equal(ran, false, 'the handler fn is NEVER invoked on a denied dispatch');
  const row = db.prepare('SELECT status, payload FROM _Job WHERE kind = ?').get('transcribe');
  assert.equal(row.status, 'failed', 'a denied job is recorded as failed (fail closed)');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.denied, true, 'the denial reason is recorded');
  assert.equal(payload.operation, 'execute');
  worker.stop();
  db.close();
});

test('job-queue: a principal granted the handler operations runs the job normally', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: JOB_SECRET });
  queue.enqueue({ kind: 'render', payload: { n: 1 } });

  const seen = [];
  const worker = queue.work('render', async (job) => { seen.push(job.payload.n); return { done: true }; }, {
    principal: machinePrincipal({ id: 'worker:2', operations: ['execute', 'update'] }),
    operations: ['execute'],
    pollIntervalMs: Infinity,
  });
  const res = await worker.once();
  assert.equal(res.denied, undefined, 'not denied when the principal is granted the handler operations');
  assert.deepEqual(seen, [1], 'the handler ran');
  assert.equal(db.prepare('SELECT status FROM _Job WHERE kind = ?').get('render').status, 'completed');
  worker.stop();
  db.close();
});

test('job-queue: work() requires an attributable machine principal (fail closed at construction)', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: JOB_SECRET });
  assert.throws(
    () => queue.work('k', async () => {}, { principal: null, operations: ['execute'] }),
    /attributable machine principal is required/,
  );
  assert.throws(
    () => queue.work('k', async () => {}, { principal: { type: 'user', id: 'u' }, operations: ['execute'] }),
    /attributable machine principal is required/,
  );
  assert.throws(
    () => queue.work('k', async () => {}, { principal: machinePrincipal({ id: 'w', operations: ['execute'] }), operations: [] }),
    /must be a non-empty array/,
  );
  assert.throws(
    () => queue.work('k', async () => {}, { principal: machinePrincipal({ id: 'w', operations: ['execute'] }), operations: ['hack'] }),
    /unknown operation 'hack'/,
  );
  assert.throws(
    () => queue.enqueue({ kind: 'k', principal: { type: 'system', attributes: { source: 'x' } } }),
    /must be an attributable machine principal/,
  );
  db.close();
});

test('job-queue: the job attribution (enqueue principal) must also cover the handler operations', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const queue = createJobQueue({ db, sharedSecret: JOB_SECRET, maxAttempts: 1 });
  queue.enqueue({
    kind: 'attributed',
    payload: {},
    principal: machinePrincipal({ id: 'job-owner', operations: ['read'] }),
  });

  let ran = false;
  const worker = queue.work('attributed', async () => { ran = true; return {}; }, {
    principal: machinePrincipal({ id: 'worker:3', operations: ['execute', 'update'] }),
    operations: ['update'], // the worker is granted it, but the JOB's attribution is not
    pollIntervalMs: Infinity,
  });
  const res = await worker.once();
  assert.equal(res.denied, 'update', 'a job whose attribution does not grant the handler operations is denied');
  assert.equal(ran, false, 'fn never invoked');
  worker.stop();
  db.close();
});
