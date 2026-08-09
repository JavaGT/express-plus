# Annotated-doc interaction parity — blockless re-scope (issue #4)

Date: 2026-08-09 · Coordinator: DeepSeek Flash (epic lead) · Repo: `JavaGT/workbench`

The #5–#12 chain was written against the **block-era** annotated-text editor
(every paragraph was a `block` with a `blockId`, block groups, split/merge
commands). The blockless cutover has since landed:

- **#55** (`bdda499`) — blockless public API cutover: one continuous RGA text
  stream per document; annotations are absolute document ranges; `{ blockId,
  offset }` is gone; positions are absolute UTF-16 offsets + affinity.
- **#33** — the block layer was removed (split/merge/group commands rejected in
  `annotated-text-admit.ts`).
- **#32** — client CRDT fold: one ingest reconciliation path.
- **#13** — collaborative compensating undo/redo (landed; `annotated-text-history`).
- **#22** — span-native confidential spans + redacted editing (landed).

This document re-scopes each child in blockless vocabulary, records its current
status against HEAD (`6e8d6cc`), and defines the delegated acceptance that the
epic will land and verify.

## Blockless vocabulary

| Block-era term | Blockless meaning |
| --- | --- |
| paragraph / visible block | an **LF-delimited text run** in the one document text |
| empty paragraph | an empty run between two `\n` (or a run at document start/end bounded by `\n`) — representable purely as text (`\n\n`) |
| paragraph anchor | no structural element exists; boundaries are `\n` scalars in the text stream |
| cross-block selection | an offset range spanning at least one `\n` |
| cross-block replacement | one `text.replace` whose range spans `\n` and whose replacement may itself contain `\n` |
| `blockId` position | absolute UTF-16 offset into the continuous text (half-open ranges; surrogate-splitting offsets rejected) |
| block paint | keyed per-run paint; an ordinary edit must not rebuild unrelated runs |
| `splitBlock` / `mergeBlocks` | `\n` insert / `\n` deletion at run boundaries via the ordinary replace path |

## Per-child status

### #11 — Represent empty paragraphs with paragraph anchors

**Blockless meaning.** There are no blocks and no anchors. Empty paragraphs are
empty LF-delimited runs; `\n` is ordinary scalar text. The grammar already
represents them: `a\n\nb` persists, projects, reloads, and replays as text.

**Current status.** **SUPERSEDED by #55/#33.** The anchor model no longer has a
target: the cutover removed the block element an anchor would live on. Insertion
at an LF boundary is ordinary affinity-resolved insertion; deletion never
removes the ability to represent an empty run.

**Delegated acceptance (blockless).**
1. A family persists, restores, projects, and reloads a document with leading,
   middle, and trailing empty LF-delimited runs without losing order.
2. Insertion at an LF boundary (offset naming a `\n`, or between two `\n`s)
   produces visible text and converges through replay.
3. Deletion of a paragraph's last visible scalar leaves the empty run in place
   (`\n\n`) instead of collapsing both boundaries.
4. Replacement at offsets 0 and at `text.length` behaves atomically and never
   produces an unpaired or re-ordered run sequence.
5. Annotation ranges spanning empty runs remain LF-anchor-safe (endpoint
   resolution at `\n` boundaries is surrogate-safe).

### #12 — Migrate annotated-text checkpoints to the anchored grammar

**Blockless meaning.** There is no anchored grammar to migrate *to*. The one
canonical checkpoint grammar is the continuous family (public action version 9,
plan version 13). #13 replaced snapshot-backed undo with compensating actions.

**Current status.** **SUPERSEDED by #55/#33/#13.** `bdda499` removed the last
public block-era grammar; `docs/annotated-text-undo-algebra.md` and
`src/annotated-text-history.ts` implement the compensating-action recovery
policy. No migration remains: there is no anchorless checkpoint variant in
production use.

