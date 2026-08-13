// Priority 4 SLICE C — Session security fixes (cso M1, M2).

import { text, ref, scope, grant, read, write, subscribe } from '../build/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity } from '../build/internal.mjs';
import { parseCookies, sessionCookie } from '../build/auth/session.mjs';

// M1: Malformed cookie does not throw → anonymous principal, not 500
test('parseCookies: malformed % escape does not throw', () => {
  // A cookie with a malformed percent-encoding should not throw
  const header = 'sid=%ZZ; other=value';
  const cookies = parseCookies(header);
  // The malformed cookie should be skipped or stored raw, but not throw
  assert.ok(typeof cookies === 'object');
});

test('parseCookies: multiple cookies with one malformed pair', () => {
  const header = 'good=hello; bad=%ZZ; another=world';
  const cookies = parseCookies(header);
  // Should not throw, should have at least the good cookies
  assert.equal(cookies.good, 'hello');
  assert.equal(cookies.another, 'world');
  // bad cookie may be missing or raw, but must not throw
});

test('request with malformed sid cookie → anonymous principal (route 401s)', async (t) => {
  const db = new DatabaseSync(':memory:');
  const Note = entity('Note', {
        body: text(),

    grant: () => [scope().can(() => grant(read, write))],
  });
  const app = workbench({ db });
  app.mount('/notes', Note);
  await app.ddl();

  // Default route gate is requireUser() — anonymous is denied
  app.listen(0);
  await app.ready;
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(() => { app.httpServer.close(); db.close(); });

  // Request with malformed sid cookie - should NOT 500, should treat as anonymous
  // Since route gate defaults to requireUser(), anonymous gets 401
  const r = await fetch(`${base}/notes`, {
    headers: { cookie: 'sid=%ZZ' },
  });
  // Should be 401 (anonymous denied by route gate), NOT 500
  assert.equal(r.status, 401, `Expected 401 for anonymous (malformed cookie), got ${r.status}`);
});

// M2: sessionCookie refuses secure:false in production
test('sessionCookie: secure:false in production throws', () => {
  // sessionCookie now accepts optional env override for testing
  assert.throws(
    () => sessionCookie('test-token', { secure: false, env: 'production' }),
    /secure.*production/i,
  );
});

test('sessionCookie: secure:false in development is allowed', () => {
  const cookie = sessionCookie('test-token', { secure: false, env: 'development' });
  // Should not throw in development
  assert.ok(cookie.includes('test-token'));
  // Should NOT include Secure attribute when secure:false
  assert.ok(!cookie.includes('Secure'), 'secure:false should not include Secure attribute');
});

test('sessionCookie: secure:true (default) works in production', () => {
  const cookie = sessionCookie('test-token', { env: 'production' });
  assert.ok(cookie.includes('Secure'));
});
