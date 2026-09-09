// Gzip storage envelopes for committed-log payload text (`_Log.eventData`,
// `_ActionReceipt.resultData`). See src/storage-envelope.ts for the stored
// format and src/committed-log.ts for the write/read seams. The load-bearing
// properties: byte-identical roundtrips, transparent mixed-history reads,
// fail-closed malformed envelopes, exact byte parity with the knob off, and
// idempotent re-sweeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  STORAGE_ENVELOPE_PREFIX,
  attachStorageEnvelopePolicy,
  decodeStorageEnvelope,
  encodeStorageEnvelope,
  isStorageEnvelope,
  maybeEnvelopeStoredPayload,
  unwrapStoredPayloadText,
} from '../build/storage-envelope.mjs';
import {
  actionReceiptTableDDL,
  appendEvents,
  compactReceiptResultData,
  committedRevisionTableDDL,
  decodeConsumerLogRowData,
  decodeLogRowData,
  eventsFor,
  historyOrderCounterTableDDL,
  insertReceipt,
  logTableDDL,
  receiptFor,
} from '../build/committed-log.mjs';
import workbench from '../build/index.mjs';
import { defineSqliteSchema } from '../build/server.mjs';

function openDb({ policy } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(logTableDDL());
  db.exec(actionReceiptTableDDL());
  db.exec(historyOrderCounterTableDDL());
  db.exec(committedRevisionTableDDL());
  if (policy) attachStorageEnvelopePolicy(db, policy);
  return db;
}

function appendOne(db, data, { scope = 's', seq = 1, type = 'Doc.body.operated', actionId = 'act-1' } = {}) {
  appendEvents(db, [{ scope, seq, type, data, actionId, committedAt: '2026-01-01T00:00:00.000Z' }]);
}

function storedEventText(db, scope = 's', seq = 1) {
  return db.prepare('SELECT eventData FROM _Log WHERE scope = ? AND seq = ?').get(scope, seq).eventData;
}

function storedResultText(db, scope, actionId) {
  return db.prepare('SELECT resultData FROM _ActionReceipt WHERE scope = ? AND actionId = ?').get(scope, actionId).resultData;
}

// ---------- codec ----------

test('the codec roundtrips byte-identical text, including astral and transcript-scale payloads', () => {
  for (const plain of [
    '{"actionId":"act-1","confirmedThrough":41}',
    '{"text":"transcript with emoji 🙂 and combining accents étude"}',
    JSON.stringify({ operation: { insert: 'x'.repeat(512 * 1024) }, padding: 'y'.repeat(512 * 1024) }),
  ]) {
    const envelope = encodeStorageEnvelope(plain);
    assert.ok(envelope.startsWith(STORAGE_ENVELOPE_PREFIX));
    assert.equal(unwrapStoredPayloadText(envelope), plain, 'decoded text is byte-identical');
  }
});

test('envelopes are deterministic and plain payloads are never mistaken for envelopes', () => {
  const plain = '{"k":"v"}';
  assert.equal(encodeStorageEnvelope(plain), encodeStorageEnvelope(plain), 'same input, same stored bytes');
  assert.equal(isStorageEnvelope(plain), false);
  assert.equal(isStorageEnvelope('[1,2]'), false);
  assert.equal(isStorageEnvelope(null), false);
  assert.equal(isStorageEnvelope(new Uint8Array()), false);
  assert.equal(unwrapStoredPayloadText(plain), plain, 'plain rows pass through untouched');
});

test('malformed envelopes fail closed with a fixed opaque error', () => {
  const badEnvelopes = [
    STORAGE_ENVELOPE_PREFIX + '!!!not-base64!!!',
    STORAGE_ENVELOPE_PREFIX + Buffer.from('this is not gzip bytes at all', 'utf8').toString('base64'),
    STORAGE_ENVELOPE_PREFIX + Buffer.from([0x1f, 0x8b]).toString('base64'), // truncated gzip header
    STORAGE_ENVELOPE_PREFIX, // empty payload
  ];
  for (const envelope of badEnvelopes) {
    assert.throws(() => decodeStorageEnvelope(envelope), /malformed gzip storage envelope/);
    assert.throws(() => unwrapStoredPayloadText(envelope), /malformed gzip storage envelope/);
  }
});

