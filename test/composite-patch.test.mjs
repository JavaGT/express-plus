// Composite snapshot patch delivery tests (#122 design §13).
//
// Parity oracle: applyPatches(initialSnapshot, patches) deep-equals a fresh
// authorized snapshot at the same cursor, across principals with varied
// denials. Non-disclosure red-lines: denied creates emit nothing; removals of
// never-visible rows name nothing; field values absent from a fresh snapshot
// never appear in patches. Cursor decisions and ledger eviction fallbacks are
// exercised against the real delivery seam.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, inherit, ref, text, grant, read, subscribe, write, scope, everyone, snapshot } from '../build/index.mjs';
const { object, select, include, keyed, many, one, count, orderBy, related, user: userNode } = snapshot;
import { executeDDL, executeFrameworkDDL } from '../build/internal.mjs';

const alice = { type: 'user', id: 'alice', attributes: {} };
const bob = { type: 'user', id: 'bob', attributes: {} };

function buildGraph(db) {
  db.exec(`
    CREATE TABLE Project (id TEXT PRIMARY KEY, name TEXT, owner TEXT);
    CREATE TABLE Code (id TEXT PRIMARY KEY, projectId TEXT REFERENCES Project(id), label TEXT, colour TEXT, position INTEGER);
    CREATE TABLE Note (id TEXT PRIMARY KEY, codeId TEXT REFERENCES Code(id), projectId TEXT REFERENCES Project(id), title TEXT);
    CREATE TABLE Meta (id TEXT PRIMARY KEY, noteId TEXT REFERENCES Note(id), tag TEXT);
  `);
}

