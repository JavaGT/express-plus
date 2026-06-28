# SCOPE-FINDINGS — what the scope workbench proves, and what express-plus should build

This report mines `~/Development/scope` — a real, shipped SvelteKit + Prisma +
SQLite app whose `src/lib/wb/` is an app-agnostic, event-sourced collaboration
framework (~2638 LOC, zero domain nouns, enforced by a grep-audit gate). Its
stated north star is *"Express, but for collaborative, persisted, realtime
data"* — the same target express-plus designs on paper. scope is the working
proof; express-plus is the cleaner second cut.

The brief that frames this report: **express-plus is a real foundation to build
and use, not a paper exercise.** We are not waiting for a first consumer before
landing machinery, and we do not want to expand the featureset incrementally as
each app stubs its toe. The goal is a solid foundation that supports the known
use cases (the `projects/*` stress-test set) up front, structured so the
developer — and the framework author — cannot easily shoot their own foot.

So this report separates two things:

- **Bring the SHAPE now.** The validated architecture scope proves works under
  real realtime load. Build it into the express-plus foundation deliberately.
- **Keep the DISCIPLINE, drop the deferral.** scope's design rules are sound and
  worth adopting wholesale — *except* its "land machinery with the first real
  consumer, not before" sequencing rule, which the brief overrides. The
  anti-foot-gun half of that discipline (the deletion test, no second path, fail
  closed) stays; the "defer until a consumer asks" half goes.

---

## 1. The discipline to adopt (minus the deferral)

### 1.1 The deletion test — the gate on every abstraction

scope's central design rule (its ADR-0001, restated in ADR-0002 §5) is the
**deletion test**:

> Delete a candidate abstraction and look at what happens to the code. If one
> concept *absorbs* another and the net line count drops — it **concentrates**.
> Keep it. If the same code merely *moves into a config object* behind a new
> name, same net count — it **relocates**. Reject it.

This is the right gate for express-plus, and it does not depend on the deferral
rule. A relocation trap is a foot-gun whether or not a consumer exists: it adds
a name without removing a concept, so the next reader has more to learn and the
same code to maintain. Apply the deletion test to every primitive in the
foundation — `app.doc`, the grant compiler, the effect engine, the live spine.
If a primitive does not let us delete something, it is ceremony.

scope's own worked example that **passes** the test: `defineManagedResource`, a
CRUD generator that deletes a triplicated payload schema (the action shape was
written three times — domain schema, payload type, wire schema) by deriving the
wire schema from the domain schema. It concentrates: three definitions become
one. Its server half (`authorize` + `handler`) stays hand-written, because that
half *genuinely varies* per entity (ownership re-checks, cascade deletes) and a
generator would only relocate the variation into a config DSL. **The pure half
concentrates; the varying half stays explicit.** That split is the model for
every express-plus generator.

### 1.2 What the brief overrides — and what survives

scope's red line was *"Land machinery WITH the first real consumer, not
before."* The express-plus brief overrides this: we build the foundation for the
known use cases proactively. scope itself half-relaxed this rule late (its
ADR-0003 "proactive stance": the seven target apps *are* the consumer set that
justifies building the featureset out). express-plus takes that relaxation as the
baseline.

The relaxation has a bar, and we keep the bar: **"a real app in the set needs
this shape" — not "build every conceivable knob."** The `projects/*` stress-test
apps (blog-platform, reddit, library, space-invaders, minecraft, drawing-canvas,
photo-editor, google-photos, todo) are the consumer set. A feature earns its
place by being needed by one of them. A feature that no app needs (scope's
example: a WebSocket transport when SSE+POST covers every app) is the
speculative knob the brief still forbids — proactive is not the same as
exhaustive.

### 1.3 No second path — the structural anti-foot-gun

scope's hardest invariant, and the one most worth importing verbatim:

