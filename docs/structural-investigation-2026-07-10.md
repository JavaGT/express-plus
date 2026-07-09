# Structural investigation — 2026-07-10

Investigation only. No code moves in this commit. Philosophy is now binding in
`AGENTS.md` / `CONTEXT.md` / `docs/architecture-map.md`. Candidates below are
ranked by **machine risk** (second path) then **accidental thickness**.

## Measured surface (approx line counts)

| Surface | Lines | Role |
| --- | --- | --- |
| Auth coat (`passkey`, `totp`, `auth-routes`, `auth-entities`, `invitation`, `session`, `membership`) | ~2.2k | Coat |
| Live deliver (`live*`, `websocket`, `field-delta`, `field-pace`) | ~1.2k | Deliver loop |
| HTTP skin (`http*`, `serve`, `middleware`) | ~1.5k | Skin |
| Client (`workbench-client` + local + ui bindings) | ~2.0k | Deliver + coat |
| `entity/compile` | ~650 | Compile |
| `effect-compiler` | ~690 | Compile/commit |
| `scope-sql` | ~715 | Compile |
| `pipeline` | ~530 | Commit |
| `kernel` | ~200 | Commit assembly |

## Candidates

### S1 — Live Delivery singular public seam (**done** 2026-07-10)

**Landed:** `createLiveDelivery(httpServer, opts)` →
`{ emit, count, close, createConsumer }`. Serve wires delivery; Kernel
registers `app.live.createConsumer(app)`. `createLiveServer` is the same
function (alias). `live.mjs` re-exports only. Internals remain private
implementation of the seam.

### S2 — Client fold parity contract (Worth exploring)

**Observation:** Replay decision is shared. Folds diverge by design:
`createClient` uses declared `event.reduce`; LiveList uses hardcoded
`_applyEvent`. Zero-import forces copy of pure grammar only.

**Change (stopgap):** Golden fixtures both folds must pass for lifecycle +
value/crdt/ordered ops. **Not** full LiveList codegen into pipeline.

**Change (later, if folds diverge in production bugs):** Generate field-fold
core or shared test corpus with stronger parity.

**Risk:** Low for fixtures; high for full merge. **Priority:** Medium.

### S3 — Auth coat packaging (Speculative / defer)

**Observation:** Auth product (~2.2k) is larger than Live (~1.2k). Correct as
coat if it stays on Principal + routes. Cognitive map of `src/` is skewed.

**Change options:** (a) document-only (architecture-map already marks coat);
(b) `src/auth/` directory move without API change; (c) optional
`workbench/auth` subpath export.

**Deletion test:** (b)/(c) often **relocate** unless import graph simplifies.
Prefer (a) until a real dual-auth bug appears.

**Priority:** Low. Do not invent a second grant system while “cleaning.”

### S4 — HTTP leaf cluster (Parked — reaffirm)

**Observation:** Seven `http-*` files + serve. Already parked in DECISIONLOG:
pass deletion test as focused utilities; further Entity/HTTP deepenings without
runtime story relocate ceremony.

**Change:** None. Map them as “skin” in architecture-map (done).

### S5 — Kernel engaged-consumer list (Small hygiene)

**Observation:** `engagedPostCommitConsumers` still a hand list in `kernel.mjs`,
but each item is a module factory — correct thin assembly.

**Change:** Only if a new pattern of “auto-discover consumers” is needed.
Discovery-by-convention is a second path risk. **Keep explicit list.**

### S6 — `workbench-local-*` (Investigate demand)

**Observation:** Local log/store exist with tests; W5 census mixed build/defer.
Not on the main createLiveStore happy path for all apps.

**Change:** Keep until a `projects/*` app is the spine for offline/cross-tab;
then fold vocabulary into the client story. Do not grow inverse/undo there if
it becomes a second journal (AGENTS / DECISIONLOG #100).

### S7 — Field-kind coat (Ongoing bar)

**Observation:** Replace-stub CRDTs, vector, FTS, etc. are coat/field plugins.
Each must re-defend known-app need (AGENTS now states this).

**Change:** No structural move; process bar only.

## Recommended sequence if executing

1. ~~**S1** Live Delivery singular seam~~ **done**.
2. **S2** Golden fold fixtures (correctness insurance).
3. **S3** only as directory packaging if author pain is high — not for purity.
4. Never un-park **S4** without a compiled-Entity runtime story.
5. Leave **S5** explicit list; **S6** demand-gated.

## Revisit triggers

- Production bug from LiveList vs createClient fold divergence → escalate S2.
- Multi-process writers → Kernel/write-queue/SQLite model reopened (not this list).
- Auth coat invents grant bypass → emergency singular-system fix, not packaging.
