// invalidation-ledger.ts — bounded durable revision markers for live recovery
// (S3/A3, JavaGT/workbench#101).
//
// This is deliberately not a second history. A row says only that a resource
// or collection reached a revision at a time. Recovery reads it to decide
// whether a client needs a fresh snapshot; it never reconstructs mutations.

import { prepareCached, type DbHandle } from './driver.ts';

export const INVALIDATION_LEDGER_TABLE = '_InvalidationLedger';

// Retaining eight markers per key detects ordinary reconnect gaps while keeping
// the ledger bounded. Applications with a longer reconnect window can opt in to
// a larger value when constructing their ledger writer.
export const DEFAULT_INVALIDATION_LEDGER_LIMIT = 8;

export type InvalidationKind = 'resource' | 'collection';

export type InvalidationLedgerEntry = Readonly<{
  resourceKey: string;
  kind: InvalidationKind;
  revision: number;
  updatedAt: string;
}>;

export type InvalidationRecovery = Readonly<{
  revision: number;
  retainedFromRevision: number;
}> & (
  | Readonly<{ status: 'current' }>
  | Readonly<{ status: 'resnapshot'; reason: 'stale' | 'compacted' | 'unknown' }>
);

export type WriteCoordinator = {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
};

// Only resource identity, kind, revision, and timestamp belong here. In
// particular there is no payload, prior value, snapshot, or actor attribution.
export function invalidationLedgerTableDDL() {
  return `CREATE TABLE IF NOT EXISTS ${INVALIDATION_LEDGER_TABLE} (
  resourceKey TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('resource', 'collection')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (resourceKey, revision)
);`;
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('invalidation ledger limit must be a positive integer');
  }
}

function validateEntry(entry: InvalidationLedgerEntry): void {
  if (typeof entry.resourceKey !== 'string' || entry.resourceKey.length === 0) {
    throw new TypeError('invalidation ledger requires a non-empty resourceKey');
  }
  if (entry.kind !== 'resource' && entry.kind !== 'collection') {
    throw new TypeError("invalidation ledger kind must be 'resource' or 'collection'");
  }
  if (!Number.isInteger(entry.revision) || entry.revision < 1) {
    throw new TypeError('invalidation ledger revision must be a positive integer');
  }
  if (typeof entry.updatedAt !== 'string' || entry.updatedAt.length === 0) {
    throw new TypeError('invalidation ledger requires a non-empty updatedAt');
  }
}

// compactInvalidations — keep the latest contiguous tail for one key. The
// caller controls transaction scope; a compaction failure throws, so it cannot
// be mistaken for a successful write. The insert has already happened, and the
// newest revision is never selected for deletion.
export function compactInvalidations(db: DbHandle, resourceKey: string, limit = DEFAULT_INVALIDATION_LEDGER_LIMIT): void {
  if (typeof resourceKey !== 'string' || resourceKey.length === 0) {
    throw new TypeError('invalidation ledger requires a non-empty resourceKey');
  }
  validateLimit(limit);
  prepareCached(
    db,
    `DELETE FROM ${INVALIDATION_LEDGER_TABLE}
     WHERE resourceKey = :resourceKey
       AND revision NOT IN (
         SELECT revision FROM ${INVALIDATION_LEDGER_TABLE}
         WHERE resourceKey = :resourceKey
         ORDER BY revision DESC
         LIMIT :limit
       )`,
  ).run({ resourceKey, limit });
}

// writeInvalidationInTxn — the live mutation path calls this after it bumps the
// authoritative revision, inside its existing write-coordinator transaction.
// It opens no transaction or second mutex of its own.
export function writeInvalidationInTxn(
  db: DbHandle,
  entry: InvalidationLedgerEntry,
  limit = DEFAULT_INVALIDATION_LEDGER_LIMIT,
): void {
  validateEntry(entry);
  validateLimit(limit);
  const existing = prepareCached(
    db,
    `SELECT kind, updatedAt FROM ${INVALIDATION_LEDGER_TABLE}
     WHERE resourceKey = :resourceKey AND revision = :revision`,
  ).get({ resourceKey: entry.resourceKey, revision: entry.revision });
  if (existing) {
    if (existing.kind !== entry.kind || existing.updatedAt !== entry.updatedAt) {
      throw new Error(`invalidation ledger revision already recorded differently for '${entry.resourceKey}'`);
    }
  } else {
    prepareCached(
      db,
      `INSERT INTO ${INVALIDATION_LEDGER_TABLE} (resourceKey, kind, revision, updatedAt)
       VALUES (:resourceKey, :kind, :revision, :updatedAt)`,
    ).run(entry);
  }
  compactInvalidations(db, entry.resourceKey, limit);
}

// writeInvalidation — coordinator-routed entry point for a standalone writer.
// Normal live dispatch uses writeInvalidationInTxn so the row change, revision
// bump, and marker share one existing transaction.
export function writeInvalidation(
  writeCoordinator: WriteCoordinator,
  db: DbHandle,
  entry: InvalidationLedgerEntry,
  limit = DEFAULT_INVALIDATION_LEDGER_LIMIT,
): Promise<void> {
  if (!writeCoordinator || typeof writeCoordinator.run !== 'function') {
    throw new TypeError('invalidation ledger requires the platform write coordinator');
  }
  return writeCoordinator.run(() => writeInvalidationInTxn(db, entry, limit));
}

export function invalidationsFor(db: DbHandle, resourceKey: string): readonly InvalidationLedgerEntry[] {
  if (typeof resourceKey !== 'string' || resourceKey.length === 0) {
    throw new TypeError('invalidation ledger requires a non-empty resourceKey');
  }
  return prepareCached(
    db,
    `SELECT resourceKey, kind, revision, updatedAt FROM ${INVALIDATION_LEDGER_TABLE}
     WHERE resourceKey = :resourceKey ORDER BY revision`,
  ).all({ resourceKey }) as InvalidationLedgerEntry[];
}

// invalidationRecovery — the delivery-facing gap check. A ledger marker can
// only prove freshness; any stale client gets a resnapshot, never a replay.
export function invalidationRecovery(db: DbHandle, resourceKey: string, knownRevision: number): InvalidationRecovery {
  if (typeof resourceKey !== 'string' || resourceKey.length === 0) {
    throw new TypeError('invalidation ledger requires a non-empty resourceKey');
  }
  if (!Number.isInteger(knownRevision) || knownRevision < 0) {
    throw new TypeError('knownRevision must be a non-negative integer');
  }
  const row = prepareCached(
    db,
    `SELECT MIN(revision) AS retainedFromRevision, MAX(revision) AS revision
     FROM ${INVALIDATION_LEDGER_TABLE} WHERE resourceKey = :resourceKey`,
  ).get({ resourceKey });
  const revision = Number(row?.revision ?? 0);
  const retainedFromRevision = Number(row?.retainedFromRevision ?? 0);
  if (revision === 0) {
    return knownRevision === 0
      ? { status: 'current', revision, retainedFromRevision }
      : { status: 'resnapshot', reason: 'unknown', revision, retainedFromRevision };
  }
  if (knownRevision === revision) return { status: 'current', revision, retainedFromRevision };
  return knownRevision < retainedFromRevision - 1
    ? { status: 'resnapshot', reason: 'compacted', revision, retainedFromRevision }
    : { status: 'resnapshot', reason: 'stale', revision, retainedFromRevision };
}