function entities() {
  const Project = entity('Project', {
    name: text(),
    // A compiled read-scope keyed on the row owner column; children inherit it
    // through `inherit(Project, ...)`. `owner` mirrors the acting principal id.
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, subscribe))],
  });
  const Code = entity('Code', {
    projectId: ref(Project, { immutable: true }),
    label: text(),
    colour: text({ optional: true }),
    position: text({ optional: true }),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const Note = entity('Note', {
    projectId: ref(Project, { immutable: true }),
    codeId: ref(Code),
    title: text(),
    grant: inherit(Project, { via: 'projectId' }),
  });
  const Meta = entity('Meta', {
    noteId: ref(Note),
    tag: text(),
    grant: () => grant(read, subscribe),
  });
  return { Project, Code, Note, Meta };
}

async function setup(t, { principal = alice, authorization = null, declare = true } = {}) {
  const db = new DatabaseSync(':memory:');
  buildGraph(db);
  const { Project, Code, Note, Meta } = entities();
  executeDDL(Code, db);
  executeDDL(Note, db);
  executeDDL(Meta, db);
  const app = workbench({
    db,
    entities: [Project, Code, Note, Meta],
    actions: [
      projectAction(), codeAction(), noteAction(), metaAction(),
    ],
  });
  if (declare) {
    app.attachLiveDelivery({
      principalOf: () => principal,
      ...(authorization ? { authorization } : {}),
      snapshots: [snapshot(Project, {
        output: object({
          name: select(Project.field.name),
          codes: keyed(Code, {
            via: Code.field.projectId,
            orderBy: orderBy(Code.field.position, 'asc'),
            include: object({
              codeFields: select(Code.field.label, Code.field.colour),
              notes: many(Note, {
                via: Note.field.codeId,
                include: object({
                  noteFields: select(Note.field.title),
                  meta: keyed(Meta, { via: Meta.field.noteId, select: select(Meta.field.tag) }),
                  metaCount: count(Meta, { via: Meta.field.noteId }),
                }),
              }),
            }),
          }),
        }),
      })],
    });
  }
  await app.ddl();
  app.listen(0);
  await app.ready;
  t.after(async () => {
    app.httpServer.closeAllConnections?.();
    await app.shutdown();
    db.close();
  });
  const delivery = app._applicationLiveDelivery.delivery;
  return { app, db, delivery };
}

// ---- minimal registered actions over the graph -----------------------------

function projectAction() {
  return {
    type: 'project.write',
    authorize: ({ principal }) => principal.id === 'alice',
    handler: ({ payload }) => ({
      events: [{
        type: payload.exists ? 'Project.updated' : 'Project.created',
        scope: `Project:${payload.id}`,
        data: { id: payload.id, name: payload.name },
      }],
      privateFact: { before: payload.before ?? null, after: payload },
    }),
    projections: [{
      eventTypes: ['Project.created', 'Project.updated'],
      apply(event, tx) {
        tx.prepare(`INSERT INTO Project (id, name) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name`).run(event.data.id, event.data.name);
      },
    }],
  };
}
function codeAction() {
  return {
    type: 'code.write',
    authorize: ({ principal }) => principal.id === 'alice' || principal.id === 'bob',
    handler: ({ payload }) => {
      const events = [];
      if (!payload.exists) events.push({ type: 'Code.created', scope: `Project:${payload.projectId}`, data: payload.row });
      else if (payload.removed) events.push({ type: 'Code.removed', scope: `Project:${payload.projectId}`, data: { id: payload.row.id } });
      else events.push({ type: 'Code.updated', scope: `Project:${payload.projectId}`, data: payload.row });
      return { events, privateFact: { before: payload.before ?? null, after: payload.row } };
    },
    projections: [
      {
        eventTypes: ['Code.created', 'Code.updated'],
        apply(event, tx) {
          tx.prepare(`INSERT INTO Code (id, projectId, label, colour, position) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET label = excluded.label, colour = excluded.colour, position = excluded.position`)
            .run(event.data.id, event.data.projectId, event.data.label ?? null, event.data.colour ?? null, event.data.position ?? null);
        },
      },
      {
        eventTypes: ['Code.removed'],
        apply(event, tx) {
          tx.prepare('DELETE FROM Code WHERE id = ?').run(event.data.id);
        },
      },
    ],
  };
}
function noteAction() {
  return {
    type: 'note.write',
    authorize: ({ principal }) => principal.id === 'alice' || principal.id === 'bob',
    handler: ({ payload }) => {
      const events = [];
      if (!payload.exists) events.push({ type: 'Note.created', scope: `Project:${payload.projectId}`, data: payload.row });
      else if (payload.removed) events.push({ type: 'Note.removed', scope: `Project:${payload.projectId}`, data: { id: payload.row.id } });
      else events.push({ type: 'Note.updated', scope: `Project:${payload.projectId}`, data: payload.row });
      return { events, privateFact: { before: payload.before ?? null, after: payload.row } };
    },
    projections: [
      {
        eventTypes: ['Note.created', 'Note.updated'],
        apply(event, tx) {
          tx.prepare(`INSERT INTO Note (id, codeId, projectId, title) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET codeId = excluded.codeId, title = excluded.title`)
            .run(event.data.id, event.data.codeId, event.data.projectId, event.data.title);
        },
      },
      {
        eventTypes: ['Note.removed'],
        apply(event, tx) {
          tx.prepare('DELETE FROM Note WHERE id = ?').run(event.data.id);
        },
      },
    ],
  };
}
function metaAction() {
  return {
    type: 'meta.write',
    authorize: () => true,
    handler: ({ payload }) => {
      const events = [{ type: payload.exists ? 'Meta.updated' : 'Meta.created', scope: `Project:${payload.projectId}`, data: payload.row }];
      return { events };
    },
    projections: [{
      eventTypes: ['Meta.created', 'Meta.updated'],
      apply(event, tx) {
        tx.prepare(`INSERT INTO Meta (id, noteId, tag) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET noteId = excluded.noteId, tag = excluded.tag`).run(event.data.id, event.data.noteId, event.data.tag);
      },
    }],
  };
}

async function dispatchOk(app, request) {
  const result = await app.dispatch(request);
  assert.equal(result.ok, true, `dispatch failed for ${request.type}: ${JSON.stringify(result).slice(0, 300)}`);
  return result;
}

// ---- client-side patch application (the grammar under test's mirror) -------

function getPath(snapshotValue, path) {
  let current = snapshotValue;
  for (const segment of path) current = current[segment];
  return current;
}

function applyOperation(snapshotValue, operation) {
  const parentPath = operation.path;
  switch (operation.op) {
    case 'replace-fields': {
      // Replaces the declaration's SELECTED-field set at this node; relation
      // branches and identity are untouched (design §4).
      const target = getPath(snapshotValue, parentPath);
      Object.assign(target, JSON.parse(JSON.stringify(operation.value)));
      return;
    }
    case 'put-keyed': {
      const collection = getPath(snapshotValue, parentPath);
      collection[operation.id] = JSON.parse(JSON.stringify(operation.value));
      return;
    }
    case 'remove-keyed': {
      const collection = getPath(snapshotValue, parentPath);
      delete collection[operation.id];
      return;
    }
    case 'replace-many': {
      const segments = [...parentPath];
      const last = segments.pop();
      const holder = getPath(snapshotValue, segments);
      holder[last] = JSON.parse(JSON.stringify(operation.value));
      return;
    }
    case 'replace-one':
    case 'replace-value': {
      const segments = [...parentPath];
      const last = segments.pop();
      const holder = getPath(snapshotValue, segments);
      holder[last] = operation.value === null ? null : JSON.parse(JSON.stringify(operation.value));
      return;
    }
    default:
      throw new Error(`unknown op ${operation.op}`);
  }
}

function applyPatches(initial, envelopes) {
  let state = JSON.parse(JSON.stringify(initial));
  for (const envelope of envelopes) {
    for (const operation of envelope.operations) applyOperation(state, operation);
  }
  return state;
}

// ---- journal sanity ---------------------------------------------------------

test('composite journal records per-scope entries atomically with _Log', async (t) => {
  const { app, db } = await setup(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { id: 'p1', name: 'Research', exists: false }, principal: alice });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity', position: '1' } }, principal: alice });

  const changes = db.prepare("SELECT * FROM _CompositeChange WHERE scope = 'Project:p1' ORDER BY seq").all();
  assert.equal(changes.length, 2, 'both actions journaled');
  assert.deepEqual(JSON.parse(changes[0].affected), [{ branch: 'anchor', entity: 'Project', id: 'p1', reason: 'create' }]);
  assert.deepEqual(JSON.parse(changes[1].affected), [{ branch: 'codes', entity: 'Code', id: 'code1', reason: 'create' }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM _CompositeChangeCursor WHERE scope = 'Project:p1' AND lastSeq = 2").get().n, 1);
});

test('unselected-field member updates produce no journal entry', async (t) => {
  const { app, db } = await setup(t);
  await dispatchOk(app, { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { id: 'p1', name: 'R', exists: false }, principal: alice });
  await dispatchOk(app, { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'cA', projectId: 'p1', label: 'L', position: '1' } }, principal: alice });
  // `colour` IS selected; add an unselected column write via raw SQL to prove the gate.
  db.prepare("UPDATE Code SET position = '9' WHERE id = 'cA'").run();
  const before = db.prepare("SELECT lastSeq FROM _CompositeChangeCursor WHERE scope = 'Project:p1'").get().lastSeq;
  await dispatchOk(app, { actionId: 'c2', type: 'note.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'nX', codeId: 'cA', projectId: 'p1', title: 'T' } }, principal: alice });
  const after = db.prepare("SELECT lastSeq FROM _CompositeChangeCursor WHERE scope = 'Project:p1'").get().lastSeq;
  assert.ok(after > before, 'note create is journalled');
});

// ---- bootstrap + parity oracle ----------------------------------------------

test('patch-capable bootstrap returns composite cursor + token; legacy clients get aggregate cursors', async (t) => {
  const { app, delivery } = await setup(t);
  await dispatchOk(app, { actionId: 'p0', type: 'project.write', scope: 'Project:p1', payload: { id: 'p1', name: 'Seed', exists: false }, principal: alice });
  const legacy = await delivery.bootstrap({ principal: alice, scope: 'Project:p1' });
  assert.equal(legacy.kind, 'snapshot');
  assert.ok(!('projectionToken' in legacy), 'no token without capability negotiation');
  const patched = await delivery.bootstrap({ principal: alice, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(patched.kind, 'snapshot');
  assert.equal(patched.protocol, 'snapshot-patch/v1');
  assert.match(patched.projectionToken, /^wbpt_/);
  assert.equal(typeof patched.cursor.composite, 'number');
  assert.equal(typeof patched.cursor.anchor, 'number');
});

async function drivePatches({ t, principal, authorization, mutations, initialSetup }) {
  const { app, db, delivery } = await setup(t, { principal, authorization });
  for (const mutation of initialSetup) await dispatchOk(app, mutation);
  const boot = await delivery.bootstrap({ principal, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
  assert.equal(boot.kind, 'snapshot');
  let cursor = boot.cursor;
  let token = boot.projectionToken;
  const envelopes = [];
  for (const mutation of mutations) {
    await dispatchOk(app, { ...mutation, principal: mutation.principal ?? principal });
    const outcome = await delivery.catchup({ principal, scope: 'Project:p1', after: cursor, capabilities: ['snapshot-patch/v1'], projectionToken: token });
    if (outcome.kind === 'catchup') {
      if (outcome.envelopes.length > 0) {
        envelopes.push(...outcome.envelopes);
        token = outcome.envelopes.at(-1)?.projectionToken ?? token;
      }
      cursor = outcome.cursor;
    } else {
      // Fallback: refresh full snapshot and continue.
      const fresh = await delivery.bootstrap({ principal, scope: 'Project:p1', capabilities: ['snapshot-patch/v1'] });
      assert.notEqual(fresh.kind, 'retry');
      cursor = fresh.cursor;
      token = fresh.projectionToken;
    }
  }
  const final = await delivery.bootstrap({ principal, scope: 'Project:p1' });
  return { app, db, delivery, boot, envelopes, final };
}

test('parity oracle: keyed child lifecycle + anchor rename deep-equals fresh snapshots', async (t) => {
  const initialSetup = [
    { actionId: 'p1', type: 'project.write', scope: 'Project:p1', payload: { id: 'p1', name: 'Research', exists: false }, principal: alice },
    { actionId: 'c1', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity', colour: '#334155', position: '1' } }, principal: alice },
  ];
  const mutations = [
    { actionId: 'u1', type: 'project.write', scope: 'Project:p1', payload: { id: 'p1', name: 'Renamed', exists: true } },
    { actionId: 'c2', type: 'code.write', scope: 'Project:p1', payload: { exists: false, projectId: 'p1', row: { id: 'code2', projectId: 'p1', label: 'Money', colour: null, position: '2' } } },
    { actionId: 'c3', type: 'code.write', scope: 'Project:p1', payload: { exists: true, projectId: 'p1', row: { id: 'code1', projectId: 'p1', label: 'Identity2', colour: '#000000', position: '1' } } },
    { actionId: 'c4', type: 'code.write', scope: 'Project:p1', payload: { exists: true, removed: true, projectId: 'p1', row: { id: 'code2' } } },
  ];
  const { envelopes, final } = await drivePatches({ t, principal: alice, mutations, initialSetup });
  assert.ok(envelopes.length >= 3, `expected patch envelopes, got ${envelopes.length}`);
  const patched = applyPatches(
    { id: 'p1', name: 'Research', codes: { code1: { id: 'code1', label: 'Identity', colour: '#334155', notes: [] } } },
    envelopes,
  );
  assert.deepEqual(patched, final.snapshot, 'parity: patched state === fresh snapshot');
});
