// Annotated-text operated version admission + replay contract (ADR 0008).
// The projection admits exactly ONE durable operated version (v13, the
// span-native codec). v13 rows must replay deterministically from the
// committed _Log through the real projector seam (rowToEvent + projection),
// and every other version — legacy lattice v1–v12 or unknown — must fail
// closed with a stable, diagnosable error before touching durable state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, entity, everyone, executeDDL, executeFrameworkDDL,
  grant, native, parseEventType, read, ref, scope, text, write,
} from '../src/internal.mjs';
import { rowToEvent } from '../src/committed-log.mjs';
import { txn } from '../src/driver.mjs';
import { materializeText, restoreTextFamily } from '../src/annotated-text-continuous.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

function declaredEntity() {
  return entity('ReplayDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('note', { fields: {} }),
        annotation('theme', { fields: { color: text() } }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function installSchema(db) {
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(declaredEntity(), db);
}

function bindingFor(db, ReplayDoc) {
  const principal = { id: 'u1' };
  const row = db.prepare("SELECT * FROM ReplayDoc WHERE id = 'd1'").get();
  return withAuthoringBinding({
    db, entity: ReplayDoc, Document: ReplayDoc, row, principal,
    fieldName: 'body', descriptor: ReplayDoc.fields.body,
  });
}

function authoringOf(binding, mutationId) {
  return { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId };
}

function familyText(db) {
  const state = db.prepare("SELECT family_checkpoint FROM ReplayDoc_body_state WHERE document_id = 'd1'").get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

const PROJECTION_TABLES = [
  'ReplayDoc',
  'ReplayDoc_body_state',
  'ReplayDoc_body_annotation',
  'ReplayDoc_body_annotation_note',
  'ReplayDoc_body_annotation_theme',
  'ReplayDoc_body_membership',
  'ReplayDoc_body_annotation_orphan_state',
];

function projectedState(db) {
  const state = {};
  for (const table of PROJECTION_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all()
      .map((row) => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    state[table] = JSON.stringify(rows);
  }
  return state;
}

// The real rebuild seam: _Log rows -> rowToEvent (the one shared row->event
// shape, used by history/dedupe/migrations) -> projection.apply, in seq order,
// folding into the target database. The low-level projector owns NO transaction:
// a single rejected event performs zero writes, while a whole-log rebuild that
// must stay atomic has to wrap this replay in the framework's named txn boundary
// (driver txn / exclusiveTxn, the same lanes the kernel commit bracket and
// migrations use).
function replayLog(source, projection, target) {
  const rows = source.prepare('SELECT * FROM _Log ORDER BY seq').all();
  for (const raw of rows) {
    projection.apply(rowToEvent(raw, parseEventType), target);
  }
}

// Seed the committed v13 log: create + one of every v13 operated operation
// kind, all through the real app dispatch path. The premise guard at the end
// fixes that every durable operated row this fixture replays is version 13.
async function seedV13LiveLog(t) {
  const live = new DatabaseSync(':memory:');
  installSchema(live);
  const ReplayDoc = declaredEntity();
  const app = workbench({ db: live, entities: [ReplayDoc] });
  app.start();
  await app.ready;
  t.after(async () => { await app.shutdown().catch(() => {}); live.close(); });
  const principal = { id: 'u1' };

  const created = await app.dispatch({
    actionId: 'create', type: 'ReplayDoc.create', scope: 'Project:p1',
    payload: { id: 'd1', project: 'p1', owner: 'u1', body: { version: 1, blocks: [{ text: 'hello world' }] } },
    principal,
  });
  assert.equal(created.ok, true, created.failure?.message);

  let binding = await bindingFor(live, ReplayDoc);
  const insert = await app.dispatch({
    actionId: 'op-insert', type: 'ReplayDoc.body.operation', scope: 'Project:p1',
    payload: {
      version: 9, id: 'd1', authoring: authoringOf(binding, 'op-insert'),
      edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'right' }, text: 'x' },
    },
    principal,
  });
  assert.equal(insert.ok, true, insert.failure?.message);

  binding = await bindingFor(live, ReplayDoc);
  const note = await app.dispatch({
    actionId: 'op-note', type: 'ReplayDoc.body.operation', scope: 'Project:p1',
    payload: {
      version: 9, id: 'd1', authoring: authoringOf(binding, 'op-note'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'note-1', family: 'note', fields: {} },
        from: { positionToken: binding.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: 12, affinity: 'right' },
      },
    },
    principal,
  });
  assert.equal(note.ok, true, note.failure?.message);

  binding = await bindingFor(live, ReplayDoc);
  const theme = await app.dispatch({
    actionId: 'op-theme', type: 'ReplayDoc.body.operation', scope: 'Project:p1',
    payload: {
      version: 9, id: 'd1', authoring: authoringOf(binding, 'op-theme'),
      edit: {
        kind: 'annotation.apply', annotation: { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
        from: { positionToken: binding.documentPositionToken, offset: 2, affinity: 'left' },
        to: { positionToken: binding.documentPositionToken, offset: 7, affinity: 'right' },
      },
    },
    principal,
  });
  assert.equal(theme.ok, true, theme.failure?.message);

  binding = await bindingFor(live, ReplayDoc);
  const remove = await app.dispatch({
    actionId: 'op-remove', type: 'ReplayDoc.body.operation', scope: 'Project:p1',
    payload: {
      version: 9, id: 'd1', authoring: authoringOf(binding, 'op-remove'),
      edit: { kind: 'annotation.remove', annotationId: 'note-1' },
    },
    principal,
  });
  assert.equal(remove.ok, true, remove.failure?.message);

  const log = live.prepare("SELECT eventType, eventData FROM _Log WHERE eventType = 'ReplayDoc.body.operated' ORDER BY seq").all();
  assert.equal(log.length, 4);
  const kinds = log.map((row) => JSON.parse(row.eventData).operation.kind);
  assert.deepEqual(kinds, ['text.apply', 'annotation.apply-range', 'annotation.apply-range', 'annotation.remove']);
  for (const row of log) assert.equal(JSON.parse(row.eventData).version, 13, 'operated rows must all be v13');

  return { app, live, ReplayDoc };
}

test('v13 operated rows replay deterministically through the real projector/rebuild seam', async (t) => {
  const { live } = await seedV13LiveLog(t);

  const liveState = projectedState(live);
  assert.equal(familyText(live), 'xhello world');

  // Rebuild a fresh database from the same committed log through the real seam.
  const rebuilt = new DatabaseSync(':memory:');
  installSchema(rebuilt);
  const rebuiltApp = workbench({ db: rebuilt, entities: [declaredEntity()] });
  replayLog(live, rebuiltApp.entities.get('ReplayDoc').projection, rebuilt);

  assert.deepEqual(projectedState(rebuilt), liveState,
    'rebuilt projection state must byte-match the live-projected state');
  assert.equal(familyText(rebuilt), 'xhello world');
  const themeRow = rebuilt.prepare("SELECT color FROM ReplayDoc_body_annotation_theme WHERE annotation_id = 'theme-1'").get();
  assert.equal(themeRow.color, 'red');
  assert.equal(rebuilt.prepare("SELECT COUNT(*) AS c FROM ReplayDoc_body_annotation WHERE id = 'note-1'").get().c, 0);
  rebuilt.close();
});

// Stable semantic anchors for the version-guard error: the field's operated
// event, the offending version, the one admitted version, and the retired
// marker. Assertions never pin the full prose or the retirement ticket number.
function assertVersionGuardMessage(message, version) {
  const versionText = String(version);
  assert.match(message, /ReplayDoc\.body\.operated event version/);
  assert.match(message, new RegExp(`version ${versionText} is not supported`));
  assert.match(message, /only operated version 13 is admitted/);
  assert.match(message, /pre-13 lattice rows were retired and are never replayed/);
}

test('legacy lattice and unknown operated versions fail closed with a stable error', () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;

  const messageFor = (version) => {
    const data = { id: 'd1', ...(version === undefined ? {} : { version }) };
    try {
      projection.apply({ handle: native('ReplayDoc', 'body', 'operated'), data }, db);
      assert.fail(`expected operated version ${version} to fail closed`);
    } catch (error) {
      return error.message;
    }
  };

  const legacy = messageFor(11);
  const unknown = messageFor(99);
  const missing = messageFor(undefined);
  const cases = [[legacy, 11], [unknown, 99], [missing, undefined]];
  for (const [message, version] of cases) {
    assertVersionGuardMessage(message, version);
  }
  assert.ok(legacy !== unknown, 'message differs only by the offending version');

  // Fail closed: nothing was written to durable state by any rejected row.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM _Log').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ReplayDoc_body_annotation').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM ReplayDoc_body_state').get().c, 0);
  db.close();
});

test('a durable legacy lattice _Log row fails closed on replay with no state written', () => {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const projection = workbench({ db, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;

  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('ReplayDoc:d1', 1, 'ReplayDoc.body.operated',
      JSON.stringify({ id: 'd1', version: 11, operation: { kind: 'text.apply' } }),
      'legacy-action', '2024-01-01T00:00:00.000Z');
  const preimage = db.serialize();

  assert.throws(
    () => replayLog(db, projection, db),
    (error) => {
      assertVersionGuardMessage(error.message, 11);
      return true;
    },
  );
  assert.deepEqual(db.serialize(), preimage, 'rejected legacy row must leave the DB untouched');
  db.close();
});

test('batch replay atomicity requires the named txn boundary: a valid v13 write and a later legacy v11 row roll back together', async (t) => {
  const { live } = await seedV13LiveLog(t);

  // Append a trailing pre-13 lattice row to the committed log, after the
  // create and the four v13 operated rows.
  const maxSeq = live.prepare("SELECT MAX(seq) AS s FROM _Log WHERE scope = 'ReplayDoc:d1'").get().s;
  live.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('ReplayDoc:d1', maxSeq + 1, 'ReplayDoc.body.operated',
      JSON.stringify({ id: 'd1', version: 11, operation: { kind: 'text.apply' } }),
      'legacy-action', '2024-01-01T00:00:00.000Z');

  const rebuilt = new DatabaseSync(':memory:');
  installSchema(rebuilt);
  const projection = workbench({ db: rebuilt, entities: [declaredEntity()] }).entities.get('ReplayDoc').projection;
  const preimage = rebuilt.serialize();

  // The projector owns no transaction, so the whole-log rebuild must be wrapped
  // in the framework's named txn boundary (driver txn / exclusiveTxn) to undo
  // the valid v13 writes together with the legacy rejection.
  await assert.rejects(
    txn(rebuilt, () => replayLog(live, projection, rebuilt)),
    (error) => {
      assertVersionGuardMessage(error.message, 11);
      return true;
    },
  );
  assert.deepEqual(rebuilt.serialize(), preimage,
    'the named txn boundary rolls back the entire batch: the v13 writes are undone with the legacy rejection');
  rebuilt.close();
});
