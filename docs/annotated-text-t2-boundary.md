# Annotated Text T2 Boundary

## Delivery Cutover

- `src/annotated-text.mjs` owns the closed `workbench.text` v1 grammar and is
  the only suitable shared pure reducer module for server and browser.
- `Entity.<textField>.apply` is a native action accepting exactly `{id,
  operation}`. It uses the ordinary update row admission and emits
  `<Entity>.<field>.applied` with the canonical operation unchanged.
- `src/pipeline.mjs` appends finalized events to `_Log` before projection;
  `src/committed-log.mjs`, `src/durable-history.mjs`, and
  `src/http-framework-routes.mjs` replay that committed stream.
- The declared `text.crdt` field cell is the sole durable JSON canonical
  checkpoint. Projection folds `src/annotated-text.mjs` state from that cell and
  atomically replaces it with the next checkpoint. Hydration derives the visible
  string and snapshot transport separately supplies the checkpoint for browser
  bootstrap. Log, history, and live delivery preserve the raw operation event.
- `LiveList` restores the checkpoint and folds `.applied` operations with the
  same reducer. `createLiveStore.apply(id, field, operation)` POSTs the native
  field route and never PATCHes a text operation.

## Acceptance tests

- Reducer state contains IDs and parent IDs only; concurrent inserts converge
  for every causal delivery order and scalar run links are preserved.
- Readiness requires both the full causal frontier and all referenced scalar
  identities. Unready operations buffer atomically; a bounded buffer enters a
  rebootstrap-required state and accepts no more operations.
- Deletes are observed-remove tags over exact scalar IDs. Tombstoned nodes keep
  their children and remain valid anchors.
- Duplicate operation IDs accept only byte-identical canonical operations;
  applied and pending registries retain a canonical operation digest.
- A canonical checkpoint round-trips to the same normalized state and visible
  text, independent of arrival order.
- `crdtTextDiff`, whole-string `text.crdt` PATCH, and browser string-slice
  application are retired. `text.crdt` rejects whole-string create/update.
- `raster.crdt` and `polyline.crdt` remain explicit whole-value replacement
  stubs and do not enter the text operation path.

## Status

[IMPLEMENTED - TERRA APPROVED 2026-07-24] Implemented and verified through the server,
history, live, snapshot sidecar, browser bootstrap, generated browser
operations, and focused tests. Browser editing reconciles each authoritative
reducer state with its durable outbox before serially reserving operations;
when durable storage is unavailable it fails closed rather than creating an
ephemeral actor.
