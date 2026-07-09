# Workbench Framework

Workbench is a framework for collaborative, persisted, realtime applications. Its language names the seams app authors declare and the framework executes.

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
The framework's mutation-dispatch core: authorization, handler execution, event commit, projection, and post-commit consumers.
_Avoid_: Server, router
