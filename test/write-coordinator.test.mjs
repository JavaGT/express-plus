// write-coordinator.test.mjs — the platform write-coordinator red-line (epic
// scope#23, S1/A5).
//
// ONE coordinator owns every platform write (entity, live-state, operational
// queue, plugin index, migration, blob metadata). Two documented exceptions —
// the job-queue's single-statement UPDATE/INSERT…RETURNING claim/result
// writes, and the migrations stop-the-world boot transaction — are explicitly
// NOT a second mutex. This suite proves:
//   1. no module outside driver.ts (+ the documented migrations boot phase and
//      the directory-lock sidecar) issues BEGIN/COMMIT literals, with
//      SAVEPOINT/ROLLBACK TO/RELEASE and CREATE TRIGGER bodies excluded;
//   2. entity, live-state, and plugin-index writes all enter through the one
//      coordinator (observed owned during a dispatch);
//   3. job-queue single-statement + migrations boot-phase exceptions hold;
//   4. blob metadata enters through the caller's coordinated transaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import workbench, {
  entity,
  everyone,
  executeDDL,
  executeFrameworkDDL,
  grant,
  map,
  read,
  ref,
  scope,
  text,
  write,
} from '../build/internal.mjs';
import { createBlobStore } from '../build/blob-store.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ---- static audit helpers -------------------------------------------------

function walkTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkTs(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

// Transaction-control literals issued via exec/prepare on a connection. The
// literal must be the statement's leading keyword. SAVEPOINT/RELEASE never
// match; ROLLBACK TO (savepoint rollback) is excluded after matching.
const TRANSACTION_LITERAL = /(?:exec|prepare)\s*\(\s*[`'"]\s*(BEGIN|COMMIT|ROLLBACK)\b([^`'"]*)/g;

// Allowed modules: driver.ts (the transaction authority), migrations.ts (the
// documented stop-the-world boot lane — uses the driver dispatchers), and
// directory-lock.ts (the sidecar ownership lock database, which holds a
// BEGIN EXCLUSIVE but NEVER COMMITs — not a data-connection transaction).
const TRANSACTION_ALLOWLIST = new Set([
  join(SRC, 'driver.ts'),
  join(SRC, 'migrations.ts'),
  join(SRC, 'directory-lock.ts'),
]);

function transactionLiteralHits(file) {
  const source = stripTsComments(readFileSync(file, 'utf8'));
  const hits = [];
  for (const match of source.matchAll(TRANSACTION_LITERAL)) {
    const line = source.slice(0, match.index).split('\n').length;
    const literal = match[1];
    const rest = match[2] ?? '';
    if (literal === 'ROLLBACK' && /\bTO\b/i.test(rest)) continue; // savepoint rollback — excluded
    hits.push({ line, literal, raw: match[0] });
  }
  return hits;
}

test('transaction-control audit: BEGIN/COMMIT literals live only in the authority + documented exceptions', () => {
  const violations = [];
  const perModule = new Map();
  for (const file of walkTs(SRC)) {
    const hits = transactionLiteralHits(file);
    if (hits.length === 0) continue;
    perModule.set(file, hits);
    if (!TRANSACTION_ALLOWLIST.has(file)) {
      violations.push({ file, hits });
    }
  }

  assert.deepEqual(
    violations.map((v) => v.file),
    [],
    `BEGIN/COMMIT literals outside driver.ts + the documented exceptions: ${JSON.stringify(violations)}`,
  );

  // The two documented single-writer exceptions are explicitly asserted:
  const jobQueue = join(SRC, 'job-queue.ts');
  assert.equal(perModule.has(jobQueue), false, 'job-queue.ts issues no transaction literals (single-statement claim/result)');
  const blobStore = join(SRC, 'blob-store.ts');
  assert.equal(perModule.has(blobStore), false, 'blob-store.ts issues no transaction literals (adopt runs in the caller\'s transaction)');

  // The exclusion proof:
  const savepointModule = join(SRC, 'annotated-text-authoring-stream.ts');
  assert.equal(perModule.has(savepointModule), false, 'savepoint module: only SAVEPOINT/ROLLBACK TO/RELEASE, excluded by the audit');
  const triggerModule = join(SRC, 'annotated-text-field.ts');
  assert.equal(perModule.has(triggerModule), false, 'trigger module: CREATE TRIGGER ... BEGIN ... END bodies, excluded by the audit');

  // The authority itself holds the literals, and the boot lane uses the
  // dispatchers (no literals of its own):
  assert.ok(perModule.has(join(SRC, 'driver.ts')), 'driver.ts is the transaction authority');
  assert.equal(perModule.has(join(SRC, 'migrations.ts')), false, 'migrations.ts uses begin/commit/rollback dispatchers, not literals');

  // directory-lock holds its exclusive lock on the sidecar lock db and never
  // COMMITs a data transaction:
  const lockHits = perModule.get(join(SRC, 'directory-lock.ts')) ?? [];
  assert.ok(lockHits.some((h) => h.literal === 'BEGIN'), 'directory-lock holds a BEGIN EXCLUSIVE');
  assert.ok(lockHits.every((h) => h.literal !== 'COMMIT'), 'directory-lock never issues COMMIT');
});

// Strip // and /* */ comments so a source-module mention of a forbidden toggle
// in prose does not count as issuing it. Only statements carry the toggle.
function stripTsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('a raw PRAGMA foreign_keys toggle exists only in driver.ts', () => {
  const violators = [];
  for (const file of walkTs(SRC)) {
    const source = stripTsComments(readFileSync(file, 'utf8'));
    if (/PRAGMA\s+foreign_keys/.test(source) && file !== join(SRC, 'driver.ts')) {
      violators.push(file);
    }
  }
  assert.deepEqual(violators, [], 'the shared-state foreign_keys toggle is the maintenance seam\'s, and only driver.ts declares it');
});

// ---- coordinator routing (behavioral) -------------------------------------

function instrumentCoordinator(app) {
  const original = app.writeCoordinator.run.bind(app.writeCoordinator);
  const turns = [];
  app.writeCoordinator.run = (fn) => original(() => {
    turns.push({ owned: app.writeCoordinator.owned });
    return fn();
  });
  return turns;
}

function redlineApp() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec("CREATE TABLE User (id TEXT PRIMARY KEY); INSERT INTO User VALUES ('u1'), ('u2')");
  const Project = entity('RedlineProject', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Project, db);
  db.exec("INSERT INTO RedlineProject (id, owner) VALUES ('p1', 'u1')");
  const Doc = entity('RedlineDoc', {
    project: ref('RedlineProject', { physical: true }),
    owner: ref('User', { role: 'owner' }),
    title: text(),
    // A side-table strategy field: writes to RedlineDoc_collaborators via the
    // strategy projection inside the coordinated dispatch (plugin-index lane).
    collaborators: map(ref('User'), { role: ['editor'] }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
  executeDDL(Doc, db);
  const app = workbench({ db, entities: [Project, Doc] });
  return { db, app, Doc };
}

test('entity, live-state, and plugin-index writes enter through the one coordinator', async () => {
  const { db, app } = redlineApp();
  await app.start();
  await app.ready;

  const turns = instrumentCoordinator(app);
  const before = turns.length;

  const result = await app.dispatch({
    actionId: 'create', type: 'RedlineDoc.create',
    payload: { id: 'd1', project: 'p1', owner: 'u1', title: 'hello world' },
    principal: { id: 'u1' },
  });
  assert.equal(result.ok, true, result.failure?.message);

  const added = turns.slice(before);
  assert.ok(added.length > 0, 'the dispatch took at least one coordinated write turn');
  assert.ok(added.every((t) => t.owned === true), 'every write category ran inside the coordinator (owned)');

  // Entity write landed.
  assert.ok(db.prepare("SELECT 1 FROM RedlineDoc WHERE id = 'd1'").get(), 'entity row written');

  // Live-state write landed: the committed log is the platform\'s live
  // delivery substrate, appended inside the same coordinated dispatch.
  const logRow = db.prepare("SELECT * FROM _Log WHERE eventType = 'RedlineDoc.created'").get();
  assert.ok(logRow, 'committed-log (live-state) event written');

  // Plugin-index write landed: the map side-table strategy projection ran
  // inside a coordinated dispatch and wrote the membership side table.
  const memberAdd = await app.dispatch({
    actionId: 'member-add', type: 'RedlineDoc.collaborators.add',
    payload: { owner: 'd1', member: 'u2', role: 'editor' },
    principal: { id: 'u1' },
  });
  assert.equal(memberAdd.ok, true, memberAdd.failure?.message);
  const sideTableRow = db.prepare('SELECT * FROM RedlineDoc_collaborators').get();
  assert.ok(sideTableRow, 'plugin-index side table written');
  assert.equal(sideTableRow.RedlineDoc_id, 'd1');
  assert.equal(sideTableRow.member_id, 'u2');
  assert.ok(turns.length > added.length, 'the plugin-index write took its own coordinated turn');

  await app.shutdown();
  db.close();
});

test('job-queue claim/enqueue/result are the single-statement exception — no coordinator turn', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({ db, jobs: { sharedSecret: 'secret', pollIntervalMs: 9999 } });
  await app.prepareSchema();

  const turns = instrumentCoordinator(app);
  const before = turns.length;

  app.jobs.enqueue({ kind: 'k', payload: { x: 1 }, id: 'j1' });
  const claimed = app.jobs.claim('worker-1', { kind: 'k' });
  assert.equal(claimed?.id, 'j1');
  const submitted = app.jobs.submitResult('j1', 'worker-1', { status: 'completed', output: { done: true } });
  assert.equal(submitted.accepted, true);

  assert.equal(turns.length, before, 'the queue\'s single-statement writes take no coordinator turn — per-statement atomicity is the exception, not a second mutex');
  db.close();
});

test('migrations run as the stop-the-world boot lane — outside the coordinator', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    migrations: [{
      version: 1,
      up(d) {
        d.exec('CREATE TABLE boot_lane_migration (id INTEGER PRIMARY KEY)');
        d.exec('INSERT INTO boot_lane_migration VALUES (1)');
      },
    }],
  });

  const turns = instrumentCoordinator(app);
  await app.prepareSchema();
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'boot_lane_migration'").get(), 'the migration applied at boot');
  assert.equal(
    turns.length,
    0,
    'the boot migration lane does not take a coordinator turn — it runs stop-the-world before the app serves (documented exception)',
  );
  db.close();
});

test('a failing migration rolls back atomically — no partial boot state', async () => {
  const db = new DatabaseSync(':memory:');
  const app = workbench({
    db,
    migrations: [{
      version: 1,
      up(d) {
        d.exec('CREATE TABLE doomed_migration (id INTEGER PRIMARY KEY)');
        throw new Error('migration failed mid-way');
      },
    }],
  });
  await assert.rejects(() => app.prepareSchema(), /migration 1 failed/);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'doomed_migration'").get(),
    undefined,
    'the migration transaction rolled back the table it created before failing',
  );
  db.close();
});

test('blob metadata writes enter through the caller\'s coordinated transaction — never its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-blob-redline-'));
  try {
    const db = new DatabaseSync(':memory:');
    const store = createBlobStore({ db, root: dir });
    db.exec('CREATE TABLE BlobStore (id TEXT PRIMARY KEY, status TEXT)');
    db.prepare('INSERT INTO BlobStore (id, status) VALUES (?, ?)').run('b1', 'pending');

    const callerStatements = [];
    const callerHandle = {
      prepare(sql) {
        callerStatements.push(sql);
        return db.prepare(sql);
      },
    };

    const result = store.adopt(callerHandle, 'b1');
    assert.equal(result.adopted, 1, 'the adopt UPDATE landed');
    assert.ok(callerStatements.some((sql) => /UPDATE BlobStore SET status/.test(sql)), 'the metadata UPDATE went through the CALLER\'s handle (its coordinated transaction)');
    assert.ok(callerStatements.every((sql) => !/\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)), 'the caller handle received no transaction control from the blob store');

    const row = db.prepare("SELECT status FROM BlobStore WHERE id = 'b1'").get();
    assert.equal(row.status, 'adopted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
