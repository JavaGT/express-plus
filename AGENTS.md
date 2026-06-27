# AGENTS.md

Generic rules governing design decisions in this project. Apply to every change.
These are preferences expressed by the author; treat them as binding direction for
naming, architecture, authorization, data, and live behavior.

## Naming

- **Be specific.** A name should say what a thing IS, not a generic category it
  belongs to. Avoid vague words (`module`, `item`, `data`, `thing`). Prefer the
  concrete domain noun (`entity`, `document`, `share`).
- **Type-first, mechanism-second.** When a thing has a kind and a modifier, put
  the kind first: `text.crdt`, not `crdt.text`. The reader learns what a thing is
  before how it works. The bare kind (`text`) is the sensible-default mechanism.
- **Distinguish similar but different concepts with distinct names.** Don't reuse
  one word for two related ideas. If two things differ, name them differently
  (e.g. invite-notifications vs email-style messaging are not the same "inbox").
  If they are the same, use one name.
- **Avoid jargon when a plain word works.** `checks` over `predicates`. If a term
  needs explaining before a reader understands it, find one that doesn't.

## Architecture

- **Prefer a singular system.** One way to do a thing. Multiple pathways to the
  same goal drift apart, conflict in unexpected ways, and confuse. If a second
  path seems needed, fold it into the first or remove the first — don't run two
  in parallel.
- **Declaration absorbs imperative wiring.** Behavior should flow from declared
  shape, not hand-written glue. If you're writing wiring (`on`, `emit`, mount
  config) that restates what the declaration already implies, the declaration
  should own it.
- **Subtract before you add.** Before adding a concept, ask what existing concept
  it makes unnecessary. The smallest change that removes ceremony is the target,
  not the floor.
- **Fail closed.** When a default carries a security opinion, the default is the
  restrictive one: auth-on, private-by-default. Allowlists, not denylists.

## Authorization

- **Authorization is always functions** — never magic words, string sentinels, or
  static values. Decisions are computed, not matched.
- **Allowlist over denylist.** Name the capability that grants access, not the
  condition that denies it.
- **No second auth path.** Every transport (REST, live stream, subscriptions) runs
  through the same authorization engine. Live events are re-authorized before
  delivery, not bypassed.

## Data & queries

- **No magic strings** for field references, event names, or collection handles.
  Prefer typed handles; derive identifiers from declared shape.
- **Relations are typed foreign keys**, explicit about their target, with
  auto-traversal and population. Opaque sugar that hides the FK target is
  rejected.
- **A collection owned by one side is a field on that entity**, not a standalone
  table, when the relation is genuinely owned by one side.

## Live / sync

- **Fields are reactive primitives** that own their persistence, sync strategy,
  and event emission. Events are derived from field mutations, not hand-emitted.
- **Uniform transport.** Pick one live transport (WebSockets here) and use it
  consistently; don't mix transports per feature.

## Defaults

- **Sensible defaults are baked into the framework**, not hand-applied by the app.
  If the app has to mount error handlers, shutdown traps, or the events endpoint,
  that's a leak — the framework owns it.
- **Two default-on layers**: a route gate (auth required) and a row gate (grant).
  Both on by default; opt out explicitly, never implicitly.
