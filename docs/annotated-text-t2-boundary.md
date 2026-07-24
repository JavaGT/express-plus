# Annotated Text T2 Boundary

## Existing seams

- `src/annotated-text.mjs` owns the closed `workbench.text` v1 grammar and is
  the only suitable shared pure reducer module for server and browser.
- `src/entity/crud.mjs` currently accepts `Entity.update` whole-field values;
  `src/entity/projection.mjs` persists those values from lifecycle events.
- `src/pipeline.mjs` appends finalized events to `_Log` before projection;
  `src/committed-log.mjs`, `src/durable-history.mjs`, and
  `src/http-framework-routes.mjs` replay that committed stream.
- `src/field-delta.mjs` currently derives `text.crdt` prefix/suffix deltas for
  `src/live-fanout.mjs`.
- `public/workbench-client.mjs` folds those deltas with UTF-16 string slicing;
  `createLiveStore` sends the same whole-string `PATCH` route.

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
- The final cutover replaces `crdtTextDiff`, whole-string `text.crdt` PATCH,
  and browser string-slice application with one native `text.crdt` operation
  action that persists, replays, fans out, and folds through the same reducer.
- `raster.crdt` and `polyline.crdt` remain explicit whole-value replacement
  stubs and do not enter the text operation path.
