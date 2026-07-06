# S0 Wire-Contract Memo — Cursor Semantics Comparison

**Date:** 2026-07-06 | **Agent:** explore-flash | **Source:** workbench `src/cursor.mjs` vs Scope R8 `loadProjectSnapshot`

## VERDICT: INCOMPATIBLE

**Structural difference.** Scope's seq numbering is **per-project** (one global counter for all entities in a project), while workbench's seq numbering is **per-entity** (each `<entityName>:<id>` has its own independent counter). This is not an encoding or key-naming difference — it is a difference in the fundamental event numbering model.

## Detailed evidence

### 1. Cursor keys

**Scope** — `cursors` map contains a single entry keyed by `project:<projectId>`:
- `materialiser.ts:16` — `const projectScope = (projectId) => ({ kind: 'project', id: projectId })`
- `materialiser.ts:42` — `cursors: { [scopeKey(projectScope(projectId))]: result.lastSeq }`
- `scope-key.ts:3-5` — `scopeKey(scope: ScopeRef) => \`${scope.kind}:${scope.id}\``
- `ProjectActionCursor` — `projectId` is PRIMARY KEY; one cursor row per project

**Workbench** — scope keys are per-entity strings `<entityName>:<id>`:
- `cursor.mjs:7` — `SELECT lastSeq FROM _Cursor WHERE scope = ?`
- `committed-log.mjs:17-18` — `PRIMARY KEY (scope, seq)` on `_Log` table

### 2. Seq value shape

**Both** carry monotonically increasing integers. But Scope's sequence is **project-wide** (one counter for all entities), while workbench's is **per-entity** (independent counters per `<entityName>:<id>`).

### 3. When cursor bumps

**Both** bump the cursor **per event, inside the write transaction**:
- Scope: `wb/server.ts:142-153` — `seq = await tx.nextSeq(scope)` inside the history transaction
- Workbench: `pipeline.mjs:160-167` — `seq = nextSeq(scope)` inside `commitEvents` transaction

### 4. Seq assignment

**Workbench:** per event, per scope (`<entityName>:<id>`). Each event within a scope gets a monotonic seq unique to that scope. Different scopes have independent counters.

### 5. Snapshot + seq atomicity

**Scope's `loadProjectSnapshot`** returns `{ snapshot, cursors: { "project:<id>": lastSeq } }`. The cursor is read as part of `loadProjectGraph` — a single Prisma call, implicitly atomic. R8 design doc requires explicit one-transaction atomicity.

**Workbench's `GET /snapshot/:entity/:id`** reads row + cursor in one synchronous JavaScript block with no `await` yield between them — explicitly proven atomic against concurrent dispatch.

### 6. Bootstrap ordering

**Workbench:** Requires **snapshot-then-stream** (`SPEC.md:355-359`). The client loads the snapshot and sets the cursor before starting the live stream. Reverse ordering = permanent event loss.

**Scope currently: stream-then-snapshot.** SSE opens and sends `connected` event first, then client loads snapshot separately. R8 design acknowledges the need to converge to workbench's ordering but current implementation hasn't changed.

### 7. CurrentSeq bridging

**Workbench** sends `subscribed` ack with `currentSeq` per-scope on subscribe. Client compares against last-known cursor to detect missed events.

**Scope** sends `lastSeq` per-project on SSE connect (`projects.ts:83`). Mechanically same purpose but different granularity — per-project vs per-entity.

## Conclusion

| Aspect | Scope (shipped) | Workbench (target) |
|--------|----------------|-------------------|
| Seq counter | One per **project** | One per **entity** |
| Cursor key | `project:<id>` | `<entityName>:<id>` |
| Bootstrap | Stream-then-snapshot | Snapshot-then-stream |
| Cursor bump | Per event, in-transaction | Per event, in-transaction |
| Snapshot+seq atomicity | Implicit (single DB call) | Explicit (synchronous block) |

Per-project seq vs per-entity seq is a structural difference that runs through the entire event model. It determines how events are numbered, queried, and gap-detected.

## What must change

Given ADR-0005's direction (Scope migrates onto workbench, not the reverse), **Scope's event numbering must adopt workbench's per-entity seq model:**

1. Scope's `ProjectEventLog` table must be re-keyed to support per-entity seq (add `scope` column, change PK to `(scope, seq)` instead of project-wide `seq`)
2. Scope's `ProjectActionCursor` must change from per-project to per-entity (`PRIMARY KEY (scope)` instead of `PRIMARY KEY (projectId)`)
3. Scope's dispatch pipeline (`wb/server.ts`) must assign seq per entity scope
4. Scope's `loadProjectSnapshot` must return cursors per entity scope key, not one `project:<id>` entry
5. Scope's SSE bootstrap must change from stream-then-snapshot to snapshot-then-stream (R8 already flags this)

**Workbench's side does not need to change** — its per-entity seq model is the target.

**This is an owner escalation per §6:** wire-contract changes are one-way-door territory (ADR-0005 §92-93). The R8 return shape is compatible with workbench's `{ snapshot, cursors }` contract at the envelope level, but the **cursor key granularity** inside `cursors` is wrong for station A (live spine) and station B (kernel migration).
