import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotatedTextAction, annotatedTextCreateAction, annotatedTextRetireAction,
  annotation, entity, everyone, grant, measurement, read, readAnnotatedTextForRecipient, ref,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, scope, write,
} from '../src/index.mjs';
import { executeDDL, executeFrameworkDDL } from '../src/internal.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const principal = { type: 'user', id: 'viewer', attributes: {} };
registerAnnotatedTextContract('recipientReadMeasurement', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('recipientReadMeasurement', Object.freeze({
  version: 1, validate() {}, edit() {}, partition() {}, combine() {},
}));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup({ scopeAccess = async () => true, documentAccess = async () => true } = {}) {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('owner'), ('viewer')");
  const Project = entity('RecipientReadProject', {
    owner: ref('User'),
    grant: [scope(() => everyone()).can(async () => await scopeAccess() ? grant(read, write) : null)],
  });
  const Transcript = entity('RecipientReadTranscript', {
    project: ref(Project), owner: ref('User'),
    body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('note')], measurements: [measurement('words', { extension: 'recipientReadMeasurement' })] }),
    grant: [scope(() => everyone()).can(async () => await documentAccess() ? grant(read, write) : null)],
  });
  executeDDL(Project, db); executeDDL(Transcript, db);
  db.exec("INSERT INTO RecipientReadProject (id, owner) VALUES ('p1', 'owner'), ('p2', 'owner')");
  const app = workbench({ db, entities: [Project, Transcript] });
  await app.start();
  const created = await app.dispatch({ actionId: 'recipient-read-create', principal: { ...principal, id: 'owner' }, scope: 'RecipientReadProject:p1', ...annotatedTextCreateAction(Transcript, Transcript.body, { id: 'd1', projectId: 'p1', ownerId: 'owner', source: { blocks: [{ text: 'visible' }] } }) });
  assert.equal(created.ok, true, created.failure?.message);
  const request = { app, entity: Transcript, field: Transcript.body, documentId: 'd1', expectedOwningScope: { entity: Project, id: 'p1' }, principal };
  return { app, db, Project, Transcript, request, close: async () => { await app.shutdown(); db.close(); } };
}

function advance(db, scopeName = 'RecipientReadProject:p1') {
  db.prepare('INSERT INTO _Cursor (scope, lastSeq) VALUES (?, 1) ON CONFLICT(scope) DO UPDATE SET lastSeq = lastSeq + 1').run(scopeName);
}

test('recipient read returns a deeply frozen, cursor-bound public projection and ordinary absences are opaque', async (t) => {
  const c = await setup(); t.after(c.close);
  const snapshot = await readAnnotatedTextForRecipient(c.request);
  assert.equal(snapshot.kind, 'snapshot');
  assert.equal(typeof snapshot.owningScopeCursor, 'number');
  assert.equal(Object.hasOwn(snapshot, 'cursor'), false);
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.document)); assert.ok(Object.isFrozen(snapshot.document.blocks));
  assert.equal(snapshot.document.blocks[0].text, 'visible');
  assert.deepEqual(await readAnnotatedTextForRecipient({ ...c.request, documentId: 'missing' }), { kind: 'unavailable' });
  assert.deepEqual(await readAnnotatedTextForRecipient({ ...c.request, expectedOwningScope: { entity: c.Project, id: 'p2' } }), { kind: 'unavailable' });
  const retired = await c.app.dispatch({ actionId: 'recipient-read-retire', principal: { ...principal, id: 'owner' }, scope: 'RecipientReadProject:p1', ...annotatedTextRetireAction(c.Transcript, 'd1') });
  assert.equal(retired.ok, true, retired.failure?.message);
  assert.deepEqual(await readAnnotatedTextForRecipient(c.request), { kind: 'unavailable' });
});

