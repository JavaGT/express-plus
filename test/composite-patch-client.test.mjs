// Composite patch CLIENT tests (#156 client-half; #122 §12 negotiation).
//
// Everything below drives the REAL createLiveDeliverySession flow — dispatch →
// transmit → deliver envelopes → settle/publish — against a scripted host.
// No harness shortcuts into internals: settlement, replay, negotiation, and
// chain validation are observed through the public session surface.
//
// Red-lines: response-gated arming (legacy = byte-identical), token rotation +
// replay rejection, atomic coalesced-chain catch-up, optimistic replay over
// patched bases without double-application.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveDeliverySession } from '../public/workbench-client.mjs';

const CAP = 'snapshot-patch/v1';

function patchEnvelope({
  fromComposite,
  toComposite,
  token,
  operations = [],
  actionIds,
  routedInvisibleActionIds,
  declaration = 'Project',
  anchor = 1,
  // Per-axis overrides for anchor-jumping chains: `from` must still equal the
  // predecessor's exact cursor, only `to` may move the anchor forward.
  fromAnchor,
  toAnchor,
}) {
  const from = { anchor: fromAnchor ?? anchor, composite: fromComposite };
  const to = { anchor: toAnchor ?? anchor, composite: toComposite };
  return {
    type: 'snapshot-patch',
    protocol: CAP,
    declaration,
    from,
    to,
    seqSpan: [from, to],
    projectionToken: token,
    ...(actionIds ? { actionIds } : {}),
    ...(routedInvisibleActionIds ? { routedInvisibleActionIds } : {}),
    operations,
  };
}

// Complete-key replace-fields on the root node: omitting `codes` would delete
// the relation branch (exact-set semantics, round-3 contract).
const renameRoot = (name) => [{ op: 'replace-fields', path: [], value: { id: 'p1', name, codes: {} } }];

function patchCapableSnapshot({ token = 'wbpt_boot', anchor = 1, composite = 1, name = 'A' } = {}) {
  return {
    kind: 'snapshot',
    snapshot: { id: 'p1', name, codes: {} },
    cursor: { anchor, composite },
    protocol: CAP,
    projectionToken: token,
  };
}

// A real session wired to scripted host responses, recording every
// bootstrap/subscribe invocation (advertisement evidence) and exposing the
// live delivery callback.
async function startSession({
  snapshotResult = () => patchCapableSnapshot(),
  onCatchup,
  sendAction = async () => ({ ok: true }),
  optimistic = (snapshot) => snapshot,
} = {}) {
  const probe = { bootstrapCalls: [], subscribeCalls: [], deliver: null };
  const session = createLiveDeliverySession({
    bootstrap: async (request) => {
      probe.bootstrapCalls.push({ ...request });
      if (request.mode === 'snapshot') return snapshotResult();
      return onCatchup
        ? onCatchup(request)
        : { kind: 'catchup', envelopes: [], cursor: request.after };
    },
    subscribe: async (input) => {
      probe.subscribeCalls.push(input);
      probe.deliver = (envelopes) => Promise.resolve(input.deliver(envelopes));
      return { close() {} };
    },
    validateSnapshot: (value) => value,
    // Fold-mode session: dispatches transmit with plain {ok} receipts and stay
    // pending until an authoritative envelope settles them.
    fold: (snapshot) => snapshot,
    optimistic,
    sendAction,
  });
  await session.ready;
  return { session, probe };
}

// ---- capability negotiation -------------------------------------------------

test('NEGOTIATION: client advertises snapshot-patch/v1 on bootstrap/catchup/subscribe; arms ONLY on an echoed result', async () => {
  const { session, probe } = await startSession();
  assert.equal(session.status, 'live');
  assert.equal(session.deltaCapable, true, 'echoed result arms delta mode');
  assert.equal(session.projectionToken, 'wbpt_boot', 'bootstrap token is stored');
  for (const call of probe.bootstrapCalls) {
    assert.deepEqual(call.capabilities, [CAP], 'every recovery request advertises the capability');
  }
  assert.deepEqual(probe.subscribeCalls[0].capabilities, [CAP], 'the live subscription advertises too');
  session.close();
});

test('NEGOTIATION: legacy result (no echo) never arms; a pushed patch resyncs to a full snapshot, never applies', async () => {
  const { session, probe } = await startSession({
    snapshotResult: () => ({ kind: 'snapshot', snapshot: { id: 'p1', name: 'LEGACY', codes: {} }, cursor: { anchor: 1, composite: 1 } }),
  });
  assert.equal(session.deltaCapable, false, 'absent protocol echo keeps legacy behavior');
  assert.equal(session.projectionToken, null);
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_x', operations: renameRoot('PATCHED') })]);
  assert.equal(session.deltaCapable, false, 'replacement snapshot is also legacy — still disarmed');
  assert.equal(session.snapshot.name, 'LEGACY', 'patch never mutated state; canonical snapshot installed');
  assert.equal(session.cursor.composite, 1, 'cursor came from the replacement snapshot, not the patch');
  session.close();
});