test('the policy thresholds writes: above minBytes envelopes, below stays byte-identical', () => {
  const db = openDb({ policy: { minBytes: 64 } });
  const small = JSON.stringify({ ok: 1 });
  const big = JSON.stringify({ pad: 'z'.repeat(4096) });
  assert.equal(maybeEnvelopeStoredPayload(db, small), small, 'below the threshold the bytes are exactly the legacy bytes');
  assert.ok(maybeEnvelopeStoredPayload(db, big).startsWith(STORAGE_ENVELOPE_PREFIX));
  const noPolicy = openDb();
  assert.equal(maybeEnvelopeStoredPayload(noPolicy, big), big, 'no policy means the exact legacy bytes');
  attachStorageEnvelopePolicy(noPolicy, null);
  assert.equal(maybeEnvelopeStoredPayload(noPolicy, big), big, 'detaching restores the exact legacy bytes');
});

// ---------- committed-log write/read seams ----------

test('knob off: writes store exactly the legacy bytes and reads return the same values', () => {
  const db = openDb(); // no policy — the default for every caller
  // NOTE: never use a `version: 16` data field here — that exact value is the
  // v16 operated wire brand and triggers the admission path in appendEvents.
  const data = { note: 'plain row' };
  appendOne(db, data, { type: 'Doc.created' });
  assert.equal(storedEventText(db), JSON.stringify(data), 'eventData bytes are plain JSON.stringify');

  const result = { actionId: 'act-1', confirmedThrough: 7, payload: 'r'.repeat(10000) };
  insertReceipt(db, 's', 'act-1', '2026-01-01T00:00:00.000Z', [], { actionType: 'Doc.create', resultData: result });
  assert.equal(storedResultText(db, 's', 'act-1'), JSON.stringify(result), 'resultData bytes are plain JSON.stringify');

  assert.deepEqual(eventsFor(db, 'act-1')[0].data, data);
  assert.deepEqual(receiptFor(db, 's', 'act-1').resultData, result);
});

test('knob on: large payloads store as envelopes and read back value-identical; small stay plain', () => {
  const db = openDb({ policy: { minBytes: 64 } });
  const bigEvent = { text: 'e'.repeat(8192) };
  appendOne(db, bigEvent, { type: 'Doc.body.operated', seq: 1 });
  assert.ok(storedEventText(db, 's', 1).startsWith(STORAGE_ENVELOPE_PREFIX), 'eventData is enveloped');
  const smallEvent = { n: 1 };
  appendOne(db, smallEvent, { type: 'Doc.body.operated', seq: 2 });
  assert.equal(storedEventText(db, 's', 2), JSON.stringify(smallEvent), 'below-threshold eventData keeps legacy bytes');

  const bigResult = { actionId: 'act-1', confirmedThrough: 3, payload: 'p'.repeat(8192) };
  insertReceipt(db, 's', 'act-1', '2026-01-01T00:00:00.000Z', [], { resultData: bigResult });
  assert.ok(storedResultText(db, 's', 'act-1').startsWith(STORAGE_ENVELOPE_PREFIX), 'resultData is enveloped');

  assert.deepEqual(eventsFor(db, 'act-1')[0].data, bigEvent, 'decoded eventData is value-identical');
  assert.deepEqual(receiptFor(db, 's', 'act-1').resultData, bigResult, 'decoded resultData is value-identical');
});

test('mixed histories: plain and enveloped rows in the same table decode through one API', () => {
  const db = openDb({ policy: { minBytes: 64 } });
  appendOne(db, { n: 1 }, { seq: 1 }); // legacy plain row
  appendOne(db, { text: 'e'.repeat(8192) }, { seq: 2 }); // envelope row
  insertReceipt(db, 's', 'plain', '2026-01-01T00:00:00.000Z', [], { resultData: { actionId: 'plain', confirmedThrough: 1 } });
  insertReceipt(db, 's', 'fat', '2026-01-01T00:00:00.000Z', [], { resultData: { actionId: 'fat', confirmedThrough: 2, blob: 'f'.repeat(8192) } });

  const events = eventsFor(db, 'act-1');
  assert.deepEqual(events[0].data, { n: 1 });
  assert.equal(events[1].data.text, 'e'.repeat(8192));
  assert.equal(receiptFor(db, 's', 'plain').resultData.confirmedThrough, 1);
  assert.equal(receiptFor(db, 's', 'fat').resultData.confirmedThrough, 2);
  assert.equal(receiptFor(db, 's', 'fat').resultData.blob.length, 8192);
});

