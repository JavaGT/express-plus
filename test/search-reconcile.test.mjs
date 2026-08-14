// search-reconcile-harness.mjs — the S4/A3 common contract harness (epic
// scope#23, spec 5).
//
// The reconcile/rebuild engine is generic over a plugin's reconcile/rebuild/
// search ops plus its optional shadow hooks, so FTS5 and vector plugins run the
// SAME lifecycle/rebuild/fence/parity scenarios. This file holds:
//
//   1. makeShadowIndexedPlugin() — the in-memory fake-index plugin the contract
//      suite runs against. It keeps an `active` Map and a disposable `shadow`
//      Map, records every lifecycle call (with the write-queue `owned` probe),
//      and exposes corruption/failure hooks for the recovery scenarios.
//   2. makeFakeKit(db?) — wires the plugin into a registry + staleness bridge +
//      write queue + reconcile engine over one database, exactly as production
//      wiring would.
//   3. searchReconcileContractScenarios(makeKit) — the SHARED scenarios any
//      plugin kit must pass. A kit is `{ db, registry, bridge, queue, engine,
//      plugin, close }`; `plugin` is the makeShadowIndexedPlugin shape (plugin,
//      index, calls, setRebuilder, setCommitFails, corrupt). A FTS5/vector kit
//      supplies its own factory with the same shape.
//
// The engine module owns nothing the harness needs beyond its public surface;
// these scenarios are the red-line proof that reconcile batches are bounded,
// activation is fence-guarded, parity surfaces as health, and partial/corrupt/
// failed-activation states are recoverable.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSearchReconcileEngine, censusOfRows } from '../build/search-reconcile.mjs';
import {
  createSearchPluginRegistry,
  SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
} from '../build/search-plugin.mjs';
import { createSearchStalenessBridge } from '../build/search-staleness.mjs';
import { createWriteQueue } from '../build/write-queue.mjs';

