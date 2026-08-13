import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  annotatedText, annotation, text, entity, everyone, executeDDL, executeFrameworkDDL,
  protectingAnnotation, grant, admin, read, write, ref, scope,
} from '../build/internal.mjs';
import { materializeText, restoreTextFamily } from '../build/annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot } from '../build/internal.mjs';
import { durableHistory } from '../build/internal.mjs';
import { withAuthoringBinding } from './annotated-text-authoring-fixture.mjs';

// #22 Component B: a redacted recipient edits surrounding visible text. The
// placeholder is an affinity-bound non-editable gap — typing attaches to the
// visible neighbor (never into the hidden region), forged offsets fail closed,
// and the wire→canonical basis is re-minted per fresh snapshot.

function docDecl({ protectingAccess = async ({ is }) => (await is.owner()) ? grant(read) : grant() } = {}) {
  return entity('UCDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('theme', { fields: { color: text({ default: 'blue' }) } }),
        annotation('comment'),
        protectingAnnotation('confidential', { protects: 'theme', access: protectingAccess }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

async function setup(ownerId = 'u1') {
  const db = new DatabaseSync(':memory:');
  const UCDoc = docDecl();
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, admin))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1'), ('u2')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(UCDoc, db);
  const app = workbench({
    db,
    entities: [Project, UCDoc],
    history: durableHistory({ authorize: () => true, actions: {} }),
  });
  await app.start();
  await app.ready;
  const created = await app.dispatch({
    actionId: 'create', type: 'UCDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: ownerId },
  });
  assert.equal(created.ok, true, created.failure?.message);
  return { app, db, UCDoc, scope: 'Project:p1' };
}

async function freshBinding(ctx, principalId) {
  const { db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  return withAuthoringBinding({
    db, entity: UCDoc, Document: UCDoc, row,
    principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
  });
}

async function recipientSnapshot(ctx, principalId) {
  const { db, UCDoc } = ctx;
  const row = db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1');
  return projectAnnotatedTextSnapshot({
    db, entity: UCDoc, row, principal: { id: principalId }, fieldName: 'body', descriptor: UCDoc.fields.body,
  });
}

async function dispatchEdit(ctx, actionId, principalId, session, edit, binding) {
  const authoringBinding = binding ?? (await freshBinding(ctx, principalId));
  return ctx.app.dispatch({
    actionId, principal: { id: principalId }, scope: ctx.scope, history: { session },
    type: 'UCDoc.body.operation',
    payload: {
      version: 9, id: 'd1',
      authoring: { version: 1, stream: authoringBinding.streamToken, lease: authoringBinding.leaseToken, mutationId: actionId },
      edit: {
        ...edit,
        ...(edit.at ? { at: { ...edit.at, positionToken: edit.at.positionToken ?? authoringBinding.documentPositionToken } } : {}),
        ...(edit.from ? { from: { ...edit.from, positionToken: edit.from.positionToken ?? authoringBinding.documentPositionToken } } : {}),
        ...(edit.to ? { to: { ...edit.to, positionToken: edit.to.positionToken ?? authoringBinding.documentPositionToken } } : {}),
      },
    },
  });
}

async function seedProtectedDocument(ctx, actionPrefix = 'seed') {
  let result = await dispatchEdit(ctx, `${actionPrefix}-seed`, 'u1', 'tab-u1', {
    kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'hello secret world',
  });
  assert.equal(result.ok, true, result.failure?.message);
  result = await dispatchEdit(ctx, `${actionPrefix}-theme`, 'u1', 'tab-u1', {
    kind: 'annotation.apply',
    annotation: { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 17, affinity: 'right' },
  });
  assert.equal(result.ok, true, result.failure?.message);
  result = await dispatchEdit(ctx, `${actionPrefix}-protect`, 'u1', 'tab-u1', {
    kind: 'annotation.apply',
    annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
    from: { offset: 6, affinity: 'left' },
    to: { offset: 12, affinity: 'right' },
  });
  assert.equal(result.ok, true, result.failure?.message);
}

// Text + theme annotation WITHOUT the protecting span: every recipient is
// fully visible, so a frame minted here carries an empty redaction basis.
async function seedThemeDocument(ctx, actionPrefix = 'seed') {
  let result = await dispatchEdit(ctx, `${actionPrefix}-seed`, 'u1', 'tab-u1', {
    kind: 'text.insert', at: { offset: 0, affinity: 'right' }, text: 'hello secret world',
  });
  assert.equal(result.ok, true, result.failure?.message);
  result = await dispatchEdit(ctx, `${actionPrefix}-theme`, 'u1', 'tab-u1', {
    kind: 'annotation.apply',
    annotation: { id: 'theme-1', family: 'theme', fields: { color: 'red' } },
    from: { offset: 0, affinity: 'left' },
    to: { offset: 17, affinity: 'right' },
  });
  assert.equal(result.ok, true, result.failure?.message);
}

function durableText(ctx) {
  const state = ctx.db.prepare('SELECT family_checkpoint FROM UCDoc_body_state WHERE document_id = ?').get('d1');
  return materializeText(restoreTextFamily(JSON.parse(state.family_checkpoint)));
}

function markerPositions(snapshot) {
  return (snapshot.redactions ?? []).map((redaction) => redaction.start);
}

test('redacted recipient left-edge insert attaches to the visible neighbor, never into the hidden span', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  assert.equal(deniedBinding.snapshot.text, 'hello  world');
  assert.deepEqual(markerPositions(deniedBinding.snapshot), [6]);

  const inserted = await dispatchEdit(ctx, 'u2-left', 'u2', 'tab-u2', {
    kind: 'text.insert',
    at: { offset: 6, affinity: 'left' },
    text: 'X',
  }, deniedBinding);
  assert.equal(inserted.ok, true, inserted.failure?.message);

  // Durable: X lands at the canonical boundary, immediately before 'secret'.
  assert.equal(durableText(ctx), 'hello Xsecret world');

  // The redaction basis is re-minted against the CURRENT text: the marker
  // shifts past X and X is VISIBLE to the redacted recipient.
  const after = await recipientSnapshot(ctx, 'u2');
  assert.equal(after.kind, 'workbench.annotatedText.recipient');
  assert.equal(after.text, 'hello X world');
  assert.deepEqual(markerPositions(after), [7]);
  assert.equal(JSON.stringify(after).includes('secret'), false);
});

test('redacted recipient right-edge insert attaches to the visible right neighbor', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  const inserted = await dispatchEdit(ctx, 'u2-right', 'u2', 'tab-u2', {
    kind: 'text.insert',
    at: { offset: 6, affinity: 'right' },
    text: 'Y',
  }, deniedBinding);
  assert.equal(inserted.ok, true, inserted.failure?.message);

  assert.equal(durableText(ctx), 'hello secretY world');

  const after = await recipientSnapshot(ctx, 'u2');
  assert.equal(after.kind, 'workbench.annotatedText.recipient');
  assert.equal(after.text, 'hello Y world');
  assert.deepEqual(markerPositions(after), [6]);
  assert.equal(JSON.stringify(after).includes('secret'), false);
});

