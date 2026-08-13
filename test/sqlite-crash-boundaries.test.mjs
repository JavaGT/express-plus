import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createServer,
  durableMutationVariant,
  executeFrameworkDDL,
} from '../build/internal.mjs';

const ACTION_ID = 'crash-boundary-action';
const NOTE_ID = 'note-1';

const handlers = {
  'Note.create': ({ payload }) => [{
    type: 'Note.created',
    scope: `Note:${payload.id}`,
    data: payload,
  }],
};

const noteProjection = {
  eventTypes: ['Note.created'],
  apply(event, db) {
    db.prepare('INSERT INTO Note (id, body) VALUES (?, ?)')
      .run(event.data.id, event.data.body);
  },
};

function openDatabase(filename, { initialise = false } = {}) {
  const db = new DatabaseSync(filename);
  if (initialise) {
    executeFrameworkDDL(db);
    db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  return db;
}

function serverFor(db, pipeline) {
  return createServer({
    handlers,
    authorize: () => true,
    db,
    pipeline,
  });
}

function assertEmptyDurableState(db) {
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM Note').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Log').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _Cursor').get().count, 0);
}

const boundaries = [
  {
    name: 'before the log append',
    pipeline: () => durableMutationVariant({
      projectionConsumers: [noteProjection],
      admission: {
        beforeProjection: () => { throw new Error('fail before log'); },
        afterProjection: () => true,
      },
    }),
  },
  {
    name: 'between the log append and domain projection',
    pipeline: () => durableMutationVariant({
      projectionConsumers: [{
        eventTypes: ['Note.created'],
        apply: () => { throw new Error('fail before projection'); },
      }],
    }),
  },
  {
    name: 'after domain projection but before commit',
    pipeline: () => durableMutationVariant({
      projectionConsumers: [noteProjection],
      admission: {
        beforeProjection: () => true,
        afterProjection: () => { throw new Error('fail before commit'); },
      },
    }),
  },
];

for (const boundary of boundaries) {
  test(`SQLite crash boundary: ${boundary.name} leaves no partial state`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-crash-boundary-'));
    const filename = join(directory, 'workbench.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const firstDb = openDatabase(filename, { initialise: true });
    const failingServer = serverFor(firstDb, boundary.pipeline());
    const failed = await failingServer.dispatch({
      actionId: ACTION_ID,
      type: 'Note.create',
      payload: { id: NOTE_ID, body: 'durable' },
      principal: { type: 'user', id: 'user-1' },
    });

    assert.equal(failed.ok, false);
    firstDb.close();

    const reopenedDb = openDatabase(filename);
    assertEmptyDurableState(reopenedDb);

    const healthyServer = serverFor(reopenedDb, durableMutationVariant({
      projectionConsumers: [noteProjection],
    }));
    const retried = await healthyServer.dispatch({
      actionId: ACTION_ID,
      type: 'Note.create',
      payload: { id: NOTE_ID, body: 'durable' },
      principal: { type: 'user', id: 'user-1' },
    });

    assert.equal(retried.ok, true);
    assert.equal(retried.deduped, false);
    assert.equal(retried.events[0].seq, 1);
    const note = reopenedDb.prepare('SELECT id, body FROM Note').get();
    assert.equal(note.id, NOTE_ID);
    assert.equal(note.body, 'durable');
    const logRow = reopenedDb.prepare(
      'SELECT scope, seq, actionId FROM _Log',
    ).get();
    assert.equal(logRow.scope, `Note:${NOTE_ID}`);
    assert.equal(logRow.seq, 1);
    assert.equal(logRow.actionId, ACTION_ID);
    const cursor = reopenedDb.prepare('SELECT scope, lastSeq FROM _Cursor').get();
    assert.equal(cursor.scope, `Note:${NOTE_ID}`);
    assert.equal(cursor.lastSeq, 1);
    reopenedDb.close();
  });
}