test('owning-scope and document authorization candidates are discarded when their scope cursor changes', async (t) => {
  let allowed = true; let first; let entered; let gate = false;
  const c = await setup({ scopeAccess: async () => { if (gate) { entered.resolve(); await first.promise; } return allowed; } }); t.after(c.close);
  first = deferred(); entered = deferred(); gate = true;
  const pending = readAnnotatedTextForRecipient(c.request);
  await entered.promise; allowed = false; advance(c.db); first.resolve();
  assert.deepEqual(await pending, { kind: 'unavailable' });

  allowed = true; first = undefined; entered = undefined; gate = false;
  const documentRace = await setup({ documentAccess: async () => { if (gate) { entered.resolve(); await first.promise; } return allowed; } }); t.after(documentRace.close);
  first = deferred(); entered = deferred(); gate = true;
  const second = readAnnotatedTextForRecipient(documentRace.request);
  await entered.promise; allowed = false; advance(documentRace.db); first.resolve();
  assert.deepEqual(await second, { kind: 'unavailable' });
});

test('two relevant changes exhaust the bounded recipient read and unrelated-scope changes do not', async (t) => {
  let calls = 0; let active = false;
  let raceDb;
  const raced = await setup({ scopeAccess: async () => { calls += 1; if (active) advance(raceDb); return true; } }); t.after(raced.close);
  raceDb = raced.db; calls = 0; active = true;
  const retry = await readAnnotatedTextForRecipient(raced.request);
  assert.deepEqual(retry, { kind: 'retry' }); assert.ok(Object.isFrozen(retry)); assert.equal(Object.hasOwn(retry, 'document'), false); assert.equal(calls, 2);

  let first; let entered; calls = 0; active = false;
  const unrelated = await setup({ scopeAccess: async () => { calls += 1; if (active) { entered.resolve(); await first.promise; } return true; } }); t.after(unrelated.close);
  first = deferred(); entered = deferred(); calls = 0; active = true;
  const pending = readAnnotatedTextForRecipient(unrelated.request);
  await entered.promise; advance(unrelated.db, 'RecipientReadProject:p2'); first.resolve();
  assert.equal((await pending).kind, 'snapshot');
});

test('stable projection corruption is sanitized, and an annotated operation advances only its Project owning cursor', async (t) => {
  const c = await setup(); t.after(c.close);
  c.db.prepare("UPDATE RecipientReadTranscript_body_state SET family_checkpoint = '{}' WHERE document_id = 'd1'").run();
  await assert.rejects(readAnnotatedTextForRecipient(c.request), /^Error: annotated-text recipient read failed$/);

  const clean = await setup(); t.after(clean.close);
  const row = clean.db.prepare('SELECT * FROM RecipientReadTranscript WHERE id = ?').get('d1');
  const binding = await withAuthoringBinding({ db: clean.db, entity: clean.Transcript, Document: clean.Transcript, row, principal: { ...principal, id: 'owner' }, fieldName: 'body', descriptor: clean.Transcript.fields.body });
  const blockId = clean.db.prepare('SELECT id FROM RecipientReadTranscript_body_block WHERE document_id = ?').get('d1').id;
  const beforeProject = clean.db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'RecipientReadProject:p1'").get().lastSeq;
  const operation = annotatedTextAction(clean.Transcript, clean.Transcript.body, { id: 'd1', authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'recipient-read-operation' }, kind: 'text.insert', at: { positionToken: binding.positionTokens.get(blockId), offset: 0, affinity: 'right' }, text: 'x' });
  const result = await clean.app.dispatch({ actionId: 'recipient-read-operation', principal: { ...principal, id: 'owner' }, scope: 'RecipientReadProject:p1', ...operation });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(clean.db.prepare("SELECT lastSeq FROM _Cursor WHERE scope = 'RecipientReadProject:p1'").get().lastSeq, beforeProject + 1);
  assert.equal(clean.db.prepare("SELECT 1 FROM _Cursor WHERE scope = 'RecipientReadTranscript:d1'").get(), undefined);
});
