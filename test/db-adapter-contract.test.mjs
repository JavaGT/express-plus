// db-adapter.mjs — the db adapter contract (epic scope#23, S1/A1).
//
// Runtime assertions for the contract module. The type-level assertions
// (config refuses a physical filename, DbHandle structural compatibility,
// closed capability set, encryption permanently false) live in
// type-test/db-adapter-contract.ts, which `pnpm typecheck` compiles — a .mjs
// test cannot express them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { capabilitiesOf } from '../build/db-adapter.mjs';

test('capabilitiesOf returns the closed six-flag capability set with encryption false', () => {
  assert.deepEqual(capabilitiesOf({ transactionalDdl: true, integrityCheck: true }), {
    transactionalDdl: true,
    onlineBackup: false,
    readOnlyConnections: false,
    integrityCheck: true,
    maintenance: false,
    encryption: false,
  });
});

test('capabilitiesOf normalizes an empty input to all-false flags', () => {
  assert.deepEqual(capabilitiesOf(), {
    transactionalDdl: false,
    onlineBackup: false,
    readOnlyConnections: false,
    integrityCheck: false,
    maintenance: false,
    encryption: false,
  });
});

test('capabilitiesOf fills unspecified flags with false, never fabricating encryption', () => {
  const caps = capabilitiesOf({ onlineBackup: true, maintenance: true });
  assert.equal(caps.transactionalDdl, false);
  assert.equal(caps.onlineBackup, true);
  assert.equal(caps.readOnlyConnections, false);
  assert.equal(caps.integrityCheck, false);
  assert.equal(caps.maintenance, true);
  assert.equal(caps.encryption, false);
});

test('db-adapter.mjs ships no runtime imports (pure contract module)', () => {
  const source = readFileSync(new URL('../build/db-adapter.mjs', import.meta.url), 'utf8');
  assert.match(source, /export function capabilitiesOf/);
  assert.doesNotMatch(source, /^\s*import\b/m);
});

test('db-adapter.ts source declares no runtime imports (stale-build guard)', () => {
  // The build check above reads the emitted artifact, which could silently pass
  // a STALE build after a runtime import sneaks into the source. Guard the
  // source of truth directly: every import it declares must be a type-only
  // import (stripped by emit-ts), so the build genuinely emits an import-free
  // module.
  const source = readFileSync(new URL('../src/db-adapter.ts', import.meta.url), 'utf8');
  const imports = source.match(/^import\b.*$/gm) ?? [];
  assert.ok(imports.length > 0, 'expected the type import of DbHandle');
  for (const line of imports) {
    assert.match(line, /^import type\b/);
  }
});
