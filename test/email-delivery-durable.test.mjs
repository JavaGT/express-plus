// Wave 5.3 — email delivery as a durable, cursor-backed post-commit consumer.
// Mirrors test/blob-finalize-durable.test.mjs's proof shape for the same
// _ConsumerCursor pattern, applied to email-seam.mjs's delivery seam.
//
// One deliberate divergence from the blob-finalize proof: blob-finalize's
// underlying work (a filesystem rename) is idempotent, so a reconcile replay
// after a crash is always a safe no-op. An SMTP send is NOT provably
// idempotent — test 4 below proves (rather than hides) that a crash between
// a successful send and its cursor write can cause reconcile to send AGAIN.
// That is the honest at-least-once contract this seam offers, documented in
// email-seam.mjs's header comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

import { text, grant, read, write, subscribe } from '../src/index.mjs';
import workbench, { entity } from '../src/internal.mjs';
import { emailSeam } from '../src/email-seam.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

function recordingTransport(sent, { fail = () => false } = {}) {
  return async (msg) => {
    if (fail(msg)) throw new Error('smtp down');
    sent.push(msg);
  };
}

test('email consumer advances a per-scope _ConsumerCursor after a successful send', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const sent = [];
  const seam = emailSeam({ transport: recordingTransport(sent) });

  const event = { type: 'email.send', scope: 'App:1', seq: 1, data: { to: 'a@b.c', subject: 's', body: 'hi' } };
  await seam.consumer([event], { db });

  assert.deepEqual(sent, [{ to: 'a@b.c', subject: 's', body: 'hi' }]);
  const cursor = db.prepare(
    'SELECT consumer, scope, lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?',
  ).get('email', 'App:1');
  assert.equal(cursor.consumer, 'email');
  assert.equal(cursor.lastSeq, 1);
  db.close();
});

test('an app with no email seam installed creates no durable consumer state', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [entity('Plain', {
    title: text(),
    grant: () => grant(read, write, subscribe),
  })] });
  app.mount('/plain', app.entity('Plain'));
  await app.ddl();
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.ready;

  assert.equal(
    app.postCommitConsumerDescriptors.some((d) => d.name === 'email'),
    false,
    'no email seam installed -> no email descriptor engaged',
  );
  assert.deepEqual(await app.reconcileEmailDelivery(app.db), { delivered: 0 });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM _ConsumerCursor WHERE consumer = ?').get('email').n,
    0,
  );
});

test('reconcileEmailDelivery delivers a missed email from _Log and is idempotent', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const sent = [];
  const seam = emailSeam({ transport: recordingTransport(sent) });

  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    'App:recover', 1, 'email.send', JSON.stringify({ to: 'r@b.c', subject: 'recovered', body: 'x' }), 'send-recover', '2026-01-01T00:00:00.000Z',
  );

  assert.deepEqual(await seam.reconcileEmailDelivery(db), { delivered: 1 });
  assert.deepEqual(sent, [{ to: 'r@b.c', subject: 'recovered', body: 'x' }]);
  assert.equal(
    db.prepare('SELECT lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?').get('email', 'App:recover').lastSeq,
    1,
  );

  assert.deepEqual(await seam.reconcileEmailDelivery(db), { delivered: 0 }, 're-running recovery is a no-op once the cursor is caught up');
  assert.equal(sent.length, 1, 'the transport must not be called again once the cursor is caught up');
  db.close();
});

// The honest residual risk: unlike blob finalize's idempotent rename, an SMTP
// send has no such guarantee here. A crash (simulated via a blocked cursor
// write) between a successful send and its cursor write leaves the checkpoint
// behind; reconcile correctly converges the CHECKPOINT, but that convergence
// re-runs the transport — a real duplicate send, not a safe no-op. This test
// pins that honest contract down instead of asserting a stronger guarantee
// the implementation (an external, non-idempotent transport) cannot give.
test('a blocked cursor write after a successful send can duplicate on reconcile — documented residual risk', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const sent = [];
  const seam = emailSeam({ transport: recordingTransport(sent) });

  db.exec(`
    CREATE TRIGGER fail_email_cursor
    BEFORE INSERT ON _ConsumerCursor
    BEGIN
      SELECT RAISE(ABORT, 'cursor blocked');
    END
  `);

  const event = { type: 'email.send', scope: 'App:dup', seq: 1, data: { to: 'd@b.c', subject: 'dup', body: 'x' } };
  await seam.consumer([event], { db });

  assert.equal(sent.length, 1, 'the transport call itself succeeded before the blocked cursor write');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM _ConsumerCursor WHERE consumer = ?').get('email').n,
    0,
    'the checkpoint did not advance — the scope still reads as behind',
  );

  db.exec('DROP TRIGGER fail_email_cursor');
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    'App:dup', 1, 'email.send', JSON.stringify(event.data), 'send-dup', '2026-01-01T00:00:00.000Z',
  );
  await seam.reconcileEmailDelivery(db);

  assert.equal(sent.length, 2, 'reconcile re-sent the email — a real duplicate, not a safe no-op (unlike blob finalize)');
  assert.equal(
    db.prepare('SELECT lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?').get('email', 'App:dup').lastSeq,
    1,
  );
  db.close();
});

test('app.ready runs email delivery recovery sweep before serving', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const sent = [];
  const seam = emailSeam({ transport: recordingTransport(sent) });

  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    'App:boot', 1, 'email.send', JSON.stringify({ to: 'boot@b.c', subject: 'boot', body: 'x' }), randomUUID(), '2026-01-01T00:00:00.000Z',
  );

  const app = workbench({ db, entities: [entity('Plain', {
    title: text(),
    grant: () => grant(read, write, subscribe),
  })] });
  app.mount('/plain', app.entity('Plain'));
  seam.install(app);
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); });

  await app.ready;

  assert.deepEqual(sent, [{ to: 'boot@b.c', subject: 'boot', body: 'x' }], 'the pre-existing crashed commit was delivered by the boot recovery sweep');
});
