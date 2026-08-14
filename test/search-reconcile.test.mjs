// search-reconcile-harness.mjs — the S4/A3 common contract harness (epic
// scope#23, spec 5).
//
// The reconcile/rebuild engine is generic over a plugin's reconcile/rebuild/
// search ops plus its optional shadow hooks, so FTS5 and vector plugins run the
// SAME lifecycle/rebuild/fence/parity scenarios. This file holds:
//
//   1. makeShadowIndexedPlugin() — the in-memory fake-index plugin the contract
//      suite runs against. It keeps an `active` Map and a disposable `shadow`
//      Map, records every lifecycle callback (which must be outside the queue),
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

// A search plugin over the Note source whose index is persisted by generation
// and mirrored in an in-memory Map. A newly constructed fake reloads the map
// selected by the durable active pointer, just as a fresh plugin process must.
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
// The hooks record `owned` at each lifecycle point. The strict owned-index
// facade in makeFakeKit separately records host statement execution, proving
// callbacks never hold the coordinator even though their writes do.
export function makeShadowIndexedPlugin({ db, id = 'notes-fts', version = '1.0.0' } = {}) {
  function generationRows(generation) {
    return db.prepare('SELECT id, title, body FROM notes_fts_document WHERE generation = ? ORDER BY id').all(generation);
  }

  function generationMap(generation) {
    return new Map(generationRows(generation).map((row) => [row.id, row]));
  }

  let active = generationMap(db.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'active'").get().generation);
  let shadow = null;
  let shadowGeneration = null;
  let mode = 'active'; // 'active' | 'shadow'
  let rebuilder = null;
  let commitFails = false;
  let validateFails = false;
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
      { kind: 'table', name: 'notes_fts_state', ddl: ['CREATE TABLE IF NOT EXISTS notes_fts_state (slot TEXT PRIMARY KEY, generation INTEGER NOT NULL);'] },
      { kind: 'table', name: 'notes_fts_document', ddl: ['CREATE TABLE IF NOT EXISTS notes_fts_document (generation INTEGER NOT NULL, id TEXT NOT NULL, title TEXT, body TEXT, PRIMARY KEY (generation, id));'] },
    ],
    sourceInterests: [{ entity: 'Note' }],
    stalenessKey: (change) => (change.entity === 'Note' ? `${change.entity}:${change.rowId}` : null),
    prepare: () => {},
    validate: () => {
      if (validateFails) throw new Error('validate failed (injected)');
      return { counts: { documents: active.size } };
    },
    async reconcile(ctx, changes) {
      const target = mode === 'shadow' ? shadow : active;
      const owned = probeOwned();
      calls.push({ op: 'reconcile', rowIds: changes.map((change) => change.rowId), owned });
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: "UPDATE notes_fts_state SET generation = generation WHERE slot = 'active'" }] });
      for (const change of changes) {
        if (change.kind === 'removed') target.delete(change.rowId);
        else target.set(change.rowId, { id: change.rowId, ...(change.data ?? {}) });
      }
      return { counts: { documents: target.size } };
    },
    async rebuild(ctx) {
      const owned = probeOwned();
      calls.push({ op: 'rebuild', mode, owned });
      if (rebuilder) return rebuilder(ctx);
      const target = mode === 'shadow' ? shadow : active;
      const rows = ctx.reader.rows('Note');
      await ctx.index.write({
        expectedFence: ctx.fence,
        statements: [
          { sql: 'DELETE FROM notes_fts_document WHERE generation = ?', params: [ctx.generation] },
          ...rows.map((row) => ({
            sql: 'INSERT INTO notes_fts_document (generation, id, title, body) VALUES (?, ?, ?, ?)',
            params: [ctx.generation, row.id, row.title ?? null, row.body ?? null],
          })),
        ],
      });
      target.clear();
      for (const row of rows) target.set(String(row.id), { ...row });
      return { counts: { documents: target.size } };
    },
    search: (ctx) => {
      const activeGeneration = ctx.index.query({ sql: "SELECT generation FROM notes_fts_state WHERE slot = 'active'" })[0]?.generation;
      calls.push({ op: 'search', owned: probeOwned(), activeGeneration });
      return { hits: ctx.index.query({ sql: 'SELECT id FROM notes_fts_document WHERE generation = ? ORDER BY id', params: [activeGeneration] }) };
    },
    async beginShadow(ctx) {
      calls.push({ op: 'beginShadow', owned: probeOwned() });
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: "INSERT OR REPLACE INTO notes_fts_state (slot, generation) VALUES ('shadow', ?)", params: [ctx.generation] }] });
      shadow = new Map();
      shadowGeneration = ctx.generation;
      mode = 'shadow';
    },
    async commitShadow(ctx) {
      const owned = probeOwned();
      calls.push({ op: 'commitShadow', owned });
      if (commitFails) throw new Error('commitShadow failed (injected)');
      const result = await ctx.index.write({ expectedFence: ctx.fence, statements: [
        { sql: "INSERT OR REPLACE INTO notes_fts_state (slot, generation) SELECT 'prior', generation FROM notes_fts_state WHERE slot = 'active'" },
        { sql: "INSERT OR REPLACE INTO notes_fts_state (slot, generation) VALUES ('active', ?) ", params: [ctx.generation] },
      ] });
      if (result.changes === 0) throw new Error('fence moved before durable shadow activation');
      active = shadow;
      shadow = null;
      shadowGeneration = null;
      mode = 'active';
    },
    async rollbackShadow(ctx) {
      calls.push({ op: 'rollbackShadow', fence: ctx.fence, owned: probeOwned() });
      await ctx.index.write({ expectedFence: ctx.fence, statements: [{ sql: "UPDATE notes_fts_state SET generation = (SELECT generation FROM notes_fts_state WHERE slot = 'prior') WHERE slot = 'active'" }] });
      active = generationMap(db.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'active'").get().generation);
      mode = 'active';
    },
    async abortShadow(ctx) {
      calls.push({ op: 'abortShadow', owned: probeOwned() });
      await ctx.index.write({ expectedFence: ctx.fence, statements: [
        { sql: 'DELETE FROM notes_fts_document WHERE generation = ?', params: [shadowGeneration] },
        { sql: "DELETE FROM notes_fts_state WHERE slot = 'shadow'" },
      ] });
      shadow = null;
      shadowGeneration = null;
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
    setValidateFails(fails) {
      validateFails = fails;
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
export function makeFakeKit(db = null, { maxStatements = 128, maxRows = 10_000 } = {}) {
  const handle = db ?? new DatabaseSync(':memory:');
  if (db === null) {
    handle.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT); CREATE TABLE notes_fts_state (slot TEXT PRIMARY KEY, generation INTEGER NOT NULL); CREATE TABLE notes_fts_document (generation INTEGER NOT NULL, id TEXT NOT NULL, title TEXT, body TEXT, PRIMARY KEY (generation, id)); INSERT INTO notes_fts_state (slot, generation) VALUES ('active', 0);");
  }
  const owned = makeShadowIndexedPlugin({ db: handle });
  const registry = createSearchPluginRegistry();
  registry.register(owned.plugin);
  registry.bindSource(handle);
  const bridge = createSearchStalenessBridge({ registry, now: () => 't' });
  bridge.engage(handle);
  const queue = createWriteQueue();
  const hostCalls = [];
  let failIndexWriteAt = null;
  registry.bindIndex(() => ({
    query({ sql, params = [] }) {
      return handle.prepare(sql).all(...params);
    },
    async write({ expectedFence, statements }) {
      if (!Array.isArray(statements) || statements.length === 0 || statements.length > maxStatements) {
        throw new Error(`owned-index write requires 1 to ${maxStatements} statements`);
      }
      return queue.run(() => {
        if (registry.stateOf('notes-fts').fence !== expectedFence) return { changes: 0 };
        const before = Number(handle.prepare('SELECT total_changes() AS changes').get().changes);
        handle.exec('BEGIN');
        try {
          for (const [position, statement] of statements.entries()) {
            if (failIndexWriteAt === position + 1) {
              failIndexWriteAt = null;
              throw new Error(`owned-index write failed at statement ${position + 1} (injected)`);
            }
            hostCalls.push({ sql: statement.sql, owned: queue.owned });
            handle.prepare(statement.sql).run(...(statement.params ?? []));
            const changes = Number(handle.prepare('SELECT total_changes() AS changes').get().changes) - before;
            if (changes > maxRows) throw new Error(`owned-index write exceeds the ${maxRows}-row batch limit`);
          }
          handle.exec('COMMIT');
          return { changes: Number(handle.prepare('SELECT total_changes() AS changes').get().changes) - before };
        } catch (error) {
          handle.exec('ROLLBACK');
          throw error;
        }
      });
    },
  }));
  const engine = createSearchReconcileEngine({ registry, staleness: bridge, db: handle, writeQueue: queue, now: () => 't' });
  owned.setOwnedProbe(() => queue.owned);
  return {
    db: handle,
    registry,
    bridge,
    queue,
    engine,
    plugin: owned,
    hostCalls,
    setIndexWriteFailure(statement) {
      failIndexWriteAt = statement;
    },
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
        assert.equal(plugin.calls.some((call) => call.op === 'commitShadow' && call.owned === false), true);
        assert.equal(kit.hostCalls.some((call) => call.owned === true), true, 'owned-index statements execute inside the coordinator');

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
        const { db, registry, bridge, engine, plugin, hostCalls } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');

        // A healthy active generation is the baseline.
        const baseline = await engine.rebuildShadow('notes-fts');
        assert.equal(baseline.ok, true);
        const fenceAtStart = registry.stateOf('notes-fts').fence;
        const commitsBefore = plugin.calls.filter((call) => call.op === 'commitShadow').length;
        const activationStatementsBefore = hostCalls.filter((call) => call.sql.includes("'prior'") || call.sql.includes("VALUES ('active', ?)")).length;
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
        assert.equal(
          hostCalls.filter((call) => call.sql.includes("'prior'") || call.sql.includes("VALUES ('active', ?)")).length,
          activationStatementsBefore,
          'a moved fence admits neither durable promotion statement',
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
      name: 'parity requires a ready registry generation as well as matching census rows',
      async run(kit) {
        const { db, bridge, engine } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
        assert.equal((await engine.rebuildShadow('notes-fts')).ok, true);
        assert.equal(engine.parity('notes-fts').matches, true);

        bridge.notifySourceChange({
          entity: 'Note', rowId: 'n1', kind: 'updated', data: { id: 'n1', title: 'one' },
          committedAt: '2026-08-15T00:00:00.000Z',
        });
        const report = engine.parity('notes-fts');
        assert.equal(report.generation, 1);
        assert.equal(report.fence, 1);
        assert.equal(report.state, 'stale');
        assert.equal(report.matches, false, 'a stale generation cannot pass parity on census alone');
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
      name: 'a throwing validator aborts before generation promotion',
      async run(kit) {
        const { db, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
        assert.equal((await engine.rebuildShadow('notes-fts')).ok, true);

        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
        plugin.setValidateFails(true);
        const failed = await engine.rebuildShadow('notes-fts');

        assert.equal(failed.activated, false);
        assert.equal(plugin.calls.some((call) => call.op === 'abortShadow'), true);
        assert.deepEqual(plugin.index.content().map((row) => row.id), ['n1']);
        assert.equal(kit.registry.stateOf('notes-fts').generation, 1, 'the failed validator did not consume a generation');
      },
    },
    {
      name: 'a rejected registry stamp rolls back a committed shadow and aborts it',
      async run(kit) {
        const { db, registry, bridge, queue, engine, plugin } = kit;
        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
        assert.equal((await engine.rebuildShadow('notes-fts')).ok, true);

        db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
        const rejectingRegistry = {
          ...registry,
          validate: async () => {
            bridge.notifySourceChange({
              entity: 'Note', rowId: 'n2', kind: 'created', data: { id: 'n2', title: 'two' },
              committedAt: '2026-08-15T00:00:00.000Z',
            });
            return { ok: false, lastError: null };
          },
        };
        const rejectingEngine = createSearchReconcileEngine({
          registry: rejectingRegistry,
          staleness: bridge,
          db,
          writeQueue: queue,
          now: () => 't',
        });
        const failed = await rejectingEngine.rebuildShadow('notes-fts');

        assert.equal(failed.activated, false);
        assert.equal(plugin.calls.some((call) => call.op === 'rollbackShadow'), true);
        assert.equal(plugin.calls.some((call) => call.op === 'abortShadow'), true);
        assert.equal(plugin.calls.findLast((call) => call.op === 'rollbackShadow').fence, 1, 'rollback receives the registry fence moved by the failed stamp');
        assert.deepEqual(plugin.index.content().map((row) => row.id), ['n1']);
        assert.equal(db.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'active'").get().generation, 1, 'rollback restored the real prior durable generation pointer');
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
          assert.equal(call.owned, false, 'plugin callbacks stay outside the write coordinator');
        }
        assert.equal(registry.stateOf('notes-fts').state, 'ready');
      },
    },
    {
      name: 'an unknown durable ledger kind is retained rather than rebuilt',
      async run(kit) {
        const { bridge, db, engine, plugin } = kit;
        bridge.notifySourceChange({
          entity: 'Note', rowId: 'n1', kind: 'created', data: { id: 'n1' },
          committedAt: '2026-08-15T00:00:00.000Z',
        });
        db.prepare("UPDATE _SearchStaleness SET kind = 'corrupt-kind' WHERE sourceResource = 'Note' AND sourceKey = 'n1'").run();

        const summary = await engine.reconcileBatches();
        assert.equal(summary.processed, 0);
        assert.equal(summary.retained, 1);
        assert.match(summary.failures[0].error, /unknown kind/);
        assert.equal(bridge.pending().length, 1);
        assert.equal(plugin.calls.some((call) => call.op === 'rebuild'), false);
      },
    },
    {
      name: 'a restart discards an incomplete shadow and rebuilds the persisted source and pending ledger',
      async run() {
        const directory = mkdtempSync(join(tmpdir(), 'workbench-search-reconcile-'));
        const path = join(directory, 'search.sqlite');
        try {
          const firstDb = new DatabaseSync(path);
          firstDb.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT); CREATE TABLE notes_fts_state (slot TEXT PRIMARY KEY, generation INTEGER NOT NULL); CREATE TABLE notes_fts_document (generation INTEGER NOT NULL, id TEXT NOT NULL, title TEXT, body TEXT, PRIMARY KEY (generation, id)); INSERT INTO notes_fts_state (slot, generation) VALUES ('active', 0);");
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
            await second.registry.search('notes-fts', { query: {} });
            assert.equal(second.plugin.calls.at(-1).activeGeneration, 1, 'a fresh plugin instance reads the durable active generation');
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

test('rebuild refuses an index write beyond the owned capability row bound and rolls back the shadow', async () => {
  const kit = makeFakeKit(null, { maxRows: 1 });
  try {
    kit.db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    kit.db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');

    const outcome = await kit.engine.rebuildShadow('notes-fts');
    assert.equal(outcome.ok, false);
    assert.match(outcome.lastError, /batch limit/);
    assert.equal(kit.db.prepare('SELECT count(*) AS count FROM notes_fts_document').get().count, 0, 'the over-limit rebuild write was atomic');
    assert.equal(kit.db.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'active'").get().generation, 0, 'the active pointer was not promoted');
  } finally {
    await kit.close();
  }
});

test('rebuild refuses an index write beyond the owned capability statement bound', async () => {
  const kit = makeFakeKit(null, { maxStatements: 2 });
  try {
    kit.db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    kit.db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');

    const outcome = await kit.engine.rebuildShadow('notes-fts');
    assert.equal(outcome.ok, false);
    assert.match(outcome.lastError, /requires 1 to 2 statements/);
    assert.equal(kit.db.prepare('SELECT count(*) AS count FROM notes_fts_document').get().count, 0);
  } finally {
    await kit.close();
  }
});

test('a failed second promotion statement rolls back the whole durable activation batch', async () => {
  const kit = makeFakeKit();
  try {
    kit.db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    assert.equal((await kit.engine.rebuildShadow('notes-fts')).ok, true);
    kit.setIndexWriteFailure(2);

    const outcome = await kit.engine.rebuildShadow('notes-fts');
    assert.equal(outcome.ok, false);
    assert.equal(kit.db.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'active'").get().generation, 1);
    assert.equal(kit.db.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'prior'").get().generation, 0, 'the first promotion statement was rolled back too');
  } finally {
    await kit.close();
  }
});

test('an index-write failure retains the ledger while the committed source mutation survives', async () => {
  const kit = makeFakeKit();
  try {
    kit.db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    kit.bridge.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'created', data: { id: 'n1', title: 'one' },
      committedAt: '2026-08-15T00:00:00.000Z',
    });
    kit.setIndexWriteFailure(1);

    const summary = await kit.engine.reconcileBatches({ batchSize: 1 });
    assert.equal(summary.retained, 1);
    assert.equal(kit.db.prepare('SELECT title FROM Note WHERE id = ?').get('n1').title, 'one');
    assert.equal(kit.bridge.pending().length, 1, 'ledger deletion remains host-coordinated after plugin failure');
  } finally {
    await kit.close();
  }
});

test('a fresh plugin instance selects and serves the durable generation after activation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-search-reconcile-'));
  const path = join(directory, 'search.sqlite');
  try {
    const firstDb = new DatabaseSync(path);
    firstDb.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT); CREATE TABLE notes_fts_state (slot TEXT PRIMARY KEY, generation INTEGER NOT NULL); CREATE TABLE notes_fts_document (generation INTEGER NOT NULL, id TEXT NOT NULL, title TEXT, body TEXT, PRIMARY KEY (generation, id)); INSERT INTO notes_fts_state (slot, generation) VALUES ('active', 0);");
    const first = makeFakeKit(firstDb);
    firstDb.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    assert.equal((await first.engine.rebuildShadow('notes-fts')).ok, true);
    await first.close();

    const secondDb = new DatabaseSync(path);
    const second = makeFakeKit(secondDb);
    try {
      const search = await second.registry.search('notes-fts', { query: {} });
      assert.deepEqual(search.result.hits.map((hit) => ({ ...hit })), [{ id: 'n1' }]);
      assert.equal(second.plugin.calls.at(-1).activeGeneration, 1, 'the fresh instance selected durable generation 1');
    } finally {
      await second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a fresh plugin instance serves the restored durable generation after a failed stamp rollback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-search-reconcile-'));
  const path = join(directory, 'search.sqlite');
  try {
    const firstDb = new DatabaseSync(path);
    firstDb.exec("CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT); CREATE TABLE notes_fts_state (slot TEXT PRIMARY KEY, generation INTEGER NOT NULL); CREATE TABLE notes_fts_document (generation INTEGER NOT NULL, id TEXT NOT NULL, title TEXT, body TEXT, PRIMARY KEY (generation, id)); INSERT INTO notes_fts_state (slot, generation) VALUES ('active', 0);");
    const first = makeFakeKit(firstDb);
    firstDb.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    assert.equal((await first.engine.rebuildShadow('notes-fts')).ok, true);
    firstDb.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
    const rejectingEngine = createSearchReconcileEngine({
      registry: { ...first.registry, validate: async () => ({ ok: false, lastError: null }) },
      staleness: first.bridge,
      db: firstDb,
      writeQueue: first.queue,
      now: () => 't',
    });
    assert.equal((await rejectingEngine.rebuildShadow('notes-fts')).ok, false);
    assert.equal(firstDb.prepare("SELECT generation FROM notes_fts_state WHERE slot = 'active'").get().generation, 1);
    await first.close();

    const secondDb = new DatabaseSync(path);
    const second = makeFakeKit(secondDb);
    try {
      const search = await second.registry.search('notes-fts', { query: {} });
      assert.deepEqual(search.result.hits.map((hit) => ({ ...hit })), [{ id: 'n1' }]);
      assert.equal(second.plugin.calls.at(-1).activeGeneration, 1, 'the fresh instance served the restored generation');
    } finally {
      await second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('engine refuses to run without the application write queue', async () => {
  const kit = makeFakeKit();
  try {
    assert.throws(() => createSearchReconcileEngine({ registry: kit.registry, staleness: kit.bridge }), /requires the application write queue/);
  } finally {
    await kit.close();
  }
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
