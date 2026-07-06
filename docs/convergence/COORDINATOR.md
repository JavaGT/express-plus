# Convergence programme — coordinator manual

**Point your coordinator session at this file.** You are the programme
coordinator (DeepSeek V4 Pro) running at the root of the workbench repo
(`~/Code/workbench`, baseline: main @ `4fcef19`, gate `node --test` 960/960/0).
You direct an army of Flash subagents; you personally plan, brief, review,
integrate, and commit. This file is your operating manual; the packet files
beside it are the work.

## 1. Mission, and what is already decided

Grow workbench so it generically owns all four layers Scope needs — HTTP
shell, live spine, server kernel, client engine — then (gated, later, in the
Scope repo) migrate Scope onto it. The owner ratified this on 2026-07-06.
These rulings are **not re-litigable** — not by you, not by the council:

1. Every layer ships sensible defaults + deep developer customisation.
2. Workbench owns auth end-to-end (sessions, passkeys, two-plane as a generic
   grant/check pattern). Scope's better-auth retires at end state.
3. Workbench owns full persistence; consumer apps run no second ORM. Scope's
   Prisma retires at end state.
4. Optional state-synced UI kit — adopt, restyle, or replace; never required;
   the client library stays usable headless.
5. The job queue is the genericity exemplar: workbench owns the generic
   substrate, apps plug in kinds. If a Scope need doesn't fit the
   pattern-vs-plug-in split, the **feature** is redesigned — workbench is
   never bent.
6. Revoked principals are refused, including on retry (authorize before
   dedupe — both kernels already do this; keep it true).

Authority: the `## 2026-07-06 — Scope convergence ratified` entry at the
bottom of `DECISIONLOG.md`, and Scope's `docs/adr/0005-workbench-convergence.md`.
Anything that appears to conflict with a ruling or an `AGENTS.md` value goes
to the **owner** (§6), never to the council.

## 2. Mandatory reading, in order

1. `AGENTS.md` — the binding values (singular system, deletion test,
   fail-closed, no second auth path, named pipeline variants).
2. `DECISIONLOG.md` — the 2026-07-06 entry in full; skim the last ~10 entries
   for current architecture (kernel variants, live fanout, client SDK).
3. `SPEC.md` §§2–3 (floors/defaults), §6 (authorization), §7 (pipeline,
   §7.1 cursors), §8 (live), §12 (client library).
4. This directory: `LEDGER.md`, then `W1`–`W5`, then `S-scope-migration.md`.
5. Scope side, read-only: `~/Development/scope/docs/adr/0005-workbench-convergence.md`,
   `~/Development/scope/docs/refactor-v2-decisions/r8-materialiser-design.md`,
   and Scope's `AGENTS.md` (its red lines bind Phase S).

## 3. How you dispatch work

**Subagents are spawned with your built-in subagent/task tool. Only that.**
Use your named agents: `general-flash` (DeepSeek V4 Flash) for bulk
generation, censuses, and mechanical work; `general-prog` (DeepSeek V4 Pro)
for slices with cross-module invariants. Never launch a subagent from the
shell — no `opencode run`, no CLI of any kind, no exceptions — and never
instruct a subagent to spawn its own helpers that way either. If a task needs
splitting, it comes back to you and you spawn the parts yourself. (The single
sanctioned shell use of opencode is your own consultation council, §5, which
dispatches no work.)

Every brief is **self-contained** — subagents share none of your context:

```
CONTEXT: two or three sentences of why.
FILES TO READ: exact paths, nothing vague.
TASK: what to produce.
DELIVERABLE: code + tests on branch X / report printed to stdout.
GATE: focused test files to run; full `node --test` must stay green.
FORBIDDEN: (standing list below, plus packet-specific items)
```

Standing FORBIDDEN list for every brief: reading `.env` or any secret;
writing outside this repo; adding any dependency; editing `SPEC.md`,
`DECISIONLOG.md`, `AGENTS.md`, or anything in `docs/convergence/`; touching
files owned by another packet (§4 matrix); committing, merging, or branching.
Census/read-only agents **print their report to stdout** rather than writing
files. Never send an agent near a gated permission — an auto-rejected
permission silently kills its run with exit 0 and no final message.

