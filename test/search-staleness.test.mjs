// search-staleness.test.mjs — the S4/A2 staleness + invalidation bridge.
//
// Covers the durable, coalescible, revocation-priority ledger (epic scope#23):
// post-commit firing for history + no-history tiers, restart-with-pending,
// coalescing (N notifications → one reconcile per source key), revocation/
// erasure priority ordering (protected content leaves results before 'ready' is
// claimed), the uncommitted-state guard, and the plugin-declared trigger census.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createSearchStalenessBridge, SEARCH_STALENESS_PRIORITY_HIGH, SEARCH_STALENESS_PRIORITY_ORDINARY } from '../build/search-staleness.mjs';
import { createSearchPluginRegistry, SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION } from '../build/search-plugin.mjs';
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { executeFrameworkDDL } from '../build/ddl.mjs';
import { createSqliteAdapter } from '../build/sqlite-adapter.mjs';
import workbench from '../build/app.mjs';
import { principal } from '../build/index.mjs';

// ---- helpers ---------------------------------------------------------------

function freshNoteDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, body TEXT);');
  return db;
}

// An indexed plugin over the Note source: rebuild re-reads the committed source
// through the scoped reader; reconcile applies the delivered changes. The
// in-memory `index` Map is what the red-line test asserts against.
function makeIndexedPlugin({ id = 'notes-fts', version = '1.0.0' } = {}) {
  const index = new Map();
  const calls = [];
  return {
    index,
    calls,
    plugin: {
      contractVersion: SUPPORTED_SEARCH_PLUGIN_CONTRACT_VERSION,
      id,
      version,
      ownedObjects: [
        { kind: 'virtual-table', name: 'notes_fts', ddl: ['CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title);'] },
      ],
      sourceInterests: [{ entity: 'Note' }],
      stalenessKey: (change) => (change.entity === 'Note' ? `${change.entity}:${change.rowId}` : null),
      prepare: () => {},
      validate: () => {},
      reconcile: (_ctx, changes) => {
        calls.push({ op: 'reconcile', rowIds: changes.map((change) => change.rowId) });
        for (const change of changes) {
          if (change.kind === 'removed') index.delete(change.rowId);
          else index.set(change.rowId, { id: change.rowId, ...(change.data ?? {}) });
        }
        return { counts: { documents: index.size } };
      },
      rebuild: (ctx) => {
        calls.push({ op: 'rebuild' });
        index.clear();
        for (const row of ctx.reader.rows('Note')) index.set(String(row.id), { ...row });
        return { counts: { documents: index.size } };
      },
      search: () => ({ hits: [...index.keys()].map((rowId) => ({ id: rowId })) }),
    },
  };
}

function setupBridge(db, { registry } = {}) {
  const plugin = makeIndexedPlugin();
  const searchRegistry = registry ?? createSearchPluginRegistry();
  searchRegistry.register(plugin.plugin);
  searchRegistry.bindSource(db);
  const bridge = createSearchStalenessBridge({ registry: searchRegistry, now: () => 't' });
  bridge.engage(db);
  return { plugin, searchRegistry, bridge };
}

// The post-commit consumer S3's plumbing will feed the bridge with: convert each
// committed event to a source change and notify. Mirrors the future kernel
// consumer (history-tier commits today; the no-history-tier path uses the same
// seam once S3/A2 lands).
function stalenessConsumer(bridge, { tier = 'history' } = {}) {
  return async (events) => {
    for (const event of events) {
      const entity = event.handle?.entity ?? String(event.scope).split(':')[0];
      const rowId = event.data?.id ?? String(event.scope).split(':')[1];
      if (!entity || !rowId) continue;
      bridge.notifySourceChange({
        entity,
        rowId,
        kind: String(event.type).split('.')[1] ?? 'updated',
        data: event.data ?? {},
        committedAt: event.committedAt,
        tier,
      });
    }
  };
}

function durableKernel(db, { postCommitConsumers = [] } = {}) {
  return createServer({
    handlers: {
      'Note.create': ({ payload }) => [{
        type: 'Note.created',
        scope: `Note:${payload.id}`,
        data: { id: payload.id, title: payload.title },
      }],
    },
    authorize: () => true,
    db,
    pipeline: durableMutationVariant({ postCommitConsumers }),
  });
}

