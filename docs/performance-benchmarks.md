# Performance benchmarks

`bench/hot-path.mjs` measures the framework's HTTP CRUD hot path through the
real `node:http` transport. Each request uses the default route gate and the
owner-scoped row grant, including its SQL scope and runtime capability check.
The harness is dependency-free apart from the Node runtime's `node:sqlite`.

## Running it

The normal package entry point runs all three workload sizes with five samples
per size:

```sh
pnpm run bench
```

For a fast smoke measurement:

```sh
pnpm run bench:quick
```

Progress is written to stderr. Stdout is exactly one newline-terminated JSON
report, so it can be saved without filtering log lines:

```sh
pnpm run bench > /tmp/workbench-benchmark.json
```

The workload and sample count can be selected explicitly:

```sh
pnpm run bench -- --sizes small,medium --samples 7
```

Keep the Node version, machine load, workload names, and operation counts fixed
when comparing reports. Startup, schema preparation, feed seeding, the list
sanity check, warmup, and app teardown are outside the timed phases. Each sample
gets a fresh in-memory database and app; warmup rows remain in that sample's
database so the measured requests see warmed, non-empty tables. Requests within
each phase are sequential to measure a clean round-trip rate rather than a
client concurrency limit.

## Workloads

Each size measures create, single-row read, fixed-size list, and update. The
`list_seed` rows make list work comparable as the `Note` table grows.

| Size | Warmup cycles | Create/read/update requests | List requests | Seeded list rows |
| --- | ---: | ---: | ---: | ---: |
| `small` | 50 | 200 each | 50 | 25 |
| `medium` | 100 | 600 each | 120 | 60 |
| `large` | 200 | 1,200 each | 240 | 120 |

The default sizes and counts are part of the JSON report. Change them in the
harness only when the workload itself is intentionally being revised.

## JSON report

The report has a versioned, deterministic shape:

```json
{
  "schema_version": 1,
  "benchmark": "http-crud-hot-path",
  "samples": 5,
  "workloads": [
    {
      "name": "small",
      "operations": { "warmup": 50, "create": 200, "read": 200, "list": 50, "update": 200, "list_seed": 25 },
      "metrics": {
        "create_ops_s": {
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

The real report includes the same metric object for `read_ops_s`, `list_ops_s`,
`update_ops_s`, and `composite_ops_s`. Values are rounded to three decimal
places in the JSON. `median_ops_s` is the primary comparison value. Standard
deviation is the sample standard deviation (`n - 1` denominator), and relative
standard deviation is `stddev / mean * 100`. The composite is the geometric
mean of the four phase throughputs for each sample, then summarized like the
other metrics.

The schema deliberately omits timestamps, host identifiers, and log output.
The numbers will vary; the JSON keys, ordering, units, and workload description
are stable for machine comparison.

## Regression comparison

Capture a baseline and compare a later run against it:

```sh
pnpm run bench > /tmp/workbench-baseline.json
pnpm run bench -- --compare /tmp/workbench-baseline.json
```

Or use the convenience script with the conventional local path:

```sh
pnpm run bench > bench/baseline.json
pnpm run bench:compare
```

Comparison validates the benchmark schema and operation counts, then checks all
five metrics for every selected workload. A check passes when the current median
is no more than 10% below the baseline median. Override that budget explicitly:

```sh
pnpm run bench -- --compare /tmp/workbench-baseline.json --max-regression-pct 5
```

The comparison report remains valid JSON on stdout. A failed check sets the
process exit code to 1, which makes the mode suitable for CI. Gains and losses
are reported as `change_pct`; `regression_pct` is zero for a gain.

## CPU profiling

Profiling is opt-in and writes a V8 `.cpuprofile` file. Do not use a profiled
run as a performance baseline because the profiler changes timing:

```sh
pnpm run bench:profile -- --sizes medium --samples 1
```

To keep the profile outside the repository, pass an explicit path:

```sh
pnpm run bench -- --sizes medium --samples 1 --profile /tmp/workbench-hot-path.cpuprofile
```

The JSON report records that profiling was enabled and the requested path. The
profile can be opened in Chrome DevTools' **Performance** panel or another V8
CPU-profile viewer.
