# Semantic operations and reducer projections

This is the required programming model for durable Workbench behavior. It takes
the useful unidirectional-flow idea often associated with Redux and applies it
to a durable, authorized, collaborative system. This is an analogy, not a
second Redux architecture:

```text
Action -> authorize -> semantic operation/event -> reducer/projection -> delivery -> client ingest -> rendered state
```

The UI, HTTP transport, WebSocket transport, and client optimism do not own a
second state transition. They request or display the result of this path.

## The vocabulary

| Term | Meaning | Must not become |
| --- | --- | --- |
| Action | A caller's requested change before authorization. | A trusted state mutation. |
| Semantic operation | The precise durable contribution that an accepted Action makes. | A broad replacement of current state. |
| Event | The committed record of that accepted operation. | A client-only notification with hidden mutation rules. |
| Reducer/projection | Deterministic code deriving durable or client state from prior state and an event. | An ad-hoc second write path. |
| Contribution/provenance | Stable identities and facts an operation created, removed, or transformed. | A guess based only on current visible text. |
| Compensation | A later operation that reverses or counteracts an earlier contribution against current state. | Restoring an old whole-state image. |
| Snapshot | An authorized bootstrap, resync, backup, recovery, or integrity representation of state. | The normal meaning of a collaborative edit, undo, or redo. |

## Required design questions

Before adding a durable behavior, answer these in the issue, test, or code
review packet:

1. What domain intent does the Action name?
2. What exact contribution does the accepted operation make?
3. Which stable identities let a later operation refer to that contribution?
4. Which projection owns the affected durable state or client view, and what invariant does it preserve?
5. What does the operation do when current state has changed concurrently?
6. How do retry and delivery deduplication identify the same operation?
7. If it is undoable, what compensating operation acts on current state, and what
   does redo compensate?
8. Which information is durable, which is recipient-projected, and which is
   ephemeral?

If these questions cannot be answered, do not hide the ambiguity in a client
callback, a database update, or a snapshot restore. Settle the operation
contract first.

## Rules for agents

### Write semantic operations

Prefer actions such as:

- `text.insert` with identities for the inserted CRDT elements.
- `annotation.apply` with the exact declared target/range facts.
- `membership.grant` with the member and capability contribution.
- `undo` translated to a compensation targeting one prior action's surviving
  contribution.

Avoid actions such as:

- `document.replace` solely because it is easier than representing the edit.
- `restore(beforeSnapshot)` as ordinary collaborative undo.
- A browser-local reducer whose result is separately persisted by the server.
- A direct SQL update that duplicates a declared handler/projection transition.

An operation may legitimately replace a value when replacement is the domain
meaning, for example "set this preference to dark" or an authorized import. It
must still be one declared Action, one authorized commit path, and one owning
projection for the affected state.
Do not confuse a value-setting operation with an implementation that silently
overwrites a larger unrelated projection.

### Reduce against current state

The projection that owns a particular durable state or client view must apply an
event to its actual current input, not assume that an
earlier snapshot is still current. A concurrent change therefore has an explicit
outcome:

- Both contributions coexist when their algebra permits it.
- The declared operation wins when the domain explicitly chooses that rule.
- The operation becomes an idempotent no-op when its target no longer survives.
- The operation fails closed when no safe deterministic transform exists.

Never silently rewind unrelated state to make an old request fit.

### Collaborative undo and redo

Collaborative compensation is the required target contract for history. Issue
`#13` owns the necessary history API/provenance changes; do not claim the
current snapshot-backed annotated history API already supplies this behavior.

Undo is not time travel. It is a new durable compensation authored by the user
who owns the eligible cursor entry. It must preserve other users' later,
unrelated contributions.

For example, if Alice inserts text and Bob edits elsewhere, Alice's undo targets
Alice's inserted element identities. It does not restore the document as it was
before Alice typed. Redo compensates Alice's completed undo; it does not reload
an old after-image.

Compound operations compensate atomically. If an edit created text, structure,
annotation membership, and derived measurement facts, its compensation either
transforms that declared contribution as one operation or produces the specified
no-op/failure. It does not partially restore a document image.

### Snapshots have a different job

Snapshots are correct for initial loading, reconnect/resync, recovery, backup,
and integrity validation. They are delivery or recovery artifacts. A snapshot
does not create a second reconciliation path: normal clients still settle via
the shared `ingest`/fold decision.

Do not use a snapshot as a shortcut for the meaning of an ordinary edit,
collaborative undo, redo, retry, or conflict resolution. If private recovery
needs an image, keep it package-owned, validate it before use, and do not expose
it as an application mutation API.

## Review checks

Reject a change when it introduces any of the following without an explicit,
ratified exception:

- Two ways to mutate the same durable state.
- A reducer/fold different from the one that handles delivered events.
- An inverse that replaces broad current state instead of compensating the
  original contribution.
- A retry that can create a second contribution because it lacks durable
  idempotency identity.
- A conflict rule that is implicit in timing, client order, or a hidden SQL
  update rather than declared and tested.
- A snapshot used as a normal collaboration operation rather than bootstrap,
  resync, recovery, backup, or integrity machinery.

## Relationship to the three loops

This model strengthens the existing architecture; it does not add another
machine.

- **Compile:** declarations define the valid Actions, operation grammar,
  reducer laws, authorization, and durable facts.
- **Commit:** one authorized handler accepts an Action and records one durable
  semantic operation/event before its projection changes state.
- **Deliver:** every client, including the author, reaches settled state through
  the same replay decision and `ingest` fold.

See `AGENTS.md` for the binding architecture rules and
[`durable-history-contract.md`](./durable-history-contract.md) for the history
contract.
