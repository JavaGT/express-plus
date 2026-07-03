// C2: `list` must run the row-grant, not just the SQL read-scope.
//
// Before this fix `dispatch`'s `list` branch applied only the SQL read-scope
// (which rows are VISIBLE) and returned them directly — it never ran
// `mayVerb('read')` (the .can capability decision), unlike `read` at the same
// site. A grant can admit a row through scope yet DENY read in its `.can`
// body; then GET /:id returns 403 but GET / (list) leaks the same row.
// Latent because no exemplar's grant admits-then-denies-read.
//
// The fix post-filters list rows through the SAME mayVerb('list') engine
// (list→read capability). Entities whose grant has no own `.can` body (scope-
// only, or inherit children whose capability resolves at the parent seam) are
// NOT filtered — their scope already decided visibility, and mayVerb returns
// denied for them (no clause to run), which would wrongly empty the list.

import { text, grant, deny, read, scope, everyone } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import workbench, { entity, generateDDL } from '../src/internal.mjs';

// A Secret visible to everyone (scope = everyone) but readable only by `vip`
// (the .can body denies read to non-vip). This is the admits-then-denies-read
// shape no exemplar has — it isolates the list-only leak.
function makeSecret() {
  return entity('Secret', {
        label: text(),

    checks: { vip: ({ principal }) => principal.id === 'vip' },
    grant: () => [
      scope(everyone).can(async ({ is }) =>
        (await is.vip()) ? grant(read) : deny('vip only')),
    ],
  });
}

function setup() {
  const db = new DatabaseSync(':memory:');
  const Secret = makeSecret();
  for (const sql of generateDDL(Secret)) db.exec(sql);
  // Seed directly (the create-hook would deny non-vip, and vip grants only
  // read, not write) — the point is the LIST path, not create.
  db.prepare("INSERT INTO Secret (id, label) VALUES ('1', 'hidden')").run();
  const app = workbench({ db }).mount('/secrets', Secret);
  app.listen(0, {
    principalOf: (req) => {
      const u = req.headers?.['x-test-user'];
      return u ? { type: 'user', id: u } : { type: 'anonymous', id: null };
    },
  });
  return { app };
}

test('C2: list does not leak rows the row-grant denies read for', async () => {
  const { app } = setup();
  try {
    await app.ready;
    const origin = `http://127.0.0.1:${app.httpServer.address().port}`;

    // vip: scope admits (everyone) + .can grants read → list returns the row.
    const vipRes = await fetch(`${origin}/secrets`, { headers: { 'x-test-user': 'vip' } });
    assert.equal(vipRes.status, 200);
    const vipRows = await vipRes.json();
    assert.equal(vipRows.length, 1, 'vip sees the secret');
    assert.equal(vipRows[0].label, 'hidden');

    // non-vip: scope admits (everyone) BUT .can denies read → list MUST NOT
    // return the row. Before the fix, list returned it (scope-only, no mayVerb).
    const plainRes = await fetch(`${origin}/secrets`, { headers: { 'x-test-user': 'bob' } });
    assert.equal(plainRes.status, 200);
    const plainRows = await plainRes.json();
    assert.equal(plainRows.length, 0, 'a non-vip principal lists nothing (read denied by .can)');

    // Sanity: read of the single row as non-vip is 403 (the existing, correct
    // behavior — proves list + read now agree, one auth path).
    const readRes = await fetch(`${origin}/secrets/1`, { headers: { 'x-test-user': 'bob' } });
    assert.equal(readRes.status, 403);
  } finally {
    app.httpServer.close();
  }
});
