// live-revision.ts — per-resource/collection revision tracking for live-tier
// entities (S3/A2, JavaGT/workbench#100).
//
// A live tier keeps authoritative current rows + live synchronization with NO
// domain event history or undo — so it cannot use `_Log` sequence numbers to
// order or guard mutations. Instead every live resource carries its own
// monotonic revision, bumped transactionally with each row change, in the same
// write-coordinator transaction that applies the projection and writes the
// minimized receipt.
//
// The revision is the optimistic-concurrency hook: an edit may carry an
// `expectedRevision`; a mismatch rejects the whole action with a safe
// classification (conflict) instead of blind last-write-wins. The full atomic-
// operation surface is S3/A6; this module provides the primitive.

import { prepareCached,               } from './driver.mjs';

// ---- DDL ----

// One row per live resource/collection key. `resourceKey` is the live event
// scope (e.g. `Note:n1` for a resource, `Note` for a collection).
export function liveRevisionTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _LiveRevision (
  resourceKey TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);`;
}

// ---- read ----

// readRevision — the committed revision of a live resource/collection, or 0
// when the resource has never been mutated (its pre-first-mutation revision).
export function readRevision(db          , resourceKey        )         {
  const row = prepareCached(
    db,
    'SELECT revision FROM _LiveRevision WHERE resourceKey = :resourceKey',
  ).get({ resourceKey });
  const revision = row?.revision                      ;
  return revision === undefined ? 0 : revision;
}

// ---- write ----

// bumpRevision — increment the resource/collection revision inside the caller's
// open transaction. Returns the NEW revision (1 for the first mutation). The
// INSERT..ON CONFLICT is one statement, so a first mutation and every later one
// share the same atomic bump.
export function bumpRevision(db          , resourceKey        )         {
  const row = prepareCached(
    db,
    `INSERT INTO _LiveRevision (resourceKey, revision) VALUES (:resourceKey, 1)
     ON CONFLICT(resourceKey) DO UPDATE SET revision = revision + 1
     RETURNING revision`,
  ).get({ resourceKey });
  const revision = row?.revision                      ;
  if (!Number.isInteger(revision) || (revision          ) < 1) {
    throw new Error('live revision bump failed to return a positive integer revision');
  }
  return revision          ;
}

// ---- optimistic-concurrency guard ----

// expectedRevisionConflict — a 409-bearing error so the dispatch pipeline maps
// it to the closed `conflict` classification (never row content, never field
// values — the safe-error contract of S3/A2 spec item 4).
export function expectedRevisionConflict(resourceKey        , expected         , actual         )        {
  return Object.assign(
    new Error(`live revision conflict: resource '${resourceKey}' is at revision ${String(actual)}, expected ${String(expected)}`),
    { status: 409 },
  );
}

// guardExpectedRevision — the S3/A6 hook primitive. When an edit carries
// `expectedRevision`, compare it against the resource's CURRENT revision and
// throw a conflict before any row change lands. `expectedRevision` must be a
// non-negative integer; anything else fails closed as invalid input.
export function guardExpectedRevision(db          , resourceKey        , expectedRevision         ) {
  if (!Number.isInteger(expectedRevision) || (expectedRevision          ) < 0) {
    throw Object.assign(
      new Error('expectedRevision must be a non-negative integer'),
      { status: 400 },
    );
  }
  const current = readRevision(db, resourceKey);
  if (current !== expectedRevision) {
    throw expectedRevisionConflict(resourceKey, expectedRevision, current);
  }
}
