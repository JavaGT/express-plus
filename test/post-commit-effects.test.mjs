import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import workbench, { authorizedRows, entity, everyone, grant, postCommitEffect, read, ref, scope, text, write } from '../src/index.mjs';

const principal = { type: 'user', id: 'editor', attributes: {} };

function transferAction({ authorize = () => true, failProjection = false, ran }) {
  return {
    type: 'artefact.transfer',
    authorize,
    handler({ payload }) {
      ran.handlers += 1;
      return {
        events: [
          { type: 'artefact.transferred', scope: `project:${payload.source}`, data: { id: payload.id, project: payload.target } },
          { type: 'artefact.received', scope: `project:${payload.target}`, data: { id: payload.id } },
        ],
        privateFact: { before: { project: payload.source, secret: 'canonical' }, after: { project: payload.target } },
        effects: [
          postCommitEffect({ file: 'media', operation: 'copy', key: payload.id, verification: 'target-sha', payload: { from: payload.source, to: payload.target } }),
          postCommitEffect({ file: 'media', operation: 'retain-source', key: payload.id, verification: 'retained-sha' }),
        ],
      };
    },
    projections: [{
      eventTypes: ['artefact.transferred'],
      apply(event, db) {
        db.prepare('UPDATE Artefact SET project = ? WHERE id = ?').run(event.data.project, event.data.id);
        if (failProjection) throw new Error('projection failed');
      },
    }],
  };
}

async function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE Artefact (id TEXT PRIMARY KEY, project TEXT NOT NULL); INSERT INTO Artefact VALUES ('a1', 'source')");
  const ran = { handlers: 0, io: 0 };
  const app = workbench({ db, actions: [transferAction({ ...options, ran })] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  return { app, db, ran };
}

function request() {
  return { actionId: 'move-1', scope: 'project:source', type: 'artefact.transfer', payload: { id: 'a1', source: 'source', target: 'target' }, principal };
}

test('multi-project events, ownership, private fact, receipt, and effects commit atomically; projection runs no I/O', async (t) => {
  const { app, db, ran } = await setup(t);
  const result = await app.dispatch(request());
  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map((event) => event.scope), ['project:source', 'project:target']);
  assert.equal(db.prepare("SELECT project FROM Artefact WHERE id = 'a1'").get().project, 'target');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _ActionReceipt').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 2);
  assert.equal(ran.io, 0, 'projection/replay cannot execute runner I/O');

  const duplicate = await app.dispatch(request());
  assert.equal(duplicate.deduped, true);
  assert.equal(ran.handlers, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 2);
});

test('authorization and projection failure leave no cross-project, fact, receipt, or effect footprint', async (t) => {
  for (const options of [{ authorize: () => false }, { failProjection: true }]) {
    const { app, db } = await setup(t, options);
    const result = await app.dispatch(request());
    assert.equal(result.ok, false);
    assert.equal(db.prepare("SELECT project FROM Artefact WHERE id = 'a1'").get().project, 'source');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM _Log').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 0);
  }
});

test('authorizedRows requires the same principal capability on both project rows through the check/grant grammar', async (t) => {
  const Project = entity('TransferProject', {
    name: text(),
    owner: ref('User', { role: 'owner' }),
    grant: () => [scope(() => everyone()).can(async ({ is }) =>
      (await is.owner()) ? grant(read, write) : grant(read))],
  });
  let handled = 0;
  const action = {
    type: 'cross-project.authorized',
    authorize: authorizedRows(({ payload }) => [
      { entity: Project, id: payload.source, capability: write },
      { entity: Project, id: payload.target, capability: write },
    ]),
    handler: ({ payload }) => {
      handled += 1;
      return [{ type: 'cross-project.committed', scope: `TransferProject:${payload.source}`, data: {} }];
    },
  };
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [Project], actions: [action] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  db.prepare('INSERT INTO TransferProject (id, name, owner) VALUES (?, ?, ?)').run('source', 'Source', 'editor');
  db.prepare('INSERT INTO TransferProject (id, name, owner) VALUES (?, ?, ?)').run('target', 'Target', 'other');

  const denied = await app.dispatch({ actionId: 'denied-both', scope: 'TransferProject:source', type: action.type, payload: { source: 'source', target: 'target' }, principal });
  assert.equal(denied.ok, false);
  assert.equal(handled, 0);
  db.prepare("UPDATE TransferProject SET owner = 'editor' WHERE id = 'target'").run();
  const granted = await app.dispatch({ actionId: 'granted-both', scope: 'TransferProject:source', type: action.type, payload: { source: 'source', target: 'target' }, principal });
  assert.equal(granted.ok, true);
  assert.equal(handled, 1);
});

test('recipient event and ordinary receipt do not leak canonical fact or effect descriptors', async (t) => {
  const { app, db } = await setup(t);
  await app.dispatch(request());
  const recipient = db.prepare("SELECT eventData FROM _Log WHERE scope = 'project:target'").get();
  assert.deepEqual(JSON.parse(recipient.eventData), { id: 'a1' });
  const receipt = db.prepare('SELECT * FROM _ActionReceipt').get();
  assert.equal(JSON.stringify(receipt).includes('canonical'), false);
  assert.equal(JSON.stringify(recipient).includes('target-sha'), false);
});