**Delegated acceptance.** Verification only — prove the continuous checkpoint
survives reload/replay across an empty-run document and that no public
block-era writer or compatibility mutation grammar is exported (the negative
type tests from #55 already assert this; the re-scope adds runtime coverage).

### #5 — Atomic annotated-text replacement across paragraphs

**Blockless meaning.** 'Paragraph' = LF-delimited run. Atomic replacement = one
`text.replace` (or `text.insert`/`text.delete`) over absolute offsets; the range
may span `\n`, the replacement may contain `\n`, and it is exactly one durable
mutation through normal Workbench ingest. Enter inserts `\n`; paragraph-boundary
Backspace/Delete removes the `\n` (joins runs).

**Current status.** **MECHANISM LANDED, ACCEPTANCE UNPROVEN.**
`text.replace` is a first-class edit in `annotated-text-action-builder.ts:30`,
`session.replace` in `createAnnotatedTextHttpSession`, `admitTextEdit` in
`annotated-text-admit.ts:310`, `planTextOffsetEdit` (delete+insert pair) in
`annotated-text-plan.ts:167`, and the fold envelope translates it as one
delete+insert in `annotated-text-fold-envelope.ts:150`. The editor routes
typing-over-selection, paste, and composition through `session.replace`. Empty
paragraphs are representable (text). **Gap:** the browser editor does not handle
`insertParagraph` / `insertLineBreak` (Enter/Shift+Enter), so Enter cannot
create a paragraph boundary yet.

**Delegated acceptance.**
1. A replace whose range spans `\n` and whose replacement contains `\n` produces
   the correct ordered runs after settlement and reload.
2. Selection replacement is one durable mutation (single action; verified at the
   HTTP-session seam as one `text.replace` action — no delete-then-insert pair).
3. Enter creates a paragraph boundary (`\n` insert); Backspace/Delete at a
   paragraph boundary joins runs (the `\n` is deleted).
4. Reversed, hidden, stale, out-of-range, and surrogate-splitting positions fail
   with no partial write.
5. Concurrent authors editing distinct runs converge through the session.
6. Focused core and HTTP-session tests cover the above (new
   `test/annotated-text-paragraph-runs.test.mjs`), plus the editor Enter gap.

### #6 — Apply annotations across annotated-text selections

**Blockless meaning.** 'Cross-block selection' = an absolute range spanning `\n`.
One durable annotation anchors one contiguous range over the continuous text;
membership normalization is range-over-text. Identical, adjacent, crossing,
contained, containing, and multiline annotations coexist as independent ranges.
Boundary affinity: insertion at a comment start is included, at its end
excluded, strictly inside included, before/after excluded.

**Current status.** **MECHANISM LANDED, MULTILINE UNPROVEN.**
`planTextRangeApply` (`annotated-text-plan.ts:208`) applies one contiguous
range; affinity is resolved at `resolveOffsetToEndpoint`; emptied-annotation
dispositions flow through the fold (`applyAnnotatedTextFoldDispositions`);
boundary-typing affinity is covered by browser tests. **Gap:** no focused test
proves cross-LF annotation application or that identical/adjacent/crossing/
contained/containing/multiline memberships coexist and normalize through
subsequent edits.

**Delegated acceptance.**
1. Applying a comment annotation to a cross-LF selection anchors one range that
   spans the runs and projects, persists, and reloads intact.
2. Identical, adjacent, crossing, contained, containing, and multiline
   annotations coexist without nesting or loss.
3. Insertion at a comment start is included; at the end excluded; strictly
   inside included; before/after excluded (already green; re-asserted over LF
   runs).
4. Deletion and replacement transform every overlapping annotation
   deterministically; the declared empty/orphan policy is applied server-side.
5. Invalid, collapsed, reversed, hidden, stale, out-of-range, and
   surrogate-splitting selections fail atomically.
6. Core tests prove membership normalization, recipient projection,
   persistence, and replay.

### #7 — Render annotated-text as incremental paragraphs

**Blockless meaning.** LF-delimited runs render as **keyed paragraph fragments**
inside the one contentEditable root; an ordinary edit repaints only the affected
run (unchanged runs keep node identity). Native character/word/line/document and
Shift navigation, clipboard, composition, selection replacement, Enter, and
paragraph-boundary Backspace/Delete all flow through the package session seam.
Annotation overlap renders flat (maximal flat runs of constant annotation-id
set), never nested, and never alters text or selection offsets.

**Current status.** **PARTIAL.** The editor is one contentEditable root span;
native navigation, paste, composition, scalar-safe deletion, boundary affinity,
and annotation overlap already work and are browser-tested. **Not done:**
keyed per-run painting with preserved node identity; a regression test that
rejects full-document rebuilding; Enter (`insertParagraph`/`insertLineBreak`)
and Cut (`deleteByCut`) handling.

**Delegated acceptance.**
1. All LF-delimited runs render as keyed paragraph fragments inside the single
   contentEditable root, including empty runs.
2. DOM selection maps directionally to and from absolute wire offsets without
   clamping unsupported boundaries (redaction placeholders stay non-editable).
3. Native character, word, line, document, and Shift navigation works across
   runs.
4. Copy, cut, paste, text composition, selection replacement, Enter, and
   paragraph-boundary Backspace/Delete use session mutations only (add
   `insertParagraph`, `insertLineBreak`, `deleteByCut`).
5. Annotation overlap renders flat; rendering never alters text or selection
   offsets.
6. Ordinary editing preserves unchanged run and fragment node identity; a
   regression test rejects full-document rebuilding.
7. jsdom + browser tests cover multi-run selection, clipboard, composition,
   surrogate safety, reconciliation after a remote change, and the no-rebuild
   guarantee. Existing browser spec selectors that assumed a flat single-span
   DOM are updated to the keyed-run shape.

### #8 — Compose durable comment threads from selections

**Blockless meaning.** A 'thread' is a durable **discussion entity** plus a
`comment` annotation over an absolute text range. One declaration-derived
Workbench action creates the project-owned discussion row **and** applies the
comment annotation atomically. The browser gets one narrow typed session method;
no generated CRUD batch and no caller-selected IDs.

**Current status.** **NOT DONE.** The demo applies a `comment` marker via
`session.applyAnnotation` with a client-generated annotation id and caller
fields (`index.html` `addCommentMarker`). That is deliberately the prototype
path, not the declared action. No discussion entity, no `annotationAction`
implementation, no typed session method.

**Delegated acceptance.**
1. A declared comment action atomically creates its project-owned discussion
   row and applies its annotation to a valid visible selection.
2. Project, authenticated author, IDs, defaults, relation, annotation family,
   and document basis are package-derived, never caller-controlled.
3. Unauthorized, stale, hidden, malformed, cross-project, collapsed,
   projection-failing, or invalid-range requests leave neither discussion nor
   annotation.
4. Retry uses one durable receipt and derives stable discussion/annotation
   identities (idempotent on the receipt).
5. Recipient/project-shell projection never leaks comment content or the
   discussion association outside declared document-authorized delivery.
6. The annotated-doc demo composes and displays a comment thread for a selected
   range using only the typed session action.
7. Focused core + HTTP-session + browser tests cover 1–6.

### #9 — Expose recipient-projected editor carets

**Blockless meaning.** A caret is **one absolute UTF-16 offset** into the
continuous text; it is ephemeral recipient-projected presence, never durable,
never placeholder text. Restricted recipients receive only an opaque edge
(`{ kind: 'edge', edge: 'start' }`), never offsets.

**Current status.** **TRANSPORT LANDED, CLIENT NOT WIRED.**
Server-side is complete and tested: `createAnnotatedTextCaretLive`
(`src/annotated-text-caret-live.ts`) — upsert/clear/retract, presence
stability, per-recipient projection, re-authorization before delivery;
`projectAnnotatedTextCaretForRecipient` (`annotated-text-caret-projection.ts`)
— edge-only for redacted recipients; WebSocket `caret.update`/`caret.clear`
handling in `live-connection.ts`; `LiveChannel` client supports `carets`
interest + `onCaret` + `updateCaret`/`clearCaret`. **Gaps:** the
`createAnnotatedTextHttpSession` session does not expose caret publish or
subscribe; the editor binding neither publishes collapsed local carets nor
renders remote ones; the demo declares no `carets` option; no client/demo
tests.

**Delegated acceptance.**
1. A focused editor publishes collapsed local caret positions through its
   document session (one channel, not a second live path).
2. Updates are deduplicated, frame-coalesced, continuously throttled; focus and
   clear transitions publish immediately.
3. Blur, close, document switch, disconnect, and lost visibility/access clear
   local presence.
4. Remote carets render as selection-neutral decorations; restricted recipients
   receive edge-only presence and never offsets.
5. Carets never enter durable history or optimistic placeholder text.
6. Client/session + editor + browser tests cover subscription interest,
   recipient projection, reconnect, rate limiting, and cleanup.

### #10 — Gate annotated-doc against the Google Docs interaction matrix

**Blockless meaning.** The demo is the executable reference for the study:
multiple paragraphs, native navigation/directional selection, cut/copy/paste,
overlapping comments, and durable comment threads through generic Workbench
public seams, plus performance/convergence guardrails. Smart chips remain
excluded pending a typed inline-atom model.

**Current status.** **PARTIAL.** Large parts of the matrix are already
browser-covered (boundary affinity, paste, IME composition, two-tab
convergence, reload persistence, confidential redaction, orphan policy). The
matrix is not complete (paragraph runs, cross-LF comment + replace, comment
threads, carets, no-rebuild guard) and the README does not name the supported
interaction boundary.

**Delegated acceptance.**
1. The demo supports multiple paragraphs, native navigation and directional
   selection, cut/copy/paste, overlapping comments, and comment threads through
   generic Workbench public seams.
2. Browser tests cover the study checkpoints: separate comment anchors;
   before/inside/after insertion; identical/crossing/contained/containing/
   adjacent annotations; edit/delete/replacement in overlaps; multiline
   selection/comment/clipboard; two-tab distinct-run and annotated-range
   convergence.
3. The browser suite proves reload persistence and never simulates a user
   mutation with direct database writes.
4. A performance regression proves ordinary keystrokes do not rebuild unrelated
   runs/fragments or scan every annotation.
5. README names the supported interaction boundary and explicitly excludes smart
   chips pending a typed inline-atom model.
6. Existing project/browser/package tests pass.

## Global invariants (preserved)

- One commit authority + one ingest reconciliation path (`createAnnotatedTextHttpSession`
  fold + receipt; no second apply path).
- Annotations are ranges over continuous text; visible positions are UTF-16
  offsets (half-open; surrogate-splitting offsets reject).
- Carets are recipient-projected ephemeral presence — never durable.
- Comments are durable structural annotations; threads add a durable
  discussion entity authored through a declared action.
- Smart chips excluded until a typed inline-atom model exists.
- The client never folds confidential ops; redacted editing fails closed.
- The demo uses the blockless public API only.

## Dependency / delegation order

| # | Component | Tickets | Files (exclusive) | Gate |
| --- | --- | --- | --- | --- |
| A | Re-scope verification | #11, #12, #5 (core/session), #6 | `test/annotated-text-paragraph-runs.test.mjs` (new) | none |
| B | Keyed paragraph rendering + editor input gaps | #7 (+ #5 Enter/cut) | `public/workbench-annotated-text-editor.mjs`, `test/annotated-text-editor.test.mjs`, `test/browser/annotated-doc.spec.mjs` | A |
| C | Client/demo carets | #9 | `public/workbench-client.mjs`, `projects/annotated-doc/server.mjs`, `projects/annotated-doc/public/index.html`, editor.mjs (caret publish/render), `test/annotated-text-caret-session.test.mjs` (new), editor test additions, demo smoke | B |
| D | Declared comment-thread action | #8 | `src/annotated-text-thread-action.ts` (new) + public exports, `src/index.mjs`/`.ts`, demo server + panel + index, `test/annotated-text-thread-action.test.mjs` (new) | C |
| E | Demo matrix + README | #10 | `test/browser/annotated-doc.spec.mjs`, `projects/annotated-doc/README.md` | B, C, D |

Sol authority review is required on D (public API, persistence, demo contract)
and on C's session public surface.
