// S5/A3 — Field and transition admission (issue #78).
//
// Field-level read admission is enforced uniformly in recipient projections:
// unreadable fields are omitted, unreadable annotated-text fields redact to the
// explicit restricted placeholder, denied writes fail 403 with a generic reason
// code (never a field name), interest/validation errors never reveal which
// field names exist, and update/delete admission evaluates the proposed
// after-row so a transition out of the principal's write scope is rejected even
// though the current row is in scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { annotatedText, entity, everyone, grant, read, ref, scope, subscribe, text, write } from '../build/index.mjs';
import workbench from '../build/internal.mjs';
import { projectRowForRecipient } from '../build/entity/projection.mjs';
import { admitRowTransition, annotatedTextDeniedPlaceholder, mayReadField, readableFieldNames } from '../build/field-admission.mjs';
import { authorizeFieldOp } from '../build/strategy/shared.mjs';
import { authorizeSubscription } from '../build/live-admission.mjs';

const alice = { type: 'user', id: 'alice' };
const bob = { type: 'user', id: 'bob' };

// A Doc whose row grant grants read/write to the owner and read-only to every
// scoped member, plus a `secret` field whose own `.can` is readable/writable by
// the owner only. `title`/`owner` have no `.can` and strong-inherit the row grant.
function declareDoc() {
  return entity('Doc', {
    title: text(),
    owner: text(),
    secret: text().can(async ({ is }) => (await is.owner() ? grant(read, write) : grant())),
    checks: {
      owner: ({ entity: row, principal }) => row.owner === principal.id,
    },
    grant: () => [scope(() => everyone()).can(async ({ is }) => (
      await is.owner() ? grant(read, write, subscribe) : grant(read, subscribe)
    ))],
  });
}

function bootDoc() {
  const declaration = declareDoc();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT, title TEXT, owner TEXT, secret TEXT)');
  db.prepare('INSERT INTO Doc VALUES (?, ?, ?, ?)').run('d1', 'Report', 'alice', 'top-secret-value');
  const app = workbench({ db, entities: [declaration] });
  return { db, app, Doc: app.entity(declaration) };
}

// ---- Read projection: omit unreadable fields, exactly the readable subset ----

test('projectRowForRecipient omits unreadable fields and keeps the readable subset', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  const forAlice = await projectRowForRecipient(Doc, row, alice);
  assert.deepEqual(Object.keys(forAlice).sort(), ['id', 'owner', 'secret', 'title']);
  assert.equal(forAlice.secret, 'top-secret-value');

  // Bob can read the row (member) but not the owner-only `secret` field.
  const forBob = await projectRowForRecipient(Doc, row, bob);
  assert.deepEqual(Object.keys(forBob).sort(), ['id', 'owner', 'title']);
  assert.equal('secret' in forBob, false, 'unreadable field is omitted');
  // No field content can leak through an excerpt/sort/filter/count surface over
  // the projected row.
  assert.equal(JSON.stringify(forBob).includes('top-secret-value'), false);
});

test('readableFieldNames returns exactly the readable field subset', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  const aliceReadable = await readableFieldNames(Doc, row, alice);
  assert.equal(aliceReadable.has('secret'), true);
  const bobReadable = await readableFieldNames(Doc, row, bob);
  assert.equal(bobReadable.has('secret'), false);
  assert.equal(bobReadable.has('title'), true);
  assert.equal(bobReadable.has('owner'), true);
});

test('mayReadField denies the unreadable field without any field-name echo', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  assert.equal(await mayReadField(Doc, 'secret', row, bob), false);
  assert.equal(await mayReadField(Doc, 'title', row, bob), true);
  assert.equal(await mayReadField(Doc, 'secret', row, alice), true);
});

// ---- Read projection: annotated-text redaction to the explicit placeholder ----

function declareTranscript() {
  return entity('Transcript', {
    title: text(),
    owner: ref('User', { role: 'owner' }),
    project: ref('Project'),
    body: annotatedText({ project: 'project', owner: 'owner' }).can(async ({ is }) => (
      await is.owner() ? grant(read, write) : grant()
    )),
    grant: () => [scope(() => everyone()).can(() => grant(read, write))],
  });
}

test('projectRowForRecipient redacts an unreadable annotated-text field to the explicit placeholder', async () => {
  const declaration = declareTranscript();
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, entities: [declaration] });
  const Transcript = app.entity(declaration);
  const row = Transcript.deserializeRow({ id: 't1', title: 'T', owner: 'alice', project: 'p1' });

  // Owner reads the body field (not a stored column, so absent from the row).
  const forAlice = await projectRowForRecipient(Transcript, row, alice);
  assert.equal('body' in forAlice, false);

  // Bob cannot read the body field: it redacts to the explicit restricted
  // recipient placeholder — the same wire shape the existing recipient
  // projection emits for a fully-restricted document, with no canonical facts.
  const forBob = await projectRowForRecipient(Transcript, row, bob);
  assert.equal(forBob.body.kind, 'workbench.annotatedText.recipient');
  assert.equal(forBob.body.version, 1);
  assert.equal(forBob.body.restricted, true);
  assert.equal(forBob.body.text, '');
  assert.deepEqual(forBob.body.annotations, []);
  assert.deepEqual(forBob.body.measurements, []);
  db.close();
});