- **One mutation pipeline.** Every state change flows through dispatch. A REST
  endpoint that mutates an entity outside the pipeline is a *bug to remove*, not
  a shortcut. express-plus already states this ("Prefer a singular system");
  scope proves it holds under production load.
- **One reconciliation path.** The client's `ingest` is the *only* place an event
  becomes state — for the client's own echoed events *and* for foreign events
  arriving over the live stream. There is no second "apply" path. This is what
  makes optimistic UI safe: the optimistic apply is a *visible placeholder*, and
  the authoritative `ingest` is what resolves it. A dual reconciliation path is
  the classic source of "the two clients disagree" bugs; scope structurally
  forbids it.

express-plus should state both as load-bearing invariants, not preferences. They
are the structural form of "declaration absorbs imperative wiring": if there is
exactly one path, the developer cannot wire a second one wrong.

---

## 2. The core architecture to build now (the validated shape)

scope's core is reviewer-accepted and runs a real app. These are the pieces to
build into the express-plus foundation. Where express-plus already has a cleaner
design (notably authorization), the express-plus design wins — noted inline.

### 2.1 Action and Event are distinct, and the type system enforces it

An **Action** is an imperative client request that *may be rejected*. An
**Event** is a past-tense fact the server emitted; it already happened. scope
brands these two types with unique symbols so an Action is *not assignable* to an
Event — a structural hole TypeScript would otherwise leave open. The event
reducer is **non-optional**: an event type with no reducer is a compile error.

This matters for express-plus because the framework's whole value is owning the
event grammar. If Action and Event are the same type, a developer can hand an
unverified request to a reducer and the framework cannot tell. Brand them.

### 2.2 The one pipeline, end to end

scope's dispatch pipeline (client side):

1. **validate** — schema parse is the type guard; a bad payload never proceeds.
2. **resolve scope** — a *pure* function `(payload) => scopeRef`, no I/O. (See
   §2.4 — this purity is load-bearing.)
3. **authorize** — the grant runs. (express-plus's `scope`/`.can` model goes
   here; see §2.5.)
4. **preimage** — capture the current value of every entity the action affects,
   so a failed dispatch can roll back exactly.
5. **optimistic apply** — apply a *visible placeholder* so the UI moves
   immediately.
6. **dispatch** — send to the server; on failure, roll back every preimage and
   mark the operation failed (visibly, never silently).
7. **ingest** — fold each echoed event through its reducer *exactly once*,
   advancing the sequence cursor. The same `ingest` path handles foreign events
   from the live stream. No second write path.

The server side runs the *same* handler inside one transaction: resolve scope →
authorize *outside* the transaction → open the transaction → dedupe by action id
(idempotent: a re-sent action returns its stored events without re-running) →
run handler → assign each event a per-scope monotonic sequence number → append to
the durable log → commit → fan out to subscribers.

express-plus should own this whole pipeline. The developer declares the action's
shape and writes the handler body; the framework owns validate, scope, authorize,
preimage, optimistic, dispatch, dedupe, sequence, persist, and fan-out.

### 2.3 Persistence is opt-in by *presence*, not by a declared class

