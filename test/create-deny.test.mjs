// C3: `create` mutations must run the row-grant, not just the route gate.
//
// Before this fix `buildKernel` wired `createServer({ authorize: () => true })`
// and NEVER passed the in-txn post-projection admission seam (spec #5) that is
// the INTENDED create-authorizer (create has no pre-existing
// row to pre-check, unlike update/remove). So `result.granted` could only be
// true and a create never 403'd — the route gate alone admitted the principal,
// the row grant never ran. Latent for the exemplars because their `.can` grants
// `write` to owner=creator, so every create happened to be authorized; but any
// grant whose `.can` body denies write to the creator created silently, no 403.
//
// Also fixes the fragile verb-derivation in pipeline.mjs:
// `ev.type.slice(dotIdx+1).replace('d','')` removed the FIRST 'd', so
// 'updated' → 'upated' (broken), which would make the hook deny every update.

import { text, ref, grant, deny, read, write, subscribe, scope } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, generateDDL } from '../src/internal.mjs';

// A Widget whose row grant DENIES write to a 'banned' principal (via a declared
// run-only check — the .can body receives { is, entity }, not principal, so a
// principal-based decision must be a check, not inline). Everyone else (incl.
// the creator) is granted read/write/subscribe.
function makeWidget() {
  return entity('Widget', {
    fields: { label: text(), owner: ref('User', { role: 'owner', readonly: true }) },
    checks: { banned: ({ principal }) => principal.id === 'banned' },
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.banned()) ? deny('banned') : grant(read, write, subscribe)),
    ],
  });
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS User (id TEXT PRIMARY KEY, username TEXT, password TEXT)');
  db.exec("INSERT INTO User (id, username, password) VALUES ('alice', 'alice', 'hash')");
  const Widget = makeWidget();
  for (const sql of generateDDL(Widget)) db.exec(sql);
  const app = workbench({ db }).mount('/widgets', Widget);
  app.listen(0, {
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'];
      return u ? { type: 'user', id: u } : { type: 'anonymous', id: null };
    },
  });
  return { app, Widget };
}

test('C3: a create the row grant denies is rejected with 403 (not 201)', async () => {
  const { app } = setup();
  try {
    await app.ready;
    const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

    // 'banned' tries to create a widget. The route gate (requireUser) admits
    // them (authenticated), but the row grant's .can body denies write for
    // banned principals → the in-txn post-projection hook returns denied → the
    // projection rolls back → 403.
    const denied = await fetch(`${origin}/widgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'banned' },
      body: JSON.stringify({ label: 'mine' }),
    });
    assert.equal(denied.status, 403, 'a deny-write principal cannot create');

    // Control: alice (not banned) creates the same widget — owner=alice, the
    // .can body grants write → 201. Proves the hook denies selectively, not a
    // blanket block on all creates.
    const allowed = await fetch(`${origin}/widgets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'alice' },
      body: JSON.stringify({ label: 'hers' }),
    });
    assert.equal(allowed.status, 201, 'an authorized principal may create');
  } finally {
    app.httpServer.close();
  }
});
