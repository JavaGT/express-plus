import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { authorizeSubscription } from '../build/live-admission.mjs';
import { registerAnnotatedTextStructuralExtension, scope } from '../build/internal.mjs';
import { annotatedText, annotation, entity, ephemeral, grant, measurement, read, ref, registerAnnotatedTextContract, subscribe } from '../build/index.mjs';
import { executeDDL } from '../build/ddl.mjs';

const caretAdmissionMeasurement = 'caretAdmissionMeasurement';
registerAnnotatedTextContract(caretAdmissionMeasurement, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(caretAdmissionMeasurement, Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));

function annotatedEntity() {
  return {
    name: 'Doc',
    fields: { body: { kind: 'annotatedText' }, cursor: { kind: 'ephemeral' }, title: { kind: 'value' } },
    scopeFilter: () => ({ sql: '1 = 1', params: {} }),
    hydrate: (row) => row,
    grant: [scope().can(() => true)],
  };
}

function dependencies({ allowed = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Doc (id TEXT PRIMARY KEY, title TEXT)');
  db.prepare("INSERT INTO Doc (id, title) VALUES ('d1', 'visible')").run();
  const conn = { principal: { type: 'user', id: 'alice' } };
  return {
    db,
    conn,
    dependencies: {
      resolveEntity: (name) => name === 'Doc' ? annotatedEntity() : null,
      mayVerb: async () => allowed,
      fanout: { subscriptionCount: () => 0, hasSubscription: () => false },
      db,
    },
  };
}

test('annotated entities reject explicit generic ephemeral interest after subscription authorization', async () => {
  const { db, conn, dependencies: deps } = dependencies();
  try {
    const result = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1', fields: { cursor: true } }, conn, deps);
    assert.deepEqual(result, {
      admitted: false,
      failure: { category: 'invalid-input', message: 'Ephemeral interest is unavailable for annotated-text entities.' },
    });
  } finally {
    db.close();
  }
});

test('annotated ephemeral-interest rejection does not disclose itself before subscription authorization', async () => {
  const { db, conn, dependencies: deps } = dependencies({ allowed: false });
  try {
    const result = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1', fields: { cursor: true } }, conn, deps);
    assert.deepEqual(result, {
      admitted: false,
      failure: { category: 'denied', message: 'Forbidden.' },
    });
  } finally {
    db.close();
  }
});

test('annotated entities retain ordinary no-field and non-ephemeral subscriptions', async () => {
  const { db, conn, dependencies: deps } = dependencies();
  try {
    const noFields = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1' }, conn, deps);
    assert.equal(noFields.admitted, true);
    assert.equal(noFields.fields, null);
    const title = await authorizeSubscription({ type: 'subscribe', entity: 'Doc', id: 'd1', fields: { title: true } }, conn, deps);
    assert.equal(title.admitted, true);
    assert.deepEqual(title.fields, { title: true });
  } finally {
    db.close();
  }
});

test('caret interest requires a compiled declared caret association', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const WithCaret = entity('WithCaret', {
      project: ref('Project'), owner: ref('User'), presence: ephemeral({ caret: true }),
      body: annotatedText({ project: 'project', owner: 'owner', carets: { field: 'presence', cell: 'caret' }, annotations: [annotation('coding')], measurements: [measurement('words', { extension: caretAdmissionMeasurement })] }),
      grant: () => grant(read, subscribe),
    });
    const WithoutCaret = entity('WithoutCaret', {
      project: ref('Project'), owner: ref('User'), body: annotatedText({ project: 'project', owner: 'owner', annotations: [annotation('coding')], measurements: [measurement('words', { extension: caretAdmissionMeasurement })] }),
      grant: () => grant(read, subscribe),
    });
    executeDDL(WithCaret, db);
    executeDDL(WithoutCaret, db);
    db.exec("INSERT INTO WithCaret (id, project, owner) VALUES ('d1', 'p1', 'u1'); INSERT INTO WithoutCaret (id, project, owner) VALUES ('d1', 'p1', 'u1');");
    const deps = {
      resolveEntity: (name) => name === 'WithCaret' ? WithCaret : name === 'WithoutCaret' ? WithoutCaret : null,
      mayVerb: async () => true,
      fanout: { subscriptionCount: () => 0, hasSubscription: () => false }, db,
    };
    const conn = { principal: { type: 'user', id: 'alice' } };
    assert.equal((await authorizeSubscription({ type: 'subscribe', entity: 'WithCaret', id: 'd1', carets: ['body'] }, conn, deps)).admitted, true);
    const denied = await authorizeSubscription({ type: 'subscribe', entity: 'WithoutCaret', id: 'd1', carets: ['body'] }, conn, deps);
    assert.deepEqual(denied, { admitted: false, failure: { category: 'invalid-input', message: 'Invalid annotated-text caret interest.' } });
  } finally {
    db.close();
  }
});