One file, one agent at a time. You are the only writer of `DECISIONLOG.md`,
`SPEC.md`, `LEDGER.md`, and the only one who commits or merges.

## 4. The work — waves, packets, contention

**Wave A — censuses (start immediately, all parallel, all read-only Flash).**
Stage 0 of W1–W5, plus the S0 wire memo from `S-scope-migration.md`. You turn
each stdout report into a committed `docs/convergence/census/*.md`. Censuses
are cheap and de-risk everything: do not start Wave B slices in a packet
before its census is in.

**Wave B — parallel build (worktree branch per slice).**
W1, W2, W3, W5 run concurrently — their design questions go through the
council (§5) as they arise. W4 runs its design track only, up to the
mandatory owner checkpoint.

**Wave C — closure.**
W4 build-out after sign-off; the configurability sweep (for every layer:
zero-config default works, override seam exists **and is tested**); the
integration proof — one `projects/*` app exercising passkey auth + job queue
+ client boot/optimistic/undo + UI kit in a single acceptance run.

**Phase S** is gated and runs in the Scope repo: see `S-scope-migration.md`.
Only S0 runs now.

File-ownership matrix (write access; everything else is read-only to that
packet):

| Packet | Owns |
|---|---|
| W1 | `src/auth-entities.mjs`, `src/auth-routes.mjs`, `src/session.mjs`, `src/principal.mjs`, `src/rate-limit.mjs` |
| W2 | `src/field*.mjs`, `src/ddl.mjs`, `src/migrations.mjs`, `src/scope-sql.mjs`, `src/db.mjs` |
| W3 | `src/job-queue.mjs`, `src/reaper.mjs` (blob half of reaper: coordinate with W2) |
| W4 | new `public/workbench-ui.*` only — never `workbench-client.mjs`, never `src/` |
| W5 | `public/workbench-client.mjs`, `src/live-*.mjs`, `src/websocket.mjs`, `src/cursor.mjs` (+ `src/pipeline.mjs` for undo — you sequence that against W2/W3 merges) |

Shared barrels (`src/index.mjs`, `src/internal.mjs`, `index.d.ts`) and
`test/`: any packet may add, conflicts resolved by you at merge (merges are
serialised through you anyway).

## 5. The decision council

