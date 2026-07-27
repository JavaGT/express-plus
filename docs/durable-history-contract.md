# Durable history contract

Workbench is the sole durable undo/redo and cursor authority. Applications declare domain meaning;
they do not execute, persist, replay, or read canonical history independently.

## Public declaration and runtime

`durableHistory({ authorize, actions })` declares a closed action-type registry. Each registered type
has `inverse(context)` and may have `redo(context)`; absent types are non-undoable and are skipped
without clearing older cursor entries. Translations return an ordinary registered action request and
therefore use the one authorize → handler → log → projection → receipt transaction. They cannot
change owning scope. The normal registered action authorizer and history authorizer both run again
inside that transaction; denial, malformed translation, handler/projection failure, or stale cursor
rolls back projection, log, receipt, and cursor together.

The public application surface is deliberately only `history.cursor`, `history.undo`, and
`history.redo`; raw action/event payload readers are not exposed. Cursor identity is exactly
`(owning scope, user principal type+id, Studio session)`. `cursor()` returns undo/redo counts plus an
opaque `revision`. A move requires the revision and caller-generated `actionId`; stale concurrent
moves conflict, while retrying the same id returns its committed receipt without moving twice.
Empty moves succeed with `empty: true` and persist a payload-free receipt, so retrying that operation
cannot accidentally move history created later. Controls remain in flight until authoritative event ingest.

## Persistence, provenance, retention, erasure

Every action receipt records owning scope (the project boundary supplied by the application), action
id/type/time, canonical payload, principal type+id, session when present, operation, and ordered log
references. Only `user` principals with a session enter human cursors; machine/system writes remain
authorized, attributable facts but never human undo entries. Retention atomically removes expired
cursor targets and log payloads and redacts receipt payloads while preserving the minimal receipt for
idempotent retries. Declared erasure atomically tombstones log payloads, removes recoverable receipts,
and retires every cursor reference, so neither undo, redo, read, retry, replay, nor recovery can
resurrect or reveal erased material. Malformed stored cursor/history fails closed.

## Rejected alternatives

- Application history tables, executors, raw DB facades, fallback readers, dual writes, and client
  canonical journals: each creates a second mutation/replay authority.
- Global or project-only cursors: leak one user's/session's edit intent into another.
- Default-undoable actions or suffix inference: unsafe inverses become reachable accidentally.
- Random server ids without a revision: retries and concurrent shortcuts can move twice.
- Deleting receipts at ordinary retention: permits an old action id to execute again.
- History panels and undo-to-point: not required by the one-step contract and would require a wider
  payload-bearing authorization surface.

Fresh schemas only; there is no legacy reader, migration, compatibility adapter, or alternate engine.