// ---- post-commit firing for history + no-history tiers ----------------------

describe('staleness bridge — post-commit notification intake', () => {
  test('a history-tier committed dispatch fires a durable staleness record', async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    executeFrameworkDDL(db);
    const registry = createSearchPluginRegistry();
    registry.register(makeIndexedPlugin().plugin);
    const bridge = createSearchStalenessBridge({ registry });
    bridge.engage(db);

    // The real post-commit fan-out proves the history-tier path: dispatch a
    // commit and let the registered consumer notify the bridge post-commit.
    const kernel = durableKernel(db, { postCommitConsumers: [stalenessConsumer(bridge)] });

    const outcome = await kernel.dispatch({
      actionId: randomUUID(),
      type: 'Note.create',
      payload: { id: 'n1', title: 'hello' },
    });
    assert.equal(outcome.ok, true);

    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sourceResource, 'Note');
    assert.equal(pending[0].sourceKey, 'n1');
    assert.equal(pending[0].kind, 'source-change');
    assert.equal(pending[0].tier, 'history');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_ORDINARY);
    assert.deepEqual(pending[0].affected.map((a) => a.pluginId), ['notes-fts']);
  });

  test('a no-history-tier write yields a staleness record through the same seam', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    // S3/A2's no-history mutation path writes no _Log row; its post-commit
    // notification still flows through this same bridge seam with tier 'live'.
    const notice = bridge.notifySourceChange({
      entity: 'Note',
      rowId: 'n9',
      kind: 'updated',
      data: { title: 'live-write' },
      committedAt: '2026-08-15T00:00:00.000Z',
      tier: 'live',
    });
    assert.equal(notice.recorded, true);
    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tier, 'live');
    db.close();
  });

  test('a change for no indexed entity records nothing', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    const notice = bridge.notifySourceChange({
      entity: 'Other',
      rowId: 'o1',
      kind: 'created',
      committedAt: '2026-08-15T00:00:00.000Z',
    });
    assert.equal(notice.recorded, false);
    assert.equal(notice.affected, 0);
    assert.equal(bridge.pending().length, 0);
    db.close();
  });
});

// ---- uncommitted-state guard -----------------------------------------------

describe('staleness bridge — uncommitted-state guard', () => {
  test('a notification without committedAt is refused and records nothing', () => {
    const db = freshNoteDb();
    const { bridge } = setupBridge(db);
    assert.throws(
      () => bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'created' }),
      /committedAt/,
    );
    assert.equal(bridge.pending().length, 0);
    db.close();
  });

  test('a rolled-back dispatch fires no post-commit notification (no record)', async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    executeFrameworkDDL(db);
    const registry = createSearchPluginRegistry();
    registry.register(makeIndexedPlugin().plugin);
    const bridge = createSearchStalenessBridge({ registry });
    bridge.engage(db);

    const kernel = createServer({
      handlers: {
        'Note.create': ({ payload }) => [{
          type: 'Note.created',
          scope: `Note:${payload.id}`,
          data: { id: payload.id, title: payload.title },
        }],
      },
      authorize: async () => false,
      db,
      pipeline: durableMutationVariant({ postCommitConsumers: [stalenessConsumer(bridge)] }),
    });

    const outcome = await kernel.dispatch({
      actionId: randomUUID(),
      type: 'Note.create',
      payload: { id: 'n1', title: 'never' },
    });
    assert.equal(outcome.ok, false);
    // The dispatch rolled back: the post-commit consumer never ran, so no
    // staleness record exists for state that never committed.
    assert.equal(bridge.pending().length, 0);
    const logRows = db.prepare('SELECT * FROM _Log').all();
    assert.equal(logRows.length, 0);
  });
});

// ---- coalescing -------------------------------------------------------------