test('DELTA MODE (#159): a resync control re-establishes by catch-up (server patch), never a second snapshot bootstrap', async () => {
  let snapshotBootstraps = 0;
  let catchups = 0;
  const { session, probe } = await startSession({
    snapshotResult: () => {
      snapshotBootstraps += 1;
      return patchCapableSnapshot();
    },
    onCatchup: async (request) => {
      catchups += 1;
      assert.deepEqual(request.capabilities, [CAP], 'catch-up advertises the capability');
      assert.equal(typeof request.projectionToken, 'string', 'catch-up presents the held token');
      return {
        kind: 'catchup',
        envelopes: [patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_rot1', operations: renameRoot('CAUGHT-UP') })],
        cursor: { anchor: 1, composite: 2 },
      };
    },
  });
  assert.equal(session.deltaCapable, true, 'delta armed by the echoed bootstrap');
  assert.equal(probe.subscribeCalls[0].projectionToken, 'wbpt_boot', 'the live subscription presents the held token (#159 round-3)');
  await probe.deliver([{ type: 'resync', seq: 2, reason: 'recipient-snapshot-required' }]);
  assert.equal(catchups, 1, 'the control triggered a catch-up');
  assert.equal(snapshotBootstraps, 1, 'no second snapshot bootstrap');
  assert.equal(session.snapshot.name, 'CAUGHT-UP', 'the server patch installed state');
  session.close();
});

test('DELTA MODE (#159): a state-invalidate control STILL forces a full snapshot — it is not catch-up-able', async () => {
  // `state-invalidate` is the bounded-overflow boundary (an SSE frame too
  // large to carry); its replacement is inherently a full snapshot, never a
  // catch-up. This must hold even in delta mode.
  let snapshotBootstraps = 0;
  let catchups = 0;
  const { session, probe } = await startSession({
    snapshotResult: () => {
      snapshotBootstraps += 1;
      return snapshotBootstraps === 1
        ? patchCapableSnapshot()
        : patchCapableSnapshot({ token: 'wbpt_fresh', composite: 2, name: 'FRESH' });
    },
    onCatchup: async () => {
      catchups += 1;
      return { kind: 'catchup', envelopes: [], cursor: { anchor: 1, composite: 2 } };
    },
  });
  assert.equal(session.deltaCapable, true, 'delta armed');
  await probe.deliver([{ type: 'state-invalidate', reason: 'bounded-overflow' }]);
  assert.equal(snapshotBootstraps, 2, 'state-invalidate recovered through a FULL snapshot');
  assert.equal(catchups, 0, 'no catch-up was attempted for an oversized-batch boundary');
  assert.equal(session.snapshot.name, 'FRESH', 'the replacement snapshot installed');
  session.close();
});

test('NEGOTIATION: legacy sessions keep folding event envelopes byte-identically (numeric cursors)', async () => {
  const probe = { bootstrapCalls: [], subscribeCalls: [], deliver: null };
  const folded = [];
  const session = createLiveDeliverySession({
    bootstrap: async (request) => {
      probe.bootstrapCalls.push(request);
      if (request.mode === 'catchup') return { kind: 'catchup', envelopes: [], cursor: request.after };
      // Numeric cursor, no protocol echo: the exact pre-#122 wire shape.
      return { kind: 'snapshot', snapshot: { id: 'd1', title: 'Legacy' }, cursor: 7 };
    },
    subscribe: async (input) => {
      probe.subscribeCalls.push(input);
      probe.deliver = input.deliver;
      return { close() {} };
    },
    validateSnapshot: (value) => value,
    fold: (snapshot, envelope) => {
      folded.push(envelope.event?.type);
      return { ...snapshot, title: envelope.event?.data?.title ?? snapshot.title };
    },
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true }),
  });
  await session.ready;
  assert.equal(session.deltaCapable, false);
  assert.deepEqual(probe.bootstrapCalls[0].capabilities, [CAP], 'advertisement is additive even for legacy hosts');
  await probe.deliver([{ type: 'event', seq: 8, event: { type: 'doc.renamed', data: { title: 'Folded' }, actionId: 'a1' } }]);
  assert.deepEqual(folded, ['doc.renamed'], 'event folded exactly as before #122');
  assert.equal(session.snapshot.title, 'Folded');
  assert.equal(session.cursor, 8);
  session.close();
});

// ---- projectionToken lifecycle ---------------------------------------------

test('TOKEN LIFECYCLE: rotated on every accepted patch; reconnect catch-up presents the newest token', async () => {
  const tokensPresented = [];
  const { session, probe } = await startSession({
    onCatchup: (request) => {
      tokensPresented.push(request.projectionToken);
      return { kind: 'catchup', envelopes: [], cursor: request.after };
    },
  });
  assert.equal(session.projectionToken, 'wbpt_boot');
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_rot1', operations: renameRoot('B') })]);
  assert.equal(session.snapshot.name, 'B');
  assert.equal(session.cursor.composite, 2);
  assert.equal(session.projectionToken, 'wbpt_rot1', 'accepted patch rotates the held handle');
  await session.reconnect();
  assert.deepEqual(tokensPresented, ['wbpt_rot1'], 'catch-up presents the ROTATED token, not the bootstrap one');
  assert.deepEqual(
    probe.bootstrapCalls.at(-1).capabilities,
    [CAP],
    'reconnect catch-up advertises the capability alongside the token',
  );
  session.close();
});