test('claim is ordered per key, fenced, lease-recoverable, target-verified, and completion-idempotent', async (t) => {
  let now = 100;
  const { app } = await setup(t);
  await app.dispatch(request());
  const runner = (await import('../src/post-commit-effects.mjs')).createPostCommitEffectRunner({ db: app.db, leaseMs: 10, now: () => now });
  const first = runner.claim('w1');
  assert.equal(first.id.ordinal, 0);
  assert.equal(runner.claim('w2'), null, 'same key preserves order while predecessor incomplete');
  assert.deepEqual(runner.complete(first.id, 'w1', first.fence, { verification: 'wrong' }), { accepted: false, verification: false });
  now = 111;
  const recovered = runner.claim('w2');
  assert.equal(recovered.id.ordinal, 0);
  assert.ok(recovered.fence > first.fence);
  assert.equal(runner.complete(first.id, 'w1', first.fence, { verification: 'target-sha' }).accepted, false, 'stale fence rejected');
  assert.deepEqual(runner.complete(recovered.id, 'w2', recovered.fence, { verification: 'target-sha' }), { accepted: true, noop: false });
  assert.deepEqual(runner.complete(recovered.id, 'w2', recovered.fence, { verification: 'wrong' }), { accepted: false, verification: false });
  assert.deepEqual(runner.complete(recovered.id, 'w2', recovered.fence, { verification: 'target-sha' }), { accepted: true, noop: true });
  assert.equal(runner.claim('w3').id.ordinal, 1);
});

test('independent keys claim concurrently; heartbeat extends a lease and fail honors retry time', async (t) => {
  let now = 100;
  const { app, db } = await setup(t);
  await app.dispatch(request());
  db.prepare("UPDATE _PostCommitEffect SET exclusionKey = 'independent' WHERE ordinal = 1").run();
  const runner = (await import('../src/post-commit-effects.mjs')).createPostCommitEffectRunner({ db, leaseMs: 10, now: () => now });

  const first = runner.claim('w1');
  const second = runner.claim('w2');
  assert.equal(first.id.ordinal, 0);
  assert.equal(second.id.ordinal, 1, 'a claimed effect does not block an independent key');
  now = 105;
  assert.equal(runner.heartbeat(first.id, 'w1', first.fence), true);
  assert.deepEqual(runner.fail(second.id, 'w2', second.fence, { retryAt: 120 }), { accepted: true });
  now = 111;
  assert.equal(runner.claim('w3'), null, 'heartbeat keeps the original lease live');
  assert.equal(runner.complete(first.id, 'w1', first.fence, { verification: 'target-sha' }).accepted, true);
  assert.equal(runner.claim('w3'), null, 'failed work remains unavailable before retryAt');
  now = 120;
  const retried = runner.claim('w3');
  assert.equal(retried.id.ordinal, 1);
  assert.ok(retried.fence > second.fence);
});

test('expired ownership cannot heartbeat or complete before recovery', async (t) => {
  let now = 100;
  const { app, db } = await setup(t);
  await app.dispatch(request());
  const runner = (await import('../src/post-commit-effects.mjs')).createPostCommitEffectRunner({ db, leaseMs: 10, now: () => now });
  const claimed = runner.claim('expired');
  now = 110;
  assert.equal(runner.heartbeat(claimed.id, 'expired', claimed.fence), false);
  assert.equal(runner.complete(claimed.id, 'expired', claimed.fence, { verification: 'target-sha' }).accepted, false);
  assert.equal(runner.fail(claimed.id, 'expired', claimed.fence).accepted, false);
  const recovered = runner.claim('recovery');
  assert.ok(recovered.fence > claimed.fence);
});

test('effects require a canonical private before/after envelope', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, actions: [{
    type: 'invalid.fact', authorize: () => true,
    handler: () => ({
      events: [],
      effects: [postCommitEffect({ file: 'f', operation: 'copy', verification: 'v' })],
    }),
  }] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const result = await app.dispatch({ actionId: 'invalid-fact', scope: 'project:p', type: 'invalid.fact', payload: {}, principal });
  assert.equal(result.ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PrivateActionFact').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _PostCommitEffect').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _ActionReceipt').get().c, 0);
});

test('fresh reconstruction derives missing pending rows without changing completed rows or running I/O', async (t) => {
  const { app, db, ran } = await setup(t);
  await app.dispatch(request());
  const first = app.postCommitEffects.claim('w');
  app.postCommitEffects.complete(first.id, 'w', first.fence, { verification: 'target-sha' });
  db.prepare('DELETE FROM _PostCommitEffect WHERE ordinal = 1').run();
  assert.deepEqual(app.postCommitEffects.reconstruct(), { inserted: 1 });
  assert.deepEqual(app.postCommitEffects.reconstruct(), { inserted: 0 });
  assert.equal(db.prepare('SELECT status FROM _PostCommitEffect WHERE ordinal = 0').get().status, 'completed');
  assert.equal(db.prepare('SELECT status FROM _PostCommitEffect WHERE ordinal = 1').get().status, 'pending');
  assert.equal(ran.io, 0);
});