describe('staleness bridge — coalescing', () => {
  test('N notifications for one source key collapse to one record and one reconcile', async () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);

    for (let i = 0; i < 3; i += 1) {
      bridge.notifySourceChange({
        entity: 'Note',
        rowId: 'n1',
        kind: 'updated',
        data: { title: `version-${i}` },
        committedAt: `2026-08-15T00:00:0${i}.000Z`,
      });
    }

    const pending = bridge.pending();
    assert.equal(pending.length, 1, 'three notifications for one key → one record');
    assert.equal(pending[0].sourceResource, 'Note');
    assert.equal(pending[0].sourceKey, 'n1');

    const summary = await bridge.drain();
    assert.equal(summary.processed, 1);
    // Coalescing acceptance: N notifications → exactly one reconcile.
    const reconciles = plugin.calls.filter((call) => call.op === 'reconcile');
    assert.equal(reconciles.length, 1);
    assert.deepEqual(reconciles[0].rowIds, ['n1']);
    assert.equal(bridge.pending().length, 0);
    // The reconcile received the NEWEST change data.
    assert.equal(plugin.index.get('n1').title, 'version-2');
    db.close();
  });
});

// ---- durability: restart with pending ---------------------------------------

describe('staleness bridge — restart with pending staleness', () => {
  test('pending records survive restart and re-process through a fresh bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-staleness-restart-'));
    const dataPath = join(root, 'app.db');
    try {
      let db = new DatabaseSync(dataPath);
      const first = setupBridge(db);
      first.bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'created', data: { title: 'one' }, committedAt: '2026-08-15T00:00:00.000Z' });
      first.bridge.notifySourceChange({ entity: 'Note', rowId: 'n2', kind: 'created', data: { title: 'two' }, committedAt: '2026-08-15T00:00:01.000Z' });
      assert.equal(first.bridge.pending().length, 2);
      db.close();

      // "Restart": a fresh handle + fresh registry + fresh bridge over the
      // same database. The durable ledger carries the pending set forward.
      db = new DatabaseSync(dataPath);
      const second = setupBridge(db);
      const pending = second.bridge.pending();
      assert.equal(pending.length, 2, 'pending staleness survives restart');
      const summary = await second.bridge.drain();
      assert.equal(summary.processed, 2);
      assert.equal(summary.retained, 0);
      assert.equal(second.bridge.pending().length, 0);
      assert.deepEqual(
        [...second.plugin.index.keys()].sort(),
        ['n1', 'n2'],
        'no missed source changes after restart',
      );
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- revocation / erasure priority ------------------------------------------

describe('staleness bridge — revocation and erasure priority', () => {
  test('a revocation drains before an ordinary reconcile', async () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
    const { plugin, bridge, searchRegistry } = setupBridge(db);
    // Materialize so the plugin is 'ready' before invalidation arrives.
    await searchRegistry.rebuild('notes-fts');
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'ready');

    // Ordinary source change first, then an access revocation.
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'updated', committedAt: '2026-08-15T00:00:00.000Z' });
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'entity', key: 'Note:n2' });

    const pending = bridge.pending();
    assert.equal(pending.length, 2);
    const revocation = pending.find((record) => record.kind === 'revocation');
    assert.ok(revocation);
    assert.equal(revocation.priority, SEARCH_STALENESS_PRIORITY_HIGH, 'revocation is the high-priority channel');

    // Before drain, the plugin is stale — never fresh with a pending revocation.
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'stale');

    await bridge.drain();

    const rebuildIndex = plugin.calls.findIndex((call) => call.op === 'rebuild');
    const reconcileIndex = plugin.calls.findIndex((call) => call.op === 'reconcile');
    assert.ok(rebuildIndex !== -1, 'a revocation triggers a rebuild');
    assert.ok(rebuildIndex < reconcileIndex, 'revocation rebuild runs BEFORE ordinary reconcile');
    db.close();
  });

  test('red-line: erased content leaves results before ready is claimed', async () => {
    const db = freshNoteDb();
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n1', 'one');
    db.prepare('INSERT INTO Note (id, title) VALUES (?, ?)').run('n2', 'two');
    const { plugin, bridge, searchRegistry } = setupBridge(db);

    // Materialize a healthy index over the committed source.
    await searchRegistry.rebuild('notes-fts');
    assert.deepEqual([...plugin.index.keys()].sort(), ['n1', 'n2']);
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'ready');

    // The source row is ERASED (committed removal) and an ordinary change for
    // another key is also pending.
    db.prepare('DELETE FROM Note WHERE id = ?').run('n2');
    bridge.notifySourceChange({ entity: 'Note', rowId: 'n1', kind: 'updated', data: { title: 'one-updated' }, committedAt: '2026-08-15T00:00:00.000Z' });
    bridge.notifySourceChange({
      entity: 'Note', rowId: 'n2', kind: 'removed', committedAt: '2026-08-15T00:00:01.000Z', erasure: true,
    });

    // Immediately after the invalidation the plugin is stale (fence bumped) —
    // 'ready'/'fresh' is NOT claimed while protected content is still pending.
    const stateBeforeDrain = searchRegistry.stateOf('notes-fts');
    assert.equal(stateBeforeDrain.state, 'stale');

    const summary = await bridge.drain();
    assert.equal(summary.rebuilt, 1, 'the erasure record rebuilds the index');
    assert.equal(summary.reconciled, 1);
    assert.equal(summary.retained, 0);

    // Protected (erased) content has left the plugin's results, and ready is
    // only claimed afterwards.
    assert.equal(plugin.index.has('n2'), false, 'erased content is gone from the index');
    assert.ok(plugin.index.has('n1'), 'unaffected content remains');
    assert.equal(searchRegistry.stateOf('notes-fts').state, 'ready');
    db.close();
  });

  test('a principal revocation queues a high-priority rebuild for every plugin', () => {
    const db = freshNoteDb();
    const { plugin, bridge } = setupBridge(db);
    bridge.onRevocation(principal({ type: 'user', id: 'u1' }), { category: 'principal', key: 'user:u1' });
    const pending = bridge.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'revocation');
    assert.equal(pending[0].priority, SEARCH_STALENESS_PRIORITY_HIGH);
    assert.equal(pending[0].sourceResource, '$principal');
    assert.deepEqual(pending[0].affected.map((a) => a.pluginId), [plugin.plugin.id]);
    db.close();
  });
});

