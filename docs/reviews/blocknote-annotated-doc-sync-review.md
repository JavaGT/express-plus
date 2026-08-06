# Review: Improving annotated-doc data & sync with ideas from BlockNote

Status: analysis only — no decisions made. Evidence-based; existing architecture
rules (`AGENTS.md`, `CONTEXT.md`, ADR 0005, the v9/operated lattice doc) are
treated as binding constraints, not as things to casually overturn.

Sources: BlockNote official docs and repo (citations inline), plus a read of the
current annotated-text machinery in `src/` and `public/` (file:line evidence).

---

## 1. What each system is

### 1.1 BlockNote (the object of study)

BlockNote is a **block-based rich-text editor** built on ProseMirror/Tiptap. Its
document model is an ordered list of `Block`s, each with a stable `id`, a `type`,
`props`, rich-text `content` (an array of styled runs / inline annotations), and
recursive `children` for nesting. It collaborates through **Yjs** — the document
is mirrored into a `Y.XmlFragment` bound to ProseMirror, and the network layer is
a pluggable Yjs provider (`y-websocket`, `y-indexeddb`, Liveblocks, PartyKit…).
Presence/cursors use the Yjs **awareness** protocol, kept separate from the
document CRDT so cursor churn does not pollute history or undo stacks.

The pieces Workbench would most plausibly learn from:

- Stable **block IDs** as first-class CRDT-synced identity (not a SQL position).
- **Inline annotations** represented as *styled runs inside a block's text*,
  rather than whole-block/whole-group membership.
- **Per-user undo** via Yjs `UndoManager` (reverts only the current user's
  changes) instead of a server-side compensation action.
- A single reconciliation path through Yjs where local *and* remote edits share
  one ProseMirror transaction system.
- Offline-first sync delegated to the provider.

### 1.2 Workbench annotated-text (the subject)

Workbench's annotated-text is a block-based document too, but built differently:

- **One RGA CRDT** (`text.crdt()`) partitioned into contiguous "blocks" by a
  `position` column; blocks are not CRDTs themselves. See
  `src/annotated-text-family.mjs:121-155` and `docs/adr/0005-annotated-text-kernel.md`.
- **Annotations attach to whole blocks / whole block-groups** — there is no
  inline/range granularity inside a block's text at the public wire level
  (`src/annotated-text-recipient-projection.mjs:168-173`).
- **Public wire is v9 offset edits only**; durable log carries `operated`
  v1–v11 (`docs/annotated-text-public-v9-operated-lattice.md`).
- **Live delivery is snapshot-only** — annotated `operated` forces a full
  snapshot resync, never a live op fold (`src/live-fanout.mjs:245-252`).
- **Client fold is materialize-only** — the whole field document is replaced
  from a fresh recipient snapshot (`public/workbench-annotated-text-snapshot.mjs:60-72`).
- **Undo/redo is a server compensation action** limited to `text.insert`
  contributions (`src/entity/crud.mjs:1531-1567`).

---

## 2. Findings mapped to candidate improvements

This section goes line-by-line through the areas where BlockNote's design is
directly relevant. Each is labelled with a rough value/size/risk and whether it
conflicts with Workbench architecture rules.

### 2.1 Block identity: CRDT-meaningful block IDs vs SQL `position` — **high value, medium risk**

BlockNote treats **block `id` as CRDT-synced identity** that persists from
creation to removal (structure docs; `packages/core/yjs` conversion). Workbench
derives block order from a SQL `position` column re-staged during projection
(`src/entity/projection.mjs:196-200`), and blocks have **no RGA/CRDT identity**
(`src/annotated-text-r2.mjs:93-94`). Consequently every split/merge is a durable
projection event, not a convergent op.

BlockNote's approach would let block *structural* operations (insert, move,
split, merge, nest) be expressed as convergent ops with stable references, and
would make reorder/nest first-class rather than a re-staged position. But it
collides head-on with the "no second write path" / "one reconciliation path"
rules: Workbench deliberately keeps block structure ordinary durable rows and
lets only the character stream be CRDT. Adopting CRDT block order would be a
**second machine** unless it folds through the same committed-log grammar.