test('consecutive redacted-recipient edge typing stays visible and never leaks', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const first = await freshBinding(ctx, 'u2');
  let result = await dispatchEdit(ctx, 'u2-x', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: first.documentPositionToken, offset: 6, affinity: 'left' }, text: 'X',
  }, first);
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(durableText(ctx), 'hello Xsecret world');

  const second = await freshBinding(ctx, 'u2');
  assert.equal(second.snapshot.text, 'hello X world');
  result = await dispatchEdit(ctx, 'u2-y', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: second.documentPositionToken, offset: 7, affinity: 'right' }, text: 'Y',
  }, second);
  assert.equal(result.ok, true, result.failure?.message);
  assert.equal(durableText(ctx), 'hello XsecretY world');

  const third = await freshBinding(ctx, 'u2');
  result = await dispatchEdit(ctx, 'u2-z', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: third.documentPositionToken, offset: 8, affinity: 'right' }, text: 'Z',
  }, third);
  assert.equal(result.ok, true, result.failure?.message);
  // The re-minted basis maps wire 8 (the space after Y, marker still at 7) to
  // the boundary just before that space, so Z lands at the visible right edge
  // of the placeholder — never inside the hidden span.
  assert.equal(durableText(ctx), 'hello XsecretYZ world');

  const deniedView = await recipientSnapshot(ctx, 'u2');
  assert.equal(deniedView.kind, 'workbench.annotatedText.recipient');
  assert.equal(deniedView.text.includes('X'), true);
  assert.equal(deniedView.text.includes('Y'), true);
  assert.equal(deniedView.text.includes('Z'), true);
  assert.equal(JSON.stringify(deniedView).includes('secret'), false);
});

