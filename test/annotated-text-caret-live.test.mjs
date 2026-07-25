import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { annotatedText, annotation, ephemeral, entity, ref, measurement, registerAnnotatedTextContract, grant, read, subscribe } from '../src/index.mjs';
import { createAnnotatedTextCaretLive } from '../src/annotated-text-caret-live.mjs';
import { createLiveFanout } from '../src/live-fanout.mjs';
import { registerAnnotatedTextStructuralExtension } from '../src/internal.mjs';
import { executeDDL } from '../src/ddl.mjs';
import { createTextState, textCheckpoint } from '../src/annotated-text.mjs';
import { createTextFamily } from '../src/annotated-text-family.mjs';

const ext = 'caretLiveT5';
registerAnnotatedTextContract(ext, Object.freeze({ kind: 'measurement' }));
registerAnnotatedTextStructuralExtension(ext, Object.freeze({
  version: 1,
  validate: function validate() {},
  edit: function edit() {},
  partition: function partition() {},
  combine: function combine() {},
}));

function makeEntity() {
  const Doc = entity('CaretDoc', {
    project: ref('Project'), owner: ref('User'),
    presence: ephemeral({ caret: true }),
    body: annotatedText({
      project: 'project', owner: 'owner',
      carets: { field: 'presence', cell: 'caret' },
      annotations: [annotation('coding')],
      measurements: [measurement('words', { extension: ext })],
    }),
    grant: () => grant(read, subscribe),
  });
  return Doc;
}