test('TOKEN LIFECYCLE: an envelope repeating the currently-held token is a replay — resync, never applied', async () => {
  const { session, probe } = await startSession();
  const bootstrapCallsBefore = probe.bootstrapCalls.length;
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_boot', operations: renameRoot('REPLAYED') })]);
  assert.equal(session.snapshot.name, 'A', 'held-token envelope never mutates state');
  assert.ok(probe.bootstrapCalls.length > bootstrapCallsBefore, 'failure converged through snapshot recovery');
  assert.equal(session.cursor.composite, 1, 'cursor restored by the replacement snapshot');
  session.close();
});

test('RECONNECT TOKEN RACE: an unresolvable presented token downgrades to a full snapshot and RE-ARMS from its echo', async () => {
  // The reconnect presents wbpt_rot1 (the rotated handle), but the server's
  // ledger has already evicted/expired it (lost race) → canonical full-snapshot
  // answer carrying its own negotiation echo. The client must land that
  // snapshot, adopt its fresh token, and stay delta-capable — never wedge on
  // the dead handle.
  const { session, probe } = await startSession({
    onCatchup: (request) => {
      assert.equal(request.projectionToken, 'wbpt_rot1', 'the rotated handle is presented on catch-up');
      return patchCapableSnapshot({ token: 'wbpt_fresh', composite: 9, name: 'FRESH' });
    },
  });
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_rot1', operations: renameRoot('R') })]);
  assert.equal(session.projectionToken, 'wbpt_rot1');
  await session.reconnect();
  assert.equal(session.snapshot.name, 'FRESH');
  assert.equal(session.cursor.composite, 9);
  assert.equal(session.deltaCapable, true, 'fallback snapshot re-arms delta mode');
  assert.equal(session.projectionToken, 'wbpt_fresh', 'dead handle replaced by the fresh echo');
  session.close();
});

// ---- settlement through the REAL dispatch/deliver flow -----------------------

test('SETTLEMENT: actionIds echo reconciles the sender pending op (real dispatch → patch → settle)', async () => {
  const { session, probe } = await startSession();
  const dispatched = await session.dispatch('code.rename', { codeId: 'c1' });
  assert.equal(dispatched.ok, true);
  assert.equal(session.pendingCount(), 1, 'op is pending before its echo lands');
  const settled = dispatched.settlement.wait();
  await probe.deliver([patchEnvelope({
    fromComposite: 1,
    toComposite: 2,
    token: 'wbpt_t2',
    actionIds: [dispatched.opId],
    operations: renameRoot('B'),
  })]);
  const outcome = await settled;
  assert.equal(outcome.status, 'reconciled', 'the echo attributed the commit to this op');
  assert.equal(session.pendingCount(), 0);
  session.close();
});

test('SETTLEMENT: routedInvisibleActionIds reconciles invisible-effect ops; UNLISTED ops stay pending', async () => {
  const { session, probe } = await startSession();
  const visible = await session.dispatch('code.rename', { codeId: 'c1' });
  const invisible = await session.dispatch('meta.bump', { metaId: 'm1' });
  const settledVisible = visible.settlement.wait();
  const settledInvisible = invisible.settlement.wait();
  await probe.deliver([patchEnvelope({
    fromComposite: 1,
    toComposite: 2,
    token: 'wbpt_t2',
    // Only the invisible-routing list names the second op; neither op is
    // actionIds-echoed (its effect is not in this recipient's projection).
    routedInvisibleActionIds: [invisible.opId],
    operations: renameRoot('B'),
  })]);
  assert.equal((await settledInvisible).status, 'reconciled', 'explicit invisible-routing settles');
  // Unattributed ops stay pending: observable as unsettled state, never
  // awaited (a pending settlement promise does not resolve until attributed).
  assert.equal(session.pendingCount(), 1);
  assert.deepEqual(session.operations().map((operation) => operation.opId), [visible.opId], 'the unattributed op survives');
  // The still-pending op settles when ITS attribution arrives later.
  await probe.deliver([patchEnvelope({
    fromComposite: 2,
    toComposite: 3,
    token: 'wbpt_t3',
    actionIds: [visible.opId],
    operations: renameRoot('C'),
  })]);
  assert.equal((await settledVisible).status, 'reconciled', 'late echo settles the survivor');
  assert.equal(session.pendingCount(), 0);
  session.close();
});

// ---- optimistic replay over patched bases -----------------------------------

test('OPTIMISTIC REPLAY: pending ops replay exactly once over each patched base, in dispatch order; settlement clears the overlay', async () => {
  const { session, probe } = await startSession({
    optimistic: (snapshot, action) => ({ ...snapshot, edits: [...(snapshot.edits ?? []), action.type] }),
  });
  const first = await session.dispatch('edit.one', {});
  const second = await session.dispatch('edit.two', {});
  assert.deepEqual(session.snapshot.edits, ['edit.one', 'edit.two'], 'dispatch order preserved');

  // Patch advances the base; neither op echoed yet — both replay over it.
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_r1', operations: renameRoot('P1') })]);
  assert.equal(session.snapshot.name, 'P1', 'base patched underneath the overlay');
  assert.deepEqual(session.snapshot.edits, ['edit.one', 'edit.two'], 'replayed ONCE over the new base — no doubling');

  // Second patch echoes both ops: server truth now includes their effects.
  await probe.deliver([patchEnvelope({
    fromComposite: 2,
    toComposite: 3,
    token: 'wbpt_r2',
    actionIds: [first.opId, second.opId],
    operations: renameRoot('P2'),
  })]);
  assert.equal(session.pendingCount(), 0);
  assert.equal(session.snapshot.edits, undefined, 'settled ops leave the optimistic overlay');
  assert.equal(session.snapshot.name, 'P2');
  void first;
  void second;
  session.close();
});

