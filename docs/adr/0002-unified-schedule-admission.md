# Schedule admission is one declared-trigger seam

Status: accepted

Tick and schedule system principals are admitted by `admitSystemMutation`, which discriminates by the entity's declared trigger kind rather than by parsing source string shape in `serve.mjs`. The schedule module owns the source grammar, row re-read, due or while re-check, and payload comparison; effect-originated admission stays in the dispatch spine because it is not schedule grammar.

## Extension (2026-07-10) — clock-dispatch

Admission alone left two shallow discover→dispatch loops (`tick-engine.mjs`,
`reaper.mjs`). Those modules are deleted. Schedule now owns a single starter,
`startClockTriggers({ db, entities, dispatch, clock, now? })`, for both deadline
and tick sweeps. `discover*` stays private; fire-path tests cross the starter
seam. Job-queue lease reaping remains on `job-queue.mjs` (different seam).
See DECISIONLOG 2026-07-10 arch-schedule-clock-dispatch.