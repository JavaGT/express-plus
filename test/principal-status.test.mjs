// S5/A1 — the principal status contract (src/principal.ts).
//
// The invariants under test: `status` defaults to `'active'` so existing
// principal literals keep compiling and behaving; the non-active statuses
// construct; an unknown status fails closed at construction; `anonymous` is
// identity-free and always `'active'`; `principalKeyOf` stays stable for active
// principals; `statusOf` returns the REAL status (the audit reader — admission
// callers collapse non-active principals to anonymous at the A2 seam, they
// never key a decision off statusOf).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  principal, anonymous, statusOf, principalKeyOf,
  UnknownPrincipalStatusError,
} from '../build/principal.mjs';

const NON_ACTIVE = ['disabled', 'expired', 'revoked'];

test('principal defaults to status active', () => {
  const who = principal({ type: 'user', id: 'alice' });
  assert.equal(who.status, 'active');
  const apiKey = principal({ type: 'apiKey', id: 'k1' });
  assert.equal(apiKey.status, 'active');
});

test('a principal with status revoked/expired constructs', () => {
  for (const status of NON_ACTIVE) {
    const who = principal({ type: 'user', id: 'alice', status });
    assert.equal(who.type, 'user');
    assert.equal(who.id, 'alice');
    assert.equal(who.status, status);
  }
});

test('anonymous is identity-free and always active', () => {
  assert.equal(anonymous.type, 'anonymous');
  assert.equal(anonymous.id, null);
  assert.equal(anonymous.status, 'active');
  assert.equal(statusOf(anonymous), 'active');
});

test('an unknown status fails closed at construction', () => {
  assert.throws(
    () => principal({ type: 'user', id: 'alice', status: 'banned' }),
    UnknownPrincipalStatusError,
  );
  assert.throws(
    () => principal({ type: 'user', id: 'alice', status: 42 }),
    UnknownPrincipalStatusError,
  );
  assert.throws(
    () => principal({ type: 'user', id: 'alice', status: 'suspended' }),
    UnknownPrincipalStatusError,
  );
});

test('a non-active anonymous principal fails closed', () => {
  for (const status of NON_ACTIVE) {
    assert.throws(
      () => principal({ type: 'anonymous', id: null, status }),
      UnknownPrincipalStatusError,
      `anonymous with status ${status} is meaningless`,
    );
  }
});

test('principalKeyOf stays stable for active principals', () => {
  assert.equal(principalKeyOf(principal({ type: 'user', id: 'alice' })), 'user:alice');
  assert.equal(principalKeyOf(principal({ type: 'apiKey', id: 'k1' })), 'apiKey:k1');
  assert.equal(principalKeyOf(principal({ type: 'user', id: 'alice', status: 'revoked' })), 'user:alice');
  assert.equal(principalKeyOf(anonymous), null);
});

test('statusOf distinguishes active from the three non-active statuses', () => {
  assert.equal(statusOf(principal({ type: 'user', id: 'alice' })), 'active');
  for (const status of NON_ACTIVE) {
    const who = principal({ type: 'user', id: 'alice', status });
    assert.equal(statusOf(who), status, `statusOf reports the real ${status} status`);
    assert.notEqual(statusOf(who), 'active');
  }
});

test('a non-active principal is NOT the canonical anonymous (audit context only)', () => {
  // The two-valued rule: a revoked principal carries its identity + real status
  // for audit/diagnostic contexts, but the ADMISSION decision must collapse it
  // to anonymous (enforced at the A2 seam) so a revoked and an unknown caller
  // are indistinguishable. statusOf is the audit reader, never a decision input.
  const revoked = principal({ type: 'user', id: 'alice', status: 'revoked' });
  assert.notEqual(revoked, anonymous);
  assert.equal(revoked.type, 'user');
  assert.equal(statusOf(revoked), 'revoked');
});