// ---- receipt fence vs patch-stream coverage (3.C, #156 round 2) --------------

test('RECEIPT FENCE: patch stream already past confirmedThrough — successful dispatch triggers ZERO snapshot recovery; legacy still recovers', async () => {
  // Armed: the patch chain advances the cursor ANCHOR to 3 (fences compare on
  // the anchor axis). The receipt then names confirmedThrough=2 — already
  // covered — so the delta-capable guard must skip the bootstrap tax entirely;
  // the op stays pending until its patch attribution settles it.
  const { session, probe } = await startSession({
    sendAction: async () => ({ ok: true, confirmedThrough: 2 }),
  });
  await probe.deliver([
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_f2', operations: renameRoot('F2') }),
    patchEnvelope({ fromComposite: 2, toComposite: 3, token: 'wbpt_f3', operations: renameRoot('F3'), toAnchor: 3 }),
  ]);
  assert.equal(session.cursor.anchor, 3, 'chain carried the anchor forward');
  const bootstrapCallsBefore = probe.bootstrapCalls.length;
  const dispatched = await session.dispatch('code.rename', { codeId: 'c1' });
  assert.equal(dispatched.ok, true);
  assert.equal(
    probe.bootstrapCalls.length, bootstrapCallsBefore,
    'fence covered by the patch stream — no snapshot recovery',
  );
  assert.equal(session.pendingCount(), 1, 'op waits for patch attribution, not a stale bootstrap');
  await probe.deliver([patchEnvelope({
    fromComposite: 3,
    toComposite: 4,
    token: 'wbpt_f4',
    anchor: 3,
    actionIds: [dispatched.opId],
    operations: renameRoot('F4'),
  })]);
  assert.equal(session.pendingCount(), 0, 'attribution settled the skipped op normally');
  session.close();

  // Legacy complement: a non-armed session (numeric cursor, no echo) with an
  // UNCOVERED fence still performs receipt recovery exactly as before #156.
  const legacyProbe = { bootstrapCalls: [], subscribeCalls: [], deliver: null };
  const legacy = createLiveDeliverySession({
    bootstrap: async (request) => {
      legacyProbe.bootstrapCalls.push(request);
      if (request.mode === 'catchup') return { kind: 'catchup', envelopes: [], cursor: request.after };
      // Replacement covers the fence (10 >= 9) so recovery converges first try.
      return { kind: 'snapshot', snapshot: { id: 'd1', title: 'Legacy' }, cursor: 10 };
    },
    subscribe: async (input) => {
      legacyProbe.subscribeCalls.push(input);
      legacyProbe.deliver = input.deliver;
      return { close() {} };
    },
    validateSnapshot: (value) => value,
    fold: (snapshot) => snapshot,
    optimistic: (snapshot) => snapshot,
    sendAction: async () => ({ ok: true, confirmedThrough: 9 }),
  });
  await legacy.ready;
  assert.equal(legacy.deltaCapable, false, 'legacy host never arms');
  const legacyBootstrapsBefore = legacyProbe.bootstrapCalls.length;
  const legacyDispatch = await legacy.dispatch('doc.rename', {});
  assert.equal(legacyDispatch.ok, true);
  assert.ok(
    legacyProbe.bootstrapCalls.length > legacyBootstrapsBefore,
    'uncovered fence still triggers receipt snapshot recovery on legacy sessions',
  );
  assert.equal(legacy.deltaCapable, false, 'recovery stayed legacy');
  legacy.close();
});

// ---- edge coverage: coalesced chains + duplicates ----------------------------

test('CHAIN CATCH-UP: a contiguous coalesced chain applies atomically; the held token becomes the chain tail', async () => {
  const chain = [
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_c2', operations: renameRoot('C2') }),
    patchEnvelope({ fromComposite: 2, toComposite: 3, token: 'wbpt_c3', operations: renameRoot('C3') }),
  ];
  const { session } = await startSession({
    onCatchup: () => ({ kind: 'catchup', envelopes: chain, cursor: { anchor: 1, composite: 3 } }),
  });
  await session.reconnect(); // real reconnect → catchup → applyCatchup(chain)
  assert.equal(session.snapshot.name, 'C3', 'both chain links landed in order');
  assert.equal(session.cursor.composite, 3);
  assert.equal(session.projectionToken, 'wbpt_c3', 'held handle is the LAST rotation');
  session.close();
});

