# Annotated Text Sequence Kernel

Status: accepted

## Decision

`text.crdt()` will use a run-compressed RGA sequence with immutable scalar
identities, causal frontiers, observed-remove tombstones, and deterministic
child ordering. T1 fixes the durable grammar and executable validation laws;
T2 alone implements causal buffering, reduction, checkpointing, and delivery.

## Grammar

- An actor ID is exactly 32 lowercase hexadecimal characters. An operation ID is
  `[actor, positiveCounter]`; a replica emits contiguous counters and never
  reuses an identity.
- A frontier is sorted `[[actor, positiveCounter], ...]`, with one entry per
  actor. An operation's dependencies contain its own actor at `counter - 1`.
- Operations are closed, versioned arrays:

```text
["workbench.text", 1, opId, lamport, frontier, body]
body = ["insert", anchor, nonEmptyWellFormedText]
     | ["delete", sortedNonOverlappingObservedDeleteSpans]
anchor = ["root"] | ["element", [insertOpId, scalarOrdinal]]
```

- Text is well-formed Unicode without normalization. Public positions are
  UTF-16 offsets; only a boundary between the halves of a surrogate pair is
  invalid. Internally, each inserted Unicode scalar has an immutable element ID
  `[insertOpId, scalarOrdinal]` and a parent anchor.
- A delete names exact observed element IDs, compressed as sorted, minimally
  merged spans. It never names a persistent numeric range.
- RGA children render in descending Lamport order, then descending operation ID.
  Arrival order and server sequence do not participate.
- A structural point is an immutable anchor plus `left` or `right` affinity.
  T4 will use it for split/merge rather than persisting UTF-16 positions.

## T2 Requirements

T2 must reject malformed or equivocal duplicate IDs; buffer causally unready
operations; retain observed-remove deletion tags and anchor tombstones; produce
canonical checkpoints; and prove convergence across every causality-respecting
delivery order. It must replace the existing prefix/suffix pseudo-delta rather
than run beside it.

## Consequences

The grammar module is dependency-free and shared verbatim with the browser
client. It has no field, persistence, live, history, or declaration wiring in
T1. Tests validate the grammar itself, not static field-law flags.
