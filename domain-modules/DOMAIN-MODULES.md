# Domain Modules — retired

This was the original reactive-entity paradigm doc, written *before* the
authorization grill. Its structural content has been absorbed into the canonical
specification and its authorization content was superseded by the grill.

Read **[../SPEC.md](../SPEC.md)** for the current design. Specifically:

- The single-constructor / fields-own-everything / routes-home paradigm → SPEC §5
  (documents, field types as an open registry) and §15 (the values).
- Authorization (superseded here): `hide()` is dead (ADR #1, no visibility axis —
  a denied read removes the row); an entity with no grant is a load-time error
  (ADR #7, no zero-to-one default); the per-field `access` block was replaced by
  field `.can()`; the check parameter is `principal`, not `user`. → SPEC §6.

The decisions are recorded in **[../DECISIONLOG.md](../DECISIONLOG.md)** (ADRs
#1–#15); the values in **[../AGENTS.md](../AGENTS.md)**.
