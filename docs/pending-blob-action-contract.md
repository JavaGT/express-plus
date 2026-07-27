# Pending blob action contract

## Decision

Workbench owns the generic canonical blob-reference contract. Byte transport may stage a blob before an entity action, but staging produces only an opaque, principal- and scope-bound `PendingBlobClaim`. A registered action declares the payload field that consumes the claim. Inside the ordinary durable action transaction Workbench authorizes the action, exclusively claims and adopts the blob, replaces the claim with the canonical blob ID before invoking the handler, and requires the owning event to carry that ID. The event projection, committed log, action receipt, and blob claim therefore commit or roll back together.

`pendingBlobStager(app, principal).stage({ scopeId, resourceId, bytes, mediaType })` is the public server staging seam. `scopeId` must be the exact owning action scope; `resourceId` is the caller-selected deterministic entity identity. The package partitions its internal pending key by authenticated principal, stores bytes under an internal random blob ID, and returns an opaque claim token. Neither token nor pending key may enter an event, projection, receipt payload, private fact, or delivery record.

`declaredBlobField({ actionName, field, resourceField, purgeActionName? })` engages the seam. Claim admission requires the action's `resourceField` value to equal the identity used at staging. It supplies handler and projection contexts with `claimedBlobs[field] = { blobId, resourceId, sha256, md5, byteLength, mediaType }`, computed from package persistence and bound to that transaction. The payload is still rewritten only to the canonical blob ID: the attestation never enters payload, log, receipt, delivery, dispatch result, or post-commit effect serialization. Authorization remains the registered action's one `authorize` function; there is no blob-policy callback. A missing, expired, already claimed, wrong-principal, wrong-scope, wrong-resource, or undeclared claim fails closed before the handler. Durable receipt retry returns the original committed outcome without reclaiming or rerunning the handler. Staging is serialized through Workbench's write queue; SQLite's write transaction and conditional status update serialize concurrent claims. A declared blob action requires single dispatch, never batch dispatch.

Adoption is metadata-only and atomic. Physical finalization is package-owned, idempotent post-commit work recovered from durable `_PendingBlob` state at boot. A projection or receipt failure rolls back the claim/adoption; the unchanged pending bytes can be retried until reaped. A declared `purgeActionName` verifies the exact scope, resource identity, and blob ID in the authorized action transaction, then package reconciliation idempotently removes bytes and releases the deterministic staging identity. Recoverable application deletion does not declare this seam and retains bytes. The ordinary blob reaper treats active `_PendingBlob` rows as references and cannot remove their bytes.

Permanent erasure deliberately does not implicitly remove blobs. An erasure directive tombstones its declared log targets and receipts only; it neither reads nor mutates `_PendingBlob` or `BlobStore`, and erasure preparation cannot declare package tables. Applications compose an explicitly authorized action declared as `purgeActionName`; Workbench alone verifies and persists the deletion request and its reconciliation is crash recoverable. The application never receives BlobStore deletion authority or queues a byte-removal effect.

## Rejected alternatives

- A Scope-specific upload action or delivery facade: duplicates package mutation policy.
- A validator/policy callback on the blob declaration: creates a second authorization path.
- Caller-supplied or entity-derived canonical blob IDs: permits fake/colliding identity and couples storage identity to Scope keys.
- Raw `BlobStore`/`_PendingBlob` access, private imports, or direct REST entity writes.
- Finalize-before-commit or best-effort canonical writes: can expose/orphan bytes or commit rows without recoverable content.
- Dual write, compatibility tables, or migration logic: fresh-schema single-runtime only.

## Hostile acceptance matrix

| Case | Required result | Evidence |
|---|---|---|
| Missing/stale claim | fail closed; handler/log/projection/receipt untouched | `pending-blob.test.mjs` missing/stale cases |
| Foreign principal/scope | fail closed without revealing metadata | wrong-principal/wrong-scope cases |
| Action authorization denial | authorization fails before claim; staged bytes remain pending | denial case |
| Receipt retry | original outcome; no handler or claim rerun | receipt-retry case |
| Concurrent adoption | exactly one action may claim a generation | concurrent-claim case |
| Projection/receipt failure | whole canonical transaction rolls back; claim remains retryable | projection rollback case |
| Finalize crash/retry | canonical metadata remains readable; boot reconciliation converges idempotently | `blob-finalize-durable.test.mjs`, pending recovery cases |
| Deletion | authorized action makes bytes unavailable; retry/reconcile is idempotent | declared deletion case |
| Permanent erasure | no implicit byte erasure; a later explicit package contract must compose exact blob targets | contract boundary above |
| Payload leakage | log/projection/receipt/delivery contain canonical ID only, never claim token/key | canonicalization case |

Scope activation and package-pin changes are deliberately excluded. Scope may adopt this API only in the atomic registered-action/delivery/client-ingest cut.
