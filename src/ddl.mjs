// ddl.mjs — generate CREATE TABLE statements for compiled entities.
//
// The framework generates NO DDL by default (the app owns its schema). This
// module provides `generateDDL(entity)` which returns an ordered array of SQL
// strings: the main entity table first, then each side-table (map membership,
// log entries, ephemeral cells). The returned SQL is standalone — it may be executed
// against a node:sqlite DatabaseSync handle, or printed and committed to a
// migration file.
//
// Column type mappings (SQLite):
//   text / ref / crdt / hash / json → TEXT
//   date / boolean                  → INTEGER
//   number                          → REAL
//   struct (link)                       → one column per struct cell
//   id                                  → TEXT PRIMARY KEY (caller-owned UUID)
//
// Side-table naming (from scope-sql.mjs):
//   map          → {Entity}_{field} ({Entity}_id, member_id [, role])
//   log          → {Entity}_{field} ({Entity}_id, ...entry sub-fields)
//   ephemeral   → {Entity}_{field} ({Entity}_id, client_id)
import { structCellColumn } from './field-strategy.mjs';
import { sideTableDDL } from './side-table-strategy.mjs';
import { frameworkLogDDL } from './committed-log.mjs';

// Map a field's kind+type to its SQLite column type.
function sqlType(descriptor) {
  const { kind, type } = descriptor;
  if (kind === 'value' || kind === 'store' || kind === 'crdt' || kind === 'hash') {
    switch (type) {
      case 'boolean': return 'INTEGER';
      case 'date': return 'INTEGER';
      case 'number': return 'REAL';
      default: return 'TEXT';
    }
  }
  if (kind === 'struct') return 'TEXT'; // each struct cell is a TEXT column
  return 'TEXT'; // fallback (state, ephemeral, etc.)
}

function isMainTableField(descriptor) {
  return descriptor?.kind === 'value'
    || descriptor?.kind === 'crdt'
    || descriptor?.kind === 'hash'
    || descriptor?.kind === 'state'
    || descriptor?.kind === 'projected'
    || (descriptor?.kind === 'computed' && descriptor.mode === 'stored');
}

function collectAstFields(ast, result, seen = new Set()) {
  if (ast === null || typeof ast !== 'object' || seen.has(ast)) return;
  seen.add(ast);
  if (typeof ast.field === 'string') result.add(ast.field);
  for (const value of Object.values(ast)) {
    if (typeof value === 'function') continue;
    if (Array.isArray(value)) {
      for (const entry of value) collectAstFields(entry, result, seen);
    } else {
      collectAstFields(value, result, seen);
    }
  }
}

function scheduleIndexDDL(entity) {
  const fields = new Set();
  for (const triggerOrTriggers of Object.values(entity.schedule ?? {})) {
    const triggers = Array.isArray(triggerOrTriggers) ? triggerOrTriggers : [triggerOrTriggers];
    for (const trigger of triggers) {
      if (trigger?.kind === 'schedule.at' || trigger?.kind === 'schedule.after') {
        if (trigger.fieldName) fields.add(trigger.fieldName);
      }
      collectAstFields(trigger?.whileAst, fields);
    }
  }
  return [...fields]
    .filter((fieldName) => isMainTableField(entity.fields?.[fieldName]))
    .sort()
    .map((fieldName) => (
      `CREATE INDEX IF NOT EXISTS idx_${entity.name}_schedule_${fieldName} ` +
      `ON ${entity.name} (${fieldName});`
    ));
}

// Generate the main table DDL for one entity.
function mainTableDDL(entity) {
  const cols = ['id TEXT PRIMARY KEY'];
  const { fields } = entity;
  if (!fields) return cols;

  for (const [name, descriptor] of Object.entries(fields)) {
    // Pull computed fields have no stored column (computed on read).
    if (descriptor.kind === 'computed' && descriptor.mode === 'pull') continue;
    // Fields that are stored in the main table (value, crdt, hash, struct)
    if (descriptor.kind === 'value' || descriptor.kind === 'crdt' || descriptor.kind === 'hash' || descriptor.kind === 'state' || descriptor.kind === 'projected' || (descriptor.kind === 'computed' && descriptor.mode === 'stored')) {
      cols.push(`${name} ${sqlType(descriptor)}`);
    } else if (descriptor.kind === 'struct') {
      // struct fields (link) flatten to multiple columns
      for (const cellName of Object.keys(descriptor.cells ?? {})) {
        cols.push(`${structCellColumn(name, cellName)} TEXT`);
      }
    }
    // map / log / ephemeral / store → NOT stored in main table
  }
  return `CREATE TABLE IF NOT EXISTS ${entity.name} (\n  ${cols.join(',\n  ')}\n);`;
}

