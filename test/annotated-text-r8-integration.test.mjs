import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, boolean, entity, executeDDL, executeFrameworkDDL, grant, measurement, ref, read, scope, write, everyone,
  registerAnnotatedTextContract, registerAnnotatedTextStructuralExtension, protectingAnnotation, admin, deny,
} from '../src/internal.mjs';
import { exportAnnotatedText } from '../src/index.mjs';
import { materializeText, restoreTextFamily } from '../src/annotated-text-continuous.mjs';
import { projectRangeToOffsets } from '../src/annotated-text-ranges.mjs';
import { native } from '../src/event-handle.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

const extension = {
  version: 1,
  validate() {},
  edit() {},
  partition({ blockText, utf16Offset, payload }) {
    return { version: 1, leftPayload: { ...payload, text: blockText.slice(0, utf16Offset) }, rightPayload: { ...payload, text: blockText.slice(utf16Offset) } };
  },
  combine({ left, right }) { return { version: 1, payload: { text: `${left?.payload?.text ?? ''}${right?.payload?.text ?? ''}` } }; },
};
registerAnnotatedTextContract('r8IntegrationSource', Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension('r8IntegrationSource', Object.freeze(extension));

function r8Doc({
  protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant(),
  access = () => grant(read, write),
} = {}) {
  return entity('R8IntegrationDocument', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('coding'),
        annotation('tag', { fields: { value: boolean({ default: false }) } }),
        annotation('other', { fields: { value: boolean({ default: false }) } }),
        annotation('comment', { empty: 'orphan' }),
        protectingAnnotation('confidential', { protects: 'coding', access: protectingAccess }),
      ],
      measurements: [measurement('source', { extension: 'r8IntegrationSource' })],
    }),
    grant: [scope(() => everyone()).can(access)],
  });
}

async function appFor(db = new DatabaseSync(':memory:'), principalId = null, options) {
  const Document = r8Doc(options);
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(async ({ is }) => (await is.owner()) ? grant(read, write, admin) : deny('not project owner'))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(Document, db);
  const app = workbench({ db, entities: [Project, Document] });
  if (principalId !== null) app.listen(0, { principalOf: () => typeof principalId === 'function' ? principalId() : ({ id: principalId }) });
  else app.start();
  await app.ready;
  return { app, db, Document, Project };
}

async function setupDoc(docText, principalId = null, options) {
  const { app, db, Document, Project } = await appFor(new DatabaseSync(':memory:'), principalId, options);
  const created = await app.dispatch({
    actionId: 'create', type: 'R8IntegrationDocument.create',
    payload: {
      id: 'd1', project: 'p1', owner: 'u1',
      ...(docText ? { body: { version: 1, blocks: [{ text: docText }] } } : {}),
    },
    principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);

  const row = db.prepare("SELECT * FROM R8IntegrationDocument WHERE id = 'd1'").get();
  const principal = { id: typeof principalId === 'function' ? (principalId()?.id ?? 'u1') : (principalId ?? 'u1') };
  const binding = await withAuthoringBinding({
    db, entity: Document, Document, row, principal, fieldName: 'body', descriptor: Document.fields.body,
  });

  async function refreshBinding(forPrincipal = principal) {
    const current = db.prepare("SELECT * FROM R8IntegrationDocument WHERE id = 'd1'").get();
    return withAuthoringBinding({
      db, entity: Document, Document, row: current, principal: forPrincipal,
      fieldName: 'body', descriptor: Document.fields.body,
    });
  }

  function authoringOf(b, mutationId = `m-${randomUUID()}`) {
    return { version: 1, stream: b.streamToken, lease: b.leaseToken, mutationId };
  }

  return {
    app, db, Document, Project, binding, refreshBinding, authoringOf,
    documentPositionToken: binding.documentPositionToken,
  };
}

function familyText(db) {
  const state = db.prepare("SELECT family_checkpoint FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get();
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function durableAnnotatedTextState(db) {
  const prefix = 'R8IntegrationDocument_body';
  const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '${prefix}_*' ORDER BY name`)
    .all()
    .map(({ name }) => name)
    .filter((name) => !name.includes('_authoring_'));
  return tables.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map((column) => column.name);
    const order = columns.map(quote).join(', ');
    return [name, db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order}`).all()];
  });
}