// A search plugin over the Note source whose index is an in-memory Map. It
// implements the A3 shadow hooks (beginShadow/indexCensus/commitShadow/abortShadow)
// exactly as a real FTS5/vector plugin would for its own tables:
//   - beginShadow      starts building a FRESH target; the active index is
//                      untouched until commitShadow.
//   - rebuild          fills the CURRENT build target (shadow during a shadow
//                      build, active otherwise) from the scoped source reader.
//   - indexCensus      reports the CURRENT build target's census in the engine's
//                      canonical form (censusOfRows).
//   - commitShadow     atomically promotes the shadow over the active index.
//   - abortShadow      discards the shadow, leaving the active index intact.
//
// The hooks also record `owned` (the write-queue coordinator's turn flag) at
// each lifecycle point, so a red-line test can prove reconcile/commit run inside
// the coordinated turn while the shadow build does NOT hold the mutex.
export function makeShadowIndexedPlugin({ id = 'notes-fts', version = '1.0.0' } = {}) {
  let active = new Map();
  let shadow = null;
  let mode = 'active'; // 'active' | 'shadow'
  let rebuilder = null;
  let commitFails = false;
  let ownedProbe = null;
  const calls = [];

  function probeOwned() {
    return ownedProbe ? ownedProbe() : undefined;
  }

  const index = {
    get size() {
      return active.size;
    },
    has(rowId) {
      return active.has(rowId);
    },
    content() {
      return [...active.values()];
    },
  };

  const plugin = {
    contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
    id,
    version,
    ownedObjects: [
      {
        kind: 'virtual-table',
        name: `${id.replace(/[^A-Za-z0-9_]/g, '_')}_fts`,
        ddl: [`CREATE VIRTUAL TABLE IF NOT EXISTS ${id.replace(/[^A-Za-z0-9_]/g, '_')}_fts USING fts5(title);`],
      },
    ],
    sourceInterests: [{ entity: 'Note' }],
    stalenessKey: (change) => (change.entity === 'Note' ? `${change.entity}:${change.rowId}` : null),
    prepare: () => {},
    validate: () => ({ counts: { documents: active.size } }),
    reconcile: (_ctx, changes) => {
      const target = mode === 'shadow' ? shadow : active;
      const owned = probeOwned();
      calls.push({ op: 'reconcile', rowIds: changes.map((change) => change.rowId), owned });
      for (const change of changes) {
        if (change.kind === 'removed') target.delete(change.rowId);
        else target.set(change.rowId, { id: change.rowId, ...(change.data ?? {}) });
      }
      return { counts: { documents: target.size } };
    },
    rebuild: (ctx) => {
      const owned = probeOwned();
      calls.push({ op: 'rebuild', mode, owned });
      if (rebuilder) return rebuilder(ctx);
      const target = mode === 'shadow' ? shadow : active;
      target.clear();
      for (const row of ctx.reader.rows('Note')) target.set(String(row.id), { ...row });
      return { counts: { documents: target.size } };
    },
    search: () => ({ hits: [...active.keys()].map((rowId) => ({ id: rowId })) }),
    beginShadow: () => {
      calls.push({ op: 'beginShadow', owned: probeOwned() });
      shadow = new Map();
      mode = 'shadow';
    },
    commitShadow: () => {
      const owned = probeOwned();
      calls.push({ op: 'commitShadow', owned });
      if (commitFails) throw new Error('commitShadow failed (injected)');
      active = shadow;
      shadow = null;
      mode = 'active';
    },
    abortShadow: () => {
      calls.push({ op: 'abortShadow', owned: probeOwned() });
      shadow = null;
      mode = 'active';
    },
    indexCensus: () => ({
      Note: censusOfRows([...(mode === 'shadow' ? shadow : active).values()]),
    }),
  };

  return {
    plugin,
    index,
    calls,
    // During a shadow build, `rebuilder(ctx)` REPLACES the fill-from-reader logic:
    // a scenario can inject a mid-build source mutation (via notifySourceChange)
    // or throw to simulate a partial build.
    setRebuilder(fn) {
      rebuilder = fn;
    },
    // Inject a commit-time failure to simulate a failed activation.
    setCommitFails(fails) {
      commitFails = fails;
    },
    // Corrupt the ACTIVE index out-of-band (simulates a corrupt index whose
    // census no longer matches the source).
    corrupt() {
      active.set('bogus', { id: 'bogus', title: 'ghost' });
    },
    setOwnedProbe(fn) {
      ownedProbe = fn;
    },
  };
}

// Wire a full S4/A3 environment over one database: registry (A1) + staleness
// bridge (A2) + write coordinator (S1/A5) + reconcile engine (A3). `db` defaults
// to a fresh in-memory Note database; pass a file-backed handle to simulate
// restarts.
export function makeFakeKit(db = null) {
  const handle = db ?? new DatabaseSync(':memory:');
  if (db === null) {
    handle.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
  }
  const owned = makeShadowIndexedPlugin();
  const registry = createSearchPluginRegistry();
  registry.register(owned.plugin);
  registry.bindSource(handle);
  const bridge = createSearchStalenessBridge({ registry, now: () => 't' });
  bridge.engage(handle);
  const queue = createWriteQueue();
  const engine = createSearchReconcileEngine({ registry, staleness: bridge, db: handle, writeQueue: queue, now: () => 't' });
  owned.setOwnedProbe(() => queue.owned);
  return {
    db: handle,
    registry,
    bridge,
    queue,
    engine,
    plugin: owned,
    close: async () => {
      await queue.close();
      handle.close();
    },
  };
}

