// The generic audit contract (S5/A4) — event schema, classification routing,
// retention passthrough, denial rate-limiting, and the real-status-on-audit vs
// collapsed-on-decision rule (owner r2). Pure unit tests: no HTTP, sockets, or
// DB state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { principal, anonymous, requireUser } from '../build/index.mjs';
import { createAuditor, noopAuditSink } from '../build/audit.mjs';
import { createDenialAuditor } from '../build/denial-log.mjs';
import { createAuthorizationAdapter } from '../build/authorization-adapter.mjs';

const alice = principal({ type: 'user', id: 'alice' });
const bob = principal({ type: 'user', id: 'bob' });

function input(overrides = {}) {
  return {
    principal: alice,
    operation: 'read',
    resourceCategory: 'entity',
    resourceId: 'n1',
    outcome: 'deny',
    reasonCode: 'no-capability',
    ...overrides,
  };
}

// --- event shape: enumerated fields only, no secrets/aliases/filenames/excerpts

test('an audit event carries exactly the enumerated fields — secrets, aliases, filenames, and excerpts never ride it', () => {
  const events = [];
  const auditor = createAuditor({
    sink: { write: (event) => events.push(event) },
    retentionConfig: { security: '12m', diagnostic: '30d' },
    now: () => 1700000000000,
    id: () => 'evt-1',
  });

  const secretBearer = principal({
    type: 'user', id: 'alice',
    attributes: { token: 'SECRET-TOKEN-abc123', alias: 'a@example.com', path: '/private/report.pdf', excerpt: 'the quick brown fox...' },
  });
  const securityEvent = auditor.auditSecurity({
    principal: secretBearer, operation: 'read', resourceCategory: 'entity', resourceId: 'n1',
    outcome: 'deny', reasonCode: 'no-capability',
  });
  const diagnosticEvent = auditor.auditDiagnostic({
    principal: secretBearer, operation: 'search', resourceCategory: 'search', resourceId: null,
    outcome: 'allow', reasonCode: null,
  });
  assert.equal(diagnosticEvent.classification, 'diagnostic');
  assert.equal(diagnosticEvent.operation, 'search');
  assert.equal(diagnosticEvent.reasonCode, null);

  assert.equal(events.length, 2);
  for (const event of events) {
    // structurally ONLY the enumerated fields
    assert.deepEqual(
      Object.keys(event).sort(),
      ['actor', 'classification', 'id', 'operation', 'outcome', 'reasonCode', 'resourceCategory', 'resourceId', 'time'],
    );
    assert.deepEqual(Object.keys(event.actor).sort(), ['id', 'status', 'type']);
    assert.ok(Object.isFrozen(event));
    assert.ok(Object.isFrozen(event.actor));
    // content carried in principal attributes never reaches the event
    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes('SECRET-TOKEN-abc123'), 'no secret token');
    assert.ok(!serialized.includes('a@example.com'), 'no alias');
    assert.ok(!serialized.includes('report.pdf'), 'no filename');
    assert.ok(!serialized.includes('quick brown fox'), 'no excerpt');
  }

  assert.equal(securityEvent.id, 'evt-1');
  assert.equal(securityEvent.time, 1700000000000);
  assert.deepEqual(securityEvent.actor, { type: 'user', id: 'alice', status: 'active' });
  assert.equal(securityEvent.operation, 'read');
  assert.equal(securityEvent.resourceCategory, 'entity');
  assert.equal(securityEvent.resourceId, 'n1');
  assert.equal(securityEvent.outcome, 'deny');
  assert.equal(securityEvent.reasonCode, 'no-capability');
  assert.equal(securityEvent.classification, 'security');
});

