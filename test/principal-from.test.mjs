// S5/A5 principalFrom disposition (workbench#75, spec item 5) — KILL decision.
//
// principalFrom minted an ID-LESS `system` principal tagged with a source. It
// is REMOVED: the scheduler clock dispatch now mints an attributable
// `machinePrincipal({ id, operations })`, so no id-less system principal
// reaches an admission decision as an implicit grant. This file asserts the
// kill decision is reflected in the shipped surface and behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { schedule, date, scope, everyone, grant, read } from '../build/index.mjs';
import { entity, generateDDL, executeFrameworkDDL } from '../build/internal.mjs';
import { admitSystemMutation, startClockTriggers, schedulerSource, machinePrincipal } from '../build/schedule.mjs';

// The helper is gone from the internal surface: importing it fails closed at
// link time. Assert the module does not export it.
test('principalFrom is removed from the surface (kill decision)', async () => {
  const mod = await import('../build/principal.mjs');
  assert.equal('principalFrom' in mod, false, 'principalFrom must not be exported');
  const internal = await import('../build/internal.mjs');
  assert.equal('principalFrom' in internal, false, 'principalFrom must not be re-exported on the internal surface');
});

test('no id-less system principal is minted for admission (dispatch uses machinePrincipal)', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const Blog = entity('PrincipalFromKill', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    schedule: {
      update: schedule.at(publishedAt, { with: { published: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  db.prepare('INSERT INTO PrincipalFromKill (id, publishedAt) VALUES (?, ?)').run('k1', Date.now() - 1000);

  const calls = [];
  const handle = startClockTriggers({ db, entities: [Blog], dispatch: (args) => calls.push(args), now: () => Date.now() });
  handle.stop();
  assert.equal(calls.length, 1, 'due row dispatched');
  assert.equal(calls[0].principal.id != null, true, 'the dispatched principal carries a stable id — never id-less');
  assert.equal(calls[0].principal.attributes.machine, true, 'the dispatched principal is a machine principal');
  assert.equal(calls[0].principal.type, 'system');
  db.close();
});

test('an id-less system principal is DENIED by admitSystemMutation (no implicit grant)', () => {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  const publishedAt = date();
  const Blog = entity('PrincipalFromDeny', {
    grant: scope(() => everyone()).can(() => grant(read)),
    publishedAt,
    schedule: {
      update: schedule.at(publishedAt, { with: { published: true } }),
    },
  });
  for (const sql of generateDDL(Blog)) db.exec(sql);
  const now = Date.now();
  db.prepare('INSERT INTO PrincipalFromDeny (id, publishedAt) VALUES (?, ?)').run('d1', now - 1000);
  const source = schedulerSource(Blog.name, 'update', Blog.schedule.update.triggerId);

  // The legacy shape principalFrom produced (id null, attributes.source) —
  // exactly what an id-less system principal looked like — is denied.
  const denied = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'd1',
    payload: { published: true },
    principal: { type: 'system', attributes: { source } },
    db, now,
  });
  assert.equal(denied, false, 'an id-less system principal reaches no admission decision as an implicit grant');

  // The attributable replacement is admitted through the same seam.
  const admitted = admitSystemMutation({
    entity: Blog, verb: 'update', rowId: 'd1',
    payload: { published: true },
    principal: machinePrincipal({ id: source, operations: ['update'] }),
    db, now,
  });
  assert.equal(admitted, true, 'machinePrincipal is the attributable replacement and admits');
  db.close();
});
