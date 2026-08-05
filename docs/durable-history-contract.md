# Durable history contract

Workbench is the sole durable undo/redo and cursor authority. Applications declare domain meaning;
they do not execute, persist, replay, or read canonical history independently.

## Public declaration and runtime

## Collaborative history rule

Undo and redo are **compensating actions**, not state restoration. The inverse
of an eligible action is a new ordinary durable action that targets the original
action's surviving contribution in the current projection. It shares the normal
authorize → handler → log → projection → receipt → delivery → client fold path.

This gives history its collaboration rule: a user's undo may remove or
compensate for that user's contribution, but it must preserve unrelated later
contributions from other users. Redo compensates the completed undo action; it
does not replace current state with an old after-image. If a contribution no
longer exists or cannot safely be transformed, the declared inverse must fail
closed or produce an explicit idempotent no-op. It must never silently restore a
broad document, row, or projection snapshot.

Every undoable action therefore declares its contribution and its compensating
algebra explicitly. Text may target CRDT element identities; a structural edit
may target its created topology; a compound action must compensate its text,
structure, annotations, and derived facts atomically. A private fact may retain
the narrow provenance needed to authorize and validate that compensation, but it
is not a recoverable whole-state image and is never delivered to clients.

The general agent-facing programming guide is
[`semantic-operations.md`](./semantic-operations.md).

`durableHistory({ authorize, actions })` declares a closed action-type registry. Each registered type
has explicit `inverse(context)` and `redo(context)`; absent types are non-undoable and are skipped
without clearing older cursor entries. Translations return an ordinary registered action request and
therefore use the one authorize → handler → log → projection → receipt transaction, or return a
non-empty `actions` batch committed atomically under that same receipt and cursor transition. They cannot
change owning scope. The normal registered action authorizer and history authorizer both run again
inside that transaction; denial, malformed translation, handler/projection failure, or stale cursor
rolls back projection, log, receipt, and cursor together.

Translation receives the authenticated principal/session, original receipt metadata, and the canonical
private `{ before, after }` fact loaded by Workbench. The fact is erasure-aware: missing, malformed,
retained-away, or erased material fails closed. It is never returned by public `app.history` cursor/move
surfaces. There is no default replay when a redo declaration is absent.

A translated action may carry opaque `input`. Workbench binds it by batch position to that action's
handler as `history: { operation, input }`, only while the handler runs inside the history transaction.
Ordinary dispatches omit `history`. This input is not action payload: Workbench never supplies it to
authorization, serializes it into the event log or receipt, or includes it in delivery or dispatch
results. An application may derive it from the package-owned private fact but cannot persist or replay it.

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
- Putting before-images in payloads, receipts, events, or application history storage: each turns a
  transaction-local capability into recoverable application-owned history.
- Whole-document, row, or projection snapshot restore as ordinary collaborative
  undo: it overwrites unrelated concurrent work rather than compensating for the
  initiating user's contribution.

Fresh schemas only; there is no legacy reader, migration, compatibility adapter, or alternate engine.