scope's owner explicitly **rejected** a `class: 'persistent' | 'ephemeral' |
'volatile'` field on actions. Instead, persistence is gated by whether a
persistence module is *wired*: the gate is `action.persistence != null`. The
class of an action (durable, ephemeral, volatile) is **emergent from which seams
it engages**, not a label it carries.

This is the same principle as express-plus's "override, not additive": you reach
a capability by engaging its slot, not by setting a flag that the framework then
interprets. A WhatsApp-style chat on scope's core expresses all three classes
from one action primitive, differing only in engaged seams:

- **durable** — persistence wired; events get a sequence number and replay.
- **ephemeral** — no persistence; journals nothing (presence heartbeats).
- **volatile** — no persistence; coalesced broadcast, emits no events (typing
  indicators).

express-plus's `app.doc` is the durable class; `app.room`'s presence/chat is the
ephemeral/volatile class. Build them as *one action primitive with engaged
seams*, not three separate mechanisms. This is "subtract before you add" made
concrete: one primitive, three emergent classes, zero class field.

> **Anti-foot-gun refinement scope flagged for us.** scope chose presence over a
> class *field* (good), but it ships a no-op persistence module named
> `persistent` whose mere presence flips the gate — a marker that does nothing.
> express-plus should make the wired seam *do the work itself* (the field-type
> plugin owns persistence strategy, per IMPLEMENTATION-PLAN §1), so there is no
> inert marker to misread.

### 2.4 `resolveScope` is pure — and that purity buys real safety

scope makes scope-resolution a *pure* function of the payload: no database read.
Two things fall out, both anti-foot-gun:

- **Unauthorized requests never open a write transaction.** Because the scope is
  known before any I/O, authorization runs *outside* the transaction. On
  single-writer SQLite this is a real win: a flood of forbidden requests cannot
  hold the write lock.
- **The scope is a typed handle, derived from declared shape**, not a string
  parsed at runtime — exactly express-plus's "no magic strings."

To make resolution pure, scope carries the scope key (its `projectId`) on every
action payload as a wire field. express-plus's typed-FK model already supplies
the scope handle from declared shape; keep resolution pure so the same
out-of-transaction-authorize win holds.

### 2.5 Authorization — express-plus is already ahead; do not regress

This is the one place scope is *weaker* than the express-plus design, and the
gap is instructive.

scope has a clean `withEditorAuth((p) => p.projectId)` factory for the common
membership check (~70% of actions). But wherever authorization depends on **row
ownership**, scope falls back to *inline, hand-written* checks restated per
handler: re-fetch the comment, verify it belongs to the project, then check
`principal.id === comment.userId` by hand. There is no `withOwnerOf(entity =>
…)` abstraction. The ownership predicate is duplicated across every handler that
needs it — a drift hazard and a foot-gun (forget the check in one handler and
that entity is unprotected).

**This is exactly the anti-pattern express-plus's `checks` + `scope(predicate)
.can(fn)` model is designed to eliminate.** A `check` is a per-entity named fact
(`owner`, `collaborator`, `editor`); a grant calls it; the framework compiles
the read half to SQL and runs the rest per-row. Ownership is declared once as a
check and reused, never restated inline. Keep this. scope's inline-ownership
mess is the concrete cost of *not* having the express-plus authorization model —
it is the strongest evidence that the model is worth its complexity.

scope does contribute one layering insight worth keeping: it runs **three**
authorization layers — pure `resolveScope` (no I/O), membership `authorize` on
the resolved scope (reads committed state, outside the transaction), and a
defense-in-depth re-check *inside* the handler that the entity actually belongs
to the resolved scope. express-plus's compiled `scope` + runtime `.can` already
covers the first two; the third (the entity-belongs-to-scope check) is worth
having the framework enforce structurally rather than leaving to each handler.

### 2.6 Sequence-cursor replay — the realtime correctness core

scope's realtime correctness rests on a per-scope monotonic **sequence number**
on every durable event, and a **sequence cursor** the client advances. On each
incoming event the client decides:

- **duplicate** (sequence < expected) — idempotent skip.
- **gap** (sequence > expected) — do *not* apply; signal a resync.
- **next** (sequence == expected) — reduce once, advance the cursor.

Because the client's own echoed events route through the *same* `ingest` and
advance the cursor, a later redelivery of the same event over the live stream is
correctly seen as a duplicate. This is what closes the double-apply corruption
that a separate echo path would open.

Resync fetches the missing events and folds them through the reducers in
sequence order. **The reducer fold is the source of truth; resync never replaces
the snapshot wholesale** (except at initial bootstrap). A "gap → silently
truncate" or "stale cursor → quietly reset" path is the foot-gun here; scope
*hard-fails* a stale cursor instead, turning "offline a week, history subtly
wrong" into a loud forced re-bootstrap. Build the hard-fail, not the silent
truncate.

> **Bootstrap ordering is a real foot-gun scope hit and documented.** The client
> must load the snapshot and set the cursor to the snapshot's sequence *before*
> starting the live stream. If the stream starts first, foreign events during the
> race resync into an empty snapshot, then the snapshot load overwrites them
> while the cursor has already advanced — permanent event loss in the gap.
> express-plus's client library (`LiveList` boot-from-snapshot then apply-deltas)
> must enforce this ordering structurally, not leave it to the developer.

### 2.7 Undo is preimage-restore, not a reverse action

scope's client-side undo *restores the captured preimage* (the pre-dispatch
value), not a hand-written inverse action. Redo restores the captured
post-state. Server-side undo *appends inverse domain events through the same
pipeline*, so the durable log stays append-only and every client converges. The
undo/redo audit markers reduce to *no state change* — convergence rides the
re-emitted inverse events, not the marker.

express-plus's IMPLEMENTATION-PLAN already reserves an `inverse` operator slot
and rejects a pipeline-level undo log as a competing truth. scope confirms the
shape: undo is *inverse mutations through the one pipeline*, plus client-local
preimage restore for immediacy. Build the preimage capture (§2.2 step 4) and the
inverse-event append; do not build a second undo log.

### 2.8 Out-of-band effects are PROJECTIONS over the committed log — this closes an open question

express-plus's FEATURES §7 and DECISIONLOG leave one question open: *out-of-band
side effects (webhooks, emails, external HTTP) are not yet designed.* The grilled
`effects` primitive covers in-transaction DB mutations only.

**scope answers this, and the answer fits express-plus's grain.** scope's
full-text-search index and its embeddings index are not in-band effects — they
are **projections over the committed event log.** After a transaction commits,
the framework fans the events out to a set of projection consumers, each of which
is *independently durable*: a projection failure never rolls back the committed
action. Adding a new derived read model (or a webhook, or an email) is writing
another projection consumer and composing it onto the post-commit fan-out. The
core fan-out API does not change.

This is the right home for out-of-band effects in express-plus:

- **In-transaction effects** (the existing `effects` primitive) — declarative
  `{ mutate, with }` cross-entity mutations that *must* be atomic with the
  origin. A target failure rolls back the origin.
- **Out-of-band effects** (new, from scope) — **projections** over the committed
  log. A webhook fires *after* commit, from a projection consumer; its failure
  is retried independently and never rolls back the origin.

The two are distinct precisely on the atomicity boundary: an effect that must
roll the origin back is in-transaction; an effect that must *not* (because it
leaves the process and cannot participate in the DB transaction) is a projection.
This dissolves the open question without a new primitive — it reuses the
committed log express-plus already has. **Recommend recording this in
DECISIONLOG.md** (see §4).

---

## 3. The DX target — proven reachable

scope proves the express-plus DX ceiling is reachable. A realtime-collaborative
feature page in scope is **30–80 lines, none of which is event handling.** The
page author:

- constructs a store with a handful of endpoint URLs and a teardown, in one
  reactive effect, and
- calls `dispatch(type, payload)` per mutation.

The framework owns the live stream, the journal, the reducers, undo, gap
recovery, and cross-tab sync. The page does not know it is doing realtime — it
reads a reactive snapshot and re-renders. This is express-plus's "declaration
absorbs imperative wiring" verified against a shipped app.

Three DX details worth importing:

- **Dispatch does not throw; it returns a result.** scope's `dispatch` returns
  `{ ok: false, reason, message }` on failure, decoded through *one* shared
  decoder so two call sites cannot drift. A prior scope bug reported every
  failure as success because two hand-rolled parsers diverged; the single
  decoder is the fix. express-plus should have one dispatch-result shape and one
  decoder, framework-owned.
- **The principal is built server-side from the session, never from the client.**
  scope's dispatch route derives the session from the request cookie, builds the
  principal `{ id: session.user.id }` itself, and uses the client-supplied id
  only as a transport correlation id. The client cannot supply its own identity.
  This is the structural form of express-plus's "two default-on layers": a route
  gate (session → principal) and a row gate (the per-action grant).
- **The read resync endpoint authorizes at a lower bar than dispatch.** Reading
  the event stream requires `viewer`; dispatching requires `editor`. Same auth
  engine, different capability — express-plus's "no second auth path" with the
  capability split the grant model already expresses.

The ceremony scope *could not* fully absorb is endpoint-URL configuration (each
page passes 3–5 URL strings). express-plus, owning both the server routes and the
client library, can absorb this into the declaration: the URLs are derived from
the declared doc/room name, not hand-passed. That is a concentration the
deletion test endorses — and the brief says build it now.

---

## 4. Recommended documentation advances

This report is paired with targeted edits to the existing express-plus docs, so
the findings live in the canonical places, not only here:

- **AGENTS.md** — add the structural invariants scope validates: the deletion
  test as the abstraction gate; one reconciliation path (`ingest` is the only
  place an event becomes state); out-of-band effects are projections over the
  committed log; persistence is opt-in by engaged seam, not a class field;
  pipeline variants are named wholes, not orthogonal boolean flags.
- **CONTEXT.md** — add the vocabulary the live-sync core needs: **action** /
  **event** (branded, distinct), **the pipeline** and its **stages**, **sequence
  cursor**, **ingest**, **preimage**, **projection** (the post-commit derived
  read model), **snapshot** / **snapshot sequence**.
- **DECISIONLOG.md** — record the resolution of the out-of-band-effects open
  question: in-transaction effects stay the `{ mutate, with }` primitive;
  out-of-band effects (webhooks, emails, external HTTP) are projections over the
  committed log, fanned out post-commit, independently durable, never rolling
  back the origin.
- **FEATURES.md** — update §7's "Out-of-band side effects … NOT yet designed" to
  point at the projection model now that the question is resolved.

---

## 5. Debts in scope NOT to carry over

scope's own code flags these as things it would do differently. Avoid them in
express-plus:

- **An identity wrapper that exists only to coax type inference.** scope wraps
  every action entry in a `pure({...})` identity function purely to make
  TypeScript infer per-entry payload types. Design the registry so entry types
  infer without a wrapper.
- **A no-op marker that flips a gate.** The `persistent` module does nothing but
  its presence flips persistence on (see §2.3). Make the engaged seam do real
  work.
- **Dual source of identity.** scope action payloads carry an optional `userId`
  the client predicts with and the server ignores (using the principal). One
  source of identity: the server principal, with the client predicting against a
  client-known id, never a payload field the server discards.
- **Inconsistent event naming.** One scope event uses a colon
  (`file:uploaded`) where every other uses a dot. Pick one separator and lint it.
- **Two monotonic counters on one row labeled `seq`.** scope keeps an event
  sequence and an action sequence on the same cursor row, both called some form
  of "seq," inviting "which seq?" confusion. Name them distinctly (express-plus
  house rule: distinguish similar-but-different concepts).
- **Inline ownership authorization** (§2.5) — the single biggest structural debt,
  and the one express-plus's authorization model already fixes. Do not regress
  into per-handler ownership checks.

---

## Summary

scope is the working proof that express-plus's design is buildable: the one
pipeline, branded action/event, opt-in persistence by engaged seam, pure scope
resolution, sequence-cursor replay, preimage-restore undo, and projections over
the committed log all run a real app under real realtime load. Build that shape
now, proactively, for the `projects/*` use-case set — gated by the deletion test
and the no-second-path invariant so the foundation is solid and hard to misuse.
Keep express-plus's authorization model exactly as designed; it is the one place
the paper design is already ahead of the shipped one. The single open question
express-plus carried — out-of-band side effects — is answered by scope's
projection model and should be recorded as resolved.
