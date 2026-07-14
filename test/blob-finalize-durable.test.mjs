// Wave 5 — blob finalize as a durable, cursor-backed post-commit consumer.
// Mirrors durable-effects.test.mjs's proof shape for the same _ConsumerCursor
// pattern, applied to blob-lifecycle.mjs's finalize seam (blob-lifecycle.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { text, ref, blob, scope, grant, read, write, subscribe, principal } from '../src/index.mjs';
import workbench, { entity } from '../src/internal.mjs';
import { createBlobLifecycle } from '../src/blob-lifecycle.mjs';
import { createBlobStore } from '../src/blob-store.mjs';
import { generateDDL, generateFrameworkDDL, executeFrameworkDDL } from '../src/ddl.mjs';

function photoNote() {
  return entity('Note', {
    body: text(),
    photo: blob(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), 'express-blobfinal-'));
}

async function harness(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const root = tmpRoot();
  const app = workbench({ db, blobs: { root }, entities: [photoNote()], ...options });
  app.mount('/notes', app.entity('Note'));
  await app.ddl();
  app.listen(0, { principalOf: () => ({ id: 'u1' }) });
  await app.ready;
  t.after(async () => {
    await app.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, db, root };
}

test('blob finalize consumer advances a per-scope _ConsumerCursor after finalizing', async (t) => {
  const { app, db } = await harness(t);
  const { id: blobId } = app.blobs.upload({ bytes: Buffer.from('photo-bytes'), mime: 'image/png' });

  const res = await app.dispatch({
    actionId: randomUUID(),
    type: 'Note.create',
    payload: { id: 'n1', body: 'hi', photo: blobId },
    principal: principal({ type: 'user', id: 'u1' }),
  });
  assert.equal(res.ok, true);

  const scopeKey = res.events[0].scope;
  assert.equal(app.blobs.stat(blobId).status, 'adopted');
  const cursor = db.prepare(
    'SELECT consumer, scope, lastSeq FROM _ConsumerCursor WHERE consumer = :c AND scope = :s',
  ).get({ c: 'blob.finalize', s: scopeKey });
  assert.equal(cursor.consumer, 'blob.finalize');
  assert.equal(cursor.lastSeq, 1);
});

test('an unengaged blob seam creates no durable consumer state', async (t) => {
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

  await app.dispatch({
    actionId: randomUUID(),
    type: 'Plain.create',
    payload: { id: 'p1', title: 'no blobs here' },
    principal: principal({ type: 'user', id: 'u1' }),
  });

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM _ConsumerCursor WHERE consumer = ?').get('blob.finalize').n,
    0,
    'no blobs configured -> the blob.finalize seam never engages, so it leaves no cursor row',
  );
});

test('reconcileBlobFinalize finalizes a missed blob from _Log and is idempotent', async () => {
  const db = new DatabaseSync(':memory:');
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  const Note = photoNote();
  for (const sql of generateDDL(Note)) db.exec(sql);
  const root = tmpRoot();
  const store = createBlobStore({ root, db });

  const { id: blobId } = store.upload({ bytes: Buffer.from('recovered-photo'), mime: 'image/png' });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, blobId);
  db.exec('COMMIT');
  assert.equal(store.stat(blobId).status, 'adopted');
  assert.ok(!existsSync(store.pathFor(blobId)), 'not yet finalized — simulating a crash between commit and the post-commit consumer');

  const scopeKey = 'Note:n-recover';
  Note.projection.apply(
    { type: 'Note.created', scope: scopeKey, data: { id: 'n-recover', body: 'x', photo: blobId } },
    db,
  );
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    scopeKey, 1, 'Note.created', JSON.stringify({ id: 'n-recover', body: 'x', photo: blobId }), 'create-note-recover', '2026-01-01T00:00:00.000Z',
  );

  const { reconcileBlobFinalize } = createBlobLifecycle({ blobs: store, entities: new Map([[Note.name, Note]]) });

  assert.deepEqual(await reconcileBlobFinalize(db), { finalized: 1 });
  assert.ok(existsSync(store.pathFor(blobId)), 'the missed finalize ran during recovery');
  assert.equal(
    db.prepare('SELECT lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?').get('blob.finalize', scopeKey).lastSeq,
    1,
  );

  assert.deepEqual(await reconcileBlobFinalize(db), { finalized: 0 }, 're-running recovery is a no-op once the cursor is caught up');
  rmSync(root, { recursive: true, force: true });
  db.close();
});

