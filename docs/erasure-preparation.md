# Erasure preparation

An erasure action may return `erasureDirectivePreparation({ owningScope, subject, census })` instead of assembling target digests itself. Workbench derives and validates the exact manifest from the current durable transaction snapshot.

Register the privileged action with `history: { cursor: 'excluded' }` and `erasure: { tables, prepare }`, explicitly listing the application-owned cleanup/outbox tables. After manifest validation, `prepare({ writes, manifest })` runs once in the same transaction. Its write-only `insert`, `update`, and `delete` methods accept record-shaped values/filters and reject every undeclared table. Workbench does not retain its return value or the manifest. A thrown error is sanitized and rolls back preparation, committed events, receipt changes, and erasure.

The callback is unavailable to ordinary actions and projections. Receipt retries return the existing result without rerunning it; replay does not invoke it. Do not copy the manifest into durable application state, logs, event data, or callback errors.
