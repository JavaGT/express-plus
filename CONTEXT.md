# Workbench Framework

Workbench is a framework for collaborative, persisted, realtime applications. Its language names the seams app authors declare and the framework executes.

## Structure (the machine)

Three loops — the mental map of the library (see also `AGENTS.md`, `docs/architecture-map.md`):

| Loop | Outcome | Authority |
| --- | --- | --- |
| **Compile** | Declaration becomes handlers, DDL, grants, effects, routes | Entity compiler |
| **Commit** | Action becomes sequenced event + projected row | Kernel / durable pipeline |
| **Deliver** | Committed event reaches authorized clients and folds | Live Delivery + Replay decision |

**Machine vs coat:** the three loops are the machine. Auth product (passkeys,
TOTP, invitations), job workers, blobs, and UI kit are the **coat** — justified
by known apps, always engaged as seams on the machine, never a second write or
auth authority.

**Grammar:** Event handle, Scope handle, Seq cursor, and Replay decision name
identity and ordering so loops do not re-parse strings independently.

## Language

**Entity**:
A declared persisted record type with fields, grants, routes, schedules, and mutation verbs.
_Avoid_: Model, table, resource

**Grant**:
A function-declared authorization rule with a row-scope half and a runtime capability half.
_Avoid_: Role map, permission string, policy object; the row-scope half is not a Scope handle

**Principal**:
The actor for a request or framework-originated mutation, represented as a closed kind plus identity and attributes.
_Avoid_: User when the actor may be system, link, or anonymous

**Event handle**:
A typed event identity that carries structured meaning and derives the persisted event string.
_Avoid_: Event name string, event type string

**Scope handle**:
A typed identity for one entity row in the committed log, live delivery, and cursor streams; derives the persisted scope string.
_Avoid_: Scope string, room, collaboration key; not the Grant row-scope half

**Seq cursor**:
The last applied sequence position for one Scope handle on a client or consumer.
_Avoid_: Offset, watermark when meaning the per-scope live/replay position

**Replay decision**:
The pure duplicate / next / gap verdict from comparing an incoming seq span to a Seq cursor.
_Avoid_: Ingest, apply, reconcile (those fold state; this only decides whether to)

**Committed log**:
The durable sequence of committed events that projections, live delivery, and clients consume.
_Avoid_: Message bus, audit log

**Projection**:
A committed-log consumer that derives stored state or delivery output after an event commits.
_Avoid_: Callback, after-save hook

**Schedule**:
A one-shot time source bound to a date or numeric field on an entity row.
_Avoid_: Timer, cron job

**Tick**:
A recurring time source that repeatedly scans eligible rows and dispatches declared mutations.
_Avoid_: Schedule, loop job

**Kernel**:
The durable mutation-dispatch core: handlers, named durable pipeline variant, admission, and write-queue serialization. Post-commit consumers and clock starters are contributed by the modules that own each engaged seam (Live Delivery, blob, projected, effects, Schedule), not implemented inside Kernel.
_Avoid_: Server, router; not a bag of every post-commit side effect

**Compile loop / Commit loop / Deliver loop**:
The three essential runtime cycles of the framework (see Structure above).
_Avoid_: “Layer”, “tier”, “service” when meaning one of these cycles

**Coat**:
Known-app capability on top of the machine (auth product, jobs, blobs, UI) that must not invent a second mutation or auth authority.
_Avoid_: Plugin when meaning a second path; microservice