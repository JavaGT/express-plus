# Structural investigation — 2026-07-10

Philosophy is binding in `AGENTS.md` / `CONTEXT.md` / `docs/architecture-map.md`.
Candidates below are ranked by **machine risk** then **accidental thickness**.

## Status

| ID | Candidate | Status |
| --- | --- | --- |
| **S1** | Live Delivery singular public seam | **done** (`createLiveDelivery`) |
| **S2** | Golden fold fixtures createClient vs LiveList | **done** (`test/fold-golden.test.mjs`) |
| **S3** | Auth coat packaging under `src/auth/` | **done** (directory + barrel; public API unchanged) |
| **S4** | Further HTTP leaf / Entity splits | **parked** (reaffirmed) |
| **S5** | Auto-discover post-commit consumers | **rejected** — keep explicit engaged list |
| **S6** | Grow `workbench-local-*` | **demand-gated** — no growth without projects/* spine |
| **S7** | New field kinds | **process bar only** (AGENTS known-app bar) |

## Measured surface (approx, pre-S3)

| Surface | Lines | Role |
| --- | --- | --- |
| Auth coat | ~2.2k | Coat → now `src/auth/` |
| Live deliver | ~1.2k | Deliver loop |
| HTTP skin | ~1.5k | Skin |
| Client | ~2.0k | Deliver + coat |

## Candidates (detail)

### S1 — Live Delivery singular public seam (**done**)

`createLiveDelivery(httpServer, opts)` → `{ emit, count, close, createConsumer }`.
Serve engages delivery; Kernel registers `app.live.createConsumer(app)`.
`createLiveServer` is the same function. `live.mjs` re-exports.

### S2 — Client fold parity contract (**done**)

Golden fixtures in `test/fixtures/fold-golden.mjs` + `test/fold-golden.test.mjs`:
lifecycle CRUD, value `{set}`, CRDT insert, replay edges. createClient reducers
mirror LiveList whole-value + delta-XOR semantics for those cases. Folds stay
separate implementations; contract is locked by tests.

### S3 — Auth coat packaging (**done**)

Moved product auth modules into `src/auth/`:
`entities`, `routes`, `session`, `passkey`, `totp`, `invitation`, `membership`,
plus `index.mjs` barrel. Public exports via `index.mjs` / `internal.mjs` paths
updated. **Not** a second grant system — compile authz remains at top-level
`authz.mjs` / `scope-sql` / `row-grant`.

### S4 — HTTP leaf cluster (**parked**)

`http-*` leaves pass deletion test as focused utilities. No further Entity/HTTP
deepening without a compiled-Entity runtime story (DECISIONLOG).

### S5 — Kernel engaged-consumer list (**rejected**)

Keep the explicit list in `engagedPostCommitConsumers`. Auto-discovery by
convention is a second-path risk and fails the deletion test (relocates wiring
into magic).

### S6 — `workbench-local-*` (**demand-gated**)

Keep tests and modules. Do not grow inverse/undo journals there (second
reconciliation path). Expand only when a `projects/*` app is the offline spine.

### S7 — Field-kind coat (**process**)

Each new field kind must re-defend known-app need (AGENTS). No structural move.

## Revisit triggers

- Production bug from LiveList vs createClient fold divergence → strengthen S2 fixtures.
- Multi-process writers → Kernel/write-queue/SQLite model reopened.
- Auth coat invents grant bypass → emergency singular-system fix, not packaging.
