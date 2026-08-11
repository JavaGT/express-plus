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

import { exclusiveTxn, type DbHandle } from './driver.ts';
import { restoreTextFamily, serializeCompactTextFamilyCheckpoint } from './annotated-text-continuous.ts';

function tableExists(db: DbHandle, name: string) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name));
}

function rebuildAuthoringFamily(db: DbHandle, prefix: string) {
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
    db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name as string)
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
     CREATE TABLE ${prefix}_authoring_snapshot_position (
       snapshot_id TEXT NOT NULL,
       position_token TEXT NOT NULL,
       PRIMARY KEY (snapshot_id, position_token),
       FOREIGN KEY (snapshot_id) REFERENCES ${prefix}_authoring_snapshot(id) ON DELETE CASCADE,
       FOREIGN KEY (position_token) REFERENCES ${prefix}_authoring_position(token) ON DELETE CASCADE
     );
     CREATE INDEX idx_${prefix}_authoring_snapshot_position_token ON ${prefix}_authoring_snapshot_position (position_token, snapshot_id);`
  );
}

// v4: annotated-text `_membership` tables move from annotation_id PRIMARY KEY
// (one row per annotation) to PRIMARY KEY (annotation_id, start_point) so an
// exclusive 'one'-cardinality apply can store a trimmed annotation's left and
// right remnants as separate rows. A canonical family is skipped untouched;
// a legacy shape is rebuilt and its rows copied over (each annotation has one
// row today, so the composite key introduces no duplicate collision).
function rebuildMembershipFamily(db: DbHandle, prefix: string) {
  if (PREFIX_IDENTIFIER.test(prefix) === false) {
    throw new Error(`invalid annotated-text membership table prefix: ${prefix}`);
  }
  if (!tableExists(db, `${prefix}_membership`) || !tableExists(db, `${prefix}_annotation`)) {
    throw new Error(`incomplete annotated-text table family: ${prefix}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${prefix}_membership)`).all().map((r) => ({ name: r.name as string, pk: r.pk as number }));
  const pkColumns = columns.filter((c) => c.pk > 0).map((c) => c.name);
  if (columns.some((column) => column.name === 'range_id') && columns.some((column) => column.name === 'ordinal')) return;
  const hasCanonicalShape = pkColumns.length === 2 && pkColumns.includes('annotation_id') && pkColumns.includes('start_point');
  if (hasCanonicalShape) return;
  if (pkColumns.length !== 1 || pkColumns[0] !== 'annotation_id') {
    throw new Error(`unrecognized annotated-text membership table shape: ${prefix}`);
  }
  const tmp = `${prefix}_membership_v4`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(`CREATE TABLE ${tmp} (
    annotation_id TEXT NOT NULL,
    start_point TEXT NOT NULL CHECK (json_valid(start_point)),
    end_point TEXT NOT NULL CHECK (json_valid(end_point)),
    PRIMARY KEY (annotation_id, start_point),
    FOREIGN KEY (annotation_id) REFERENCES ${prefix}_annotation(id) ON DELETE CASCADE
  )`);
  db.exec(`INSERT INTO ${tmp} (annotation_id, start_point, end_point) SELECT annotation_id, start_point, end_point FROM ${prefix}_membership`);
  db.exec(`DROP TABLE ${prefix}_membership`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${prefix}_membership`);
}

type WorkbenchMigration = {
  version: number;
  transaction: 'exclusive';
  up(db: DbHandle, context?: { now?: () => string }): void;
};

