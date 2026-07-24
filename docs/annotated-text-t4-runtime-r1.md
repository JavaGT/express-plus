# Annotated Text T4 Runtime R1

## Status

[APPROVED 2026-07-25]

## Cutover

R1 creates the one permanent runtime aggregate seam without exposing structural,
annotation, or measurement mutation variants.

- Every annotated-text field generates `<Entity>.<field>.operation` and emits one
  `<Entity>.<field>.operated` native event in the owning document scope.
- The sole accepted v1 command is `text.apply`, targeting one existing block.
  It includes an exact structural revision and family frontier precondition.
- The in-transaction handler reads the canonical state row, checks the precondition,
  runs the pure block text reducer, and emits one canonical post-family fact.
- The event states an explicit transition `(structuralRevision, frontier) ->
  (structuralRevision, nextFrontier)`: R1 text changes causal text state only,
  not durable topology. Future split/merge variants advance structural revision.
- The synchronous projection validates the event's prior state and exact canonical
  pure-reducer result before persisting its own serialized result. It never executes
  application adapters, authorization, I/O, or extension callbacks.
- Generated operation actions are cursor-excluded. The durable action receipt remains
  permanent; no inverse is available until all composite variants have one.
- R1 operations require single dispatch. Generic batches intentionally reject this
  aggregate action rather than executing its state read outside the atomic brace or
  assigning a receipt to an ambiguous multi-document scope.
- Split/merge, memberships, annotations, orphan persistence, and measurements remain
  unavailable through R1. No Scope integration is introduced.
