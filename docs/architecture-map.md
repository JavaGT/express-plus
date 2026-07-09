# Architecture map — modules by loop

Binding philosophy lives in `AGENTS.md` (three loops, machine vs coat, thin
Kernel, grammar modules). Domain nouns live in `CONTEXT.md`. This file maps
**code** onto that mental model so agents and humans navigate by loop, not by
alphabetical `src/` listing.

Status: living map. Update when a seam moves. Do not invent modules here that
do not exist.

## Compile loop

Declaration → compiled Entity (handlers, DDL, auth, effects, schedules, routes).

| Module | Role |
| --- | --- |
| `entity/compile.mjs` | Orchestrates compile |
| `entity/crud.mjs` | Lifecycle action handlers |
| `entity/projection.mjs` | Entity-as-projection consumer |
| `entity/query.mjs` | Ambient find/query surface |
| `field.mjs` | Field constructors |
| `field-strategy.mjs` | Kind → validate/apply/diff |
| `side-table-strategy.mjs` | map / ordered / log / ephemeral |
| `field-laws.mjs` | Undoability vocabulary |
| `grant.mjs` / `scope.mjs` | Grant declaration surface |
| `scope-sql.mjs` / `check.mjs` / `registry.mjs` / `authz.mjs` | Check registry + SQL harvest |
| `row-grant.mjs` | Runtime mayRow / mayVerb / mayFieldOp |
| `route-gate.mjs` | Route admission gates |
| `membership.mjs` / `owner.mjs` | Auth sugar over the same engine |
| `effect-compiler.mjs` | In-txn effects compile + execute |
| `schedule.mjs` (constructors) | schedule/tick declaration |
| `ddl.mjs` | Table generation |
| `event-handle.mjs` | Event type grammar |
| `principal.mjs` | Closed principal kinds |

## Commit loop

Action → authorize → handler → `_Log` append → projection (+ in-txn effects).

| Module | Role |
| --- | --- |
| `pipeline.mjs` | `createServer`, durable variant, `createClient` |
| `kernel.mjs` | Thin assembly + write queue + engaged consumers |
| `committed-log.mjs` / `cursor.mjs` | Log + seq storage |
| `scope-handle.mjs` | Scope key grammar |
| `write-queue.mjs` | Single-writer serialization |
| `driver.mjs` / `db.mjs` / `migrations.mjs` | SQLite engagement |
| `blob-lifecycle.mjs` (in-txn adopt) | Blob adopt atomic with commit |

## Deliver loop

Post-commit → re-auth → wire → client Replay decision → fold.

| Module | Role |
| --- | --- |
| `live-delivery.mjs` | **Singular public seam** `createLiveDelivery` → `{ emit, count, close, createConsumer }` |
| `live.mjs` | Re-export of createLiveDelivery (compat import path) |
| `live-connection.mjs` / `live-admission.mjs` / `live-fanout.mjs` | Private impl of the seam (conn / subscribe auth / fan-out) |
| `websocket.mjs` | Framing |
| `field-delta.mjs` / `field-pace.mjs` | Delta + pace |
| `replay-decision.mjs` | Pure dup/next/gap (also embedded in client) |
| `projected-async.mjs` / `durable-effects.mjs` / `email-seam.mjs` | Other post-commit consumers |
| `blob-lifecycle.mjs` (finalize consumer) | Post-commit blob rename |
| `schedule.mjs` (`startClockTriggers`) | Time → dispatch (feeds commit) |
| `public/workbench-client.mjs` | LiveChannel / LiveList / store |

## HTTP presentation (skin on compile + commit)

Not a fourth loop — transport over the machine.

| Module | Role |
| --- | --- |
| `app.mjs` | Two-phase mount / listen |
| `serve.mjs` | HTTP server, CSRF, boot |
| `http-crud-dispatch.mjs` | CRUD → kernel.dispatch |
| `http-framework-routes.mjs` | snapshot / events-since / blobs / jobs / SDK |
| `http-body.mjs` / `http-response*.mjs` / `http-route-match.mjs` / `http-handler-chain.mjs` | Leaf HTTP utilities |
| `middleware.mjs` / `rate-limit.mjs` / `lifecycle.mjs` / `config.mjs` | Ops defaults |

## Coat (known-app seams on the machine)

| Module | Role |
| --- | --- |
| `session.mjs` / `auth-entities.mjs` / `auth-routes.mjs` | Cookie session + User |
| `passkey.mjs` / `totp.mjs` / `invitation.mjs` | Auth product |
| `job-queue.mjs` | Worker claim/lease board |
| `blob-store.mjs` | Blob bytes |
| `public/workbench-ui*.mjs` + Svelte primitives | UI kit over the client store |
| `public/workbench-local-*.mjs` | Local log / cross-tab (opt-in client) |

## Structural rules of thumb

1. Prefer navigating by **loop**, not by file prefix count.
2. New code: name which loop it serves before writing it.
3. If it does not serve a loop and is not coat/ops/grammar — deletion-test it.
4. Do not “deepen” HTTP leaves or further split Entity without a clearer
   runtime story (parked; see DECISIONLOG).