test('an operation token normalizes to its category name; anonymous actor is identity-free', () => {
  const auditor = createAuditor({
    retentionConfig: { security: '12m', diagnostic: '30d' },
  });

  // an OperationCategory-shaped token (what the admission decision carries)
  const event = auditor.auditSecurity({
    principal: anonymous, operation: { operation: 'update' }, resourceCategory: 'entity',
    outcome: 'deny', reasonCode: 'anonymous',
  });
  assert.equal(event.operation, 'update');
  assert.deepEqual(event.actor, { type: 'anonymous', id: null, status: 'active' });
});

// --- classification routing

test('security and diagnostic events are distinguishable and routable to different sinks', () => {
  const securityEvents = [];
  const diagnosticEvents = [];
  const auditor = createAuditor({
    sinks: {
      security: { write: (event) => securityEvents.push(event) },
      diagnostic: { write: (event) => diagnosticEvents.push(event) },
    },
    retentionConfig: { security: '12m', diagnostic: '30d' },
  });

  auditor.auditSecurity(input());
  auditor.auditDiagnostic(input({ outcome: 'allow', reasonCode: null }));

  assert.equal(securityEvents.length, 1);
  assert.equal(diagnosticEvents.length, 1);
  assert.equal(securityEvents[0].classification, 'security');
  assert.equal(securityEvents[0].outcome, 'deny');
  assert.equal(securityEvents[0].reasonCode, 'no-capability');
  assert.equal(diagnosticEvents[0].classification, 'diagnostic');
  assert.equal(diagnosticEvents[0].outcome, 'allow');
  assert.equal(diagnosticEvents[0].reasonCode, null);
});

test('a shared sink receives both classes; the default sink is a no-op', () => {
  const shared = [];
  const auditor = createAuditor({
    sink: { write: (event) => shared.push(event) },
    retentionConfig: { security: '12m', diagnostic: '30d' },
  });
  auditor.auditSecurity(input());
  auditor.auditDiagnostic(input({ outcome: 'allow', reasonCode: null }));
  assert.equal(shared.length, 2);

  // no sink configured at all → events are still built, nothing is written
  const silent = createAuditor({ retentionConfig: { security: '12m', diagnostic: '30d' } });
  const event = silent.auditSecurity(input());
  assert.equal(event.outcome, 'deny');
  assert.ok(noopAuditSink.write({}, '12m') === undefined, 'noop sink writes nothing');
});

// --- retention config passthrough

test('a two-class retention config passes through untouched (security 12m / diagnostic 30d)', () => {
  const seen = [];
  const retentionConfig = { security: '12m', diagnostic: '30d' };
  const auditor = createAuditor({
    sink: { write: (event, retention) => seen.push({ classification: event.classification, retention }) },
    retentionConfig,
  });

  auditor.auditSecurity(input());
  auditor.auditDiagnostic(input({ outcome: 'allow', reasonCode: null }));

  assert.deepEqual(seen, [
    { classification: 'security', retention: '12m' },
    { classification: 'diagnostic', retention: '30d' },
  ]);
  // the auditor exposes the config untouched (and frozen) for the sink to consume
  assert.deepEqual(auditor.retentionConfig, retentionConfig);
  assert.ok(Object.isFrozen(auditor.retentionConfig));
});

// --- denial rate-limit window

