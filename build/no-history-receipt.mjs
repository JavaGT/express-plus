// no-history-receipt.ts — the minimized idempotency receipt for live-tier
// mutations (S3/A2, JavaGT/workbench#100).
//
// A live-tier mutation must NOT quietly write every mutation into `_Log`
// (section consideration #2: that would preserve history despite the tier's
// purpose). Its write path is: apply the row change, bump the resource
// revision, write a MINIMIZED receipt, and settle the caller — all inside the
// S1/A5 write-coordinator transaction. This module is the canonical owner of
// that receipt: its DDL, its insert, and its read (the retry-dedupe lookup).
//
// The receipt is deliberately independent of undo history (consideration #8):
// undo still reads the history tier only. It carries ONLY the enumerated
// fields — no full mutation payload, no prior values, no domain payload
// history (considerations #8, #9):
//
//   { actionId, resourceKey, committedRevision, outcome,
//     actorType/actorId (where required), safeErrorClassification }
//
// `safeErrorClassification` is drawn from the closed S5/A2 failure-category
// vocabulary (never row content, never field values). Receipt retention and
// payload minimization are configured independently from undo history.
//
// Idempotency: a retried (scope, actionId) settles to the same outcome without
// a second apply — the receipt IS the proof, and the durable `_ActionReceipt`
// is NOT written for a live-only commit (it would retain the request payload).
// Only committed outcomes receive a receipt. Rejected actions roll back with no
// receipt, so a retry runs validation again against the then-current state.

import { prepareCached,               } from './driver.mjs';




// The closed, safe error vocabulary. Reuses the S5/A2 failure categories —
// generic classifications only; row content and field values never cross into
// the receipt.


























// ---- DDL ----

// The minimized receipt table. `scope` is the dispatch owning stream (the same
// owning-scope identity `_ActionReceipt` keys on — including the empty-string
// bucket for scope-less dispatch — so retry dedupe is symmetric between the
// durable and no-history lanes); `resourceKey` names the live resource actually
// mutated (an event scope such as `Note:n1`). Primary key is (scope, actionId)
// — one receipt per committed live action, mirroring the owning-stream action
// receipt shape.
export function noHistoryReceiptTableDDL() {
  return `CREATE TABLE IF NOT EXISTS _NoHistoryReceipt (
  scope TEXT NOT NULL,
  actionId TEXT NOT NULL,
  resourceKey TEXT NOT NULL,
  committedRevision INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'committed',
  actorType TEXT,
  actorId TEXT,
  safeErrorClassification TEXT,
  committedAt TEXT NOT NULL,
  PRIMARY KEY (scope, actionId)
);`;
}

// ---- write ----

// insertNoHistoryReceipt — record the minimized receipt inside the caller's
// open write-coordinator transaction, immediately after the same action's row
// change and revision bump. Atomic with both: they land in the same commit, or
// neither does. A structural assertion keeps the receipt minimal by
// construction: only the enumerated fields are ever written — no actionData,
// no eventRefs, no payload, no prior values.
export function insertNoHistoryReceipt(db          , input                       ) {
  const { scope, actionId, resourceKey, committedRevision, committedAt } = input;
  if (typeof scope !== 'string') {
    throw new TypeError('no-history receipt requires a string scope');
  }
  if (typeof actionId !== 'string') {
    throw new TypeError('no-history receipt requires a string actionId');
  }
  if (typeof resourceKey !== 'string' || resourceKey.length === 0) {
    throw new TypeError('no-history receipt requires a non-empty resourceKey');
  }
  if (!Number.isInteger(committedRevision) || committedRevision < 0) {
    throw new TypeError('no-history receipt requires a non-negative integer committedRevision');
  }
  if (input.outcome !== undefined && input.outcome !== 'committed' && input.outcome !== 'rejected') {
    throw new TypeError(`no-history receipt outcome must be 'committed' | 'rejected', got ${JSON.stringify(input.outcome)}`);
  }
  prepareCached(
    db,
    `INSERT INTO _NoHistoryReceipt
       (scope, actionId, resourceKey, committedRevision, outcome, actorType, actorId, safeErrorClassification, committedAt)
     VALUES
       (:scope, :actionId, :resourceKey, :committedRevision, :outcome, :actorType, :actorId, :safeErrorClassification, :committedAt)`,
  ).run({
    scope,
    actionId,
    resourceKey,
    committedRevision,
    outcome: input.outcome ?? 'committed',
    actorType: input.actorType ?? null,
    actorId: input.actorId ?? null,
    safeErrorClassification: input.safeErrorClassification ?? null,
    committedAt,
  });
}

// ---- read ----

// noHistoryReceiptFor — read the minimized receipt for (scope, actionId), or
// undefined when the action never committed under that owning scope. The retry
// dedupe check for the no-history lane (S3/A2): same owning-scope identity as
// `receiptFor`, a different table.
export function noHistoryReceiptFor(db          , scope        , actionId        )                               {
  const row = prepareCached(
    db,
    'SELECT * FROM _NoHistoryReceipt WHERE scope = :scope AND actionId = :actionId',
  ).get({ scope, actionId });
  if (!row) return undefined;
  return row                               ;
}
