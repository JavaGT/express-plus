# W1a recipient snapshot profile and gate evidence

Issue: #152. Design authority: #148 rev 2, D1-A.

## Pre-repair profile

Committed source at `5fa4729` used the exact 36,000-word, 72,000-annotation,
one-protector, 36,001-range, 13-visible/12-denied, 50-control fixture.

- Projection samples (ms, recipient order): `2809.138, 2680.945, 3776.102, 3382.128, 2394.533, 3330.250, 2564.045, 3161.220, 2686.546, 4479.379, 2191.058, 3428.611, 2882.923, 2972.066, 2438.368, 3352.166, 2394.615, 4540.366, 3269.586, 2103.785, 2267.264, 3901.661, 3655.036, 3562.218, 3040.493`.
- Nearest-rank p95: 4,479.379 ms overall, 4,479.379 ms visible, 4,540.366 ms denied.
- Projection/recovery RSS delta: +22.22 MiB. Fixture setup: +82.20 MiB.
- Event-loop p99: 14.741 ms. C=0: 50 attempts (bound 100). C=1: 100 attempts (bound 200), at least two transport generations. No write coordinator held.

The profiled representative visible/denied calls isolated the dominant work:

| Phase | Visible ms | Denied ms |
|---|---:|---:|
| family checkpoint read + restore + materialize | 9.68 | 4.46 |
| annotation base/edge/per-family SQL and row decode | 1,016.80 | 1,136.05 |
| membership SQL | 1,014.17 | 998.47 |
| endpoint parse and 36,001 unique range projections | 1,792.24 | 1,694.57 |
| orphan and measurement load | 18.36 | 20.98 |
| protector and field authorization | 6.03 | 7.54 |
| recipient validation, indexing, activation, mapping, and freeze | 1,202.30 | 992.42 |
| serialization (separate from projection gate) | 826.06 | 179.36 |

The root cause was duplicate representation and native row conversion, not family
materialization, authorization, interval merging, fanout, or coordinator contention.

## Repair

- `e6c823e` establishes `projectAnnotatedTextRecipient({ source, descriptor, decisions })` as the common policy and rejects a source carrying a generic database handle.
- `6d1e510` supplies ordered capability data from `annotated-text-snapshot.ts`, uses SQLite array-returning iteration, projects each unique range once, avoids repeated endpoint retention for denied recipients, and allocates only policy/source backing plus recipient output.
- `02fbac6` records exact phase, serialization, peak-RSS, process-list, environment, recovery, and provenance instrumentation.

Focused evidence covers byte-equivalent old/new policy output, denied/allowed and
whole-document protection, overlap/nesting, marker show-through, hidden target
removal, orphan suppression, malformed ranges/decisions/targets, recipient-read
cursor behavior, and the deletion mutation that removes the common policy call.

## Committed archive diagnostic

Archive SHA: `02fbac6`. Benchmark SHA-256:
`a0dd5f207ae707dcfa038e25dc16f27df7a987c5f4c6781abc5928a04697fd08`.
Node: `v26.7.0`; platform: `darwin/arm64`; CPU: Apple M4 (10 logical CPUs);
RAM: 16,384 MiB. Dependency-only `node_modules` symlink. Profiling disabled.

Commands:

```sh
ANNOTATED_TEXT_BENCH_SCENARIO=initial ANNOTATED_TEXT_BENCH_COMMIT=02fbac6 pnpm benchmark:annotated-text-composite-resync
ANNOTATED_TEXT_BENCH_SCENARIO=fallback ANNOTATED_TEXT_BENCH_COMMIT=02fbac6 pnpm benchmark:annotated-text-composite-resync
```

Initial exact samples (ms): `3582.277, 15852.280, 3960.763, 1519.681, 5640.413, 2968.658, 2358.500, 3107.718, 3402.206, 4413.401, 5352.485, 5888.790, 6939.140, 9421.396, 2714.874, 4571.137, 5043.236, 5289.099, 6193.538, 6909.560, 8150.920, 13644.765, 4615.982, 8609.225, 6985.797`.

Forced-fallback exact samples (ms): `3165.958, 8861.033, 3011.743, 2650.876, 3482.986, 3048.312, 3836.649, 5293.412, 5561.558, 6459.549, 7402.182, 13146.905, 3833.731, 3167.526, 4681.916, 3555.222, 4185.005, 4397.225, 3513.677, 2441.680, 4822.385, 5998.999, 10309.094, 3504.189, 6050.236`.

| Gate evidence | Initial | Forced fallback |
|---|---:|---:|
| overall p95 | 13,644.765 ms | 10,309.094 ms |
| visible p95 | 15,852.280 ms | 13,146.905 ms |
| denied p95 | 13,644.765 ms | 10,309.094 ms |
| peak RSS delta | 185.91 MiB | 136.47 MiB |
| final RSS delta | -13.63 MiB | -14.77 MiB |
| event-loop p99 | 46.325 ms | 42.539 ms |
| C=0 / C=1 | 50 / 100 | 50 / 100 |
| write coordinator held | no | no |

These two archive runs are **not eligible D2 acceptance runs**. Their captured
process lists show unrelated Scope Vitest workers, Svelte typechecking, and
multiple agents saturating the machine. The scheduling effect is directly
visible in the instrumented archive diagnostic: an empty orphan/measurement
query took 7,737.541 ms, versus about 4 ms in the earlier directional run.
Consequently the timing threshold cannot be accepted or rejected from these
wall-clock samples. RSS, loop delay, recovery bounds, and coordinator ownership
passed despite contention.

## Status

W1a remains open. The implementation removes the measured structural defect and
the exact clean-archive harness is committed, but the required uncontended
initial and forced-fallback p95 evidence is still blocked by concurrent full
suites. W1c must remain blocked; no historical timing and no contended result is
carried forward as acceptance.

## Hostile-review corrections

The post-review benchmark defines one acceptance sample as the complete
recipient path from projection start through `JSON.stringify`, `JSON.parse`, and
public snapshot validation. It reports projection, serialization, validation,
and end-to-end nearest-rank p95 independently; only end-to-end p95 is compared
with the 500 ms gate. Exact serialized sizes and hashes of the benchmark and all
source files on that path are included in every report.

The fallback scenario now starts real client delivery sessions, changes both the
stored protector topology and document-owner visibility, and sends the 50
resync controls through `createLiveDeliverySession`. Instrumentation asserts no
measured snapshot recovery occurs before those controls and at least one occurs
afterward. Each recipient sample includes every bounded recovery attempt in that
cycle, so a fold or a hidden second snapshot cannot masquerade as fallback.

Snapshot loading also rejects non-contiguous membership ordinals and any
unprojectable membership belonging to a protected target. Recipient policy now
accepts only package-minted frozen source capabilities; inherited and ad hoc
closure-bearing source objects are rejected before policy iteration.
