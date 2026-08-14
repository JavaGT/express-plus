// workbench-migrations.mjs — package-owned migration lane, re-homed into the
// reserved `workbench` namespace of the shared namespaced ledger (S2/A4,
// workbench#90).
//
// Sol ruling (issue JavaGT/scope#184, comment 5175490719): the authoring
// checkpoint deduplication must be performed by a versioned, idempotent
// migration owned by the Workbench package and run automatically from
// app.prepareSchema. The application-supplied migration lane is NOT reused:
// Scope passes an empty list, and the `workbench` namespace is package-owned
// (reserved), so no app migration can impersonate this lane. The whole lane
// runs inside ONE BEGIN EXCLUSIVE transaction — a failure rolls every
// migration of the lane back together (no partial lane state), matching the
// Sol ruling. Each `up` remains safe to re-apply against a rolled-back state
// and to run against an already-canonical schema (fresh DBs emit the canonical
// shape, so v1/v4 skip; v2/v3/v5 detect and skip or no-op).

import {
  runLedgerMigrations,
  ensureMigrationTable,
  ledgerRows,


} from './migration-ledger.mjs';

import { restoreTextFamily, serializeCompactTextFamilyCheckpoint } from './annotated-text-continuous.mjs';

// The package version that supplies the lane, recorded per ledger row. Keep in
// sync with package.json when releasing.
const WORKBENCH_PACKAGE_VERSION = '0.1.2';
export const WORKBENCH_SUPPLIED_BY = `workbench@${WORKBENCH_PACKAGE_VERSION}`;

const PREFIX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tableExists(db          , name        ) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name));
}

function rebuildAuthoringFamily(db          , prefix        ) {
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
    db.prepare(`PRAGMA table_info(${prefix}_authoring_position)`).all().map((r) => r.name          )
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
function rebuildMembershipFamily(db          , prefix        ) {
  if (PREFIX_IDENTIFIER.test(prefix) === false) {
    throw new Error(`invalid annotated-text membership table prefix: ${prefix}`);
  }
  if (!tableExists(db, `${prefix}_membership`) || !tableExists(db, `${prefix}_annotation`)) {
    throw new Error(`incomplete annotated-text table family: ${prefix}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${prefix}_membership)`).all().map((r) => ({ name: r.name          , pk: r.pk           }));
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

export const WORKBENCH_MIGRATIONS                       = Object.freeze([
  {
    namespace: 'workbench',
    name: 'authoring-stream-family-rebuild',
    version: 1,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const name = row.name          ;
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
    namespace: 'workbench',
    name: 'authoring-defective-checkpoint-purge',
    version: 2,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_lease'").all()) {
        const name = row.name          ;
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
    namespace: 'workbench',
    name: 'authoring-redaction-column',
    version: 3,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_position'").all()) {
        const name = row.name          ;
        const columns = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name          ));
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
    namespace: 'workbench',
    name: 'membership-composite-primary-key',
    version: 4,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_membership'").all()) {
        const name = row.name          ;
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
    namespace: 'workbench',
    name: 'authoring-compact-checkpoints',
    version: 5,
    up(db) {
      for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '*_authoring_lease'").all()) {
        const name = row.name          ;
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
          const raw = JSON.parse(state.family_checkpoint          );
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

// The reserved `workbench` lane is internal-only via internal.ts.
// `ensureWorkbenchMigrationTable` now ensures the shared namespaced ledger
// table; `appliedWorkbenchVersion` reads the `workbench` namespace of it.

export function ensureWorkbenchMigrationTable(db          )       {
  // Alias of the shared namespaced-ledger ensure: the workbench lane lives in
  // the same `_SchemaMigration` table as every other namespace.
  ensureMigrationTable(db);
}

export function appliedWorkbenchVersion(db          )         {
  return ledgerRows(db)
    .filter((row) => row.namespace.toLowerCase() === 'workbench')
    .reduce((max, row) => Math.max(max, row.version), 0);
}

export function runWorkbenchMigrations(db          , options                      = {}) {
  // The runner handles the read-only "nothing pending" fast path itself: it
  // validates checksums and resolves order before opening the exclusive
  // transaction, so an already-applied lane that has not been mutated skips
  // BEGIN EXCLUSIVE entirely. The whole lane is one transaction when it does
  // run (Sol ruling 5175490719).
  runLedgerMigrations(db, WORKBENCH_MIGRATIONS, {
    ...options,
    suppliedBy: options.suppliedBy ?? WORKBENCH_SUPPLIED_BY,
    singleTransaction: true,
    allowReserved: true,
  });
}
