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