test('annotatedTextDeniedPlaceholder is a frozen explicit restricted recipient shape', () => {
  const placeholder = annotatedTextDeniedPlaceholder();
  assert.equal(placeholder.kind, 'workbench.annotatedText.recipient');
  assert.equal(placeholder.restricted, true);
  assert.equal(placeholder.text, '');
  assert.ok(Object.isFrozen(placeholder));
});

// ---- Write rejection: 403, generic reason code, no field-name echo ----

test('authorizeFieldOp rejects a write to a protected field with a generic 403 (no field name)', async () => {
  const { Doc } = bootDoc();
  const row = Doc.deserializeRow({ id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' });

  // Bob cannot write the owner-only `secret` field.
  let thrown = null;
  try {
    await authorizeFieldOp(Doc, 'secret', write, row, bob);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'protected field write must throw');
  assert.equal(thrown.status, 403);
  assert.equal(thrown.message, 'forbidden');
  assert.equal(thrown.reasonCode, 'no-field-access');
  // The failure never echoes the field name or its value.
  assert.equal(thrown.message.includes('secret'), false);
  assert.equal(JSON.stringify(thrown.failure).includes('secret'), false);

  // The owner is admitted — no throw.
  await authorizeFieldOp(Doc, 'secret', write, row, alice);
});

// ---- Inference prevention: errors never distinguish existing vs missing fields ----

test('live subscribe interest error never reveals the requested field name', async () => {
  const { db, app } = bootDoc();
  const conn = { id: 'c1', closed: false, principal: bob, send() {} };
  const fanout = { subscriptionCount: () => 0, hasSubscription: () => false };
  const deps = {
    resolveEntity: (name) => app.entities.get(name),
    mayVerb: async () => true,
    db,
    fanout,
  };

  // An unknown field is rejected with a message that carries no field name.
  const unknown = await authorizeSubscription({ entity: 'Doc', id: 'd1', fields: { bogus: true } }, conn, deps);
  assert.equal(unknown.admitted, false);
  assert.equal(unknown.failure.category, 'invalid-input');
  assert.match(unknown.failure.message, /unknown field/i);
  assert.equal(unknown.failure.message.includes('bogus'), false);

  // An existing-but-unreadable field is indistinguishable from a readable one:
  // subscription succeeds (projection omits the field at delivery).
  const existing = await authorizeSubscription({ entity: 'Doc', id: 'd1', fields: { secret: true } }, conn, deps);
  assert.equal(existing.admitted, true);
});

// ---- Proposed-transition mutation admission ----

test('admitRowTransition rejects an update that moves the row out of the principal write scope', async () => {
  const { Doc } = bootDoc();
  const before = { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' };
  const afterOutOfScope = { ...before, owner: 'bob' };
  const afterInScope = { ...before, title: 'Updated' };

  // Current row in scope, proposed after-row out of scope -> rejected.
  assert.equal(
    await admitRowTransition({ entity: Doc, verb: 'update', before, after: afterOutOfScope, principal: alice }),
    false,
    'transition out of the write scope must be rejected',
  );
  // Current row in scope and proposed after-row still in scope -> admitted.
  assert.equal(
    await admitRowTransition({ entity: Doc, verb: 'update', before, after: afterInScope, principal: alice }),
    true,
  );
  // A principal already out of scope on the current row stays denied.
  assert.equal(
    await admitRowTransition({ entity: Doc, verb: 'update', before, after: afterInScope, principal: bob }),
    false,
  );
});

test('admitRowTransition evaluates field access against both the current and proposed row', async () => {
  const { Doc } = bootDoc();
  const before = { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' };
  const afterOutOfScope = { ...before, owner: 'bob' };

  // Alice writes `secret` on the current row, but the transition re-owns the
  // row so the after-row field access denies -> rejected.
  assert.equal(
    await admitRowTransition({
      entity: Doc, verb: 'update', fieldName: 'secret', capability: write,
      before, after: afterOutOfScope, principal: alice,
    }),
    false,
  );
  // Field access on an in-scope transition is admitted.
  assert.equal(
    await admitRowTransition({
      entity: Doc, verb: 'update', fieldName: 'secret', capability: write,
      before, after: { ...before, title: 'Updated' }, principal: alice,
    }),
    true,
  );
});

test('admitRowTransition delete/revoke evaluates the stable before anchor when no after-row exists', async () => {
  const { Doc } = bootDoc();
  const before = { id: 'd1', title: 'Report', owner: 'alice', secret: 'top-secret-value' };

  // Owner remove: admitted against the current anchor.
  assert.equal(await admitRowTransition({ entity: Doc, verb: 'remove', before, principal: alice }), true);
  // Non-owner remove: denied (no write capability).
  assert.equal(await admitRowTransition({ entity: Doc, verb: 'remove', before, principal: bob }), false);
  // Absent current row fails closed.
  assert.equal(await admitRowTransition({ entity: Doc, verb: 'remove', before: null, principal: alice }), false);
});