test('a forged selection spanning the hidden interval fails closed with position-redacted', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  // A forged delete from wire 2 (before the marker) to wire 8 (inside the
  // visible text after it) maps to a canonical range that CONTAINS the denied
  // interval — the wire→canonical table cannot hide that it spans the span.
  const deleteResult = await dispatchEdit(ctx, 'u2-forged-delete', 'u2', 'tab-u2', {
    kind: 'text.delete',
    from: { positionToken: deniedBinding.documentPositionToken, offset: 2, affinity: 'left' },
    to: { positionToken: deniedBinding.documentPositionToken, offset: 8, affinity: 'right' },
  }, deniedBinding);
  assert.equal(deleteResult.ok, false);
  assert.equal(deleteResult.failure.details.code, 'position-redacted');
  assert.equal(durableText(ctx), 'hello secret world');

  const replaceResult = await dispatchEdit(ctx, 'u2-forged-replace', 'u2', 'tab-u2', {
    kind: 'text.replace', text: '!!',
    from: { positionToken: deniedBinding.documentPositionToken, offset: 2, affinity: 'left' },
    to: { positionToken: deniedBinding.documentPositionToken, offset: 8, affinity: 'right' },
  }, deniedBinding);
  assert.equal(replaceResult.ok, false);
  assert.equal(replaceResult.failure.details.code, 'position-redacted');
  assert.equal(durableText(ctx), 'hello secret world');
});

test('a forged equal-offset selection at the marker fails closed with position-redacted', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  // Wire offsets 6/'left' → 6/'right' at the marker are equal wire offsets but
  // pin to opposite boundaries of the hidden interval: the range semantically
  // spans the denied span. The gate must reject it, not collapse it into an
  // insertion/no-op at the marker.
  const deleteResult = await dispatchEdit(ctx, 'u2-forged-eq-delete', 'u2', 'tab-u2', {
    kind: 'text.delete',
    from: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'left' },
    to: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'right' },
  }, deniedBinding);
  assert.equal(deleteResult.ok, false);
  assert.equal(deleteResult.failure.details.code, 'position-redacted');
  assert.equal(durableText(ctx), 'hello secret world');

  const replaceResult = await dispatchEdit(ctx, 'u2-forged-eq-replace', 'u2', 'tab-u2', {
    kind: 'text.replace', text: '!!',
    from: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'left' },
    to: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'right' },
  }, deniedBinding);
  assert.equal(replaceResult.ok, false);
  assert.equal(replaceResult.failure.details.code, 'position-redacted');
  assert.equal(durableText(ctx), 'hello secret world');

  const applyResult = await dispatchEdit(ctx, 'u2-forged-eq-apply', 'u2', 'tab-u2', {
    kind: 'annotation.apply',
    annotation: { id: 'u2-forged', family: 'comment', fields: {} },
    from: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'left' },
    to: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'right' },
  }, deniedBinding);
  assert.equal(applyResult.ok, false);
  assert.equal(applyResult.failure.details.code, 'position-redacted');
  assert.equal(durableText(ctx), 'hello secret world');
});

test('an edit against a stale authoring basis fails closed with position-stale', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  const first = await dispatchEdit(ctx, 'u2-stale-first', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'left' }, text: 'X',
  }, deniedBinding);
  assert.equal(first.ok, true, first.failure?.message);

  // Reusing the OLD position frame after the recipient's own edit landed: the
  // frame's family basis no longer equals the current family frontier.
  const second = await dispatchEdit(ctx, 'u2-stale-second', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: deniedBinding.documentPositionToken, offset: 7, affinity: 'right' }, text: 'Y',
  }, deniedBinding);
  assert.equal(second.ok, false);
  assert.equal(second.failure.details.code, 'position-stale');
  assert.equal(durableText(ctx), 'hello Xsecret world');
});

test('a denied editor edit response discloses no denied plaintext and no canonical family checkpoint', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  const edited = await dispatchEdit(ctx, 'u2-no-leak', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'left' }, text: 'X',
  }, deniedBinding);
  assert.equal(edited.ok, true, edited.failure?.message);
  // The edit receipt must not carry the hidden plaintext in ANY field, and the
  // canonical family checkpoint (the full text including tombstones) is only
  // released to fully-visible recipients.
  assert.equal(JSON.stringify(edited.resultData).includes('secret'), false,
    'the denied editor receipt must not disclose the hidden text');
  assert.equal('family' in (edited.resultData?.authoring ?? {}), false,
    'a redacted recipient must never receive the canonical family checkpoint');
  assert.equal(durableText(ctx), 'hello Xsecret world');
});