// Generate a complete, ordered sequence of CREATE TABLE statements for one
// compiled entity: the main table, then each side-table.
export function generateDDL(entity) {
  const statements = [];
  const { fields } = entity;
  if (!fields) return statements;

  statements.push(mainTableDDL(entity));

  for (const [name, descriptor] of Object.entries(fields)) {
    if (descriptor.kind === 'store') {
      if (descriptor.type === 'map' || descriptor.type === 'log') {
        const storeDDL = sideTableDDL(entity, name, descriptor);
        if (storeDDL) statements.push(storeDDL);
      }
    } else if (descriptor.kind === 'ephemeral') {
      const ephemeralDDL = sideTableDDL(entity, name, descriptor);
      if (ephemeralDDL) statements.push(ephemeralDDL);
    } else if (descriptor.kind === 'ordered') {
      const orderedDDL = sideTableDDL(entity, name, descriptor);
      if (orderedDDL) statements.push(orderedDDL);
    } else if (descriptor.indexed === 'fts') {
      const ftsDDL = sideTableDDL(entity, name, descriptor);
      if (ftsDDL) statements.push(ftsDDL);
    }
  }

  // Preserve the documented main-table/side-table ordering. Indexes are
  // independent trailing statements, which also keeps generated migrations
  // stable for callers that inspect the table statements by position.
  statements.push(...scheduleIndexDDL(entity));

  return statements;
}

// Execute the generated DDL statements against a DatabaseSync handle.
export function executeDDL(entity, db) {
  for (const sql of generateDDL(entity)) {
    db.exec(sql);
  }
}

export function generateFrameworkDDL() {
  return [
    `CREATE TABLE IF NOT EXISTS BlobStore (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  md5 TEXT,
  sha256 TEXT,
  size INTEGER,
  mime TEXT,
  createdAt TEXT NOT NULL
);`,
    'CREATE INDEX IF NOT EXISTS idx_blob_status ON BlobStore(status);',
    // _Log, _Cursor, and their index are owned by committed-log.mjs.
    ...frameworkLogDDL(),
    `CREATE TABLE IF NOT EXISTS _ScheduleReceipt (
  source TEXT NOT NULL,
  rowId TEXT NOT NULL,
  dueAt INTEGER NOT NULL,
  PRIMARY KEY (source, rowId, dueAt)
);`,
    // Job-queue substrate (spec #5). A job is a unit of work with its own
    // lifecycle (queued/claimed/running/completed/failed), NOT a derived read
    // model — separate seam from the projection registry. Timestamps are ms-epoch
    // INTEGERS so lease/grace comparisons are plain numeric (no ISO-string
    // juggling). _Worker stores only the token HASH (never the raw bearer).
    `CREATE TABLE IF NOT EXISTS _Job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  enqueuedAt INTEGER NOT NULL,
  workerId TEXT,
  claimedAt INTEGER,
  leaseUntil INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  availableAt INTEGER,
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  scope TEXT
);`,
    'CREATE INDEX IF NOT EXISTS idx__job_claim ON _Job (status, enqueuedAt);',
    'CREATE INDEX IF NOT EXISTS idx__job_scope_status ON _Job (scope, status, enqueuedAt);',
    `CREATE TABLE IF NOT EXISTS _ProjectedCursor (
  entity TEXT NOT NULL,
  field TEXT NOT NULL,
  lastSeq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entity, field)
);`,
    // Per-scope cursor for post-commit consumers over _Log. Tracks the real
    // per-scope log seq last successfully consumed by a named consumer, so a
    // boot-time sweep can detect scopes that fell behind (process died between
    // COMMIT and a post-commit consumer) and catch them up. _ProjectedCursor is
    // separate: it is a staleness version counter (self-incrementing count) for
    // response headers, not a recovery cursor.
    `CREATE TABLE IF NOT EXISTS _ConsumerCursor (
  consumer TEXT NOT NULL,
  scope TEXT NOT NULL,
  lastSeq INTEGER NOT NULL,
  PRIMARY KEY (consumer, scope)
);`,
    `CREATE TABLE IF NOT EXISTS _Worker (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL,
  lastHeartbeat INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  registeredAt INTEGER NOT NULL
);`,
  ];
}

export function executeFrameworkDDL(db) {
  for (const sql of generateFrameworkDDL()) {
    db.exec(sql);
  }
  // Additive column migrations for persistent dbs where CREATE TABLE IF NOT
  // EXISTS would not add columns added after the table's first creation. Each
  // guard checks PRAGMA table_info so it is a no-op on a fresh db and a safe
  // one-time ALTER on an older one.
  ensureJobColumns(db);
}

function ensureJobColumns(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(_Job)').all().map((r) => r.name));
  if (!cols.has('attempts')) {
    db.exec('ALTER TABLE _Job ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('availableAt')) {
    db.exec('ALTER TABLE _Job ADD COLUMN availableAt INTEGER');
  }
  if (!cols.has('progress')) {
    db.exec('ALTER TABLE _Job ADD COLUMN progress INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('stage')) {
    db.exec('ALTER TABLE _Job ADD COLUMN stage TEXT');
  }
  if (!cols.has('scope')) {
    db.exec('ALTER TABLE _Job ADD COLUMN scope TEXT');
  }
}