// finalize() is a filesystem rename — it cannot be rolled back by the SQL
// transaction wrapping the cursor write, so it is deliberately at-least-once,
// not exactly-once: a blocked cursor write can leave the byte-level finalize
// already done while the durable checkpoint stays behind. That is safe only
// because finalize() is idempotent (blob-store.mjs), so the recovery sweep's
// replay of the same id is always a no-op. This test pins that contract down
// rather than asserting a stronger atomicity the implementation can't give.
test('a blocked cursor write leaves the checkpoint behind, but the idempotent finalize still converges on reconcile', async () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const root = tmpRoot();
  const store = createBlobStore({ root, db });
  const Note = photoNote();
  for (const sql of generateDDL(Note)) db.exec(sql);

  const { id: blobId } = store.upload({ bytes: Buffer.from('atomic-photo'), mime: 'image/png' });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, blobId);
  db.exec('COMMIT');

  const { blobFinalizeConsumer } = createBlobLifecycle({ blobs: store, entities: new Map([[Note.name, Note]]) });

  db.exec(`
    CREATE TRIGGER fail_blob_cursor
    BEFORE INSERT ON _ConsumerCursor
    BEGIN
      SELECT RAISE(ABORT, 'cursor blocked');
    END
  `);

  const event = { type: 'Note.created', scope: 'Note:n-atomic', seq: 1, data: { id: 'n-atomic', body: 'x', photo: blobId } };
  await blobFinalizeConsumer([event], { db });

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM _ConsumerCursor WHERE consumer = ?').get('blob.finalize').n,
    0,
    'the checkpoint did not advance — the scope still reads as behind',
  );

  db.exec('DROP TRIGGER fail_blob_cursor');
  const { reconcileBlobFinalize } = createBlobLifecycle({ blobs: store, entities: new Map([[Note.name, Note]]) });
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    'Note:n-atomic', 1, 'Note.created', JSON.stringify(event.data), 'create-note-atomic', '2026-01-01T00:00:00.000Z',
  );
  await reconcileBlobFinalize(db);
  assert.ok(existsSync(store.pathFor(blobId)), 'the recovery sweep converges the checkpoint (a no-op re-finalize is safe)');
  assert.equal(
    db.prepare('SELECT lastSeq FROM _ConsumerCursor WHERE consumer = ? AND scope = ?').get('blob.finalize', 'Note:n-atomic').lastSeq,
    1,
  );
  rmSync(root, { recursive: true, force: true });
  db.close();
});

test('app.ready runs blob finalize recovery sweep before serving', async (t) => {
  const db = new DatabaseSync(':memory:');
  const root = tmpRoot();
  const Note = photoNote();
  const store = createBlobStore({ root, db });
  for (const sql of generateFrameworkDDL()) db.exec(sql);
  for (const sql of generateDDL(Note)) db.exec(sql);

  const { id: blobId } = store.upload({ bytes: Buffer.from('boot-recovered-photo'), mime: 'image/png' });
  db.exec('BEGIN IMMEDIATE');
  store.adopt(db, blobId);
  db.exec('COMMIT');
  const scopeKey = 'Note:n-boot';
  Note.projection.apply(
    { type: 'Note.created', scope: scopeKey, data: { id: 'n-boot', body: 'x', photo: blobId } },
    db,
  );
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    scopeKey, 1, 'Note.created', JSON.stringify({ id: 'n-boot', body: 'x', photo: blobId }), 'create-note-boot', '2026-01-01T00:00:00.000Z',
  );

  const app = workbench({ db, blobs: { root }, entities: [photoNote()] });
  app.mount('/notes', app.entity('Note'));
  app.listen(0);
  t.after(async () => { await app.shutdown(); db.close(); rmSync(root, { recursive: true, force: true }); });

  await app.ready;

  assert.ok(existsSync(store.pathFor(blobId)), 'the pre-existing crashed commit was finalized by the boot recovery sweep');
});
