// email-seam — pluggable post-commit email delivery (Deliver coat).
// Drives the shipped emailSeam / noopTransport / install / consumer / send APIs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { emailSeam, noopTransport } from '../src/email-seam.mjs';
import { createJobQueue } from '../src/job-queue.mjs';
import { executeFrameworkDDL } from '../src/ddl.mjs';

test('noopTransport is a function and resolves without throwing', async () => {
  assert.equal(typeof noopTransport, 'function');
  await noopTransport({ to: 'a@b.c', subject: 's', body: 'hello' });
});

test('emailSeam installs consumer on app and delivers email.send events', async () => {
  const sent = [];
  const seam = emailSeam({
    transport: async (msg) => { sent.push(msg); },
  });
  assert.equal(typeof seam.install, 'function');
  assert.equal(typeof seam.consumer, 'function');
  assert.equal(typeof seam.send, 'function');
  assert.equal(typeof seam.transport, 'function');

  const app = {};
  seam.install(app);
  assert.equal(app._emailConsumer, seam.consumer);

  await seam.consumer(
    [
      { type: 'Note.created', data: { id: '1' } }, // ignore non-email
      { type: 'email.send', data: { to: 'u@x.test', subject: 'hi', body: 'body' } },
      { type: 'email.send', data: { to: null, subject: 'x', body: 'y' } }, // incomplete — skip
    ],
    { db: null },
  );

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { to: 'u@x.test', subject: 'hi', body: 'body' });
});

test('emailSeam consumer swallows transport errors (best-effort post-commit)', async () => {
  const seam = emailSeam({
    transport: async () => { throw new Error('smtp down'); },
  });
  // Must not throw — post-commit failures must not undo the origin
  await seam.consumer(
    [{ type: 'email.send', data: { to: 'a@b.c', subject: 's', body: 'b' } }],
    { db: null },
  );
});

test('emailSeam.send enqueues a job when app.jobs is engaged', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const jobs = createJobQueue({ db, sharedSecret: 'test-secret-for-email-seam' });
  const app = { jobs };
  const seam = emailSeam();
  seam.send(app, { to: 'a@b.c', subject: 'sub', body: 'body' });

  const rows = db.prepare(`SELECT kind, payload FROM _Job WHERE kind = 'email'`).all();
  assert.equal(rows.length, 1);
  const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
  assert.equal(payload.to, 'a@b.c');
  assert.equal(payload.subject, 'sub');
  assert.equal(payload.body, 'body');
});

test('emailSeam.send is a no-op warn when jobs not configured', () => {
  const seam = emailSeam();
  // Must not throw
  seam.send({}, { to: 'a@b.c', subject: 's', body: 'b' });
  seam.send(null, { to: 'a@b.c', subject: 's', body: 'b' });
});

test('default emailSeam uses noopTransport', async () => {
  const seam = emailSeam();
  assert.equal(seam.transport, noopTransport);
  await seam.consumer(
    [{ type: 'email.send', data: { to: 'z@z.z', subject: 's', body: 'b' } }],
    { db: null },
  );
});
