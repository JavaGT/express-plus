// S2 — golden fold fixtures: createClient and LiveList must agree on final
// state + cursor for shared-semantics sequences (lifecycle, value set, replay
// edges). Text CRDT operations use their dedicated shared reducer instead.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '../build/pipeline.mjs';
import { LiveList } from '../public/workbench-client.mjs';
import { makeFakeChannel, makeFakeFetch } from './fixtures/fake-transport.mjs';
import {
  LIFECYCLE,
  LIFECYCLE_THEN_REMOVE,
  VALUE_SET,
  REPLAY_EDGES,
  noteLifecycleEvents,
} from './fixtures/fold-golden.mjs';

async function openLiveList(fixture) {
  const channel = makeFakeChannel();
  const snap = fixture.bootstrap?.snapshot ?? null;
  const seq = fixture.bootstrap?.seq ?? 0;
  channel._setAck({ currentSeq: seq });
  const list = new LiveList({
    entity: fixture.entity,
    id: fixture.id,
    channel,
    fetchImpl: makeFakeFetch([
      { match: '/snapshot', response: { snapshot: snap, seq } },
      { match: '/events', response: { events: [] } },
    ]),
    snapshotUrl: (e, id) => `/api/${e}/${id}/snapshot`,
    eventsSinceUrl: (e, id, c) => `/api/${e}/${id}/events?cursor=${c}`,
  });
  await list.subscribe();
  return { list, channel };
}

function runCreateClient(fixture) {
  const client = createClient({ events: noteLifecycleEvents() });
  const snap = fixture.bootstrap?.snapshot;
  const seq = fixture.bootstrap?.seq ?? 0;
  if (snap !== undefined) {
    client.bootstrap(fixture.scope, snap, seq);
  }
  for (const ev of fixture.events) {
    client.ingest(ev);
  }
  return client;
}

async function runLiveList(fixture) {
  const { list, channel } = await openLiveList(fixture);
  for (const ev of fixture.events) {
    channel.emit({
      type: 'event',
      entity: fixture.entity,
      id: fixture.id,
      seq: ev.seq,
      seqSpan: ev.seqSpan ?? [ev.seq, ev.seq],
      event: { type: ev.type, scope: ev.scope, seq: ev.seq, data: ev.data },
      delta: ev.delta,
    });
  }
  return list;
}

function assertStateEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

describe('S2 golden fold fixtures — createClient vs LiveList', () => {
  test('LIFECYCLE: created → updates agree on state and cursor', async () => {
    const client = runCreateClient(LIFECYCLE);
    const list = await runLiveList(LIFECYCLE);
    assertStateEqual(client.state(LIFECYCLE.scope), LIFECYCLE.expectedState, 'createClient state');
    assertStateEqual(list.state, LIFECYCLE.expectedState, 'LiveList state');
    assert.equal(client.cursor(LIFECYCLE.scope), LIFECYCLE.expectedCursor);
    assert.equal(list.cursor, LIFECYCLE.expectedCursor);
    await list.close();
  });

  test('LIFECYCLE_THEN_REMOVE: both end removed / null', async () => {
    const client = runCreateClient(LIFECYCLE_THEN_REMOVE);
    const list = await runLiveList(LIFECYCLE_THEN_REMOVE);
    assert.equal(client.state(LIFECYCLE_THEN_REMOVE.scope), null);
    assert.equal(list.state, null);
    assert.equal(client.cursor(LIFECYCLE_THEN_REMOVE.scope), 4);
    assert.equal(list.cursor, 4);
    await list.close();
  });

  test('VALUE_SET: whole data vs delta {set} converge', async () => {
    const client = runCreateClient(VALUE_SET);
    const list = await runLiveList(VALUE_SET);
    assertStateEqual(client.state(VALUE_SET.scope), VALUE_SET.expectedState, 'createClient');
    assertStateEqual(list.state, VALUE_SET.expectedState, 'LiveList');
    assert.equal(client.cursor(VALUE_SET.scope), 2);
    assert.equal(list.cursor, 2);
    await list.close();
  });

  test('REPLAY_EDGES: duplicate skip and next advance both; createClient gap signals resync', async () => {
    const f = REPLAY_EDGES;
    const client = createClient({ events: noteLifecycleEvents() });
    client.bootstrap(f.scope, f.bootstrap.snapshot, f.bootstrap.seq);

    const { list, channel } = await openLiveList(f);

    // Duplicate — both skip, state unchanged
    const d1 = client.ingest(f.duplicate);
    assert.equal(d1.duplicate, true);
    channel.emit({
      type: 'event', entity: f.entity, id: f.id,
      seq: f.duplicate.seq, seqSpan: f.duplicate.seqSpan,
      event: { type: f.duplicate.type, data: f.duplicate.data },
    });
    assert.equal(client.cursor(f.scope), 2);
    assert.equal(list.cursor, 2);
    assert.equal(client.state(f.scope).title, 'a');
    assert.equal(list.state.title, 'a');

    // Gap — createClient only (LiveList gap path is async resync; covered in live-list tests)
    const g = client.ingest(f.gap);
    assert.equal(g.resync, true);
    assert.equal(client.cursor(f.scope), 2);
    assert.equal(client.state(f.scope).title, 'a');

    // Next — both advance to 3
    client.ingest(f.next);
    channel.emit({
      type: 'event', entity: f.entity, id: f.id,
      seq: f.next.seq, seqSpan: f.next.seqSpan,
      event: { type: f.next.type, data: f.next.data },
    });
    assert.equal(client.cursor(f.scope), f.expectedCursorAfterNext);
    assert.deepEqual(client.state(f.scope), f.expectedAfterNext);
    assert.equal(list.cursor, f.expectedCursorAfterNext);
    assert.deepEqual(list.state, f.expectedAfterNext);

    await list.close();
  });
});
