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
- **A new general mechanism retires the special-case it generalizes, in the same
  change.** When you introduce a more-general mechanism (a registry, a uniform
  evaluator, a single pipeline) that *subsumes* an existing hand-rolled path, you
  migrate the old case onto the new mechanism NOW — you do not leave the old path
  running beside the new one "because it works." A working second path is still a
  second path: its agreement with the new path today is unverified luck, not
  safety, and it is the exact seam where the two drift tomorrow. This OUTRANKS
  "subtract before you add" and "build no further" when they are read as "don't
  touch working code" — minimal-diff is about not adding *unneeded* concepts, never
  an excuse to keep a redundant pathway alive. The larger, riskier migration that
  ends with one mechanism beats the smaller change that ends with two. (Pay the
  cost behind a green test suite: migrate, then prove the suite still passes.)
- **Declaration absorbs imperative wiring.** Behavior should flow from declared
  shape, not hand-written glue. If you're writing wiring (`on`, `emit`, mount
  config) that restates what the declaration already implies, the declaration
  should own it.
- **Subtract before you add.** Before adding a concept, ask what existing concept
  it makes unnecessary. The smallest change that removes ceremony is the target,
  not the floor.
- **The deletion test gates every abstraction.** Delete a candidate abstraction
  and watch the code. If one concept *absorbs* another and the net line count
  drops, it **concentrates** — keep it. If the same code merely *moves into a
  config object* behind a new name, same net count, it **relocates** — reject it.
  A generator's pure half (a derivable schema, a uniform reducer) may concentrate;
  its varying half (a per-entity authorize/handler body) stays hand-written, never
  encoded into a config DSL.
- **Build for the known use cases proactively, but no further.** The foundation
  is built for the `projects/*` stress-test apps up front, not landed
  incrementally as each app stubs its toe. The bar is "a real app in the set needs
  this shape," never "build every conceivable knob" — proactive is not exhaustive.
- **Fail closed.** When a default carries a security opinion, the default is the
  restrictive one: auth-on, private-by-default. Allowlists, not denylists.
- **One reconciliation path.** A client event becomes state in exactly one place
  (`ingest`), for the client's own echoed events and for foreign live events
  alike. There is no second "apply" path. Optimistic apply is a *visible
  placeholder*; `ingest` is what resolves it. A dual reconciliation path is the
  source of "the two clients disagree" bugs — structurally forbidden.
- **Persistence is opt-in by engaged seam, not a class field.** An action's class
  (durable, ephemeral, volatile) is *emergent* from which seams it engages, never
  a label it carries. Engage the persistence seam and it is durable; don't and it
  is ephemeral. Reaching a capability means engaging its slot, not setting a flag
  the framework reinterprets.
- **Pipeline variants are named wholes, not orthogonal flags.** Where the dispatch
  pipeline varies (durable vs live), a spec selects a *named, pre-validated
  variant*, never toggles individual stages with independent booleans. Orthogonal
  flags form an incoherent lattice that can half-apply; a named variant cannot.

## Authorization

- **Authorization is always functions** — never magic words, string sentinels, or
  static values. Decisions are computed, not matched.
- **Allowlist over denylist.** Name the capability that grants access, not the
  condition that denies it.
- **No second auth path.** Every transport (REST, live stream, subscriptions) runs
  through the same authorization engine. Live events are re-authorized before
  delivery, not bypassed. This applies *within* the engine too: a capability
  (`owner`, `collaborator`) resolves through ONE check registry evaluated in both
  modes — compiled to SQL for the row-scope filter and run as a boolean at request
  time — never a role-map for one mode plus a separate derived function for the
  other. When a check gains a second mode, route the existing checks through the
  same registry rather than letting the old per-mode handling persist.

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
- **Out-of-band effects are projections over the committed log**, not a new effect
  primitive. An in-transaction effect (`{ mutate, with }`) must be atomic with its
  origin; a webhook, email, or external call must *not* (it leaves the process and
  cannot join the DB transaction), so it runs as a post-commit projection consumer
  — independently durable, retried on its own, never rolling back the origin.

## Defaults

- **Sensible defaults are baked into the framework**, not hand-applied by the app.
  If the app has to mount error handlers, shutdown traps, or the events endpoint,
  that's a leak — the framework owns it.
- **Two default-on layers**: a route gate (auth required) and a row gate (grant).
  Both on by default; opt out explicitly, never implicitly.
