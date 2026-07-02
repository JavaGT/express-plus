# Workbench Framework

Workbench is a framework for collaborative, persisted, realtime applications. Its language names the seams app authors declare and the framework executes.

## Language

**Entity**:
A declared persisted record type with fields, grants, routes, schedules, and mutation verbs.
_Avoid_: Model, table, resource

**Grant**:
A function-declared authorization rule with a row-scope half and a runtime capability half.
_Avoid_: Role map, permission string, policy object

**Principal**:
The actor for a request or framework-originated mutation, represented as a closed kind plus identity and attributes.
_Avoid_: User when the actor may be system, link, or anonymous

**Event handle**:
A typed event identity that carries structured meaning and derives the persisted event string.
_Avoid_: Event name string, event type string

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
