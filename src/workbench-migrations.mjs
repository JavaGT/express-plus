// workbench-migrations.mjs — package-owned versioned migration lane.
//
// Sol ruling (issue JavaGT/scope#184, comment 5175490719): the authoring
// checkpoint deduplication must be performed by a versioned, idempotent
// migration owned by the Workbench package and run automatically from
// app.prepareSchema, backed by a PRIVATE ledger. The application-supplied
// `options.migrations` / `_Migration` lane is deliberately NOT reused: Scope
// passes an empty list, and sharing one integer namespace would risk duplicate
// version or skip collisions between package migrations and app migrations.
// Scope's own string-id schema lane (ScopeSchemaVersion / SCOPE_SCHEMA_MIGRATIONS)
// is untouched; this lane only reshapes Workbench-authored ephemeral tables.
//
// The single migration transaction is BEGIN EXCLUSIVE (this package's normal
// begin() uses BEGIN IMMEDIATE; exclusive is the binding requirement). Every
// per-prefix step and the version-record insert commit or roll back together.

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS _WorkbenchMigration (
  version INTEGER PRIMARY KEY,
  appliedAt TEXT NOT NULL
)`;

const PREFIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tableExists(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name));
}

function rebuildAuthoringFamily(db, prefix) {
  if (PREFIX_IDENTIFIER.test(prefix) === false) {
    throw new Error(`invalid authoring stream table prefix: ${prefix}`);
  }
  if (!tableExists(db, `${prefix}_authoring_stream`) || !tableExists(db, `${prefix}_authoring_lease`)) {
    throw new Error(`incomplete authoring stream table family: ${prefix}`);
  }
  // A canonical family (already the post-dedup shape) must be skipped, not
  // rebuilt: the migration is a legacy-shape upgrader and a fresh DB's data
  // must survive v1 untouched.
  const positionColumns = new Set(
    db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name)
  );
  const hasCanonicalPosition = positionColumns.has('checkpoint_id') && !positionColumns.has('family_checkpoint');
  if (hasCanonicalPosition) return;
  // Fail-closed validation: a legacy family must be complete before any clear
  // or rebuild. A partial/unrecognized family is refused and rolls back, rather
  // than being silently reconstructed. The checkpoint table is NOT required for
  // the legacy shape — the whole point of this migration is to create it.
  const required = ['snapshot_position', 'split', 'snapshot', 'group', 'position'];
  const missing = required.filter((table) => !tableExists(db, `${prefix}_authoring_${table}`));
  if (missing.length > 0) {
    throw new Error(`incomplete authoring stream table family: ${prefix} missing ${missing.join(', ')}`);
  }
  // Dependent ephemeral rows first. The lease owns every authoring row; the
  // snapshot/split/group/position rows reference leases, positions, snapshots
  // and checkpoints — clear in dependency-safe order, then rebuild.
  for (const table of ['snapshot_position', 'split', 'snapshot', 'group', 'position', 'checkpoint']) {
    if (tableExists(db, `${prefix}_authoring_${table}`)) {
      db.exec(`DELETE FROM ${prefix}_authoring_${table}`);
    }
  }
  // Drop child tables referencing position/snapshot before the parents.
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_snapshot_position`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_split`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_snapshot`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_group`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_position`);
  db.exec(`DROP TABLE IF EXISTS ${prefix}_authoring_checkpoint`);
  // Recreate the canonical shape: checkpoint holds the payload once, position
  // references it. The lease table is preserved so clients re-bootstrap.
  db.exec(
    `CREATE TABLE ${prefix}_authoring_checkpoint (
       id TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       family_checkpoint TEXT NOT NULL CHECK (json_valid(family_checkpoint)),
       created_at TEXT NOT NULL,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE
     );
     CREATE TABLE ${prefix}_authoring_position (
       token TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       issued_fence INTEGER NOT NULL,
       block_id TEXT,
       checkpoint_id TEXT NOT NULL,
       visible_at_issue INTEGER NOT NULL DEFAULT 1,
       redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions)),
       created_at TEXT NOT NULL,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE,
       FOREIGN KEY (checkpoint_id) REFERENCES ${prefix}_authoring_checkpoint(id) ON DELETE RESTRICT
     );
     CREATE INDEX idx_${prefix}_authoring_position_lease ON ${prefix}_authoring_position (lease_id, issued_fence);
     CREATE TABLE ${prefix}_authoring_snapshot (
       id TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       fence INTEGER NOT NULL,
       issued_at TEXT NOT NULL,
       acknowledged_at TEXT,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE
     );
     CREATE INDEX idx_${prefix}_authoring_snapshot_lease ON ${prefix}_authoring_snapshot (lease_id, fence);
     CREATE TABLE ${prefix}_authoring_group (
       token TEXT PRIMARY KEY,
       lease_id TEXT NOT NULL,
       issued_fence INTEGER NOT NULL,
       group_id TEXT,
       visible_blocks TEXT NOT NULL CHECK (json_valid(visible_blocks)),
       assignable INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE
     );
     CREATE INDEX idx_${prefix}_authoring_group_lease ON ${prefix}_authoring_group (lease_id, issued_fence);
     CREATE TABLE ${prefix}_authoring_snapshot_position (
       snapshot_id TEXT NOT NULL,
       position_token TEXT NOT NULL,
       PRIMARY KEY (snapshot_id, position_token),
       FOREIGN KEY (snapshot_id) REFERENCES ${prefix}_authoring_snapshot(id) ON DELETE CASCADE,
       FOREIGN KEY (position_token) REFERENCES ${prefix}_authoring_position(token) ON DELETE CASCADE
     );
     CREATE INDEX idx_${prefix}_authoring_snapshot_position_token ON ${prefix}_authoring_snapshot_position (position_token, snapshot_id);
     CREATE TABLE ${prefix}_authoring_split (
       lease_id TEXT NOT NULL,
       temporary_block TEXT NOT NULL,
       authoritative_block_id TEXT NOT NULL,
       position_token TEXT NOT NULL,
       action_id TEXT NOT NULL,
       mutation_id TEXT NOT NULL,
       fence INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (lease_id, temporary_block),
       UNIQUE (lease_id, action_id, temporary_block),
       FOREIGN KEY (lease_id) REFERENCES ${prefix}_authoring_lease(id) ON DELETE CASCADE
     );`
  );
}

