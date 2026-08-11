# Annotated Text T5a Recipient Projection

> Superseded (issue #33): annotated text is now **blockless continuous text**.
> The "restricted blocks" / "metadata on restricted blocks" language below is
> historical — restricted content is a range on the continuous document, not a
> block. The canonical recipient projection is the span-native document in
> `src/annotated-text-recipient-projection.ts` (`kind:
> 'workbench.annotatedText.canonical'`: `text`, `annotations`, `ranges`,
> `measurements`, `capabilityHints`, `orphans?`). Fail-closed redaction and the
> placeholder rule stand.

T5a establishes a fail-closed recipient projection foundation. It is not the
complete confidentiality-delivery ticket.

- `protectingAnnotation()` declares one deterministic recipient placeholder.
  All protecting families in one field use the same placeholder.
- The internal projector accepts canonical T4 facts plus exact, already-resolved
  protector decisions. Missing, duplicate, stale, malformed, or incomplete
  decisions reject the complete projection.
- A denied active protector restricts only blocks where it overlaps a protected
  target. Restricted blocks expose only stable ID and placeholder. They contain
  no body, fields, membership, measurements, protector identity, or target IDs.
- Recipient documents use the closed
  `workbench.annotatedText.recipient` v1 envelope. The browser materializer
  rejects raw canonical snapshots and rejects metadata on restricted blocks.
- Capability hints are recipient guidance only. Generated actions still require
  authorization in their transaction.

T5a does not yet create decisions from the authorization engine or wire this
projector into HTTP snapshots, live delivery, history, receipts, presence,
measurements, search, export, logs, revocation, or orphan handling.