test('create imports continuous family text without block tables', async () => {
  const { app, db } = await setupDoc('hello world');
  assert.equal(familyText(db), 'hello world');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get().count, 1);
  const blockTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'R8IntegrationDocument_body_block*'").all();
  assert.equal(blockTables.length, 0);
  await app.close?.();
});

test('text.insert mutates the continuous family at an absolute offset', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'insert', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-insert'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(familyText(db), 'hello! world');
  await app.close?.();
});

test('annotation.apply creates one document-scoped membership range', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const result = await app.dispatch({
    actionId: 'apply-coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-apply-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(result.ok, true, result.failure?.message);
  const ann = db.prepare("SELECT id, family FROM R8IntegrationDocument_body_annotation WHERE id = 'coding-1'").get();
  assert.equal(ann.family, 'coding');
  const memberships = db.prepare("SELECT * FROM R8IntegrationDocument_body_membership WHERE annotation_id = 'coding-1'").all();
  assert.equal(memberships.length, 1);
  assert.equal('block_id' in memberships[0], false);
  await app.close?.();
});

test('protecting annotation.apply records protected targets; remove deletes both cleanly', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  assert.equal((await app.dispatch({
    actionId: 'apply-coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'apply-protect', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-protect'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['coding-1'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation_protected_target').get().count, 1);

  const afterProtect = await refreshBinding();
  const removed = await app.dispatch({
    actionId: 'remove-protect', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(afterProtect, 'm-remove-protect'),
      edit: { kind: 'annotation.remove', annotationId: 'protect-1' },
    },
  });
  assert.equal(removed.ok, true, removed.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation WHERE id = 'protect-1'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation_protected_target').get().count, 0);
  await app.close?.();
});

test('annotation.remove is an explicit delete; tampered replay is rejected without writes', async () => {
  const { app, db, Document, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('tag me');
  assert.equal((await app.dispatch({
    actionId: 'apply-tag', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-tag'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'tag-1', family: 'tag', fields: { value: true } },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 3, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const preimage = db.serialize();
  const removed = await app.dispatch({
    actionId: 'remove-tag', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-remove-tag'),
      edit: { kind: 'annotation.remove', annotationId: 'tag-1' },
    },
  });
  assert.equal(removed.ok, true, removed.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation WHERE id = 'tag-1'").get().count, 0);

  const tampered = structuredClone(removed.events[0].data);
  tampered.facts.removedAnnotationIds = ['forged-id'];
  db.deserialize(preimage);
  assert.throws(
    () => Document.projection.apply({ handle: native('R8IntegrationDocument', 'body', 'operated'), data: tampered }, db),
  );
  assert.deepEqual(db.serialize(), preimage);
  await app.close?.();
});

test('orphan-policy annotations survive text delete that empties their range', async () => {
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('hello world');
  assert.equal((await app.dispatch({
    actionId: 'orphan-comment', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-orphan-comment'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'keep-comment', family: 'comment', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  const deleted = await app.dispatch({
    actionId: 'delete-span', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-delete-span'),
      edit: {
        kind: 'text.delete',
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 5, affinity: 'right' },
      },
    },
  });
  assert.equal(deleted.ok, true, deleted.failure?.message);
  assert.equal(familyText(db), ' world');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_annotation WHERE id = 'keep-comment'").get().count, 1);
  assert.equal(db.prepare("SELECT saved_quote FROM R8IntegrationDocument_body_annotation_orphan_state WHERE annotation_id = 'keep-comment'").get().saved_quote, 'hello');
  await app.close?.();
});

test('export produces blockless canonical; retire fences reuse', async () => {
  const { app, db, Project } = await setupDoc('retired secret');
  const Doc = r8Doc();
  const exportRequest = {
    app, entity: Doc, field: Doc.body, documentId: 'd1',
    expectedOwningScope: { entity: Project, id: 'p1' },
  };
  const exported = await exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } });
  assert.equal(exported.kind, 'workbench.annotatedText.canonical');
  assert.equal(exported.text, 'retired secret');
  assert.equal(Object.hasOwn(exported, 'blocks'), false);
  assert.deepEqual(exported.ranges, []);
  assert.deepEqual(exported.annotations, []);

  const retired = await app.dispatch({
    actionId: 'retire-d1', type: 'R8IntegrationDocument.annotatedText.retire', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1' },
  });
  assert.equal(retired.ok, true, retired.failure?.message);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM R8IntegrationDocument_body_retired WHERE document_id = 'd1'").get().count, 1);
  await assert.rejects(exportAnnotatedText({ ...exportRequest, principal: { id: 'u1' } }));
  const reused = await app.dispatch({
    actionId: 'reuse-d1', type: 'R8IntegrationDocument.create', scope: 'Project:p1', principal: { id: 'u1' }, payload: { id: 'd1', project: 'p1', owner: 'u1' },
  });
  assert.equal(reused.ok, false);
});

test('HTTP snapshot redacts for non-owner; replay requires a fresh snapshot', async (t) => {
  let principal = { id: 'u1' };
  const { app, db, binding, authoringOf, documentPositionToken, refreshBinding } = await setupDoc('secret text', () => principal, {
    protectingAccess: async ({ is }) => (await is.owner()) ? grant(read) : grant(),
  });
  t.after(async () => { await app.shutdown(); db.close(); });

  assert.equal((await app.dispatch({
    actionId: 'coding', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-coding'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'coding-1', family: 'coding', fields: {} },
        from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);
  const next = await refreshBinding();
  assert.equal((await app.dispatch({
    actionId: 'protect', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(next, 'm-protect'),
      edit: {
        kind: 'annotation.apply',
        annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['coding-1'] },
        from: { positionToken: next.documentPositionToken, offset: 0, affinity: 'left' },
        to: { positionToken: next.documentPositionToken, offset: 11, affinity: 'right' },
      },
    },
  })).ok, true);

  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const owner = await (await fetch(`${origin}/snapshot/R8IntegrationDocument/d1`, { signal: AbortSignal.timeout(5_000) })).json();
  assert.equal(owner.snapshot.body.text, 'secret text');
  assert.equal(Object.hasOwn(owner.snapshot.body, 'blocks'), false);
  assert.equal('basis' in owner.snapshot.body, false);

  principal = { id: 'u2' };
  const denied = await (await fetch(`${origin}/snapshot/R8IntegrationDocument/d1`, { signal: AbortSignal.timeout(5_000) })).json();
  assert.equal(denied.snapshot.body.kind, 'workbench.annotatedText.recipient');
  assert.equal(JSON.stringify(denied.snapshot.body).includes('secret text'), false);

  principal = { id: 'u1' };
  const replay = await fetch(`${origin}/events-since/R8IntegrationDocument/d1?cursor=0`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { resync: 'stale', reason: 'annotated-text-snapshot-required' });
});

test('v9 receipt dedupe and foreign position tokens reject without mutation', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello');
  const first = await app.dispatch({
    actionId: 'dedupe-insert', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-dedupe'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(first.ok, true, first.failure?.message);
  const again = await app.dispatch({
    actionId: 'dedupe-insert', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-dedupe'),
      edit: { kind: 'text.insert', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, text: '!' },
    },
  });
  assert.equal(again.ok, true);
  assert.equal(again.deduped === true || again.events?.length === 0 || familyText(db) === 'hello!', true);

  const before = durableAnnotatedTextState(db);
  const foreign = await app.dispatch({
    actionId: 'foreign-token', type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: {
      version: 9, id: 'd1',
      authoring: authoringOf(binding, 'm-foreign'),
      edit: { kind: 'text.insert', at: { positionToken: randomBytes(32).toString('base64url'), offset: 0, affinity: 'right' }, text: 'x' },
    },
  });
  assert.equal(foreign.ok, false);
  assert.deepEqual(durableAnnotatedTextState(db), before);
  await app.close?.();
});

test('block-era structure edits and invalid families are rejected without partial writes', async () => {
  const { app, db, binding, authoringOf, documentPositionToken } = await setupDoc('hello world');
  const before = durableAnnotatedTextState(db);
  for (const [actionId, edit] of [
    ['split', { kind: 'block.split', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, temporaryBlock: 'a'.repeat(43) }],
    ['merge', { kind: 'block.merge', leftPositionToken: documentPositionToken, rightPositionToken: documentPositionToken }],
    ['continue', { kind: 'block.continue', at: { positionToken: documentPositionToken, offset: 5, affinity: 'right' }, temporaryBlock: 'b'.repeat(43) }],
    ['unknown-family', {
      kind: 'annotation.apply',
      annotation: { id: 'x', family: 'not-declared', fields: {} },
      from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
      to: { positionToken: documentPositionToken, offset: 5, affinity: 'right' },
    }],
    ['bad-offset', {
      kind: 'annotation.apply',
      annotation: { id: 'y', family: 'coding', fields: {} },
      from: { positionToken: documentPositionToken, offset: 0, affinity: 'left' },
      to: { positionToken: documentPositionToken, offset: 99, affinity: 'right' },
    }],
  ]) {
    const result = await app.dispatch({
      actionId, type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
      payload: { version: 9, id: 'd1', authoring: authoringOf(binding, `m-${actionId}`), edit },
    });
    assert.equal(result.ok, false, actionId);
  }
  assert.deepEqual(durableAnnotatedTextState(db), before);
  await app.close?.();
});

// Boundary insert affinity is the behavior the browser demo tests assert (the
// editor's interval markers and the client-side fold projection both follow
// it). Pin it server-side so the client projection and the demo tests cannot
// drift from the authoritative family projection.
test('boundary inserts join the range at its start and stay out at its end', async () => {
  let binding;
  const at = (offset, affinity = 'right') => ({ positionToken: binding.documentPositionToken, offset, affinity });
  const dispatch = (ctx, b, actionId, edit) => ctx.app.dispatch({
    actionId, type: 'R8IntegrationDocument.body.operation', scope: 'Project:p1', principal: { id: 'u1' },
    payload: { version: 9, id: 'd1', authoring: ctx.authoringOf(b, `m-${actionId}`), edit },
  });
  const committedRange = async ({ db, refreshBinding }) => {
    binding = await refreshBinding();
    const state = db.prepare("SELECT family_checkpoint FROM R8IntegrationDocument_body_state WHERE document_id = 'd1'").get();
    const family = restoreTextFamily(JSON.parse(state.family_checkpoint));
    const membership = db.prepare("SELECT * FROM R8IntegrationDocument_body_membership WHERE annotation_id = 'edge-1'").get();
    return {
      text: materializeText(family),
      range: membership
        ? projectRangeToOffsets(family, {
          annotationId: 'edge-1',
          start: JSON.parse(membership.start_point),
          end: JSON.parse(membership.end_point),
        })
        : null,
    };
  };
  const applyRange = async (ctx) => {
    const applied = await dispatch(ctx, ctx.binding, `edge-apply-${Math.random()}`, {
      kind: 'annotation.apply',
      annotation: { id: 'edge-1', family: 'comment', fields: {} },
      from: at(1, 'right'),
      to: at(3, 'right'),
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    return committedRange(ctx);
  };

  // Insert at the range START joins the comment: the range grows to include it.
  {
    const ctx = await setupDoc('abcd');
    binding = ctx.binding;
    const before = await applyRange(ctx);
    assert.deepEqual(before.range, { start: 1, end: 3 });
    const applied = await dispatch(ctx, binding, 'edge-insert-start', {
      kind: 'text.insert', at: at(1, 'right'), text: 'X',
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    const after = await committedRange(ctx);
    assert.equal(after.text, 'aXbcd');
    assert.deepEqual(after.range, { start: 1, end: 4 }, 'insert at the range start joins the range');
    await ctx.app.close?.();
  }

  // Insert at the range END stays outside: the range is unchanged.
  {
    const ctx = await setupDoc('abcd');
    binding = ctx.binding;
    await applyRange(ctx);
    const applied = await dispatch(ctx, binding, 'edge-insert-end', {
      kind: 'text.insert', at: at(3, 'right'), text: 'X',
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    const after = await committedRange(ctx);
    assert.equal(after.text, 'abcXd');
    assert.deepEqual(after.range, { start: 1, end: 3 }, 'insert at the range end stays outside');
    await ctx.app.close?.();
  }

  // A replace covering the range empties it (orphan policy): the membership
  // disappears from the projection.
  {
    const ctx = await setupDoc('abcd');
    binding = ctx.binding;
    await applyRange(ctx);
    const applied = await dispatch(ctx, binding, 'edge-replace', {
      kind: 'text.replace',
      from: at(0, 'right'),
      to: at(4, 'right'),
      text: 'XY',
    });
    assert.equal(applied.ok, true, applied.failure?.message);
    const after = await committedRange(ctx);
    assert.equal(after.text, 'XY');
    assert.equal(after.range, null, 'a covering replace empties the range (orphan)');
    await ctx.app.close?.();
  }
});