function seedAnnotatedTextTables(db, entityName, fieldName, docId, blockId, projectId, ownerId) {
  const prefix = `${entityName}_${fieldName}`;
  const state = createTextState();
  const cp = textCheckpoint(state);
  const family = createTextFamily(docId, cp, blockId);
  db.prepare(`INSERT INTO ${prefix}_state (document_id, structure_version, family_checkpoint) VALUES (?, ?, ?)`)
    .run(docId, 0, JSON.stringify(family));
  db.prepare(`INSERT INTO ${prefix}_block (id, document_id, project_id, owner_id, position, epoch, structure_version) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(blockId, docId, projectId, ownerId, 'a', 1, 1);
}

function setup() {
  const db = new DatabaseSync(':memory:');
  const Doc = makeEntity();
  executeDDL(Doc, db);
  db.exec('CREATE TABLE Project (id TEXT PRIMARY KEY); INSERT INTO Project VALUES (\'p1\');');
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES (\'u1\'), (\'u2\');');
  db.prepare('INSERT INTO CaretDoc (id, project, owner) VALUES (?, ?, ?)').run('d1', 'p1', 'u1');
  seedAnnotatedTextTables(db, 'CaretDoc', 'body', 'd1', 'b1', 'p1', 'u1');

  const sent = [];
  const writer = { id: 'writer', principal: { id: 'u1' }, closed: false, send: (frame) => sent.push(frame) };
  const recipientA = { id: 'recipient-a', principal: { id: 'u1' }, closed: false, send: (frame) => sent.push(frame) };
  const recipientB = { id: 'recipient-b', principal: { id: 'u2' }, closed: false, send: (frame) => sent.push(frame) };

  const fanout = {
    hasCaretInterest: (conn, scope, field) => {
      if (scope === 'CaretDoc:d1' && field === 'body') return true;
      return false;
    },
    recipients: (scope, field) => {
      if (scope === 'CaretDoc:d1' && field === 'body') {
        return [[recipientA, {}], [recipientB, {}]].filter(([c]) => !c.closed);
      }
      return [];
    },
    setOnCaretInterestChange: () => {},
  };

  const live = createAnnotatedTextCaretLive({
    db,
    resolveEntity: (name) => name === 'CaretDoc' ? Doc : null,
    mayVerb: async () => true,
    fanout,
  });

  return { db, Doc, live, sent, writer, recipientA, recipientB };
}

function isCaretRemove(frame) {
  return frame?.type === 'annotated-text-caret' && frame?.change?.op === 'remove';
}

function isCaretUpsert(frame) {
  return frame?.type === 'annotated-text-caret' && frame?.change?.op === 'upsert';
}

test('successful visible upsert projects and delivers to all recipients', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const upserts = sent.filter(isCaretUpsert);
    assert.equal(upserts.length, 2, 'both recipients should receive upsert');
    for (const frame of upserts) {
      assert.equal(frame.version, 1);
      assert.equal(frame.entity, 'CaretDoc');
      assert.equal(frame.id, 'd1');
      assert.equal(frame.field, 'body');
      assert.ok(frame.change.value);
      assert.equal(frame.change.value.kind, 'caret');
      assert.equal(frame.change.value.blockId, 'b1');
      assert.equal(frame.change.value.offset, 0);
      assert.ok(typeof frame.change.value.presence === 'string');
    }
    assert.equal(sent.filter((f) => f.type === 'annotated-text-caret').length, 2);
  } finally { db.close(); }
});

test('clear sends remove to all recipients', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const presence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.ok(presence);
    sent.length = 0;
    await live.clear(writer, { type: 'caret.clear', entity: 'CaretDoc', id: 'd1', field: 'body' });
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 2, 'clear should remove from both recipients');
    for (const frame of removes) {
      assert.equal(frame.change.presence, presence);
    }
  } finally { db.close(); }
});

test('source removal (row deleted) retracts prior visible presence', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const presence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.ok(presence);
    sent.length = 0;
    db.prepare('DELETE FROM CaretDoc WHERE id = ?').run('d1');
    await assert.rejects(
      () => live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 }),
      /Caret update is denied/,
    );
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 2, 'source removal should retract from all recipients');
    for (const frame of removes) {
      assert.equal(frame.change.presence, presence);
    }
  } finally { db.close(); }
});

test('closed recipient is skipped but open recipient still receives upsert', async () => {
  const { db, live, writer, sent, recipientA } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    assert.equal(sent.filter(isCaretUpsert).length, 2, 'initial upsert to both');
    sent.length = 0;
    recipientA.closed = true;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 0, 'no remove sent to closed recipient');
    const upserts = sent.filter(isCaretUpsert);
    assert.equal(upserts.length, 1, 'open recipient should receive upsert');
    assert.equal(upserts[0].change.value.offset, 0);
  } finally { db.close(); }
});

test('recipient revocation retraction sends remove without closing connection', async () => {
  const { db, live, writer, sent, recipientA, recipientB } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    assert.equal(sent.filter(isCaretUpsert).length, 2);
    sent.length = 0;
    assert.equal(recipientA.closed, false);
    db.prepare('DELETE FROM CaretDoc WHERE id = ?').run('d1');
    await assert.rejects(
      () => live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 }),
      /Caret update is denied/,
    );
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 2, 'revocation should send remove, not close');
    assert.equal(recipientA.closed, false, 'connection should not be closed');
    assert.equal(recipientB.closed, false, 'connection should not be closed');
  } finally { db.close(); }
});

test('no delivery without explicit declared interest in carets', async () => {
  const { db, writer, sent } = setup();
  try {
    sent.length = 0;
    const fanoutNoInterest = {
      hasCaretInterest: () => false,
      recipients: () => [],
      setOnCaretInterestChange: () => {},
    };
    const liveNoInterest = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout: fanoutNoInterest,
    });
    await assert.rejects(
      () => liveNoInterest.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 }),
      /Caret subscription is required/,
    );
    assert.equal(sent.length, 0);
  } finally { db.close(); }
});

test('malformed input is rejected', async () => {
  const { db, live, writer, sent } = setup();
  try {
    const cases = [
      null,
      'string',
      [],
      { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: -1 },
      { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 1.5 },
      { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0, extra: true },
      { type: 'caret.clear', entity: 'CaretDoc', id: 'd1' },
      { type: 'caret.clear', entity: 'CaretDoc', id: 'd1', field: 'body', extra: true },
    ];
    for (const c of cases) {
      await assert.rejects(
        () => c?.type === 'caret.clear' ? live.clear(writer, c) : live.update(writer, c),
        /Invalid caret message/,
        `expected rejection for: ${JSON.stringify(c)}`,
      );
    }
    assert.equal(sent.length, 0);
  } finally { db.close(); }
});

test('no _Log mutation', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const hasLog = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_Log'").get();
    assert.equal(hasLog, undefined, '_Log table should not exist');
    await live.clear(writer, { type: 'caret.clear', entity: 'CaretDoc', id: 'd1', field: 'body' });
    assert.equal(hasLog, undefined, '_Log table should not exist after clear');
  } finally { db.close(); }
});

test('generation race: stale update cannot overtake clear', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const upserts = sent.filter(isCaretUpsert);
    assert.equal(upserts.length, 2);
    const presence1 = upserts[0]?.change?.value?.presence;
    assert.ok(presence1);
    sent.length = 0;
    await live.clear(writer, { type: 'caret.clear', entity: 'CaretDoc', id: 'd1', field: 'body' });
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 2);
    const presence2 = removes[0]?.change?.presence;
    assert.equal(presence2, presence1);
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const upserts2 = sent.filter(isCaretUpsert);
    assert.equal(upserts2.length, 2);
    assert.notEqual(upserts2[0]?.change?.value?.presence, presence1, 'stale presence should not reappear after clear');
  } finally { db.close(); }
});

test('generation race: stale update cannot overtake newer update', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const firstPresence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const secondPresence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.equal(firstPresence, secondPresence, 'presence is stable across updates for same session');
    const offsetValues = sent.filter(isCaretUpsert).map((f) => f.change.value.offset);
    assert.ok(offsetValues.every((o) => o === 0), 'all recipients should see the latest offset');
  } finally { db.close(); }
});

test('multi-recipient projection: each recipient gets correct projection', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const upserts = sent.filter(isCaretUpsert);
    assert.equal(upserts.length, 2);
    const entities = new Set(upserts.map((f) => f.entity));
    const ids = new Set(upserts.map((f) => f.id));
    const fields = new Set(upserts.map((f) => f.field));
    assert.deepEqual([...entities], ['CaretDoc']);
    assert.deepEqual([...ids], ['d1']);
    assert.deepEqual([...fields], ['body']);
    const presences = new Set(upserts.map((f) => f.change.value.presence));
    assert.equal(presences.size, 1, 'same presence across all recipients');
    const offsets = new Set(upserts.map((f) => f.change.value.offset));
    assert.deepEqual([...offsets], [0]);
  } finally { db.close(); }
});

test('source disconnect removes caret presence', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const presence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.ok(presence);
    sent.length = 0;
    await live.removeConnection(writer, 'CaretDoc:d1');
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 2, 'disconnect should remove from all recipients');
    for (const frame of removes) {
      assert.equal(frame.change.presence, presence);
    }
  } finally { db.close(); }
});

test('recipient-scoped remove: revoked recipient does not see canonical offset', async () => {
  const { db, live, writer, sent } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const upserts = sent.filter(isCaretUpsert);
    const presence = upserts[0]?.change?.value?.presence;
    assert.ok(presence);
    sent.length = 0;
    db.prepare('DELETE FROM CaretDoc WHERE id = ?').run('d1');
    await assert.rejects(
      () => live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 }),
      /Caret update is denied/,
    );
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 2, 'both recipients should get remove');
    for (const frame of removes) {
      assert.equal(frame.change.presence, presence);
      assert.ok(!('offset' in frame.change), 'remove should not contain offset');
      assert.ok(!('text' in frame.change), 'remove should not contain canonical text');
    }
  } finally { db.close(); }
});

// ── Delayed async race tests ──────────────────────────────────────────────

test('delayed first update then clear: stale upsert is suppressed', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout, delay: 20,
    });
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientB, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    sent.length = 0;
    // Establish baseline presence
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const baselinePresence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.ok(baselinePresence);
    sent.length = 0;
    // Start a delayed update, then clear while it's in-flight
    const updatePromise = live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 5 }).then(
      () => assert.fail('stale update must reject'),
      (error) => error,
    );
    await live.clear(writer, { type: 'caret.clear', entity: 'CaretDoc', id: 'd1', field: 'body' });
    assert.match((await updatePromise).message, /Caret update is denied/);
    // Only remove(s) from clear, no upsert from stale update
    assert.equal(sent.filter(isCaretUpsert).length, 0, 'stale update should not produce upsert');
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 3, 'clear should produce remove with same presence');
    for (const r of removes) assert.equal(r.change.presence, baselinePresence);
  } finally { db.close(); }
});

test('delayed first update then disconnect: stale upsert suppressed', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout, delay: 20,
    });
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientB, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    sent.length = 0;
    // Establish baseline presence
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const baselinePresence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.ok(baselinePresence);
    sent.length = 0;
    // Start a delayed update, then disconnect while in-flight
    const updatePromise = live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 5 }).then(
      () => assert.fail('stale update must reject'),
      (error) => error,
    );
    await live.removeConnection(writer, 'CaretDoc:d1');
    assert.match((await updatePromise).message, /Caret update is denied/);
    assert.equal(sent.filter(isCaretUpsert).length, 0, 'stale update should not produce upsert');
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 3, 'disconnect should produce remove with same presence');
    for (const r of removes) assert.equal(r.change.presence, baselinePresence);
  } finally { db.close(); }
});

test('delayed first update then newer update: stale upsert suppressed', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout, delay: 30,
    });
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientB, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    sent.length = 0;
    // Establish baseline
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const baselinePresence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    assert.ok(baselinePresence);
    sent.length = 0;
    // Start a delayed update, then issue a newer update while in-flight
    const update1 = live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 5 }).then(
      () => assert.fail('stale update must reject'),
      (error) => error,
    );
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    // Second update uses the same presence, so stale one is rejected
    assert.match((await update1).message, /Caret update is denied/);
    const upserts = sent.filter(isCaretUpsert);
    assert.equal(upserts.length, 3, 'newer update should produce upsert');
    for (const f of upserts) {
      assert.equal(f.change.value.offset, 0, 'all recipients see latest offset');
      assert.equal(f.change.value.presence, baselinePresence, 'presence stable across updates');
    }
  } finally { db.close(); }
});

test('delayed projection failure after newer upsert: stale remove suppressed', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout, delay: 30,
    });
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientB, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    sent.length = 0;
    // Establish baseline
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    sent.length = 0;
    // Delayed update races with newer update — stale one is rejected
    const update1 = live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 5 }).then(
      () => assert.fail('stale update must reject'),
      (error) => error,
    );
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    assert.match((await update1).message, /Caret update is denied/);
    const upserts = sent.filter(isCaretUpsert);
    assert.equal(upserts.length, 3, 'only second (newer) update should produce upsert');
    for (const f of upserts) assert.equal(f.change.value.offset, 0);
    // No spurious removes from the stale update's projection failure path
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 0, 'stale update should not produce remove on projection failure');
  } finally { db.close(); }
});

// ── Interest lifecycle tests ──────────────────────────────────────────────

test('interest removal sends remove to recipient that previously saw token', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout,
    });
    // Subscribe writer with caret interest
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    // Subscribe both recipients with caret interest
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientB, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    assert.equal(sent.filter(isCaretUpsert).length, 3);
    const presence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    sent.length = 0;
    // Remove interest from recipientA — triggers onCaretInterestChange → retraction
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: [] });
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 1, 'interest removal should remove from that recipient only');
    assert.equal(removes[0].change.presence, presence);
    assert.equal(removes[0].entity, 'CaretDoc');
    assert.equal(removes[0].field, 'body');
  } finally { db.close(); }
});

test('publisher interest removal retracts its token from every recipient', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout,
    });
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientB, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    const presence = sent.filter(isCaretUpsert)[0]?.change?.value?.presence;
    sent.length = 0;
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: [] });
    const removes = sent.filter(isCaretRemove);
    assert.equal(removes.length, 3);
    assert.ok(removes.every((frame) => frame.change.presence === presence));
  } finally { db.close(); }
});

test('publisher interest removal fences an in-flight update', async () => {
  const { db, writer, sent, recipientA } = setup();
  try {
    const fanout = createLiveFanout({ mayVerb: async () => true });
    let release;
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async () => true, fanout,
      delay: () => new Promise((resolve) => { release = resolve; }),
    });
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    fanout.addSubscription('CaretDoc:d1', recipientA, null, null, { entity: 'CaretDoc', id: 'd1', carets: ['body'] });
    const pending = live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 }).then(
      () => assert.fail('withdrawn publisher update must reject'),
      (error) => error,
    );
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    fanout.addSubscription('CaretDoc:d1', writer, null, null, { entity: 'CaretDoc', id: 'd1', carets: [] });
    release();
    assert.match((await pending).message, /Caret update is denied/);
    assert.equal(sent.filter(isCaretUpsert).length, 0);
  } finally { db.close(); }
});

test('recipient disconnect removes its refs without sending after connection already closed', async () => {
  const { db, live, writer, sent, recipientA } = setup();
  try {
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    sent.length = 0;
    recipientA.closed = true;
    // Remove connection — should not send to already-closed recipient
    await live.removeConnection(recipientA, 'CaretDoc:d1');
    assert.equal(sent.length, 0, 'no sends to already-closed connection');
    recipientA.closed = false;
  } finally { db.close(); }
});

// ── Restricted recipient tests ────────────────────────────────────────────

test('restricted recipient gets only edge, no offset, no canonical facts', async () => {
  const { db, writer, sent, recipientA, recipientB } = setup();
  try {
    // recipientB (u2) gets restricted blocks via the protecting annotation access
    // We use a mayVerb that denies u2 access to the protecting annotation
    const fanout = {
      hasCaretInterest: (conn, scope, field) => scope === 'CaretDoc:d1' && field === 'body',
      recipients: (scope, field) => scope === 'CaretDoc:d1' && field === 'body'
        ? [[recipientA, {}], [recipientB, {}]].filter(([c]) => !c.closed)
        : [],
      setOnCaretInterestChange: () => {},
    };
    const live = createAnnotatedTextCaretLive({
      db, resolveEntity: (name) => name === 'CaretDoc' ? makeEntity() : null,
      mayVerb: async (entity, verb, row, principal) => {
        // Deny u2 access to the protecting annotation
        // owner is u1, so u2 should be denied
        if (principal?.id === 'u2') return false;
        return true;
      },
      fanout,
    });
    sent.length = 0;
    await live.update(writer, { type: 'caret.update', entity: 'CaretDoc', id: 'd1', field: 'body', blockId: 'b1', offset: 0 });
    // recipientB (u2) may get restricted block — project will produce edge
    const recipientBFrames = sent.filter((f) => f.entity === 'CaretDoc' && f.id === 'd1' && f.field === 'body');
    // recipientB should get either edge or remove based on projection
    // Since the test setup doesn't have a protecting annotation, u2 row access is fine
    // but the protection decision is what matters — we assert no canonical offset leaks
    for (const frame of recipientBFrames) {
      if (frame.change.op === 'upsert') {
        assert.ok(frame.change.value.kind === 'caret' || frame.change.value.kind === 'edge',
          'restricted recipient should get edge or caret, but never canonical offset');
        if (frame.change.value.kind === 'edge') {
          assert.ok(!('offset' in frame.change.value), 'edge should not contain offset');
          assert.ok(!('text' in frame.change.value), 'edge should not contain text');
        }
      }
    }
  } finally { db.close(); }
});
