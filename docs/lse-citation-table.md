# LSE citation table (read-only)

Linear's Sync Engine vocabulary (wzhudev/reverse-linear-sync-engine) mapped onto
Workbench nouns for maintainer familiarity. This document adopts nothing: every
row is `LSE X ≈ Workbench Y, not equal`. Downstream tickets (#182–#185) cite
these rows instead of LSE nouns. See #180 (epic ADR) and #181.

## Cite-only mappings

| LSE term | Workbench equivalent | Not equal because |
|---|---|---|
| Transaction (client mutation batch) | Action, or a batch of Actions | Server dedupe is per `(scope, actionId)`, not per batch (`src/pipeline.ts`) |
| Delta packet | Committed Event + delivery envelope | Per-scope seq + Replay decision, not a global packet number |
| Sync id | Per-scope Seq cursor (`CONTEXT.md`) | No global commit order exists; `_Log` is `PRIMARY KEY (scope, seq)` |
| ephemeralProperty | "Does not engage the persistence seam" (`SPEC.md` §7.2) | Persistence class is emergent, never a per-property flag |
| Identity map / object pool | LiveList per `(entity, id)` + `scopeOf` key | No pooled model graph; fold-after-Replay-decision only |
| ModelRegistry | `entity()` compiler (`src/entity/compile.ts`) | One declaration surface; decorators are a rejected second surface |
| TransactionQueue | Outbox (adopted Workbench noun, #183) | Placeholder-until-`ingest`, existing local log, no LWW, no global cursor |

## Adopted

- **Outbox** — names the #183 seam (durable client queue over the existing
  local log). On no Avoid list; not an LSE import.

## Never adopt

Model, property, watermark / lastSyncId, hydrate (LSE sense), SyncGroup,
schemaHash, loadStrategy, save(), TransactionQueue, MobX observability.

## Collision warnings (load-bearing)

- **hydrate**: Workbench verb meaning server row materialization with a
  Principal (`hydrate(row, principal)`, ~10 call sites). LSE means client lazy
  load. Same word, different loop — never use the LSE sense.
- **Model / property / watermark**: explicitly Avoid-listed in `CONTEXT.md`
  (Entity L9, Field L13, Seq cursor L48). Use Entity, Field, Seq cursor.
- **SyncGroup**: fails the Membership red line (L104, "ACL table ... as a
  second auth path"). Permission grouping stays a delivery-side cache derived
  from the grant engine, never a substitute.
