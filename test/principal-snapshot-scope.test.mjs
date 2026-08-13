import { strict as a } from 'node:assert';
import { principalSnapshotScope, parsePrincipalSnapshotScope } from '../build/principal-snapshot-scope.mjs';
import { parseScopeKey } from '../build/scope-handle.mjs';

// ── Canonical round trips ──────────────────────────────────────────────────

function roundTrip(declaration, type, id) {
  const scope = principalSnapshotScope({ declaration, principal: { type, id } });
  const parsed = parsePrincipalSnapshotScope(scope);
  a.equal(parsed.declaration, declaration);
  a.equal(parsed.type, type);
  a.equal(parsed.id, id);
  return scope;
}

a.equal(roundTrip('my-decl', 'user', 'abc123'), 'PrincipalSnapshot:my-decl/user/abc123');
a.equal(roundTrip('x', 'link', 'hello'), 'PrincipalSnapshot:x/link/hello');
a.equal(roundTrip('decl99', 'system', 'svc-1'), 'PrincipalSnapshot:decl99/system/svc-1');
a.equal(roundTrip('a', 'apiKey', 'key_abc'), 'PrincipalSnapshot:a/apiKey/key_abc');

// ── IDs with special characters ────────────────────────────────────────────

a.equal(roundTrip('d', 'user', 'id/with/slashes'), 'PrincipalSnapshot:d/user/id%2Fwith%2Fslashes');
a.equal(roundTrip('d', 'user', 'id:with:colons'), 'PrincipalSnapshot:d/user/id%3Awith%3Acolons');
a.equal(roundTrip('d', 'user', 'id%with%percent'), 'PrincipalSnapshot:d/user/id%25with%25percent');
a.equal(roundTrip('d', 'user', 'unicode \u00e9\u00f1'), 'PrincipalSnapshot:d/user/unicode%20%C3%A9%C3%B1');
a.equal(roundTrip('d', 'user', 'spaces in id'), 'PrincipalSnapshot:d/user/spaces%20in%20id');

// ── The lexical entity parser remains unchanged until live routing lands ────

const psScope = principalSnapshotScope({ declaration: 'test', principal: { type: 'user', id: '1' } });
a.equal(parseScopeKey(psScope).entity, 'PrincipalSnapshot');

// ── Malformed / hostile ────────────────────────────────────────────────────

// Malformed URI encoding
a.throws(() => parsePrincipalSnapshotScope('PrincipalSnapshot:x/user/%2'), /Malformed/);

// Extra component
a.throws(() => parsePrincipalSnapshotScope('PrincipalSnapshot:x/user/1/extra'), /Invalid/);

// Missing component
a.throws(() => parsePrincipalSnapshotScope('PrincipalSnapshot:x/user'), /Invalid/);

// No colon
a.throws(() => parsePrincipalSnapshotScope('PrincipalSnapshot'), /Invalid/);

// Wrong prefix
a.throws(() => parsePrincipalSnapshotScope('Other:x/user/1'), /Invalid/);

// Non-canonical percent escape casing
a.throws(() => parsePrincipalSnapshotScope('PrincipalSnapshot:x/user/%3a'), /Non-canonical/);

// Anonymous type
a.throws(() => principalSnapshotScope({ declaration: 'x', principal: { type: 'anonymous', id: 'x' } }), /Invalid principal type/);

// Empty type
a.throws(() => principalSnapshotScope({ declaration: 'x', principal: { type: '', id: 'x' } }), /Invalid principal type/);

// Unknown type
a.throws(() => principalSnapshotScope({ declaration: 'x', principal: { type: 'admin', id: 'x' } }), /Invalid principal type/);

// Empty id
a.throws(() => principalSnapshotScope({ declaration: 'x', principal: { type: 'user', id: '' } }), /non-empty/);

// Null id
a.throws(() => principalSnapshotScope({ declaration: 'x', principal: { type: 'user', id: null } }), /non-empty/);

// Empty declaration
a.throws(() => principalSnapshotScope({ declaration: '', principal: { type: 'user', id: 'x' } }), /Invalid principal snapshot declaration/);

// Invalid declaration (uppercase)
a.throws(() => principalSnapshotScope({ declaration: 'MY-DECL', principal: { type: 'user', id: 'x' } }), /Invalid principal snapshot declaration/);

// Invalid declaration (starts with digit)
a.throws(() => principalSnapshotScope({ declaration: '0decl', principal: { type: 'user', id: 'x' } }), /Invalid principal snapshot declaration/);

// Invalid declaration (too long)
a.throws(() => principalSnapshotScope({ declaration: 'a'.repeat(65), principal: { type: 'user', id: 'x' } }), /Invalid principal snapshot declaration/);

// Id with empty after decode
a.throws(() => parsePrincipalSnapshotScope('PrincipalSnapshot:x/user/'), /Empty principal id/);

// Numeric id is coerced
a.throws(() => principalSnapshotScope({ declaration: 'x', principal: { type: 'user', id: 123 } }), /non-empty/);
