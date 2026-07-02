// Phase 1 — the per-verb route gate (SPEC §6.2, ADR #20).
//
// TWO default-on layers guard every entity: (1) the ROUTE GATE (auth required —
// session→principal admission to the route), and (2) the ROW GRANT (the SQL
// scope + .can, §6). The per-verb route gate relaxes ONLY the route gate for
// named verbs; the row grant still runs on every verb regardless. There is no
// second auth path — the gate decides route admission, never row visibility.
//
// The gate is built from authorization FUNCTIONS, never magic words (AGENTS):
// requireUser() and allowAnonymous() each return a (principal) => boolean. The
// DEFAULT gate for any verb with no entry is requireUser() — the default-on
// route gate. `everyone()` admission and `anonymous` are the public-read path
// that replaces the dead `publicRead` flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  requireUser,
  allowAnonymous,
  isGate,
  resolveRouteGate,
  routeGateFor,
} from '../src/route-gate.mjs';
import { principal, anonymous } from '../src/principal.mjs';

const user = principal({ type: 'user', id: 'user-1' });
const link = principal({ type: 'link', id: 'link-1' });

// --- the gate predicates are authorization functions, not magic words ---

test('requireUser() admits a user principal, rejects anonymous', () => {
  const gate = requireUser();
  assert.equal(typeof gate, 'function');
  assert.equal(gate(user), true);
  assert.equal(gate(anonymous), false);
});

test('requireUser() admits any non-anonymous principal (link, system are authed)', () => {
  const gate = requireUser();
  assert.equal(gate(link), true);
});

test('allowAnonymous() admits everyone including anonymous', () => {
  const gate = allowAnonymous();
  assert.equal(typeof gate, 'function');
  assert.equal(gate(anonymous), true);
  assert.equal(gate(user), true);
});

// --- gates are BRANDED so the imperative-router varargs peel is deterministic ---
//
// In an imperative route `r.post('/', allowAnonymous(), handler)`, the gate and the handler
// are both functions. The peeler must tell them apart by the gate's BRAND, never
// by argument position or arity (that would be a magic convention). isGate() is
// the brand check; a plain middleware/handler is NOT a gate and must not peel.

test('requireUser() / allowAnonymous() return BRANDED gates', () => {
  assert.equal(isGate(requireUser()), true);
  assert.equal(isGate(allowAnonymous()), true);
});

test('isGate() rejects a plain handler/middleware (only branded gates peel)', () => {
  const handler = (req, res) => res.json({});
  assert.equal(isGate(handler), false);
  assert.equal(isGate(() => true), false);
  assert.equal(isGate(null), false);
  assert.equal(isGate(undefined), false);
  assert.equal(isGate('open'), false);
});

// --- resolveRouteGate normalizes a declared { verb: fn } map, defaulting closed ---

test('resolveRouteGate fills every standard verb, defaulting unlisted verbs to requireUser()', () => {
  const resolved = resolveRouteGate({ list: allowAnonymous() });
  // listed verb keeps its relaxed gate
  assert.equal(resolved.list(anonymous), true);
  // unlisted verbs default closed (auth required)
  assert.equal(resolved.create(anonymous), false);
  assert.equal(resolved.create(user), true);
  assert.equal(resolved.read(anonymous), false);
  assert.equal(resolved.update(anonymous), false);
  assert.equal(resolved.remove(anonymous), false);
});

test('resolveRouteGate with no declaration is fully default-on (every verb requires auth)', () => {
  const resolved = resolveRouteGate();
  for (const verb of ['list', 'read', 'create', 'update', 'remove']) {
    assert.equal(resolved[verb](anonymous), false, `${verb} default-on`);
    assert.equal(resolved[verb](user), true, `${verb} admits a user`);
  }
});

test('resolveRouteGate rejects a non-function gate value (no magic words)', () => {
  assert.throws(() => resolveRouteGate({ list: 'public' }), /must be a gate function/i);
});

test('resolveRouteGate rejects an unknown verb name (fail closed, typo guard)', () => {
  assert.throws(() => resolveRouteGate({ lst: allowAnonymous() }), /unknown verb/i);
});

// --- routeGateFor is the admission decision the dispatcher calls per request ---

test('routeGateFor admits/denies by verb + principal, relaxing only the named verb', () => {
  const resolved = resolveRouteGate({ list: allowAnonymous() });
  // anonymous may list (relaxed), but not create (default-on)
  assert.equal(routeGateFor(resolved, 'list', anonymous), true);
  assert.equal(routeGateFor(resolved, 'create', anonymous), false);
  // a user passes both
  assert.equal(routeGateFor(resolved, 'create', user), true);
});

test('routeGateFor throws on an unknown verb (cannot admit a request to an undeclared verb)', () => {
  const resolved = resolveRouteGate();
  assert.throws(() => routeGateFor(resolved, 'frobnicate', user), /unknown verb/i);
});
