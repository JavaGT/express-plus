# Typed scope handles own committed-log scope grammar

Status: accepted

Workbench scope identity is a typed **Scope handle** (`{ entity, id, key }`)
that derives the persisted scope string (`Entity:id`); `_Log.scope` remains
the durable string serialization for compatibility. This concentrates the
scope-key grammar behind one module so live fan-out, kernel post-commit
consumers, projected recovery, effects, and HTTP resync routes no longer
parse `indexOf(':')` independently.

## Context

Committed-log scopes, live subscriptions, and sequence cursors are keyed by
`entity:id` strings. That shape is the same collaboration unit Scope-project
calls a ScopeRef, but Workbench reused the word **scope** for Grant/SQL
row-filters (`src/scope.mjs`) and left the identity grammar as ad-hoc string
splits across modules.

Event identity already has this discipline via ADR-0001 (typed event
handles). Scope identity needs the same peer: a domain noun, one module,
fail-closed parse.

## Decision

- Glossary term: **Scope handle** (not Grant row-scope).
- Module: `src/scope-handle.mjs` — `scopeOf`, `parseScopeKey`, `tryParseScopeKey`.
- Callers migrate off bare `` `${entity}:${id}` `` / `indexOf(':')` for
  committed-log scopes.
- Entity names may not contain `:` or `.`; ids may contain `:` (first colon
  is the separator).

## Consequences

- Live Delivery and Kernel deepenings depend on this grammar (no more
  relocating parse helpers into fan-out).
- `src/scope.mjs` stays the Grant/SQL row-scope compiler; no rename required.
- Coarse non-entity scopes (future) stay out of Scope handle until a real
  consumer declares them — `tryParseScopeKey` fails closed for non-entity
  shapes.
