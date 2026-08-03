import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  admin, annotatedText, annotatedTextCreateAction, annotation,
  deny, entity, everyone, exportAnnotatedText, grant, map, measurement, read, readAnnotatedTextForRecipient, ref,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, scope, write,
} from '../src/index.mjs';
import { executeDDL, executeFrameworkDDL } from '../src/internal.mjs';
import { projectAnnotatedTextSnapshot } from '../src/annotated-text-snapshot.mjs';

const principal = (id) => ({ type: 'user', id, attributes: {} });
registerAnnotatedTextContract('exportAuthorizationMeasurement', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('exportAuthorizationMeasurement', Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));

test('canonical export is bound to the declared owning Project and its current admin capability', async (t) => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('project-owner'), ('editor'), ('outsider'), ('successor')");

  const Project = entity('ExportProject', {
    owner: ref('User', { role: 'owner' }),
    editors: map(ref('User'), { role: ['editor'] }),
    grant: [scope(() => everyone()).can(async ({ is }) => {
      if (await is.owner()) return grant(read, write, admin);
      return (await is.editor()) ? grant(read, write) : deny('not a project member');
    })],
  });
  const Transcript = entity('ExportTranscript', {
    project: ref(Project),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project', owner: 'owner', block: {}, annotations: [annotation('note')],
      measurements: [measurement('words', { extension: 'exportAuthorizationMeasurement' })],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Project, db);
  executeDDL(Transcript, db);
  db.exec("INSERT INTO ExportProject (id, owner) VALUES ('p1', 'project-owner'), ('p2', 'project-owner')");
  db.exec("INSERT INTO ExportProject_editors (ExportProject_id, member_id, role) VALUES ('p1', 'editor', 'editor')");

  const app = workbench({ db, entities: [Project, Transcript] });
  await app.start();
  t.after(async () => { await app.shutdown(); db.close(); });
  const created = await app.dispatch({
    actionId: 'create-editor-owned-transcript',
    principal: principal('project-owner'),
    scope: 'ExportProject:p1',
    ...annotatedTextCreateAction(Transcript, Transcript.body, {
      id: 'd1', projectId: 'p1', ownerId: 'editor',
      source: { blocks: [
        { text: 'canonical ', measurements: [{ family: 'words', payload: { provider: 'local', originalToken: 'canonical', start: 0, end: 9 } }] },
        { text: 'text' },
      ] },
    }),
  });
  assert.equal(created.ok, true, created.failure?.message);

  const request = {
    app, entity: Transcript, field: Transcript.body, documentId: 'd1',
    expectedOwningScope: { entity: Project, id: 'p1' },
  };
  const exported = await exportAnnotatedText({ ...request, principal: principal('project-owner') });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.blocks.map((block) => block.text).join(''), 'canonical text');
  assert.equal(exported.blocks.length, 2);
  assert.deepEqual(exported.measurements.map(({ family, payload }) => ({ family, payload })), [
    { family: 'words', payload: { provider: 'local', originalToken: 'canonical', start: 0, end: 9 } },
  ]);
  assert.equal(JSON.stringify(exported).includes('checkpoint'), false);
  assert.equal(JSON.stringify(exported).includes('operation'), false);

  const recipientRead = await readAnnotatedTextForRecipient({ ...request, principal: principal('editor') });
  assert.equal(recipientRead.kind, 'snapshot');
  assert.equal(typeof recipientRead.owningScopeCursor, 'number');
  assert.equal(Object.hasOwn(recipientRead, 'cursor'), false);
  assert.equal(recipientRead.document.kind, 'workbench.annotatedText.recipient');
  assert.deepEqual(recipientRead.document.blocks.filter((block) => block.kind === 'visible').map((block) => block.text), ['canonical ', 'text']);
  assert.ok(Object.isFrozen(recipientRead));
  assert.ok(Object.isFrozen(recipientRead.document));
  await assert.rejects(exportAnnotatedText({ ...request, principal: principal('editor') }), /owning scope admin authorization failed/);
  assert.deepEqual(
    await readAnnotatedTextForRecipient({ ...request, expectedOwningScope: { entity: Project, id: 'p2' }, principal: principal('editor') }),
    await readAnnotatedTextForRecipient({ ...request, documentId: 'missing', principal: principal('editor') }),
  );

  const recipient = await projectAnnotatedTextSnapshot({
    db, entity: Transcript, row: db.prepare('SELECT * FROM ExportTranscript WHERE id = ?').get('d1'),
    principal: principal('editor'), fieldName: 'body', descriptor: Transcript.fields.body,
  });
  assert.deepEqual(recipient.blocks.filter((block) => block.kind === 'visible').map((block) => block.text), ['canonical ', 'text']);
  assert.equal(recipient.measurements.length, 1);

  await assert.rejects(exportAnnotatedText({ ...request, principal: principal('editor') }), /owning scope admin authorization failed/);
  await assert.rejects(exportAnnotatedText({ ...request, principal: principal('outsider') }), /owning scope admin authorization failed/);
  await assert.rejects(exportAnnotatedText({
    ...request,
    expectedOwningScope: { entity: Project, id: 'p2' },
    principal: principal('project-owner'),
  }), /owning scope does not match document/);

  db.prepare('UPDATE ExportProject SET owner = ? WHERE id = ?').run('successor', 'p1');
  await assert.rejects(exportAnnotatedText({ ...request, principal: principal('project-owner') }), /owning scope admin authorization failed/);

  db.prepare('UPDATE ExportProject SET owner = ? WHERE id = ?').run('project-owner', 'p1');
  db.prepare('INSERT INTO ExportTranscript_body_retired (document_id, generation, retired_at) VALUES (?, ?, ?)')
    .run('d1', 'retired-generation', new Date().toISOString());
  await assert.rejects(exportAnnotatedText({ ...request, principal: principal('project-owner') }), /document is retired/);
  assert.deepEqual(await readAnnotatedTextForRecipient({ ...request, principal: principal('editor') }), { kind: 'unavailable' });
});