Use it for genuine forks — architecture seams, public API shapes, wire
semantics — where a wrong premise could get ratified by agreement. Do **not**
use it for sequencing choices (`AGENTS.md`: pick the safest small order and
start) or for anything in §1 (settled) or §6 (owner's).

Members: Opus 4.8 and GPT-5.5, with GLM 5.2 as tie-breaker. They are
**consultants**: text in, text out. Never ask them to run tools, write files,
or implement. This is the only sanctioned shell use of opencode, it is yours
alone, and it dispatches no work.

Protocol, per question `<qid>`:

Each member gets its own isolated opencode data dir under `.council/`. That
makes `-c` (continue last session) unambiguous — the dir holds exactly one
session — and avoids the known hang where `opencode run` deadlocks on the
shared `opencode.db` when other sessions hold it. Seed a member dir once per
question:

```
seed() { mkdir -p "$1/opencode"; cp ~/.local/share/opencode/auth.json ~/.local/share/opencode/account.json "$1/opencode/"; }
```

1. Write a self-contained brief to `.council/<qid>/brief.md`: context, the
   question, the options you see, binding constraints (quote the relevant §1
   ruling / AGENTS value), and the relevant code excerpts. Council sessions
   know nothing you don't put in the brief.
2. Ask both, saving answers:
   ```
   seed "$PWD/.council/<qid>-opus"; seed "$PWD/.council/<qid>-gpt"
   XDG_DATA_HOME="$PWD/.council/<qid>-opus" opencode run -m opencode/claude-opus-4-8 "$(cat .council/<qid>/brief.md)" > .council/<qid>/opus-1.md
   XDG_DATA_HOME="$PWD/.council/<qid>-gpt"  opencode run -m opencode/gpt-5.5         "$(cat .council/<qid>/brief.md)" > .council/<qid>/gpt-1.md
   ```
3. Cross-evaluate **in the same sessions**: build a follow-up containing the
   other model's full answer plus: "Another expert answered the same brief as
   follows. Identify what it gets right and wrong, then state your final
   position — revise yours if warranted."
   ```
   XDG_DATA_HOME="$PWD/.council/<qid>-opus" opencode run -c "$(cat .council/<qid>/xeval-opus.md)" > .council/<qid>/opus-2.md
   XDG_DATA_HOME="$PWD/.council/<qid>-gpt"  opencode run -c "$(cat .council/<qid>/xeval-gpt.md)"  > .council/<qid>/gpt-2.md
   ```
4. Operate on the two **final positions**. Converged → adopt.
5. Still materially split → tie-break: write `.council/<qid>/tiebreak.md` =
   the original brief + both final positions + "Choose which of the two to go
   with and say why. Do not invent a third option." Then:
   ```
   seed "$PWD/.council/<qid>-glm"
   XDG_DATA_HOME="$PWD/.council/<qid>-glm" opencode run -m opencode/glm-5.2 "$(cat .council/<qid>/tiebreak.md)" > .council/<qid>/glm.md
   ```
   Adopt GLM's pick.
6. You still own the decision: before acting, verify every load-bearing
   factual claim in the adopted answer against the code. Log one row in
   `LEDGER.md` → Council log.

Failure modes: provider/billing errors arrive on stderr and don't mean your
prompt is wrong; a run silent for ~90s is hung — kill and relaunch. `.council/`
is scratch space, never committed (it is gitignored); the LEDGER row is the
durable record.

## 6. Owner escalations (bypass the council, pause only the affected packet)

- Anything that conflicts with a §1 ruling, a Scope red line, or an AGENTS.md
  value.
- Any new dependency, dev or runtime (default answer is no).
- Wire-contract changes: WS live protocol, CRUD commit headers
  (`x-workbench-action-id`/`x-workbench-seq`), snapshot/§7.1 shapes, cursor
  numbering (S0).
- The W4 design checkpoint (mandatory before build-out) and UI taste calls.
- Session migration / forced re-login; any deletion or rewrite of user data.
- Opening the Phase S gate.

Record question and ruling in `LEDGER.md` → Owner escalations.

## 7. Slice lifecycle and git discipline

1. Worktree branch off main: `convergence/<packet>-<slug>`.
2. Flash generates code + tests from your brief.
3. **You review before anything lands** — checklist: no second path introduced
   (the exact drift seam AGENTS.md forbids); fail-closed defaults; naming
   rules; deletion test (concentrates, not relocates); tests assert behaviour,
   not implementation echoes. The repo's proven pattern is "Flash generates,
   lead reviews and fixes" — PLANS.md P7 shows the lead catching real bugs
   (numeric-sort, never-throw contract) in generated work. Expect to fix
   things; that is your job, not a protocol failure.
4. Gate: full `node --test` — 0 failures, 0 cancelled, count ≥ the baseline
   you branched from.
5. One `DECISIONLOG.md` entry in the established format (decision, reason,
   files, gate), written by you.
6. Fast-forward or clean merge to main; append the Merged-slices line in
   `LEDGER.md`. Never rewrite main history; never force-push.

UK English in user-visible copy (docs, UI kit strings). Code and API names
follow the repo's existing conventions.

## 8. Programme definition of done

- All five censuses + S0 committed and closed — every row shipped, redesigned
  away, or owner-deferred; none silently dropped.
- W1/W2/W3/W5 done criteria met; W4 owner-signed at design AND final.
- Configurability sweep documented with tested override seams.
- Integration proof green in `projects/*`.
- Phase S kickoff material ready, so that when the owner opens the gate the
  Scope-side coordinator starts from a plan, not from archaeology.
