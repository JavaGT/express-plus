# Annotated Text T4 Initialization

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The initial-block identity/epoch/derived-block initialization described below
> is historical. The current family is `{id, checkpoint}` — plain text imports
> as a single root element with no block layer — see
> `src/annotated-text-continuous.ts` (`importTextToFamily`).

[IMPLEMENTED — TERRA APPROVED 2026-07-25]

## Contract

Generic entity creation is the only initialization path for an annotated-text
field. The created event carries a server-generated initial block ID in its
private `data.__workbench.annotatedText` envelope. The entity projection uses
that durable identity to atomically create the parent row, one canonical family
state row, and one empty derived block.

- The canonical family ID is the parent document ID.
- The state and block structural revisions start at `1`; the initial block epoch
  is `1` and its stable first position is `a0`.
- The checkpoint is derived by the family reducer, never supplied by a client.
- Generic create and update reject any present annotated-text value. Clients also
  cannot supply the reserved `__workbench` event envelope.
- Action-receipt retries reuse the committed event and its block ID. The envelope
  is not inserted into the parent table or exposed as a hydrated entity field,
  live event, or HTTP resync event.
- Block defaults are validated and serialized through their declared Workbench
  field strategy before insertion.

This is projection initialization only. It exposes no annotated-text mutation,
membership, annotation, measurement, or browser action route.
