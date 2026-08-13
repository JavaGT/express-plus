// Phase 1 — client ingest and sequence-cursor replay (SPEC §7 stage 7, §7.1).
//
// `ingest` is the ONLY place an event becomes client state (AGENTS.md → one
// reconciliation path). It folds each event through its declared reducer exactly
// once and advances a per-scope sequence cursor. The same ingest handles the
// client's own echoed events and foreign live events — there is no second apply
// path.
//
// Replay rules, per incoming event's sequence vs the expected (cursor + 1):
//  - duplicate (seq < expected) — idempotent skip, no fold, cursor unchanged.
//  - gap       (seq > expected) — do NOT apply; signal a resync.
//  - next      (seq == expected) — reduce once, advance the cursor.
//
// Bootstrap ordering is load-bearing: load the snapshot and set the cursor to
// the snapshot's sequence BEFORE ingesting any live event, or a foreign event
// during the race resyncs into an empty snapshot and is then overwritten — event
// loss. The client is created from the event registry (the reducer declarations).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { event, createClient } from '../build/internal.mjs';

// A tiny event registry: a post's published-count fold, keyed by scope.
const postPublished = event('post.published', (state, e) => ({
  ...state,
  count: (state.count ?? 0) + 1,
  lastAt: e.data.at,
}));

function blogClient() {
  return createClient({ events: [postPublished] });
}

const ev = (seq, at) => ({ type: 'post.published', scope: 'p1', seq, data: { at } });

test('ingest folds a next event through its reducer and advances the cursor', () => {
  const client = blogClient();
  const r = client.ingest(ev(1, 't1'));
  assert.equal(r.applied, true);
  assert.equal(client.cursor('p1'), 1);
  assert.equal(client.state('p1').count, 1);
  assert.equal(client.state('p1').lastAt, 't1');
});

test('two next events in order fold twice and advance the cursor to 2', () => {
  const client = blogClient();
  client.ingest(ev(1, 't1'));
  client.ingest(ev(2, 't2'));
  assert.equal(client.cursor('p1'), 2);
  assert.equal(client.state('p1').count, 2);
  assert.equal(client.state('p1').lastAt, 't2');
});

test('a duplicate event (seq < expected) is an idempotent skip', () => {
  const client = blogClient();
  client.ingest(ev(1, 't1'));
  const r = client.ingest(ev(1, 't1-again'));
  assert.equal(r.applied, false);
  assert.equal(r.duplicate, true);
  assert.equal(client.cursor('p1'), 1, 'cursor unchanged by a duplicate');
  assert.equal(client.state('p1').count, 1, 'reducer not run again');
});

test('a gap event (seq > expected) does not apply and signals a resync', () => {
  const client = blogClient();
  client.ingest(ev(1, 't1'));
  const r = client.ingest(ev(3, 't3')); // expected 2, got 3
  assert.equal(r.applied, false);
  assert.equal(r.resync, true);
  assert.equal(client.cursor('p1'), 1, 'cursor not advanced across a gap');
  assert.equal(client.state('p1').count, 1, 'gap event never folded');
});

test('the client\u2019s own echoed event and a later live redelivery are the same ingest path; the redelivery is a duplicate', () => {
  const client = blogClient();
  client.ingest(ev(1, 't1'));        // own echoed event
  const redelivery = client.ingest(ev(1, 't1')); // foreign live redelivery
  assert.equal(redelivery.duplicate, true);
  assert.equal(client.state('p1').count, 1);
});

test('per-scope cursors are independent', () => {
  const client = blogClient();
  client.ingest({ type: 'post.published', scope: 'p1', seq: 1, data: { at: 'a' } });
  client.ingest({ type: 'post.published', scope: 'p2', seq: 1, data: { at: 'b' } });
  assert.equal(client.cursor('p1'), 1);
  assert.equal(client.cursor('p2'), 1);
  assert.equal(client.state('p1').count, 1);
  assert.equal(client.state('p2').count, 1);
});

test('bootstrap sets the cursor to the snapshot sequence before live events', () => {
  const client = blogClient();
  // snapshot already reflects events up to seq 5 for p1
  client.bootstrap('p1', { count: 5, lastAt: 't5' }, 5);
  assert.equal(client.cursor('p1'), 5);
  assert.equal(client.state('p1').count, 5);
  // the next live event (seq 6) applies; a replay of seq 5 is a duplicate
  const next = client.ingest(ev(6, 't6'));
  assert.equal(next.applied, true);
  assert.equal(client.state('p1').count, 6);
  const stale = client.ingest(ev(5, 't5'));
  assert.equal(stale.duplicate, true);
});

test('an unknown event type is a load-time-style error (no reducer to fold)', () => {
  const client = blogClient();
  assert.throws(
    () => client.ingest({ type: 'post.deleted', scope: 'p1', seq: 1, data: {} }),
    /no reducer|unknown event/i,
  );
});