test('a follow-up edit against the receipt frame maps wire offsets correctly', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedProtectedDocument(ctx);

  const deniedBinding = await freshBinding(ctx, 'u2');
  const first = await dispatchEdit(ctx, 'receipt-first', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: deniedBinding.documentPositionToken, offset: 6, affinity: 'left' }, text: 'X',
  }, deniedBinding);
  assert.equal(first.ok, true, first.failure?.message);
  const receipt = first.resultData?.authoring;
  assert.ok(receipt, 'the edit response must carry the authoring receipt');

  // Continue typing against the frame the RECEIPT issued (not a fresh
  // snapshot): wire offset 7 sits at the placeholder marker of the re-minted
  // basis, so 'Y' must land on the visible right edge, never in the hidden span.
  const second = await dispatchEdit(ctx, 'receipt-second', 'u2', 'tab-u2', {
    kind: 'text.insert',
    at: { positionToken: receipt.positionFrames[0].positionToken, offset: 7, affinity: 'right' },
    text: 'Y',
  }, { streamToken: receipt.stream, leaseToken: receipt.lease });
  assert.equal(second.ok, true, second.failure?.message);
  assert.equal(durableText(ctx), 'hello XsecretY world');

  const deniedView = await recipientSnapshot(ctx, 'u2');
  assert.equal(deniedView.text, 'hello XY world');
  assert.equal(JSON.stringify(deniedView).includes('secret'), false);
});

test('an unredacted frame fails closed once a protection without a text change denies the recipient', async (t) => {
  const ctx = await setup();
  t.after(async () => { await ctx.app.shutdown(); ctx.db.close(); });
  await seedThemeDocument(ctx);

  // u2 is fully visible at frame issue time: the frame carries NO redactions.
  const binding = await freshBinding(ctx, 'u2');
  assert.deepEqual(markerPositions(binding.snapshot), []);

  // Apply the protection over the theme range WITHOUT touching the text. The
  // family frontier is unchanged, so the family-basis check alone would let the
  // old frame through — the admit gate must catch the moved redaction basis.
  const protect = await dispatchEdit(ctx, 'protect-no-text', 'u1', 'tab-u1', {
    kind: 'annotation.apply',
    annotation: { id: 'protect-1', family: 'confidential', fields: {}, protectedTargetIds: ['theme-1'] },
    from: { offset: 6, affinity: 'left' },
    to: { offset: 12, affinity: 'right' },
  });
  assert.equal(protect.ok, true, protect.failure?.message);
  assert.equal(durableText(ctx), 'hello secret world', 'applying the protection must not change the text');

  const reuse = await dispatchEdit(ctx, 'reuse-old-frame', 'u2', 'tab-u2', {
    kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 6, affinity: 'left' }, text: 'X',
  }, binding);
  assert.equal(reuse.ok, false);
  assert.equal(reuse.failure.details.code, 'position-stale');
  assert.equal(durableText(ctx), 'hello secret world', 'the stale frame must not commit any edit');
});

test('an HTTP denied editor response discloses no denied plaintext', async (t) => {
  const db = new DatabaseSync(':memory:');
  const UCDoc = docDecl();
  const Project = entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write, admin))],
  });
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('u1'), ('u2')");
  executeDDL(Project, db);
  db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'u1')");
  executeDDL(UCDoc, db);
  const app = workbench({ db, entities: [Project, UCDoc], history: durableHistory({ authorize: () => true, actions: {} }) });
  app.listen(0, { principalOf: (request) => ({ type: 'user', id: request.headers['x-user'] ?? 'u1', attributes: {} }) });
  await app.ready;
  t.after(async () => { app.httpServer?.closeAllConnections?.(); await app.shutdown(); db.close(); });
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

  const ctx = { app, db, UCDoc, scope: 'Project:p1' };
  const created = await app.dispatch({
    actionId: 'create', type: 'UCDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1' }, principal: { id: 'u1' },
  });
  assert.equal(created.ok, true, created.failure?.message);
  await seedProtectedDocument(ctx);

  const binding = await withAuthoringBinding({
    db, entity: UCDoc, Document: UCDoc, row: db.prepare('SELECT * FROM UCDoc WHERE id = ?').get('d1'),
    principal: { type: 'user', id: 'u2', attributes: {} }, fieldName: 'body', descriptor: UCDoc.fields.body,
  });
  const response = await fetch(`${origin}/workbench/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': 'u2' },
    body: JSON.stringify({
      actionId: 'http-denied-insert', scope: 'Project:p1', type: 'UCDoc.body.operation', clientId: 'tab-u2',
      payload: {
        version: 9, id: 'd1',
        authoring: { version: 1, stream: binding.streamToken, lease: binding.leaseToken, mutationId: 'http-denied-insert' },
        edit: { kind: 'text.insert', at: { positionToken: binding.documentPositionToken, offset: 6, affinity: 'left' }, text: 'X' },
      },
    }),
  });
  const bodyText = await response.text();
  const body = JSON.parse(bodyText);
  assert.equal(response.status, 200, bodyText);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(JSON.stringify(body).includes('secret'), false,
    'the denied editor HTTP response must not disclose the hidden plaintext');
  assert.equal(durableText(ctx), 'hello Xsecret world');
});