export const WORKBENCH_MIGRATIONS: readonly WorkbenchMigration[] = Object.freeze([
  {
    version: 1,
    transaction: 'exclusive',
    up(db, { now = () => new Date().toISOString() } = {}) {
      void now;
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const name = row.name as string;
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
        const name = row.name as string;
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
        const name = row.name as string;
        const columns = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name as string));
        if (!columns.has('redactions')) db.exec(`ALTER TABLE ${row.name} ADD COLUMN redactions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(redactions))`);
      }
    },
  },
  {
    // v4: rebuild annotated-text `_membership` tables from the legacy one-row-per-
    // annotation shape (annotation_id PRIMARY KEY) to a composite
    // (annotation_id, start_point) primary key so an exclusive 'one'-cardinality
    // apply can persist a trimmed annotation's left AND right remnants as
    // multiple rows. The DDL emits the canonical shape for fresh databases; this
    // migration only reshapes legacy tables and copies their existing rows
    // (one per annotation today) over unchanged.
    version: 4,
    transaction: 'exclusive',
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_membership'").all()) {
        const name = row.name as string;
        if (!name.endsWith('_membership')) continue;
        rebuildMembershipFamily(db, name.slice(0, -'_membership'.length));
      }
    },
  },
  {
    // v5: position frames only need a compact immutable frontier basis; the
    // previous ephemeral rows retained a complete CRDT checkpoint per edit.
    // Purge those frames so connected clients re-bootstrap, then compact each
    // durable continuous-text checkpoint to the operation-registry v2 form.
    // Historical committed events are intentionally untouched.
    version: 5,
    transaction: 'exclusive',
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_lease'").all()) {
        const name = row.name as string;
        const prefix = name.slice(0, -'_authoring_lease'.length);
        if (!PREFIX_IDENTIFIER.test(prefix)) throw new Error(`invalid authoring stream table prefix: ${prefix}`);
        for (const table of ['snapshot_position', 'snapshot', 'position', 'checkpoint']) {
          if (tableExists(db, `${prefix}_authoring_${table}`)) db.exec(`DELETE FROM ${prefix}_authoring_${table}`);
        }
        if (tableExists(db, `${prefix}_authoring_stream`)) db.exec(`DELETE FROM ${prefix}_authoring_stream`);

        const stateTable = `${prefix}_state`;
        if (!tableExists(db, stateTable)) continue;
        const select = db.prepare(`SELECT document_id, family_checkpoint FROM ${stateTable}`);
        const update = db.prepare(`UPDATE ${stateTable} SET family_checkpoint = ? WHERE document_id = ?`);
        for (const state of select.all()) {
          const raw = JSON.parse(state.family_checkpoint as string);
          // Legacy block families contain a `blocks` member and are owned by
          // their older migration lane; only blockless continuous families are
          // compacted here.
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.hasOwn(raw, 'blocks')) continue;
          update.run(serializeCompactTextFamilyCheckpoint(restoreTextFamily(raw)), state.document_id);
        }
      }
    },
  },
]);

export function ensureWorkbenchMigrationTable(db: DbHandle) {
  db.exec(LEDGER_DDL);
}

export function appliedWorkbenchVersion(db: DbHandle): number {
  ensureWorkbenchMigrationTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM _WorkbenchMigration').get() as { v?: number } | undefined;
  return row?.v ?? 0;
}

export function runWorkbenchMigrations(db: DbHandle, { now = () => new Date().toISOString() }: { now?: () => string } = {}) {
  // Read-only pre-flight: avoid opening the exclusive transaction when the
  // ledger already records every migration. This never creates the table, so
  // a fresh DB (no ledger, no migration work) takes the same early return.
  const hasLedger = tableExists(db, '_WorkbenchMigration');
  if (hasLedger) {
    const current = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM _WorkbenchMigration').get() as { v: number }).v;
    if (WORKBENCH_MIGRATIONS.every((migration) => migration.version <= current)) return;
  }
  // One exclusive transaction for the entire lane: ledger creation, version
  // read, every migration's rebuild, and the version-record insert commit or
  // roll back together (Sol ruling 5175490719). exclusiveTxn owns the
  // BEGIN EXCLUSIVE / COMMIT / ROLLBACK bracket; the lane's work is the body.
  // Synchronous: the migration lane's body has no awaits.
  exclusiveTxn(db, () => {
    ensureWorkbenchMigrationTable(db);
    const current = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM _WorkbenchMigration').get() as { v: number }).v;
    for (const migration of WORKBENCH_MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.up(db, { now });
      db.prepare('INSERT INTO _WorkbenchMigration (version, appliedAt) VALUES (?, ?)').run(migration.version, now());
    }
  });
}
