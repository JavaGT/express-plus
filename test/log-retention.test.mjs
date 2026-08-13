import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  grant,
  principal,
  read,
  text,
  write,
} from '../build/index.mjs';

const RetainedNote = entity('RetainedNote', {
  body: text(),
  grant: () => grant(read, write),
});

const user = principal({ type: 'user', id: 'retention-user' });

test('log retention is opt-in and configured when the application is constructed', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, logRetentionDays: 1 }).mount('/retained-notes', RetainedNote);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.start();

  await app.dispatch({
    actionId: 'old-create',
    type: 'RetainedNote.create',
    payload: { body: 'old' },
    principal: user,
  });
  await app.dispatch({
    actionId: 'recent-create',
    type: 'RetainedNote.create',
    payload: { body: 'recent' },
    principal: user,
  });
  db.prepare('UPDATE _Log SET committedAt = ? WHERE actionId = ?').run(
    new Date(Date.now() - 2 * 86_400_000).toISOString(),
    'old-create',
  );

  assert.equal(typeof app.sweepLog, 'function');
  await app.sweepLog();

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM _Log WHERE actionId = ?').get('old-create').n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM _Log WHERE actionId = ?').get('recent-create').n > 0);
});

test('log retention stays disabled by default', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db }).mount('/retained-notes', RetainedNote);
  t.after(async () => {
    await app.shutdown();
    db.close();
  });
  await app.start();

  assert.equal(app.sweepLog, undefined);
});

test('log reaper interval is configured on the application runtime', async (t) => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    logRetentionDays: 1,
    logRetentionIntervalMs: 4321,
  }).mount('/retained-notes', RetainedNote);
  const registrations = [];
  const add = app.clock.add;
  app.clock.add = (watcher) => {
    registrations.push(watcher);
    return add(watcher);
  };
  t.after(async () => {
    await app.shutdown();
    db.close();
  });

  await app.start();

  assert.equal(registrations.find((watcher) => watcher.name === 'log-reaper')?.intervalMs, 4321);
});