export const WORKBENCH_MIGRATIONS = Object.freeze([
  {
    version: 1,
    transaction: 'exclusive',
    up(db, { now = () => new Date().toISOString() } = {}) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const name = row.name;
        if (!name.endsWith('_authoring_position')) continue;
        const prefix = name.slice(0, -'_authoring_position'.length);
        rebuildAuthoringFamily(db, prefix);
      }
    },
  },
  {
    // v2: purge authoring state produced by the defective pre-issue defect
    // (checkpointId footgun). A split-created right-block frame could inherit
    // the source position's checkpoint while carrying the post-split family,
    // leaving positions that resolve to the wrong family checkpoint and leases
    // whose retained bytes undercount checkpoint row metadata. Durable document
    // state and the committed log are untouched: clients re-bootstrap recovery
    // authoritative tokens for the same document, exactly as v1 does after its
    // legacy rebuild.
    version: 2,
    transaction: 'exclusive',
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_lease'").all()) {
        const name = row.name;
        if (!name.endsWith('_authoring_lease')) continue;
        const prefix = name.slice(0, -'_authoring_lease'.length);
        if (PREFIX_IDENTIFIER.test(prefix) === false) {
          throw new Error(`invalid authoring stream table prefix: ${prefix}`);
        }
        const required = ['stream', 'snapshot_position', 'snapshot', 'position', 'checkpoint'];
        const missing = required.filter((table) => !tableExists(db, `${prefix}_authoring_${table}`));
        if (missing.length > 0) {
          throw new Error(`incomplete authoring stream table family: ${prefix} missing ${missing.join(', ')}`);
        }
        // Invalidate the whole ephemeral family once, child-first. Removing
        // streams cascades leases after every lease-owned row is already gone.
        for (const table of ['snapshot_position', 'snapshot', 'position', 'checkpoint']) {
          db.exec(`DELETE FROM ${prefix}_authoring_${table}`);
        }
        db.exec(`DELETE FROM ${prefix}_authoring_stream`);
      }
    },
  },
  {
    // v3: bind redaction-aware public offsets to their canonical intervals.
    version: 3,
    transaction: 'exclusive',
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${row.name})`).all().map((column) => column.name));
        if (!columns.has('redactions')) db.exec(`ALTER TABLE ${row.name} ADD COLUMN redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions))`);
      }
    },
  },
]);

export function ensureWorkbenchMigrationTable(db) {
  db.exec(LEDGER_DDL);
}

export function appliedWorkbenchVersion(db) {
  ensureWorkbenchMigrationTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM _WorkbenchMigration').get();
  return row?.v ?? 0;
}

export function runWorkbenchMigrations(db, { now = () => new Date().toISOString() } = {}) {
  // Read-only pre-flight: avoid opening the exclusive transaction when the
  // ledger already records every migration. This never creates the table, so
  // a fresh DB (no ledger, no migration work) takes the same early return.
  const hasLedger = tableExists(db, '_WorkbenchMigration');
  if (hasLedger) {
    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM _WorkbenchMigration').get().v;
    if (WORKBENCH_MIGRATIONS.every((migration) => migration.version <= current)) return;
  }
  // One exclusive transaction for the entire lane: ledger creation, version
  // read, every migration's rebuild, and the version-record insert commit or
  // roll back together (Sol ruling 5175490719).
  db.exec('BEGIN EXCLUSIVE');
  try {
    ensureWorkbenchMigrationTable(db);
    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM _WorkbenchMigration').get().v;
    for (const migration of WORKBENCH_MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(db, { now });
      db.prepare('INSERT INTO _WorkbenchMigration (version, appliedAt) VALUES (?, ?)').run(migration.version, now());
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already unusable */ }
    throw error;
  }
}
