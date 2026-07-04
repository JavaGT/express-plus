// In-txn post-handler row-grant hook (spec #5, eng-review Tier 1).
// The second default-on auth layer (mayVerb/rowCapabilities) needs the
// materialized row, which only exists AFTER the projection consumer writes it.
// The kernel runs the row-grant hook INSIDE the write txn, after projections,
// and rolls back on deny. bindReadScope stays pure outside the txn.

import { text, ref, grant, read, write, scope, everyone } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  entity, generateFrameworkDDL, mayVerb } from '../src/internal.mjs';
import { setActiveDb } from '../src/db.mjs';

test('in-txn row-grant hook: deny after projections roll back the txn', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db, { replace: true });
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  // Seed a row owned by u1 (trusted insert, bypasses readonly check)
  const row = Note.insert({ body: 'original', owner: 'u1' });

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  const server = createServer({
    handlers: {
      'Note.update': ({ payload }) => [
        { type: 'Note.updated', scope: `Note:${payload.id}`, data: { id: payload.id, ...payload } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note.projection],
      admission: {
        beforeProjection: async () => true,
        // The in-txn row-grant hook: runs after projections, inside the txn.
        // If it returns false (deny), the txn rolls back.
        afterProjection: async ({ entityName, principal, event }) => {
          // Read the materialized row that the projection just wrote
          const currentRow = db.prepare(`SELECT * FROM ${entityName} WHERE id = ?`).get(event.data.id);
          if (!currentRow) return true; // no row to check
          // Use the SAME mayVerb as the REST dispatch — no second auth path
          return mayVerb(Note, 'update', currentRow, principal);
        },
      },
    }),
  });

  // u1 is the owner — update should succeed
  const r1 = await server.dispatch({
    actionId: 'u1',
    type: 'Note.update',
    payload: { id: row.id, body: 'updated' },
    principal: { id: 'u1' },
  });
  assert.equal(r1.granted, true);
  let updated = Note.findById(row.id);
  assert.equal(updated.body, 'updated');

  // u2 is NOT the owner — update should fail (row-grant hook denies)
  const r2 = await server.dispatch({
    actionId: 'u2',
    type: 'Note.update',
    payload: { id: row.id, body: 'hacked' },
    principal: { id: 'u2' },
  });
  assert.equal(r2.granted, false, 'non-owner denied by in-txn row-grant hook');

  // The row is unchanged — txn rolled back
  updated = Note.findById(row.id);
  assert.equal(updated.body, 'updated', 'row unchanged — txn rolled back');

  // Nothing was logged for the denied action
  const logRows = db.prepare('SELECT * FROM _Log WHERE actionId = ?').all('u2');
  assert.equal(logRows.length, 0);
});

test('in-txn row-grant hook: create — runs on the newly projected row', async () => {
  const db = new DatabaseSync(':memory:');
  setActiveDb(db, { replace: true });
  for (const sql of generateFrameworkDDL()) db.exec(sql);

  const Note = entity('Note', {
        body: text(),
    owner: ref('User', { role: 'owner', readonly: true }),

    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write) : grant(read)),
    ],
  });

  for (const sql of Note.generateDDL()) db.exec(sql);

  const { createServer, durableMutationVariant } = await import('../src/pipeline.mjs');

  // A restrictive hook: only u1 may create (simulating an entity-level create gate)
  const server = createServer({
    handlers: {
      'Note.create': ({ payload, principal }) => [
        { type: 'Note.created', scope: 'Note:new', data: { ...payload, owner: principal.id } },
      ],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({
      projectionConsumers: [Note.projection],
      admission: {
        beforeProjection: async () => true,
        afterProjection: async ({ principal }) => {
          // Only u1 may create (simulated rule)
          return principal.id === 'u1';
        },
      },
    }),
  });

  // u1 creates — succeeds
  const r1 = await server.dispatch({
    actionId: 'c1',
    type: 'Note.create',
    payload: { body: 'hi' },
    principal: { id: 'u1' },
  });
  assert.equal(r1.granted, true);

  // u2 tries to create — afterProjection admission denies
  const r2 = await server.dispatch({
    actionId: 'c2',
    type: 'Note.create',
    payload: { body: 'hacked' },
    principal: { id: 'u2' },
  });
  assert.equal(r2.granted, false);

  // Only u1's row exists
  const rows = db.prepare('SELECT * FROM Note').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'hi');
});