import { scope, everyone, grant, read, text, simulate, tick } from '../src/index.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { entity } from '../src/internal.mjs';
import { generateDDL } from '../src/ddl.mjs';
import { startSimulation } from '../src/simulate.mjs';

// Simulates a counter entity that increments every step. step reads
// the ephemeral state, increments it, and optionally returns events
// to persist a checkpoint.

function seededDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE _Log (
    scope TEXT, seq INTEGER, eventType TEXT, eventData TEXT,
    actionId TEXT, committedAt TEXT
  )`);
  db.exec('CREATE TABLE _Cursor (scope TEXT PRIMARY KEY, lastSeq INTEGER)');
  return db;
}

function poll(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      try { const r = fn(); return resolve(r); }
      catch (e) { if (Date.now() - start >= timeoutMs) reject(e); else setTimeout(check, intervalMs); }
    }
    check();
  });
}

test('simulate() declaration compiles as an entity slot', () => {
  const Counter = entity('Counter', {
    grant: scope(() => everyone()).can(() => grant(read)),
    count: text({ default: '0' }),
    simulation: {
      step: () => ({ state: {}, events: [] }),
      hz: 1,
    },
  });
  assert.equal(typeof Counter.simulation, 'object');
  assert.equal(Counter.simulation.hz, 1);
  assert.equal(typeof Counter.simulation.step, 'function');
});

test('startSimulation runs step and advances ephemeral state', async (t) => {
  let states = [];
  const Counter = entity('Counter', {
    grant: scope(() => everyone()).can(() => grant(read)),
    count: text({ default: '0' }),

    simulation: {
      hz: 20,
      step: ({ state }) => {
        const next = (state.n ?? 0) + 1;
        states.push(next);
        return { state: { n: next }, events: [] };
      },
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Counter)) db.exec(sql);
  db.prepare('INSERT INTO Counter (id, count) VALUES (?, ?)').run('c1', '0');

  const entities = new Map([[Counter.name, Counter]]);

  const engine = startSimulation({ db, entities });
  t.after(() => engine.stop());

  await engine._tick(100);
  await engine._tick(200);

  assert.equal(states.length, 2, `expected 2 steps, got ${states.length} (states: ${JSON.stringify(states)})`);
  assert.equal(states[1], 2, `final state should be 2, got ${states[1]}`);
});

test('startSimulation dispatches events returned by step', async (t) => {
  const Counter = entity('Counter', {
    grant: scope(() => everyone()).can(() => grant(read)),
    count: text({ default: '0' }),

    simulation: {
      hz: 20,
      step: ({ state }) => {
        const next = (state.n ?? 0) + 1;
        return {
          state: { n: next },
          events: [{ data: { count: String(next) } }],
        };
      },
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Counter)) db.exec(sql);
  db.prepare('INSERT INTO Counter (id, count) VALUES (?, ?)').run('c1', '0');

  const entities = new Map([[Counter.name, Counter]]);

  let dispatchCalls = 0;
  let lastPayload = null;
  const engine = startSimulation({
    db, entities,
    dispatch: async (op) => {
      dispatchCalls++;
      lastPayload = op.payload;
    },
  });
  t.after(() => engine.stop());

  await engine._tick(100);
  await engine._tick(200);

  assert.equal(dispatchCalls, 2, `expected 2 dispatch calls, got ${dispatchCalls}`);
  assert.equal(lastPayload.id, 'c1');
  assert.equal(lastPayload.count, '2');
});

test('startSimulation with when guard skips scopes not matching', async (t) => {
  const Counter = entity('Counter', {
    grant: scope(() => everyone()).can(() => grant(read)),
    count: text({ default: '0' }),

    simulation: {
      hz: 10,
      when: ({ row }) => row.active === 'yes',
      step: ({ state }) => {
        const next = (state.n ?? 0) + 1;
        return { state: { n: next }, events: [] };
      },
    },
  });
  const db = seededDb();
  for (const sql of generateDDL(Counter)) db.exec(sql);
  db.prepare('INSERT INTO Counter (id, count) VALUES (?, ?)').run('c1', '0');
  // active is 'no' — simulation should not run for this row.

  const entities = new Map([[Counter.name, Counter]]);
  let dispatchCount = 0;
  const engine = startSimulation({ db, entities, dispatch: () => { dispatchCount++; } });
  t.after(() => engine.stop());

  await engine._tick(100);

  assert.equal(dispatchCount, 0, 'when guard prevented any dispatch');
});

test('entity with no simulation gets a no-op startSimulation', () => {
  const NoSim = entity('NoSim', {
    grant: scope(() => everyone()).can(() => grant(read)),
    body: text(),
  });
  const db = seededDb();
  for (const sql of generateDDL(NoSim)) db.exec(sql);
  const entities = new Map([[NoSim.name, NoSim]]);

  const engine = startSimulation({ db, entities });
  assert.equal(typeof engine.stop, 'function');
  engine.stop();
});

test('simulation slot and tick can coexist on same entity', () => {
  const Hybrid = entity('Hybrid', {
    grant: scope(() => everyone()).can(() => grant(read)),
    status: text(),

    schedule: {
      update: tick.hz(1, { while: ({ fields }) => fields.status.is('pending'), with: { status: 'ticked' } }),
    },
    simulation: {
      hz: 5,
      step: () => ({ state: {}, events: [] }),
    },
  });
  assert.ok(Hybrid.schedule);
  assert.ok(Hybrid.simulation);
});