test('CHAIN CATCH-UP: one broken link rejects the WHOLE chain — snapshot recovery, zero partial application', async () => {
  const brokenChain = [
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_b2', operations: renameRoot('B2') }),
    patchEnvelope({ fromComposite: 99, toComposite: 100, token: 'wbpt_b3', operations: renameRoot('NEVER') }),
  ];
  const { session } = await startSession({
    onCatchup: () => ({ kind: 'catchup', envelopes: brokenChain, cursor: { anchor: 1, composite: 100 } }),
  });
  await session.reconnect();
  assert.equal(session.snapshot.name, 'A', 'canonical fallback snapshot — first link never landed');
  assert.equal(session.cursor.composite, 1, 'cursor came from the replacement snapshot');
  assert.equal(session.projectionToken, 'wbpt_boot', 'token restored with the snapshot');
  session.close();
});

test('DUPLICATE: an already-applied span with a FRESH token is ignored without any recovery churn', async () => {
  const { session, probe } = await startSession();
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_t2', operations: renameRoot('B') })]);
  assert.equal(session.snapshot.name, 'B');
  const bootstrapCallsBefore = probe.bootstrapCalls.length;
  // Same span as the cursor (duplicate) but a DIFFERENT token than held, so
  // the replay guard does not fire — pure cursor-decision territory.
  await probe.deliver([patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_dup', operations: renameRoot('SHOULD-NOT-APPLY') })]);
  assert.equal(probe.bootstrapCalls.length, bootstrapCallsBefore, 'duplicate triggered NO snapshot recovery');
  assert.equal(session.snapshot.name, 'B', 'duplicate operations were not re-applied');
  assert.equal(session.cursor.composite, 2, 'cursor unmoved');
  session.close();
});

// ---- delivery-batch coalescing (#156 round 2) --------------------------------
//
// SSE batches carrying consecutive snapshot-patch envelopes must apply as ONE
// atomic unit through receive(): one validation pass with from==prev.to chain
// discipline, one spine build, ONE listener publish. Buffering never crosses
// deliver() calls — each batch is its own unit.

test('BATCH COALESCE: an SSE batch of 3 contiguous patches applies atomically — exactly ONE publish lands the final cursor', async () => {
  const { session, probe } = await startSession();
  const publishes = [];
  const unsubscribe = session.subscribe((snapshot) => publishes.push({ name: snapshot.name, composite: snapshot.cursor?.composite }));
  // The subscribe() registration fires once immediately; count only
  // delivery-driven publications.
  publishes.length = 0;
  await probe.deliver([
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_s2', operations: renameRoot('S2') }),
    patchEnvelope({ fromComposite: 2, toComposite: 3, token: 'wbpt_s3', operations: renameRoot('S3') }),
    patchEnvelope({ fromComposite: 3, toComposite: 4, token: 'wbpt_s4', operations: renameRoot('S4'), actionIds: ['a-s4'] }),
  ]);
  assert.equal(publishes.length, 1, `three envelopes produced ${publishes.length} publishes instead of one`);
  assert.equal(publishes[0].name, 'S4', 'the single publish carries the fully-patched state');
  assert.equal(session.snapshot.name, 'S4');
  assert.equal(session.cursor.composite, 4, 'final cursor is the chain tail');
  assert.equal(session.cursor.anchor, 1);
  assert.equal(session.projectionToken, 'wbpt_s4', 'held handle is the chain-tail rotation');
  assert.equal(session.pendingCount(), 0);
  unsubscribe();
  session.close();
});

test('BATCH COALESCE: a broken middle link in a delivered batch resyncs into recovery with ZERO partial application', async () => {
  const { session, probe } = await startSession();
  const baseAtStart = structuredClone(session.snapshot);
  const publishedNames = [];
  const unsubscribe = session.subscribe((snapshot) => publishedNames.push(snapshot.name));
  publishedNames.length = 0;
  await probe.deliver([
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_k2', operations: renameRoot('K2') }),
    patchEnvelope({ fromComposite: 99, toComposite: 100, token: 'wbpt_k3', operations: renameRoot('NEVER') }),
    patchEnvelope({ fromComposite: 100, toComposite: 101, token: 'wbpt_k4', operations: renameRoot('ALSO-NEVER') }),
  ]);
  // Recovery legitimately republishes canonical state; what must NEVER escape
  // is any publication carrying partially-patched content.
  assert.ok(publishedNames.length > 0);
  assert.deepEqual(
    [...new Set(publishedNames)], ['A'],
    `every publication stayed canonical, saw: ${JSON.stringify([...new Set(publishedNames)])}`,
  );
  assert.equal(session.snapshot.name, 'A', 'baseSnapshot deeply unchanged — first link never landed');
  assert.deepEqual(session.snapshot, baseAtStart, 'deep equality with the bootstrap snapshot');
  assert.equal(session.cursor.composite, 1, 'cursor never advanced past the bootstrap');
  assert.equal(session.projectionToken, 'wbpt_boot', 'token restored by the replacement snapshot');
  assert.ok(probe.bootstrapCalls.some((call) => call.mode === 'snapshot'), 'broken chain recovered through a full snapshot');
  unsubscribe();
  session.close();
});

// ---- double-control batches (#156 round 4) ----------------------------------
//
// Round 3 made the FIRST resync/state-invalidate control in a batch await its
// replacement inline — but its recovery CLEARS the snapshot recovery cycle,
// so a SECOND control's fire-and-forget branch minted an un-awaited cycle and
// let a trailing patch run apply+publish against the base that control had
// just declared untrusted. The late replacement then wiped that state (cursor
// regression) — and worse, a trailing-run attribution could settle an op
// whose effect the replacement removed.

test('DOUBLE CONTROL: [patch, resync, resync, patch] — every control gates the rest of its batch; no untrusted-base publication, no cursor regression', async () => {
  // Bootstrap #1 arms the session (A @ composite 1). In DELTA MODE (#159) a
  // control re-establishes by CATCH-UP: each catch-up returns a replacement
  // patch envelope CONTINUING the stream. The SECOND catch-up is gated: a
  // synchronous resolution lets pre-fix modules publish the replacement before
  // receive() resumes, hiding the untrusted-base window this test exists to
  // catch.
  let catchups = 0;
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const { session, probe } = await startSession({
    onCatchup: async () => {
      catchups += 1;
      if (catchups === 1) {
        return { kind: 'catchup', envelopes: [patchEnvelope({ fromComposite: 2, toComposite: 3, token: 'wbpt_canon', operations: renameRoot('CANON') })], cursor: { anchor: 1, composite: 3 } };
      }
      await secondGate;
      return { kind: 'catchup', envelopes: [patchEnvelope({ fromComposite: 3, toComposite: 4, token: 'wbpt_canon2', operations: renameRoot('CANON') })], cursor: { anchor: 1, composite: 4 } };
    },
  });
  const publishedNames = [];
  const unsubscribe = session.subscribe((snapshot) => publishedNames.push(snapshot.name));
  publishedNames.length = 0;

  // An op attributed by the TRAILING patch run: under the round-4 fix it may
  // only settle after BOTH replacements have landed.
  const dispatched = await session.dispatch('code.rename', { codeId: 'c1' });
  const settledTrailing = dispatched.settlement.wait();
  let bootstrapsAtSettlement = -1;
  settledTrailing.then(() => { bootstrapsAtSettlement = probe.bootstrapCalls.length; });

  // Count only DELIVERY-driven publications from here (dispatch itself
  // legitimately republishes canonical state).
  publishedNames.length = 0;
  const bootstrapsBefore = probe.bootstrapCalls.length;
  const delivered = probe.deliver([
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_d2', operations: renameRoot('D2') }),
    { type: 'resync' },
    { type: 'resync' },
    // Continues the RECOVERED cursor (composite 4, after both catch-up
    // replacements), not the pre-recovery one.
    patchEnvelope({ fromComposite: 4, toComposite: 5, token: 'wbpt_d3', actionIds: [dispatched.opId], operations: renameRoot('D3') }),
  ]);

  // RED-LINE: while the second control's replacement is still gated, NOTHING
  // may publish beyond run1 + the first replacement, the op must stay
  // pending, and no cursor regression may occur. On a pre-fix module the
  // second control is fire-and-forget: the trailing run applies+publishes D3
  // against the untrusted base and settles the op BEFORE this release.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(!publishedNames.includes('D3'), `no untrusted-base publication before the second replacement lands (saw ${JSON.stringify(publishedNames)})`);
  assert.equal(session.pendingCount(), 1, 'trailing-run op must not settle before both replacements land');
  releaseSecond();
  await delivered;

  // Publication discipline: run1's own publish, then canonical/recovered
  // publications ONLY, then run2 against the recovered base. Nothing may
  // derive from a base any control declared untrusted.
  assert.ok(publishedNames.indexOf('D2') >= 0, 'run1 published');
  const firstCanon = publishedNames.indexOf('CANON');
  assert.ok(firstCanon > publishedNames.indexOf('D2'), 'first replacement landed after run1');
  const run2Index = publishedNames.indexOf('D3');
  assert.ok(run2Index > publishedNames.lastIndexOf('CANON'), 'run2 published AFTER the second replacement');
  assert.deepEqual(
    [...new Set(publishedNames)].sort(), ['CANON', 'D2', 'D3'],
    `no publication escaped outside {run1, recovered, run2}: ${JSON.stringify(publishedNames)}`,
  );

  // No cursor regression: the trailing run's commit SURVIVES the replacements.
  assert.equal(session.snapshot.name, 'D3');
  assert.equal(session.cursor.composite, 5);
  assert.equal(session.projectionToken, 'wbpt_d3');

  // Trailing-run attribution settled only against post-replacement state:
  // both control bootstraps were already spent when the settlement resolved.
  const outcome = await settledTrailing;
  assert.equal(outcome.status, 'reconciled');
  assert.equal(session.pendingCount(), 0);
  assert.ok(
    bootstrapsAtSettlement >= bootstrapsBefore + 2,
    `settlement waited for both replacements (saw ${bootstrapsAtSettlement - bootstrapsBefore} bootstraps after start)`,
  );

  // Bounded: exactly the two control replacements — no runaway cycle minting.
  assert.equal(probe.bootstrapCalls.length - bootstrapsBefore, 2);
  unsubscribe();
  session.close();
});
//
// Ordering that stranded ops before round 3: dispatch → covering patch
// DELIVERED+APPLIED (its actionIds attribute the op) WHILE the sendAction HTTP
// receipt is still in flight → at patch-commit the settlement loop required
// operation.delivered and SKIPPED the op → the receipt resolved fence-covered
// (or was suppressed outright) → the actionId was never echoed again → the op
// NEVER settled: promise unresolved, pendingCount stuck, optimistic ghost
// re-projected on every publish.

test('SETTLEMENT RACE: transport throw AFTER patch attribution — dispatch reports committed, not outcome-unknown', async () => {
  // sendAction rejects (pure transport failure) while the covering patch is
  // delivered first: the patch's actionIds attribution already settled and
  // removed the op, so the catch path must take the committed escape.
  let releaseReceipt;
  const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
  const { session, probe } = await startSession({
    sendAction: async () => {
      await receiptGate;
      throw new Error('ECONNRESET after commit');
    },
    optimistic: (snapshot, action) => ({ ...snapshot, edits: [...(snapshot.edits ?? []), action.type] }),
  });
  const dispatched = session.dispatch('code.rename', { codeId: 'c1' });
  const opId = session.operations()[0]?.opId;
  assert.ok(opId);

  await probe.deliver([patchEnvelope({
    fromComposite: 1,
    toComposite: 2,
    token: 'wbpt_thr',
    actionIds: [opId],
    operations: renameRoot('THROWN'),
  })]);
  assert.equal(session.pendingCount(), 0, 'attribution settled the in-flight op');
  assert.equal(session.snapshot.name, 'THROWN');

  releaseReceipt();
  const result = await dispatched;
  assert.equal(result.ok, true, 'attribution proves commitment despite the transport throw');
  assert.equal(result.status, 'committed');
  assert.equal(result.settlement == null || (await result.settlement.wait()).status, 'reconciled');
  assert.equal(session.pendingCount(), 0);
  assert.equal(session.snapshot.name, 'THROWN', 'no optimistic ghost re-appears');
  session.close();
});

// ---- settlement strand: the patch wins the race (#156 round 3) ---------------
//
// Ordering that stranded ops before round 3: dispatch → covering patch
// DELIVERED+APPLIED (its actionIds attribute the op) WHILE the sendAction HTTP
// receipt is still in flight → at patch-commit the settlement loop required
// operation.delivered and SKIPPED the op → the receipt resolved fence-covered
// (or was suppressed outright) → the actionId was never echoed again → the op
// NEVER settled: promise unresolved, pendingCount stuck, optimistic ghost
// re-projected on every publish.

test('SETTLEMENT RACE: covering patch delivered BEFORE the receipt resolves — op settles exactly once, overlay drains', async () => {
  let releaseReceipt;
  const receiptGate = new Promise((resolve) => { releaseReceipt = resolve; });
  const { session, probe } = await startSession({
    // Uncovered-by-the-cursor fence: without the patchAttributed suppression
    // this receipt would ALSO spend a pointless recovery bootstrap.
    sendAction: async () => { const receipt = { ok: true, confirmedThrough: 9 }; await receiptGate; return receipt; },
    optimistic: (snapshot, action) => ({ ...snapshot, edits: [...(snapshot.edits ?? []), action.type] }),
  });
  const publishes = [];
  const unsubscribe = session.subscribe((snapshot) => publishes.push({ name: snapshot.name, edits: snapshot.edits }));
  // sendAction is invoked synchronously inside dispatch; its receipt stays
  // gated while we deliver the covering patch first.
  const dispatched = session.dispatch('code.rename', { codeId: 'c1' });
  assert.equal(session.pendingCount(), 1, 'op pending while the receipt is in flight');
  publishes.length = 0;
  const opId = session.operations()[0]?.opId;
  assert.ok(opId, 'the in-flight op is observable through the public surface');

  const bootstrapCallsBefore = probe.bootstrapCalls.length;
  await probe.deliver([patchEnvelope({
    fromComposite: 1,
    toComposite: 2,
    token: 'wbpt_race',
    actionIds: [opId],
    operations: renameRoot('RACE'),
  })]);
  // THE fix: attribution by an ACCEPTED patch settles the op even though its
  // receipt has not resolved (delivered=false at patch-commit time).
  assert.equal(session.pendingCount(), 0, 'patch attribution settled the not-yet-delivered op');
  assert.equal(
    probe.bootstrapCalls.length, bootstrapCallsBefore,
    'settled op spends no recovery bootstrap',
  );
  assert.deepEqual(publishes.at(-1), { name: 'RACE', edits: undefined }, 'the settling publish cleared the optimistic ghost');

  // Now release the fence-covered receipt: it must be a silent no-op for the
  // already-settled op — no failure report, no recovery, no double settlement.
  releaseReceipt();
  const result = await dispatched;
  assert.equal(result.ok, true, 'late receipt reports the committed truth, not a spurious failure');
  assert.equal(result.status, 'committed');
  const outcome = await result.settlement.wait();
  assert.equal(outcome.status, 'reconciled', 'exactly-once: final outcome stays reconciled');
  assert.equal(session.pendingCount(), 0);
  assert.deepEqual(session.operations(), [], 'op removed from the live map — nothing left to strand');
  unsubscribe();
  session.close();
});

test('CHAIN SEQUENCE: replace-fields then put-keyed on the SAME node apply strictly in order across one coalesced chain', async () => {
  const { session, probe } = await startSession();
  const rename = await session.dispatch('code.rename', { codeId: 'c1' });
  const attach = await session.dispatch('code.attach', { codeId: 'c9' });
  const settledRename = rename.settlement.wait();
  const settledAttach = attach.settlement.wait();
  await probe.deliver([
    patchEnvelope({
      fromComposite: 1,
      toComposite: 2,
      token: 'wbpt_seq2',
      actionIds: [rename.opId],
      // Complete-key exact-set replacement: any key the NEXT link adds would
      // be deleted if the order were reversed.
      operations: renameRoot('SEQ'),
    }),
    patchEnvelope({
      fromComposite: 2,
      toComposite: 3,
      token: 'wbpt_seq3',
      actionIds: [attach.opId],
      operations: [{ op: 'put-keyed', path: ['codes'], id: 'c9', value: { id: 'c9', label: 'Attached' } }],
    }),
  ]);
  assert.equal(session.snapshot.name, 'SEQ', 'first link applied');
  assert.deepEqual(
    session.snapshot.codes.c9,
    { id: 'c9', label: 'Attached' },
    'put-keyed survived ON TOP of the exact-set replacement — sequential order proven',
  );
  assert.equal((await settledRename).status, 'reconciled');
  assert.equal((await settledAttach).status, 'reconciled', 'each link settled exactly its own op');
  assert.equal(session.pendingCount(), 0);
  session.close();
});

test('MIXED BATCH: [snapshot-patch, resync-control, snapshot-patch] — first run atomic, control recovers, second run handled POST-recovery', async () => {
  // First snapshot bootstrap arms the session (A @ composite 1). In DELTA MODE
  // (#159) the resync control re-establishes by CATCH-UP: the catch-up returns
  // a replacement patch envelope CONTINUING the stream (composite 2→3) so the
  // trailing patch run has a legitimate post-recovery continuation to be
  // evaluated against (composite 3→4).
  const { session, probe } = await startSession({
    onCatchup: async () => ({ kind: 'catchup', envelopes: [patchEnvelope({ fromComposite: 2, toComposite: 3, token: 'wbpt_canon', operations: renameRoot('CANON') })], cursor: { anchor: 1, composite: 3 } }),
  });
  const publishedNames = [];
  const unsubscribe = session.subscribe((snapshot) => publishedNames.push(snapshot.name));
  publishedNames.length = 0;
  const bootstrapsBefore = probe.bootstrapCalls.length;
  await probe.deliver([
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_m2', operations: renameRoot('M2') }),
    { type: 'resync' },
    // Continues the RECOVERED cursor (composite 3), not the pre-recovery one.
    patchEnvelope({ fromComposite: 3, toComposite: 4, token: 'wbpt_m3', operations: renameRoot('M3') }),
  ]);
  // Order proof: run1's publish precedes the recovery replacement, and run2's
  // publish follows it (pre-round-3 receive() applied run2 BEFORE the
  // replacement landed — publishing state derived from an untrusted base).
  const firstCanon = publishedNames.indexOf('CANON');
  assert.ok(firstCanon > publishedNames.indexOf('M2'), 'run1 published before the replacement');
  assert.ok(publishedNames.indexOf('M3') > publishedNames.lastIndexOf('CANON'), 'run2 published AFTER the recovery replacement');
  assert.deepEqual([...new Set(publishedNames)].sort(), ['CANON', 'M2', 'M3']);
  assert.equal(
    probe.bootstrapCalls.length - bootstrapsBefore, 1,
    'the control minted exactly ONE recovery; run2 neither blocked nor re-minted it',
  );
  assert.equal(session.snapshot.name, 'M3', 'run2 applied ON TOP of the recovered base');
  assert.equal(session.cursor.composite, 4);
  assert.equal(session.projectionToken, 'wbpt_m3', 'run2\'s rotation landed after recovery re-armed');
  unsubscribe();
  session.close();
});

test('CHAIN DUPLICATE TOKEN: two chain links presenting the SAME fresh token resync — rejected even though NEITHER copy equals the held handle', async () => {
  const { session, probe } = await startSession();
  const baseAtStart = structuredClone(session.snapshot);
  const publishedNames = [];
  const unsubscribe = session.subscribe((snapshot) => publishedNames.push(snapshot.name));
  publishedNames.length = 0;
  // Both links carry 'wbpt_twice'; the held handle is 'wbpt_boot'. The
  // pairwise within-chain check (not the held-handle check) must catch this.
  await probe.deliver([
    patchEnvelope({ fromComposite: 1, toComposite: 2, token: 'wbpt_twice', operations: renameRoot('FIRST-LANDS?') }),
    patchEnvelope({ fromComposite: 2, toComposite: 3, token: 'wbpt_twice', operations: renameRoot('SECOND') }),
  ]);
  assert.deepEqual(
    [...new Set(publishedNames)], ['A'],
    `every publication stayed canonical, saw: ${JSON.stringify([...new Set(publishedNames)])}`,
  );
  assert.equal(session.snapshot.name, 'A', 'zero partial application — first link discarded with the chain');
  assert.deepEqual(session.snapshot, baseAtStart);
  assert.equal(session.cursor.composite, 1, 'cursor never advanced');
  assert.equal(session.projectionToken, 'wbpt_boot', 'held handle untouched by the forged chain');
  assert.ok(probe.bootstrapCalls.some((call) => call.mode === 'snapshot'), 'failed closed through snapshot recovery');
  unsubscribe();
  session.close();
});
