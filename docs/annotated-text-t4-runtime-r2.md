# Annotated Text T4 Runtime R2

## Status

[APPROVED 2026-07-25]

## Cutover

R2 extends the established generated annotated-text aggregate seam with one
structural variant: interior block split. R1 version-1 `text.apply` command and
event grammars remain unchanged.

- The generated `<Entity>.<field>.operation` accepts closed version-2
  `block.split` commands with a document ID, exact structural revision/frontier,
  source block ID, and UTF-16 offset. The server mints the right block and
  measurement identities only after the pure split changes topology.
- A split at either visible edge returns successful zero events. Its ordinary
  durable action receipt makes retry idempotent without minting an ID, invoking
  an adapter, advancing topology, or entering cursor history.
- A changed split emits exactly one document-scoped `operated` event. Its
  canonical facts include the full post-split family, retained and new block
  cell snapshots, affected annotation memberships, and paired measurements.
  Structural revision advances once; frontier is unchanged.
- Split partitions existing RGA ownership only. It neither clones nor re-roots
  scalars, tombstones, insertion identities, or replacement text. The retained
  source block is left; the generated block is immediately right.
- Declared scalar block cells are copied from the source stored values, including
  explicit null and non-default values. SQLite block positions are derived from
  canonical family order as fixed-width lowercase base-36 ordinals, never trusted
  as event facts.
- Active source-block memberships expand to canonical full-block memberships for
  both descendants. Dense ordinals are normalized across every membership of
  each affected annotation. Split does not clone, delete, or orphan annotations.
- Each source measurement is validated, partitioned twice with the same frozen
  input, compared for deterministic output, and validated against both descendant
  visible texts during action admission. The projector does not invoke adapters;
  it verifies event fact lineage and persists event-carried measurement payloads.
- Projection independently reruns only framework-owned family and membership
  reducers, verifies canonical event facts against its prior relational state,
  and persists the reducer-derived family checkpoint. State, blocks,
  memberships, measurements, event, and receipt share the existing transaction.
- R2 actions remain cursor-excluded and forbidden from generic batches. Merge,
  annotation lifecycle actions, orphan persistence actions, and measurement edit
  actions remain unavailable pending their complete composite contracts.