test('a denial flood emits at most one event per (actor, reasonCode) per window', () => {
  let t = 1000;
  const events = [];
  const auditor = createAuditor({
    sink: { write: (event) => events.push(event) },
    retentionConfig: { security: '12m', diagnostic: '30d' },
    now: () => t,
  });
  const denial = createDenialAuditor({ auditor, windowMs: 1000, now: () => t });

  // a flood of identical denials collapses to one representative
  for (let i = 0; i < 50; i++) {
    denial.auditDenial({ principal: alice, operation: 'read', resourceCategory: 'entity', resourceId: 'n1', reasonCode: 'no-capability' });
  }
  assert.equal(events.length, 1, 'one representative per (actor, reasonCode) window');

  // a different reasonCode from the same actor has its own budget
  for (let i = 0; i < 50; i++) {
    denial.auditDenial({ principal: alice, operation: 'read', resourceCategory: 'entity', resourceId: 'n1', reasonCode: 'no-row-scope' });
  }
  assert.equal(events.length, 2, 'a different reasonCode emits its own representative');

  // a different actor has its own budget
  for (let i = 0; i < 50; i++) {
    denial.auditDenial({ principal: bob, operation: 'read', resourceCategory: 'entity', resourceId: 'n1', reasonCode: 'no-capability' });
  }
  assert.equal(events.length, 3, 'a different actor emits its own representative');

  // after the window rolls, a new representative is allowed
  t += 1000;
  const newWindowEvent = denial.auditDenial({ principal: alice, operation: 'read', resourceCategory: 'entity', resourceId: 'n1', reasonCode: 'no-capability' });
  assert.equal(events.length, 4, 'a new window allows a new representative');
  assert.ok(Object.isFrozen(newWindowEvent));
  assert.equal(newWindowEvent.outcome, 'deny');
  assert.equal(newWindowEvent.classification, 'security');
  assert.equal(newWindowEvent.actor.id, 'alice');

  // suppressed denials return null and emit nothing
  const suppressed = denial.auditDenial({ principal: alice, operation: 'read', resourceCategory: 'entity', resourceId: 'n1', reasonCode: 'no-capability' });
  assert.equal(suppressed, null);
  assert.equal(events.length, 4);
});

test('denial keys carry actor identity + closed reason code only — never embedded reason values', () => {
  let t = 1000;
  const events = [];
  const auditor = createAuditor({
    sink: { write: (event) => events.push(event) },
    retentionConfig: { security: '12m', diagnostic: '30d' },
  });
  const denial = createDenialAuditor({ auditor, windowMs: 1000, now: () => t });

  const who = principal({ type: 'user', id: 'alice', status: 'revoked' });
  const key = denial.keyOf({ type: 'user', id: 'alice', status: 'revoked' }, 'anonymous');
  assert.equal(key, 'user:alice:revoked\u0000anonymous');

  // the representative event carries the real actor and the closed code
  denial.auditDenial({ principal: who, operation: 'read', resourceCategory: 'principal', reasonCode: 'anonymous' });
  assert.deepEqual(events[0].actor, { type: 'user', id: 'alice', status: 'revoked' });
  assert.equal(events[0].reasonCode, 'anonymous');
  assert.ok(!JSON.stringify(events[0]).includes('revoked denial detail'), 'no embedded reason text');
});

// --- real status on audit vs collapsed on decision (owner r2)

test('the audit records the REAL principal status while the admission decision sees anonymous', async () => {
  const events = [];
  const auditor = createAuditor({
    sink: { write: (event) => events.push(event) },
    retentionConfig: { security: '12m', diagnostic: '30d' },
  });
  const denial = createDenialAuditor({ auditor });
  const adapter = createAuthorizationAdapter({ trace: true });

  for (const status of ['disabled', 'expired', 'revoked']) {
    const who = principal({ type: 'user', id: 'alice', status });

    // the DECISION surface collapses: a revoked and an unknown caller are
    // indistinguishable ('anonymous'), never the real status
    const decision = await adapter.admit({ category: 'principal', operation: 'read', principal: who, gate: requireUser() });
    assert.equal(decision.admitted, false);
    assert.equal(decision.reasonCode, 'anonymous', `decision never leaks the ${status} status`);

    // the AUDIT record keeps the real status (security classification)
    const event = denial.auditDenial({ principal: who, operation: 'read', resourceCategory: 'principal', reasonCode: 'anonymous' });
    assert.ok(event, `a representative is emitted for the ${status} principal`);
    assert.deepEqual(event.actor, { type: 'user', id: 'alice', status }, `audit actor records the real ${status} status`);
    assert.equal(event.actor.status, status, `audit status is ${status}, not anonymous`);
    assert.equal(event.actor.id, 'alice', 'audit keeps the real identity');
  }
  assert.equal(events.length, 3, 'each real status emits its own representative');
});