test('a malformed envelope row fails closed on every read seam; plain malformed keeps legacy behavior', () => {
  const db = openDb({ policy: { minBytes: 64 } });
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s', 1, 'Doc.body.operated', STORAGE_ENVELOPE_PREFIX + '!!!', 'act-1', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation, resultData) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s', 'act-1', '2026-01-01T00:00:00.000Z', '[]', 'action', STORAGE_ENVELOPE_PREFIX + '!!!');
  const row = { scope: 's', seq: 1, eventType: 'Doc.body.operated', eventData: STORAGE_ENVELOPE_PREFIX + '!!!', actionId: 'act-1', committedAt: '2026-01-01T00:00:00.000Z' };

  assert.throws(() => decodeLogRowData(row), /malformed gzip storage envelope/);
  assert.throws(() => receiptFor(db, 's', 'act-1'), /malformed gzip storage envelope/);
  assert.throws(() => eventsFor(db, 'act-1'), /malformed gzip storage envelope/);
  assert.throws(
    () => decodeConsumerLogRowData(row, { fallback: true }),
    /malformed gzip storage envelope/,
    'an envelope that fails to decompress is corruption, not a legacy parse miss — it never degrades to fallback',
  );
  // A PLAIN malformed row keeps the consumer fallback contract.
  assert.deepEqual(
    decodeConsumerLogRowData({ ...row, eventData: '{not json' }, { fallback: true }),
    { fallback: true },
  );
});

test('an enveloped v16 row still reaches the strict stored parser (unwrap happens before dispatch)', () => {
  const db = openDb({ policy: { minBytes: 0 } });
  // Hand-made NONCANONICAL v16-shaped text, stored enveloped (appendEvents
  // refuses unbranded v16 data by design, so the row is crafted directly).
  // The strict parser must see the unwrapped text and throw its canonicality
  // error — proving the envelope unwraps before the v16 dispatch rather than
  // the row being read as plain JSON or skipped.
  const forged = JSON.stringify({ version: 16, id: 'doc-1', forged: true });
  db.prepare('INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s', 1, 'Doc.body.operated', encodeStorageEnvelope(forged), 'act-1', '2026-01-01T00:00:00.000Z');
  assert.ok(storedEventText(db).startsWith(STORAGE_ENVELOPE_PREFIX));
  assert.throws(
    () => eventsFor(db, 'act-1'),
    (error) => /v16/.test(error.message) && !/malformed gzip storage envelope/.test(error.message),
    'the v16 canonicality error surfaces through the envelope, not an envelope error',
  );
});

// ---------- compaction interplay ----------

test('compaction compacts old envelope rows to the plain replay-pair marker and repeated sweeps are no-ops', () => {
  const db = openDb({ policy: { minBytes: 64 } });
  const OLD = '2020-01-01T00:00:00.000Z';
  const NOW = new Date().toISOString();
  const result = { actionId: 'act-old', confirmedThrough: 41, blob: 'b'.repeat(8192) };
  insertReceipt(db, 's', 'act-old', OLD, [], { resultData: result });
  const envelope = storedResultText(db, 's', 'act-old');
  assert.ok(envelope.startsWith(STORAGE_ENVELOPE_PREFIX));

  assert.equal(compactReceiptResultData(db, NOW), 1);
  const marker = JSON.parse(storedResultText(db, 's', 'act-old'));
  assert.equal(marker.__workbenchCompactedResult.version, 1);
  assert.equal(marker.__workbenchCompactedResult.reclaimedBytes, envelope.length, 'reclaims the stored (envelope) bytes');
  assert.equal(marker.actionId, 'act-old');
  assert.equal(marker.confirmedThrough, 41);
  // The receipt still answers its ack pair after compaction.
  assert.deepEqual(
    (({ actionId, confirmedThrough, ...rest }) => ({ actionId, confirmedThrough, marker: rest.__workbenchCompactedResult }))(receiptFor(db, 's', 'act-old').resultData),
    { actionId: 'act-old', confirmedThrough: 41, marker: marker.__workbenchCompactedResult },
  );
  assert.equal(compactReceiptResultData(db, NOW), 0, 'repeated sweeps reclaim nothing (SQL and envelope arms)');
});