If pursued, the least-invasive read is: keep the RGA as the only CRDT, but give
blocks **stable, immutable public IDs** (as the canonical snapshot already does)
and make block insert/move/split/merge *structural-anchor* operations instead of
re-staged positions — i.e. deepen the existing lattice rather than add a block
CRDT. This is a v-lattice migration (see 2.4), not a new machine.

### 2.2 Inline annotations inside block text vs whole-block membership — **high value, high risk**

BlockNote stores **inline annotations as styled runs inside a block's text**
(`InlineContent` = `StyledText` runs with `styles`; inline-content docs). The
result: annotating a sub-range of text needs **no block split**; the run is just
a styled segment.

Workbench requires a **physical block split** to annotate a sub-range: the RGA
block is partitioned so the annotated span becomes its own block
(`src/annotated-text-membership.mjs`; `isolateAnnotationSelection` in
`annotated-text-r4.mjs:90-135`, which performs 0/1/2 `splitBlock` calls). An
annotation can therefore never survive a merge of the text it wraps, and
selection crossing blocks is a separate multi-block (v7) path normalized down to
v4 (`src/entity/crud.mjs:567-586`).

BlockNote's run-based model is strictly more expressive for the common "highlight
these words" case and removes the split machinery. But it is a **large, risky
change** to the core grammar: it implies range-anchored annotations inside a
block, structural endpoints that can span fractional runs, and a new durable
version shape. It also interacts with the protection model (restricted spans vs
whole blocks). This is the single biggest divergence between the two systems and
would ripple through the projection switch, membership, protection, and the
recipient snapshot shapes.

This is not a "borrow and bolt on" — it is a redesign of the annotation model.
Worth a dedicated ADR/grill before any code, and it likely outranks the pure
sync improvements below because it changes what the data model *is*.

### 2.3 Live sync: snapshot-only resync vs live op fold — **high value, medium risk**

BlockNote syncs **live and incrementally**: remote Yjs updates become ProseMirror
transactions through one binding, so collaborators see edits without any
full-document refetch (collaboration docs; DeepWiki 8.1/8.3).

Workbench explicitly does **snapshot-only** for annotated text: an annotated
`operated` event sends `resync` / `annotated-text-snapshot-required` to every
subscriber and never delivers an op envelope (`src/live-fanout.mjs:201-252`,
`docs/annotated-text-public-v9-operated-lattice.md:17,48-52`). The client has no
`'operated'` fold — only the separate `crdt:text` path folds `'applied'` ops live
(`public/workbench-client.mjs:1304-1316`). So every annotated edit costs a full
snapshot round-trip to *every* subscriber.

