// P3 — the post-commit fan-out registry (eng-review §D3).
//
// A committed dispatch fans its events out to registered POST-COMMIT consumers
// AFTER `db.exec('COMMIT')`. These consumers run out-of-transaction: live WS
// fan-out (sync, in-process), blob file finalize, job enqueue, webhooks (async,
// independently durable/retried). None can roll back the origin — the commit
// already happened (AGENTS.md: out-of-band effects are post-commit projection
// consumers, never a new effect primitive). A consumer error is caught: the
// committed dispatch stands; a crashed effect is reconciled on its own pass.
//
// The registry RETIRES the special-case post-commit hooks: blob finalize is no
// longer an inline kernel call, and live is no longer wired imperatively from
// serve.mjs — both are registered consumers of the committed log (declaration
// absorbs imperative wiring; a general mechanism retires its special-case).
//
// These tests exercise the kernel mechanism directly (a tap consumer, dedupe
// does not re-fire, a throwing consumer does not roll back). The live + blob
// consumers are wired by buildKernel and exercised end-to-end by the live-sync
// and blob upload/atomicity suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { createServer, durableMutationVariant } from '../src/pipeline.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

// A minimal durable kernel: a Note projection (events → rows) + CRUD handlers
// (events only, no DB writes — Fork A). Each test gets a fresh :memory: db.
function setup() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT)');

  const projections = [{
    eventTypes: ['Note.created', 'Note.updated', 'Note.removed'],
    apply(ev, d) {
      if (ev.type === 'Note.created') {
        d.prepare('INSERT INTO Note (id, body) VALUES (?, ?)').run(ev.data.id, ev.data.body ?? null);
      } else if (ev.type === 'Note.updated') {
        d.prepare('UPDATE Note SET body = ? WHERE id = ?').run(ev.data.body ?? null, ev.data.id);
      } else if (ev.type === 'Note.removed') {
        d.prepare('DELETE FROM Note WHERE id = ?').run(ev.data.id);
      }
    },
  }];

  const handlers = {
    'Note.create': ({ payload }) => {
      const id = payload.id ?? randomUUID();
      return [{ type: 'Note.created', scope: `Note:${id}`, data: { id, body: payload.body } }];
    },
    'Note.update': ({ payload }) => [
      { type: 'Note.updated', scope: `Note:${payload.id}`, data: { id: payload.id, body: payload.body } },
    ],
    'Note.remove': ({ payload }) => [
      { type: 'Note.removed', scope: `Note:${payload.id}`, data: { id: payload.id } },
    ],
  };

  return { db, projections, handlers };
}

test('a registered post-commit consumer receives committed events after dispatch', async () => {
  const { db, projections, handlers } = setup();
  const seen = [];

  const kernel = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      postCommitConsumers: [
        (events, ctx) => {
          for (const ev of events) seen.push({ type: ev.type, seq: ev.seq, actionId: ctx.actionId });
        },
      ],
    }),
  });

  const actionId = randomUUID();
  const result = await kernel.dispatch({
    actionId,
    type: 'Note.create',
    payload: { body: 'hi' },
    principal: { id: 'u1' },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'Note.created');
  assert.equal(seen[0].seq, 1);
  assert.equal(seen[0].actionId, actionId);
  db.close();
});

test('a deduped dispatch does not re-fire post-commit consumers (the commit is the fan-out boundary)', async () => {
  const { db, projections, handlers } = setup();
  let count = 0;

  const kernel = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      postCommitConsumers: [() => { count += 1; }],
    }),
  });

  const actionId = randomUUID();
  const first = await kernel.dispatch({
    actionId, type: 'Note.create', payload: { body: 'a' }, principal: { id: 'u1' },
  });
  assert.equal(first.deduped, false);
  assert.equal(count, 1);

  // A retried action with the SAME actionId returns the stored events WITHOUT
  // committing again — consumers already fanned out on the first commit.
  const retry = await kernel.dispatch({
    actionId, type: 'Note.create', payload: { body: 'a' }, principal: { id: 'u1' },
  });
  assert.equal(retry.deduped, true);
  assert.equal(count, 1);

  db.close();
});

test('a throwing post-commit consumer does not roll back the commit or block later consumers', async () => {
  const { db, projections, handlers } = setup();
  const seen = [];

  const kernel = createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: projections,
      postCommitConsumers: [
        () => { throw new Error('boom'); },        // first consumer throws
        (events) => { seen.push(events.length); }, // second consumer still runs
      ],
    }),
  });

  const result = await kernel.dispatch({
    actionId: randomUUID(),
    type: 'Note.create',
    payload: { body: 'hi' },
    principal: { id: 'u1' },
  });

  assert.equal(result.ok, true);
  // The commit stood: the projected row exists despite the consumer throwing.
  const row = db.prepare('SELECT * FROM Note WHERE id = ?').get(result.events[0].data.id);
  assert.ok(row, 'the projected row survives a post-commit consumer failure');
  // The second consumer ran despite the first throwing.
  assert.deepEqual(seen, [1]);

  db.close();
});