test('compaction leaves protected, inadmissible, and corrupted envelope rows untouched', () => {
  const db = openDb({ policy: { minBytes: 64 } });
  const OLD = '2020-01-01T00:00:00.000Z';
  const NOW = new Date().toISOString();
  const insert = (actionId, resultData) => db.prepare(
    'INSERT INTO _ActionReceipt (scope, actionId, committedAt, eventRefs, operation, resultData) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('s', actionId, OLD, '[]', 'action', resultData);
  // Mixed-tier replay authority inside an envelope — never compacted.
  insert('act-mixed', encodeStorageEnvelope(JSON.stringify({
    __workbenchMixedReplay: { durableIndexes: [0], liveIndexes: [1], liveEvents: [], resultData: { actionId: 'act-mixed', confirmedThrough: 5 } },
    actionId: 'act-mixed',
    confirmedThrough: 5,
  })));
  // Envelope whose payload cannot prove the ack pair.
  insert('act-mismatch', encodeStorageEnvelope(JSON.stringify({ actionId: 'other', confirmedThrough: 1, blob: 'x'.repeat(8192) })));
  insert('act-cursor', encodeStorageEnvelope(JSON.stringify({ actionId: 'act-cursor', confirmedThrough: '41', blob: 'x'.repeat(8192) })));
  // Corrupted envelope — decode fails, left untouched rather than interpreted.
  insert('act-corrupt', STORAGE_ENVELOPE_PREFIX + '!!!');
  // Recent envelope above the cutoff.
  insertReceipt(db, 's', 'act-recent', NOW, [], { resultData: { actionId: 'act-recent', confirmedThrough: 9, blob: 'x'.repeat(8192) } });

  assert.equal(compactReceiptResultData(db, NOW), 0, 'nothing inadmissible is compacted');
  for (const actionId of ['act-mixed', 'act-mismatch', 'act-cursor', 'act-corrupt', 'act-recent']) {
    const text = storedResultText(db, 's', actionId);
    assert.ok(!text.includes('__workbenchCompactedResult'), `${actionId} untouched`);
  }
  // The corrupted envelope still fails closed on read.
  assert.throws(() => receiptFor(db, 's', 'act-corrupt'), /malformed gzip storage envelope/);
  // And the protected mixed replay envelope still replays its result payload.
  assert.equal(receiptFor(db, 's', 'act-mixed').resultData.__workbenchMixedReplay.durableIndexes.length, 1);
});

// ---------- application-level knob travel ----------

const fixtureSchema = defineSqliteSchema({
  name: 'storage-envelope-fixtures',
  tables: [],
  externalTables: [{ name: 'Source', columns: ['id', 'projectId', 'name'] }],
});

function sourceAction() {
  return {
    type: 'source.create',
    authorize: () => true,
    handler: ({ payload, now }) => [{
      type: 'source.created',
      scope: `project:${payload.projectId}`,
      data: { id: payload.id, entity: { ...payload, createdAt: now, transcript: 't'.repeat(16384) } },
    }],
    projections: [{
      eventTypes: ['source.created'],
      apply(event, tx) {
        tx.prepare('INSERT INTO Source (id, projectId, name) VALUES (?, ?, ?)').run(
          event.data.entity.id, event.data.entity.projectId, event.data.entity.name,
        );
      },
    }],
  };
}

const REQUEST = {
  actionId: 'action-1', scope: 'project:p1', type: 'source.create',
  payload: { id: 's1', projectId: 'p1', name: 'Interview' },
  principal: { type: 'user', id: 'u1', attributes: {} },
};

test('the app knob envelops committed payloads and replay returns byte-identical events', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL)');
  const app = workbench({ db, actions: [sourceAction()], schema: fixtureSchema, payloadCompressionMinBytes: 128 });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const first = await app.dispatch(REQUEST);
  assert.equal(first.ok, true);
  assert.ok(
    db.prepare('SELECT eventData FROM _Log WHERE actionId = ?').get('action-1').eventData.startsWith(STORAGE_ENVELOPE_PREFIX),
    'the committed event payload is stored as a gzip envelope',
  );

  const replay = await app.dispatch(REQUEST);
  assert.equal(replay.ok, true);
  assert.equal(replay.deduped, true, 'the durable dedupe replay reads through the envelope');
  // The replay path reconstructs events from stored rows (the full LogEvent
  // shape, with seq/actionId/committedAt); the decoded payload must be
  // byte-identical to what the first dispatch produced.
  assert.equal(JSON.stringify(replay.events[0].data), JSON.stringify(first.events[0].data));
  assert.equal(replay.events[0].type, first.events[0].type);
  assert.equal(replay.events[0].scope, first.events[0].scope);
  assert.deepEqual(replay.resultData, first.resultData, 'the replayed ack pair survives the envelope');
  assert.equal(replay.resultData.actionId, 'action-1');
  assert.equal(typeof replay.resultData.confirmedThrough, 'number');
});

test('the default app stores every payload exactly as before (byte parity, end to end)', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Source (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL)');
  const app = workbench({ db, actions: [sourceAction()], schema: fixtureSchema });
  t.after(async () => { await app.shutdown(); db.close(); });
  await app.start();

  const outcome = await app.dispatch(REQUEST);
  assert.equal(outcome.ok, true);
  const stored = db.prepare('SELECT eventData FROM _Log WHERE actionId = ?').get('action-1').eventData;
  assert.equal(stored, JSON.stringify(outcome.events[0].data), 'stored bytes are plain JSON.stringify');
  assert.ok(!stored.startsWith(STORAGE_ENVELOPE_PREFIX));
});
