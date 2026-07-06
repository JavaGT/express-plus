# S0 Joint Recommendation — Cursor Granularity & Station A Bridge

**Date:** 2026-07-07 | **Council:** Opus 4.8 + GPT 5.5 (parallel independent, cross-evaluated) | **Binding input:** Council c01 (B′ adopted)

## Preamble

Both models independently arrived at the same architecture with no material disagreement. The key reframe: Scope's per-project seq is **already a valid coarse scope** under B′. The S0 memo's "INCOMPATIBLE — Scope must adopt per-entity seq" was written under the old per-entity-only reading. With B′ adopted, that contradiction dissolves.

## Boot Payload Shape

One cursor per project — Scope's existing R8 shape preserved:

```json
{
  "scope": "project:p1",
  "snapshot": { "cards": {}, "columns": {}, "comments": {} },
  "cursors": { "project:p1": 1842 }
}
```

Rule: the cursor key is the exact stream scope string. For Scope, that's `"project:<projectId>"`. The seq value is Scope's existing project-wide sequence counter. No per-entity-instance cursors.

## Workbench-Side Changes

### W5 Slice 2 (ships now, before station A)

1. **Scope-keyed fan-out** — Replace `Map<entity, Map<id, Map<conn>>>` with `Map<scope, Set<conn>>`. Delivery rule: deliver event E to subscribers where `subscriber.scope === E.scope`. Old `{entity, id}` subscribe decodes to `scope = "Entity:id"` — per-entity fan-out retires in the same change.

2. **Generalised subscribed ack** — Works for coarse scopes without requiring `entity`/`id` fields. `{ type: "subscribed", scope: "project:p1", currentSeq: 1842 }`.

3. **Scope-level snapshot route** — `GET /snapshot?scope=project:p1` → `{ snapshot, cursors: { "project:p1": lastSeq } }`. Existing per-entity route becomes compatibility shim: `/snapshot/:entity/:id` → `scope = "Entity:id"`.

4. **Scope-level events-since route** — `GET /events-since?scope=project:p1&cursor=1842` → events where `scope === "project:p1" AND seq > 1842`. No prefix matching. Existing per-entity route becomes compatibility shim.

### Deferred to Station B

- Migrating Scope's `ProjectEventLog` into workbench `_Log`
- Migrating Scope's `ProjectActionCursor` into workbench `_Cursor`
- Moving Scope's durable writes into workbench's dispatch path
- Rebuilding Scope snapshots from workbench-owned persisted state

## Scope-Side Changes (Station A)

### Do NOT:

- Re-key `ProjectEventLog` (station A is transport swap only)
- Change seq numbering (per-project seq IS the coarse scope seq)
- Use prefix-matching bridge (rejected — cursor-invalid)

### DO:

1. **Adapter** — Map `projectId → scope "project:<id>"`. Map `ProjectEventLog.seq → event seq`. All project events emitted/replayed with the same exact scope key.

2. **Bootstrap order** — snapshot-then-subscribe (matches workbench §7.1): load snapshot for `"project:p1"` → subscribe to `"project:p1"` → events-since to fill gap → single ingest path.

3. **Event envelope** — Each event carries `scope: "project:p1"`, `seq: projectWideSeq`, plus entity/id metadata in payload.

## Station B (Later)

After station A live spine is working: physical migration — `ProjectEventLog(projectId, seq) → _Log(scope = "project:<projectId>", seq)` and `ProjectActionCursor(projectId, lastSeq) → _Cursor(scope = "project:<projectId>", lastSeq)`. Station A already uses the final wire cursor key, so station B migrates the physical store without changing the client cursor model.

## Ordering

1. W5 slice 2 — scope-keyed fan-out (retires per-entity map)
2. Workbench scope snapshot + events-since routes
3. Workbench generalised subscribed ack
4. Scope station A adapter
5. Scope boot switch to project-scope cursor boot
6. Station B (later) — durable store migration