// ---- app wiring --------------------------------------------------------------

describe('app.searchStaleness surface', () => {
  test('a raw-handle app registers the bridge and engages it with the db', () => {
    const db = freshNoteDb();
    const app = workbench({ db });
    assert.ok(app.searchStaleness, 'the bridge is registered on the app');
    app.searchStaleness.engage(db);
    const notice = app.searchStaleness.notifySourceChange({
      entity: 'Note', rowId: 'n1', kind: 'created', committedAt: '2026-08-15T00:00:00.000Z',
    });
    assert.equal(notice.recorded, false, 'no plugins registered yet — nothing recorded');
    db.close();
  });

  test('a deferred-adapter app engages the bridge after the open lands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-staleness-deferred-'));
    try {
      const app = workbench({ db: createSqliteAdapter({ directory: join(root, 'owned'), name: 'app', mode: 'file' }) });
      try {
        await app.ready;
        assert.ok(app.db, 'awaiting ready installed the deferred handle');
        assert.equal(app.searchStaleness.tableName, '_SearchStaleness');
        // First ledger use materializes the durable table in the app database.
        assert.deepEqual(app.searchStaleness.pending(), []);
        const names = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_SearchStaleness'").all();
        assert.equal(names.length, 1);
      } finally {
        await app.shutdown();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- plugin-declared trigger census ------------------------------------------

describe('staleness bridge — plugin-declared trigger census', () => {
  test('the bridge installs no triggers; plugin-declared triggers are the census', () => {
    const db = freshNoteDb();
    const plugin = makeIndexedPlugin();
    plugin.plugin.ownedObjects = [
      {
        kind: 'trigger',
        name: 'notes_fts_maintain',
        ddl: [
          'CREATE TRIGGER IF NOT EXISTS notes_fts_maintain AFTER INSERT ON Note BEGIN INSERT INTO notes_fts(rowid, title) VALUES (new.id, new.title); END',
        ],
      },
    ];
    const registry = createSearchPluginRegistry();
    registry.register(plugin.plugin);
    const bridge = createSearchStalenessBridge({ registry });
    bridge.engage(db);

    // The bridge's own DDL is a pure table ledger — no trigger on any source
    // table, Workbench-issued invalidations preferred (consideration #7).
    const ddl = bridge.stalenessDdl();
    assert.ok(!/trigger/i.test(ddl), 'the staleness ledger installs no triggers');

    const triggers = bridge.triggerCensus();
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].pluginId, 'notes-fts');
    assert.equal(triggers[0].name, 'notes_fts_maintain');
    assert.equal(triggers[0].ddl.length, 1);
    assert.match(triggers[0].ddl[0], /CREATE TRIGGER/);
    db.close();
  });
});