// The SHARED contract scenarios. Each `run` receives a FRESH kit (the factory is
// invoked per scenario), so every scenario starts from a clean plugin/index.
// These are the scenarios FTS5 and vector plugins must pass with their own kits.
export function searchReconcileContractScenarios(_makeKit) {
  return [
    {
      name: 'shadow rebuild builds a shadow generation, validates, atomically activates and retires the old',
      async run(kit) {
        const { db, registry, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');

        assert.equal(registry.stateOf('notes-fts').state, 'building');
        const outcome = await engine.rebuildShadow('notes-fts');
        assert.equal(outcome.ok, true, outcome.lastError ?? '');
        assert.equal(outcome.activated, true, 'the shadow generation was activated');
        assert.equal(outcome.retired, true, 'the old generation was retired');
        assert.equal(outcome.fenceAtStart, 0);
        assert.equal(outcome.fence, 0, 'no source change landed — the fence is unchanged');
        assert.equal(outcome.state, 'ready');

        // The activated generation serves the source content exactly.
        assert.deepEqual([...plugin.index.content()].map((row) => row.id).sort(), ['n1', 'n2']);
        // The build went through the SHADOW (a separate target), never the active index.
        assert.deepEqual(plugin.calls.filter((call) => call.op === 'rebuild'), [{ op: 'rebuild', mode: 'shadow', owned: false }]);
        assert.equal(plugin.calls.some((call) => call.op === 'commitShadow' && call.owned === true), true);

        // The registry — the single health authority — discloses the activation.
        assert.equal(registry.stateOf('notes-fts').state, 'ready');
        assert.equal(registry.stateOf('notes-fts').generation, 1);

        // Search serves the new generation.
        const search = await registry.search('notes-fts', { query: {} });
        assert.equal(search.ok, true);
        assert.deepEqual(search.result.hits.map((hit) => hit.id).sort(), ['n1', 'n2']);

        // Parity passes: deterministic source census == index census.
        const report = engine.parity('notes-fts');
        assert.equal(report.matches, true);
        assert.equal(report.source.Note.count, 2);
        assert.equal(report.index.Note.count, 2);
      },
    },
    {
      name: 'a mutation during the rebuild scan aborts activation (fence) and leaves the active generation intact',
      async run(kit) {
        const { db, registry, bridge, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');

        // A healthy active generation is the baseline.
        const baseline = await engine.rebuildShadow('notes-fts');
        assert.equal(baseline.ok, true);
        const fenceAtStart = registry.stateOf('notes-fts').fence;
        const commitsBefore = plugin.calls.filter((call) => call.op === 'commitShadow').length;
        assert.equal(fenceAtStart, 0);

        // The next rebuild's SCAN is interrupted: a committed source change
        // (row n2 inserted + its post-commit staleness notification) lands while
        // the shadow is being built. The engine captured the fence BEFORE the
        // scan, so activation must abort.
        plugin.setRebuilder(() => {
          db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
          bridge.notifySourceChange({
            entity: 'Note', rowId: 'n2', kind: 'created',
            data: { id: 'n2', title: 'two' },
            committedAt: '2026-08-15T00:00:00.000Z',
          });
        });

        const outcome = await engine.rebuildShadow('notes-fts');
        assert.equal(outcome.ok, false, 'the fence guard refuses to activate a shadow that missed committed changes');
        assert.equal(outcome.activated, false);
        assert.equal(outcome.retired, false);
        assert.equal(outcome.retryable, true);
        assert.match(outcome.lastError, /fence moved/i);
        assert.equal(outcome.fenceAtStart, fenceAtStart);
        assert.equal(outcome.fence, fenceAtStart + 1, 'the mid-scan mutation bumped the fence');
        assert.equal(plugin.calls.some((call) => call.op === 'abortShadow'), true, 'the shadow was discarded');
        assert.equal(
          plugin.calls.filter((call) => call.op === 'commitShadow').length,
          commitsBefore,
          'nothing from the aborted rebuild was committed',
        );

        // The ACTIVE generation is untouched — the old index still serves.
        assert.deepEqual([...plugin.index.content()].map((row) => row.id), ['n1']);
        // The registry stays honestly stale, never falsely ready.
        assert.equal(registry.stateOf('notes-fts').state, 'stale');

        // The mid-scan mutation is NOT lost: it is pending in the durable ledger,
        // and a bounded reconcile applies it (retryable recovery).
        assert.equal(bridge.pending().length, 1);
        const summary = await engine.reconcileBatches({ batchSize: 1 });
        assert.equal(summary.processed, 1);
        assert.equal(summary.retained, 0);
        assert.equal(registry.stateOf('notes-fts').state, 'ready');
        assert.deepEqual([...plugin.index.content()].map((row) => row.id).sort(), ['n1', 'n2']);
      },
    },
    {
      name: 'parity mismatch surfaces as plugin health, not as an authoritative-write error',
      async run(kit) {
        const { db, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');

        const outcome = await engine.rebuildShadow('notes-fts');
        assert.equal(outcome.ok, true);
        assert.equal(engine.parity('notes-fts').matches, true);

        // Corrupt the index out-of-band (e.g. a partial write clobbered a row).
        plugin.corrupt();
        const report = engine.parity('notes-fts');
        assert.equal(report.matches, false, 'a census mismatch is detected');
        const comparison = report.comparisons.find((entry) => entry.entity === 'Note');
        assert.equal(comparison.countsMatch, false);
        assert.equal(report.source.Note.count, 1);
        assert.equal(report.index.Note.count, 2);

        // The mismatch surfaces through healthOf — advisory, never thrown, and
        // never an authoritative-write error.
        const health = engine.healthOf('notes-fts');
        assert.equal(health.ok === undefined, true);
        assert.equal(health.parity.matches, false);
        assert.equal(health.parity.source.Note.count, 1);

        // A subsequent correct rebuild restores parity (recoverable).
        const repaired = await engine.rebuildShadow('notes-fts');
        assert.equal(repaired.ok, true);
        assert.equal(engine.parity('notes-fts').matches, true);
      },
    },
    {
      name: 'a failed activation discards the shadow, keeps the active generation, and is recoverable',
      async run(kit) {
        const { db, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');

        const baseline = await engine.rebuildShadow('notes-fts');
        assert.equal(baseline.ok, true);
        assert.equal(engine.parity('notes-fts').matches, true);

        // Commit now throws (simulated I/O failure during atomic activation).
        plugin.setCommitFails(true);
        const failed = await engine.rebuildShadow('notes-fts');
        assert.equal(failed.ok, false);
        assert.equal(failed.activated, false);
        assert.equal(failed.retryable, true);
        assert.match(failed.lastError, /activation failed/i);
        assert.equal(plugin.calls.some((call) => call.op === 'abortShadow'), true, 'the failed shadow was discarded');
        assert.deepEqual([...plugin.index.content()].map((row) => row.id), ['n1'], 'the active generation survived');
        assert.equal(engine.parity('notes-fts').matches, true, 'the surviving generation still matches the source');

        // The failure is recoverable: the next attempt activates cleanly.
        plugin.setCommitFails(false);
        const retried = await engine.rebuildShadow('notes-fts');
        assert.equal(retried.ok, true);
        assert.equal(retried.activated, true);
        assert.deepEqual([...plugin.index.content()].map((row) => row.id), ['n1']);
      },
    },
    {
      name: 'a partial shadow build is discarded and a fresh rebuild recovers',
      async run(kit) {
        const { db, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');

        const baseline = await engine.rebuildShadow('notes-fts');
        assert.equal(baseline.ok, true);

        // The next shadow build fails midway (simulated crash/partial generation).
        plugin.setRebuilder(() => {
          throw new Error('rebuild failed (injected)');
        });
        const partial = await engine.rebuildShadow('notes-fts');
        assert.equal(partial.ok, false);
        assert.equal(partial.activated, false);
        assert.equal(partial.retryable, true);
        assert.match(partial.lastError, /rebuild failed/i);
        assert.equal(plugin.calls.some((call) => call.op === 'abortShadow'), true);
        assert.deepEqual([...plugin.index.content()].map((row) => row.id), ['n1'], 'the partial shadow never reached the active index');

        // A fresh attempt (no injected failure) succeeds — restart-safe recovery.
        plugin.setRebuilder(null);
        const fresh = await engine.rebuildShadow('notes-fts');
        assert.equal(fresh.ok, true);
        assert.equal(fresh.activated, true);
        assert.equal(engine.parity('notes-fts').matches, true);
      },
    },
    {
      name: 'bounded-batch reconcile processes at most batchSize source keys per call',
      async run(kit) {
        const { registry, bridge, engine, plugin } = kit;

        for (let i = 0; i < 5; i += 1) {
          bridge.notifySourceChange({
            entity: 'Note', rowId: `n${i}`, kind: 'created',
            data: { id: `n${i}`, title: `note-${i}` },
            committedAt: `2026-08-15T00:00:0${i}.000Z`,
          });
        }
        assert.equal(bridge.pending().length, 5);

        const first = await engine.reconcileBatches({ batchSize: 2 });
        assert.equal(first.processed, 2, 'a bounded batch never exceeds its bound');
        assert.equal(first.remaining, 3);
        assert.equal(bridge.pending().length, 3);

        const second = await engine.reconcileBatches({ batchSize: 2 });
        assert.equal(second.processed, 2);
        assert.equal(second.remaining, 1);

        const third = await engine.reconcileBatches();
        assert.equal(third.processed, 1);
        assert.equal(third.remaining, 0);
        assert.equal(bridge.pending().length, 0);

        // Coalescing is preserved through the batches: N notifications for N
        // distinct keys → exactly one reconcile per key, each carrying its own
        // single source key (no transaction ever grows with source size).
        const reconciles = plugin.calls.filter((call) => call.op === 'reconcile');
        assert.equal(reconciles.length, 5);
        for (const call of reconciles) {
          assert.equal(call.rowIds.length, 1);
          assert.equal(call.owned, true, 'each materialization enters through the write coordinator');
        }
        assert.equal(registry.stateOf('notes-fts').state, 'ready');
      },
    },
    {
      name: 'a restart discards an incomplete shadow and rebuilds the persisted source and pending ledger',
      async run() {
        const directory = mkdtempSync(join(tmpdir(), 'workbench-search-reconcile-'));
        const path = join(directory, 'search.sqlite');
        try {
          const firstDb = new DatabaseSync(path);
          firstDb.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
          const first = makeFakeKit(firstDb);
          firstDb.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
          first.plugin.setRebuilder(() => {
            throw new Error('rebuild interrupted before activation');
          });
          const incomplete = await first.engine.rebuildShadow('notes-fts');
          assert.equal(incomplete.ok, false);
          first.bridge.notifySourceChange({
            entity: 'Note', rowId: 'n1', kind: 'created', data: { id: 'n1', title: 'one' },
            committedAt: '2026-08-15T00:00:00.000Z',
          });
          await first.close();

          const secondDb = new DatabaseSync(path);
          const second = makeFakeKit(secondDb);
          try {
            assert.equal(second.bridge.pending().length, 1, 'the unprocessed invalidation survives restart');
            const recovered = await second.engine.rebuildShadow('notes-fts');
            assert.equal(recovered.ok, true);
            assert.deepEqual(second.plugin.index.content(), [{ id: 'n1', title: 'one', body: null }]);
            assert.equal(second.engine.parity('notes-fts').matches, true);
          } finally {
            await second.close();
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    },
  ];
}

test('census canonicalizes nested object keys before hashing', () => {
  const left = censusOfRows([{ id: 'n1', metadata: { first: 'a', second: 'b' } }]);
  const right = censusOfRows([{ metadata: { second: 'b', first: 'a' }, id: 'n1' }]);
  assert.deepEqual(left, right);
});

describe('search reconcile engine', () => {
  for (const scenario of searchReconcileContractScenarios(makeFakeKit)) {
    test(scenario.name, async () => {
      const kit = makeFakeKit();
      try {
        await scenario.run(kit);
      } finally {
        await kit.close();
      }
    });
  }
});
