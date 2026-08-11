# Performance Benchmarks

`bench/hot-path.mjs` is the repository's repeatable performance harness. It
measures representative work across Workbench's compile, commit, and deliver
loops, plus the HTTP transport and annotated-text coat. It has no package
dependencies beyond the Node runtime's `node:sqlite`.

## Running It

The default command runs every benchmark family at all three workload sizes
with five samples per size:

```sh
pnpm run bench
```

For a short smoke run, use one small workload and three samples per family:

```sh
pnpm run bench:quick
```

Run one family when investigating a change:

```sh
pnpm run bench:compile
pnpm run bench:http
pnpm run bench:commit
pnpm run bench:live
pnpm run bench:text
```

Families and sizes can also be selected directly:

```sh
pnpm run bench -- --benchmarks commit,live-delivery --sizes medium,large --samples 7
```

Progress and diagnostics go to stderr. Stdout is exactly one newline-terminated
JSON report, so it can be captured without filtering log lines:

```sh
pnpm run bench:quick > /tmp/workbench-performance.json
```

Every run also writes the latest Markdown reference to
`docs/performance-results.md`. This file is intended for agents and humans who
need expected runtimes without parsing JSON. It includes the Node/platform
context, exact workload parameters, sample values, medians, variance, and
derived text sizes such as the exact UTF-16 character count. Use another output
path or suppress recording when needed:

```sh
pnpm run bench -- --record /tmp/workbench-performance.md
pnpm run bench -- --no-record
```

The runner records the full Git commit hash only when the worktree is clean both
before and after the benchmark and `HEAD` is unchanged. Dirty or changing
worktrees are explicitly marked as unversioned in the Markdown file and never
get a misleading commit identifier. A recorded file modifies the worktree, so
the next run will correctly be treated as dirty until that result is committed
or otherwise cleared.

Keep the Node version, machine load, selected families, workload names, and
operation counts fixed when comparing reports. Each sample creates fresh state.
Schema setup, data seeding, warmup, and teardown are outside the timed phase
unless the workload explicitly measures schema preparation.

## Workload Families

| Family | Measures | Small / medium / large state |
| --- | --- | --- |
| `compile` | Framework DDL plus declared Entity schema preparation | 1 / 4 / 10 Entities, 6 / 10 / 14 fields |
| `http-crud` | Real `node:http` create, read, list, and update requests with route and row authorization | 200 / 600 / 1,200 mutation requests per phase |
| `commit` | Durable dispatch, receipt dedupe, and batched durable actions | 500 / 1,500 / 4,000 dispatches; batch sizes 4 / 8 / 16 |
| `live-delivery` | Authorized history catch-up and live fan-out to subscribers | 25 / 100 / 400 history events; 1 / 10 / 40 subscribers |
| `annotated-text` | Cached materialization, checkpoint restore plus materialization, and operation apply plus materialization | 16 / 96 / 256 lines; 997 / 6,037 / 16,273 UTF-16 characters; 16 / 32 / 64 operations |

The HTTP benchmark keeps its request shape constant while increasing the amount
of live database state. It engages both default authorization layers: the route
gate and the owner-scoped row grant's SQL scope and runtime capability check.
The commit benchmark keeps its durable `_Log` growing through warmup and
dispatch phases. The live benchmark measures both replaying existing history and
delivering new events to multiple subscribers. The text benchmark uses the
same immutable-family operations used by the annotated-text runtime.

## JSON Report

The report has a versioned, stable shape. Workloads are identified by the pair
of `benchmark` and `name`, for example `commit/medium`:

```json
{
  "schema_version": 2,
  "benchmark": "workbench-performance",
  "benchmarks": ["compile", "http-crud", "commit", "live-delivery", "annotated-text"],
  "sizes": ["small", "medium", "large"],
  "samples": 5,
  "workloads": [
    {
      "benchmark": "commit",
      "name": "medium",
      "operations": {
        "warmup": 300,
        "dispatch": 1500,
        "dedupe": 600,
        "batch": 300,
        "batchSize": 8
      },
      "metrics": {
        "dispatch_ops_s": {
          "sample_ops_s": [1234.5],
          "min_ops_s": 1234.5,
          "median_ops_s": 1234.5,
          "mean_ops_s": 1234.5,
          "stddev_ops_s": 0,
          "relative_stddev_pct": 0,
          "max_ops_s": 1234.5
        }
      }
    }
  ],
  "profile": { "enabled": false },
  "comparison": null
}
```

Each family reports its phase-specific throughput metrics and a
`composite_ops_s` geometric mean. Values are rounded to three decimal places.
`median_ops_s` is the primary comparison value. Standard deviation uses the
sample `n - 1` denominator, and relative standard deviation is
`stddev / mean * 100`.

## Regression Comparison

Capture a baseline, then compare a later run against it:

```sh
pnpm run bench > /tmp/workbench-baseline.json
pnpm run bench -- --compare /tmp/workbench-baseline.json
```

For the conventional local baseline path:

```sh
pnpm run bench > bench/baseline.json
pnpm run bench:compare
```

Comparison validates the report schema, selected workloads, operation counts,
and every metric in every selected workload. A check passes when the current
median is no more than 10% below the baseline median. Override that budget when
needed:

```sh
pnpm run bench -- --compare /tmp/workbench-baseline.json --max-regression-pct 5
```

The comparison result remains valid JSON on stdout. A failed check sets the
process exit code to 1, which makes the command suitable for CI. Gains and
losses are reported as `change_pct`; `regression_pct` is zero for a gain.

## CPU Profiling

Profiling is opt-in and writes a V8 `.cpuprofile` file. Do not use a profiled
run as a performance baseline because the profiler changes timing:

```sh
pnpm run bench:profile -- --benchmarks commit --sizes medium --samples 1
```

To keep the profile outside the repository, pass an explicit path:

```sh
pnpm run bench -- --benchmarks annotated-text --sizes large --samples 1 \
  --profile /tmp/workbench-annotated-text.cpuprofile
```

The JSON report records that profiling was enabled and the requested path. The
profile can be opened in Chrome DevTools' **Performance** panel or another V8
CPU-profile viewer.