The interesting fact: **Workbench already has a live op-fold path for plain
`text.crdt()`** (`src/text-reducer-transport.mjs`; `_applyFieldOp` `'applied'` →
`applyTextOp` → `materializeText`). The annotated path deliberately does not use
it. The lattice doc frames this as a non-goal ("No live op-fold path beside
snapshot materialize"). BlockNote demonstrates that incremental live delivery for
a block document is achievable; the value here is latency and bandwidth on
collaborative sessions.

The risk is architectural: bringing live op folding to annotated text would give
the client a **second fold authority** unless it reuses the exact RGA fold the
`crdt:text` path already uses — which requires the durable `operated` versions to
carry enough RGA info to fold, and re-authorization on delivery (already a
guarantee in `live-fanout`). This is a real candidate but must be conditioned on
"one fold" surviving: the fold must be the same RGA reducer, applied to delivered
ops, not a fresh materialize. BlockNote's single-binding design is the model to
emulate here, not to copy.

### 2.4 Version lattice v1–v11 vs a smaller public surface — **medium value, low risk**

Workbench's public surface is one v9 assert
(`src/entity/crud.mjs:79-132`), but the durable log and projection switch carry
**nine durable versions** (v1–v11) dispatched by name
(`src/entity/projection.mjs:135-144`). BlockNote keeps a single document shape
and a single Yjs schema. The lattice doc already names version collapse "a
separate migration ticket with replay proofs" (lattice doc:44-46,60-61).

The improvement here is not borrowing a BlockNote technology — it is a
rationalization opportunity the BlockNote comparison makes vivid: Workbench's
*sync* machinery is simple, but its *replay* machinery is complex precisely
because every structural change is a new durable version. If block structure
became convergent (2.1) or annotations became runs (2.2), the version lattice
would shrink rather than grow. So this finding is largely a *consequence* of
2.1/2.2 rather than an independent lever.

### 2.5 Authoring tokens / leases vs ordinary conflict handling — **medium value, low risk**

Workbench gates annotated mutations on a heavy server-issued **authoring
envelope** (stream + lease + position tokens + snapshot fences), with hard caps
(16 leases/stream, 16MB/lease, 64MB/stream) and position tokens that freeze a
family checkpoint and can go stale on any concurrent commit
(`src/annotated-text-authoring-stream.mjs:5-8,108-114,173-232`;
`src/annotated-text-admit.mjs:27-33,60-73`). BlockNote has no such thing — Yjs
ops carry their own identity/frontier and merge without a server lease.

The token machinery exists because Workbench's **public wire is offset-based**
(v9 offsets whose structural meaning must be resolved against a frozen
checkpoint). BlockNote's CRDT ops are self-describing, so no lease is needed.
This suggests the authoring-envelope complexity is downstream of the offset-based
public model; if annotations/ops became structural (2.1/2.2), the lease layer
could simplify. **Not an independent change** — same root cause as 2.4.

### 2.6 Per-user undo vs server compensation — **medium value, low risk**

Workbench's undo/redo is a **server compensation action** that only undoes
`text.insert` contributions, and only if the scalars still live and are owned by
the same block; concurrent-ownership conflicts throw (`src/entity/crud.mjs:1531-1567`).
BlockNote uses Yjs `UndoManager`, giving **per-user undo stacks** that revert only
the current user's changes and respect concurrent collaborators (DeepWiki 8.1);
with collaboration on, ProseMirror's global history is disabled (8.3).

BlockNote's per-user undo is a clear UX win and a simpler mental model than
server-compensation. But it presses on the same "no second write path" rule:
undo would either remain a durable compensation action (current) or become a
client CRDT concern (BlockNote-style). The current design is fully consistent
with Workbench's machine; the BlockNote model is not directly adoptable without
changing where undo lives. Mark as a *candidate for the long-term* — the
compensation approach is defensible, and swapping it is a product decision, not a
mechanical borrow.

### 2.7 Presence: separate ephemeral channel already matches — **low value, no change**

BlockNote keeps awareness separate from the document CRDT so cursor churn does
not pollute history (DeepWiki 8.1). Workbench already does exactly this: carets
are a fully separate `annotated-text-caret` message type on an ephemeral field,
generation-fenced and re-authorized per recipient (`src/annotated-text-caret-live.mjs`),
with the projector deliberately reusing the recipient projection so protection
cannot drift (`src/annotated-text-caret-projection.mjs:20-22`). **No change
justified** — Workbench is already on the alerting-"separate awareness" design.
One small note: Workbench's caret *sends* are happy-path only (no queue/replay,
`workbench-client.mjs:299-340`), which BlockNote's awareness protocol also
tolerates; no action needed.

### 2.8 Offline / fork — **low value for now**

BlockNote delegates offline to the provider and supports `ForkYDoc` for
document forking/versioning (collaboration docs; DeepWiki 8.3). Workbench has a
local-log/cross-tab path that is **demand-gated** (architecture-map:98, "S6"),
and the lattice doc explicitly non-goals a live op-fold. Offline annotated editing
is not currently in scope; this is a **park** until the live fold (2.3) is decided.

---

## 3. Conflicts with existing architecture rules

| Candidate | Conflicts? | Notes |
| --- | --- | --- |
| CRDT block identity (2.1) | **Yes** — "no second write path" / "one reconciliation path" | Only adopt as structural ops on the existing committed log, not a block CRDT |
| Inline run annotations (2.2) | **Yes** — grammar change, projection switch, protection, snapshot shapes | Highest risk; a redesign, needs its own ADR |
| Live op fold (2.3) | **Conditional** — reuses existing `crdt:text` fold | Must reuse the RGA fold, not add a second authority |
| Version rationalization (2.4) | No | Consequence of 2.1/2.2 |
| Simpler authoring (2.5) | No | Consequence of offset→structural |
| Per-user undo (2.6) | **Yes** — where undo lives | Product decision, long-term |
| Presence (2.7) | No | Already aligned |
| Offline/fork (2.8) | **Yes** — demand-gated | Park |

---

## 4. Suggested reading & validation

- BlockNote primary sources: `https://www.blocknotejs.org/docs/foundations/document-structure`,
  `…/features/blocks/inline-content`, `…/features/collaboration`,
  `…/reference/editor/yjs-utilities`, and `packages/core/src/yjs/extensions/index.ts`
  (via unpkg). Some internals (awareness field names, mark encoding) rest on
  DeepWiki auto-generated notes from a Feb-2026 commit and should be
  spot-checked against source before acting.
- Workbench current state: `docs/annotated-text-public-v9-operated-lattice.md`,
  `docs/adr/0005-annotated-text-kernel.md`, `src/annotated-text-family.mjs`,
  `src/entity/projection.mjs:127-194`, `src/live-fanout.mjs:201-252`,
  `src/annotated-text-membership.mjs`, `public/workbench-annotated-text-snapshot.mjs`.

## 5. Bottom line

The highest-leverage divergence is **2.2 (inline run annotations)** — BlockNote's
data model is strictly more expressive and would remove Workbench's split-for-subrange
machinery, but it is a redesign of the core grammar. The most directly actionable
improvement consistent with Workbench's rules is **2.3 (live op fold reusing the
existing RGA fold)** — it is the change BlockNote demonstrates most clearly and
Workbench already has the folding primitive for plain `text.crdt()`. Items 2.4/2.5
are downstream of 2.1/2.2; 2.7 needs no change; 2.8 is parked. BlockNote's value
to Workbench is less a technology to import and more a prompt to reconsider
whether block identity and annotation granularity deserve to be first-class CRDT
concepts — a question only an ADR-level grilling can settle.

---

## Update (2026-08-06)

The design questions this review raised have since been settled. The settled
outcome makes annotated-text a single **span-native model**: annotations are
arbitrary overlapping ranges (structural, affinity-bound endpoints) over the RGA
text, replacing the whole-block-only membership and its physical block-split
machinery. A `protecting` annotation applied over a range creates a
**confidential span**, redacted per-recipient server-side at delivery — the
recipient projection is the confidentiality boundary, and the raw denied text
never reaches an unauthorized client.

The key decisions reached: redaction is the **union of denied intervals**
(overlapping denied spans merge into one placeholder, leaking no structure);
confidentiality uses **show-through**, so comments and annotations render in full
over confidential text and only the underlying information is redacted; **nesting**
is deny-transitive-outward but allow-not-inward, with denied interior intervals
joining the denied union; the hidden placeholder is an affinity-bound, non-editable
**gap** (typing attaches to the visible neighbor); spans **split/merge with blocks**;
undo is a **server-owned durable compensation** action that works on spans as units
and never leaks hidden text; and the migration is a **breaking delete-old-DB**
collapse of the v1–v11 durable lattice to a single span-native model, with no
replay of historical rows.

The authoritative record is `docs/adr/0008-inline-confidential-spans.md`, with
implementation tracked as GitHub issues **#22–#28** (epic and tickets). Where this
review's findings differ from that record, the ADR and issues govern.